use super::progress::{self, ProgressFn};
use super::{DownloadControls, parse_content_range_total, throttle};
use crate::error::DownloadError;
use futures_util::StreamExt;
use reqwest::header::{CONTENT_LENGTH, CONTENT_RANGE, RANGE};
use reqwest::{Client, StatusCode, Url};
use std::path::Path;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use tokio::io::AsyncWriteExt;

/// Direct port of `downloadGgufFile`'s sequential logic in
/// `app/src/huggingface.ts`: resumes via a Range request against the
/// existing `.part` file's size, handles a stale partial (416), handles a
/// server that ignores the Range header (falls back to a fresh download),
/// keeps the `.part` file on any failure so a retry can resume, and verifies
/// the final byte count before renaming into place. Used both as the
/// fallback for servers/files that don't support ranged chunked downloading
/// and (implicitly) as the shape the chunked path's per-chunk requests
/// mirror.
#[allow(clippy::too_many_arguments)]
pub async fn run(
    client: &Client,
    url: &Url,
    filename: &str,
    dest_path: &Path,
    part_path: &Path,
    token: Option<&str>,
    tsfn: ProgressFn,
    ctl: DownloadControls,
) -> Result<(), DownloadError> {
    loop {
        let mut existing_bytes = tokio::fs::metadata(part_path)
            .await
            .map(|m| m.len())
            .unwrap_or(0);

        let mut req = client.get(url.clone());
        if let Some(t) = token {
            req = req.bearer_auth(t);
        }
        if existing_bytes > 0 {
            req = req.header(RANGE, format!("bytes={existing_bytes}-"));
        }

        let res = req
            .send()
            .await
            .map_err(|e| DownloadError::Unreachable(e.to_string()))?;
        let status = res.status();

        // Our partial is already >= what the server has now (stale, or the
        // remote file changed) — it can't be resumed, so start clean once.
        if existing_bytes > 0 && status == StatusCode::RANGE_NOT_SATISFIABLE {
            tokio::fs::remove_file(part_path).await.ok();
            continue;
        }

        // Server ignored the Range request and is sending the whole file
        // from the start — appending that to the stale partial would
        // corrupt it, so discard the partial and treat this as fresh.
        let resuming = existing_bytes > 0 && status == StatusCode::PARTIAL_CONTENT;
        if existing_bytes > 0 && !resuming {
            existing_bytes = 0;
        }

        if !status.is_success() {
            return Err(DownloadError::HttpStatus {
                filename: filename.to_string(),
                status: status.as_u16(),
            });
        }

        let content_length = res
            .headers()
            .get(CONTENT_LENGTH)
            .and_then(|v| v.to_str().ok())
            .and_then(|s| s.parse::<u64>().ok());
        let total_bytes = if resuming {
            res.headers()
                .get(CONTENT_RANGE)
                .and_then(|v| v.to_str().ok())
                .and_then(parse_content_range_total)
                .or(content_length.map(|c| existing_bytes + c))
        } else {
            content_length
        };

        let counter = Arc::new(AtomicU64::new(existing_bytes));
        let ticker = progress::spawn_ticker(tsfn.clone(), counter.clone(), total_bytes);
        progress::emit(&tsfn, existing_bytes, total_bytes);

        let mut file = tokio::fs::OpenOptions::new()
            .create(true)
            .write(true)
            .append(resuming)
            .truncate(!resuming)
            .open(part_path)
            .await?;

        let mut received = existing_bytes;
        let mut stream = res.bytes_stream();
        let stream_result: Result<(), DownloadError> = async {
            loop {
                let item = tokio::select! {
                    biased;
                    _ = ctl.cancel.cancelled() => {
                        return Err(DownloadError::Cancelled { filename: filename.to_string() });
                    }
                    _ = ctl.pause.cancelled() => {
                        return Err(DownloadError::Paused { filename: filename.to_string() });
                    }
                    item = stream.next() => item,
                };
                let Some(item) = item else { break };
                let bytes = item.map_err(|e| DownloadError::Raw(e.to_string()))?;
                throttle(&ctl.bandwidth_limiter, bytes.len()).await;
                file.write_all(&bytes).await?;
                received += bytes.len() as u64;
                counter.store(received, Ordering::Relaxed);
            }
            Ok(())
        }
        .await;

        ticker.abort();

        if let Err(e) = stream_result {
            // Deliberately not deleting part_path here for an ordinary
            // network failure or a pause — a dropped connection (or a
            // deliberate pause) mid-stream leaves real, resumable progress
            // on disk for the next attempt. A cancel is the one case that
            // *does* delete it — the caller doesn't want it back.
            let _ = file.flush().await;
            if matches!(e, DownloadError::Cancelled { .. }) {
                tokio::fs::remove_file(part_path).await.ok();
            }
            return Err(e);
        }
        file.flush().await?;
        drop(file);

        progress::emit(&tsfn, received, total_bytes);

        if let Some(total) = total_bytes
            && received != total
        {
            return Err(DownloadError::Incomplete {
                filename: filename.to_string(),
                received,
                total,
            });
        }

        tokio::fs::rename(part_path, dest_path).await?;
        return Ok(());
    }
}
