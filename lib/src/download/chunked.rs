use super::chunk_state::{ChunkState, DownloadState, plan_chunks};
use super::progress::{self, ProgressFn};
use super::{DownloadControls, parse_content_range, throttle};
use crate::error::DownloadError;
use futures_util::StreamExt;
use reqwest::header::{CONTENT_RANGE, RANGE};
use reqwest::{Client, StatusCode, Url};
use std::path::Path;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;
use tokio::io::{AsyncSeekExt, AsyncWriteExt};
use tokio::sync::Mutex;

const MAX_WORKERS: u64 = 6;
const MIN_CHUNK_SIZE: u64 = 8 * 1024 * 1024;
const MAX_ATTEMPTS_PER_CHUNK: u32 = 3;
/// How often an in-flight chunk's progress is checkpointed to the sidecar
/// `.part.json`, in received bytes since the last checkpoint — frequent
/// enough that a crash loses at most a few MB of a chunk, not the whole
/// thing, without fsyncing on every network read.
const CHECKPOINT_INTERVAL_BYTES: u64 = 4 * 1024 * 1024;

/// Parallel Range-request downloader: splits the file into several chunks,
/// preallocates the destination `.part` file to full size, and downloads
/// all pending chunks concurrently, each writing its own byte range via an
/// independent file handle + seek (no shared cursor, no locking needed for
/// the actual disk I/O). Resume state lives in a `.part.json` sidecar next
/// to the `.part` file; a mismatched or missing sidecar means starting over.
#[allow(clippy::too_many_arguments)]
pub async fn run(
    client: &Client,
    effective_url: &Url,
    filename: &str,
    dest_path: &Path,
    part_path: &Path,
    state_path: &Path,
    token: Option<&str>,
    total_bytes: u64,
    etag: Option<String>,
    tsfn: ProgressFn,
    ctl: DownloadControls,
) -> Result<(), DownloadError> {
    let existing =
        DownloadState::load(state_path).filter(|s| s.matches(total_bytes, etag.as_deref()));

    let state = match existing {
        Some(s) => s,
        None => {
            tokio::fs::remove_file(part_path).await.ok();
            tokio::fs::remove_file(state_path).await.ok();

            let ranges = plan_chunks(total_bytes, MAX_WORKERS, MIN_CHUNK_SIZE);
            let fresh = DownloadState::new(total_bytes, etag, &ranges);

            let file = tokio::fs::OpenOptions::new()
                .create(true)
                .write(true)
                .truncate(true)
                .open(part_path)
                .await?;
            file.set_len(total_bytes).await?;
            drop(file);

            fresh.save(state_path)?;
            fresh
        }
    };

    let received_counter = Arc::new(AtomicU64::new(state.received_total()));
    let ticker = progress::spawn_ticker(tsfn.clone(), received_counter.clone(), Some(total_bytes));
    progress::emit(
        &tsfn,
        received_counter.load(Ordering::Relaxed),
        Some(total_bytes),
    );

    let pending: Vec<ChunkState> = state.chunks.iter().filter(|c| !c.done).copied().collect();
    let state = Arc::new(Mutex::new(state));

    let mut join_set = tokio::task::JoinSet::new();
    for chunk in pending {
        let client = client.clone();
        let url = effective_url.clone();
        let token = token.map(str::to_owned);
        let filename = filename.to_string();
        let part_path = part_path.to_path_buf();
        let state_path = state_path.to_path_buf();
        let counter = received_counter.clone();
        let state = state.clone();
        let ctl = ctl.clone();
        join_set.spawn(async move {
            download_chunk(
                &client,
                &url,
                &filename,
                token.as_deref(),
                &part_path,
                chunk,
                &counter,
                &state,
                &state_path,
                &ctl,
            )
            .await
        });
    }

    // Cancelled/Paused take priority over an ordinary "some chunk failed" —
    // they're not failures, and the manager needs to tell them apart from a
    // real network error without string-matching. Only the first one seen
    // matters (a job-wide signal fired once affects every in-flight chunk
    // near-simultaneously; the rest are the same outcome).
    let mut any_failed = false;
    let mut special: Option<DownloadError> = None;
    while let Some(joined) = join_set.join_next().await {
        match joined {
            Ok(Ok(())) => {}
            Ok(Err(err)) => {
                if matches!(
                    err,
                    DownloadError::Cancelled { .. } | DownloadError::Paused { .. }
                ) {
                    special.get_or_insert(err);
                } else {
                    tracing::warn!(error = %err, "chunk download failed");
                }
                any_failed = true;
            }
            Err(join_err) => {
                tracing::error!(error = %join_err, "chunk task panicked");
                any_failed = true;
            }
        }
    }

    ticker.abort();

    let final_received = received_counter.load(Ordering::Relaxed);
    progress::emit(&tsfn, final_received, Some(total_bytes));

    if let Some(err) = special {
        // A cancel doesn't want its partial bytes back; a pause does (same
        // "keep .part/.part.json, resumable" contract every other
        // non-cancel failure here already gets).
        if matches!(err, DownloadError::Cancelled { .. }) {
            tokio::fs::remove_file(part_path).await.ok();
            tokio::fs::remove_file(state_path).await.ok();
        }
        return Err(err);
    }

    // A failed or short chunk leaves `.part`/`.part.json` in place (never
    // deleted here) so the next attempt resumes only the missing pieces —
    // same "keep the partial, it's real progress" contract the single-stream
    // path follows. Reuses the same "incomplete" wording rather than
    // inventing chunk-specific error text, since callers only care that the
    // download didn't finish and can be retried.
    if any_failed || final_received != total_bytes {
        return Err(DownloadError::Incomplete {
            filename: filename.to_string(),
            received: final_received,
            total: total_bytes,
        });
    }

    tokio::fs::rename(part_path, dest_path).await?;
    tokio::fs::remove_file(state_path).await.ok();
    Ok(())
}

#[allow(clippy::too_many_arguments)]
async fn download_chunk(
    client: &Client,
    url: &Url,
    filename: &str,
    token: Option<&str>,
    part_path: &Path,
    chunk: ChunkState,
    counter: &Arc<AtomicU64>,
    state: &Arc<Mutex<DownloadState>>,
    state_path: &Path,
    ctl: &DownloadControls,
) -> Result<(), DownloadError> {
    let mut attempt = 0u32;
    loop {
        attempt += 1;
        match download_chunk_once(
            client, url, filename, token, part_path, &chunk, counter, state, state_path, ctl,
        )
        .await
        {
            Ok(()) => return Ok(()),
            // Cancelled/Paused are deliberate signals, not transient
            // failures — surface immediately rather than burning retries.
            Err(e @ (DownloadError::Cancelled { .. } | DownloadError::Paused { .. })) => {
                return Err(e);
            }
            Err(_) if attempt < MAX_ATTEMPTS_PER_CHUNK => {
                tokio::time::sleep(Duration::from_millis(500 * attempt as u64)).await;
            }
            Err(e) => return Err(e),
        }
    }
}

#[allow(clippy::too_many_arguments)]
async fn download_chunk_once(
    client: &Client,
    url: &Url,
    filename: &str,
    token: Option<&str>,
    part_path: &Path,
    chunk: &ChunkState,
    counter: &Arc<AtomicU64>,
    state: &Arc<Mutex<DownloadState>>,
    state_path: &Path,
    ctl: &DownloadControls,
) -> Result<(), DownloadError> {
    let already = state.lock().await.chunks[chunk.index as usize].received;
    if already >= chunk.size() {
        return Ok(());
    }

    let range_start = chunk.start + already;
    let mut req = client
        .get(url.clone())
        .header(RANGE, format!("bytes={range_start}-{}", chunk.end));
    if let Some(t) = token {
        req = req.bearer_auth(t);
    }
    let res = req
        .send()
        .await
        .map_err(|e| DownloadError::Raw(e.to_string()))?;
    if res.status() != StatusCode::PARTIAL_CONTENT {
        return Err(DownloadError::Raw(format!(
            "chunk {} request failed (HTTP {})",
            chunk.index,
            res.status().as_u16()
        )));
    }
    let content_range = res
        .headers()
        .get(CONTENT_RANGE)
        .and_then(|value| value.to_str().ok())
        .and_then(parse_content_range)
        .ok_or_else(|| {
            DownloadError::Raw(format!(
                "chunk {} returned an invalid Content-Range",
                chunk.index
            ))
        })?;
    let expected_total = state.lock().await.total_bytes;
    if content_range.start != range_start
        || content_range.end != chunk.end
        || content_range.total != expected_total
    {
        return Err(DownloadError::Raw(format!(
            "chunk {} returned Content-Range bytes {}-{}/{}; expected bytes {}-{}/{}",
            chunk.index,
            content_range.start,
            content_range.end,
            content_range.total,
            range_start,
            chunk.end,
            expected_total
        )));
    }

    let mut file = tokio::fs::OpenOptions::new()
        .write(true)
        .open(part_path)
        .await?;
    file.seek(std::io::SeekFrom::Start(range_start)).await?;

    let mut received_here = already;
    let mut since_checkpoint = 0u64;
    let mut stream = res.bytes_stream();
    loop {
        let item = tokio::select! {
            biased;
            _ = ctl.cancel.cancelled() => {
                file.flush().await.ok();
                return Err(DownloadError::Cancelled { filename: filename.to_string() });
            }
            _ = ctl.pause.cancelled() => {
                file.flush().await.ok();
                let mut guard = state.lock().await;
                guard.chunks[chunk.index as usize].received = received_here;
                let _ = guard.save(state_path);
                return Err(DownloadError::Paused { filename: filename.to_string() });
            }
            item = stream.next() => item,
        };
        let Some(item) = item else { break };
        let bytes = item.map_err(|e| DownloadError::Raw(e.to_string()))?;
        let remaining = chunk.size().saturating_sub(received_here);
        if bytes.len() as u64 > remaining {
            return Err(DownloadError::Raw(format!(
                "chunk {} response exceeded its requested range",
                chunk.index
            )));
        }
        throttle(&ctl.bandwidth_limiter, bytes.len()).await;
        file.write_all(&bytes).await?;
        received_here += bytes.len() as u64;
        since_checkpoint += bytes.len() as u64;
        counter.fetch_add(bytes.len() as u64, Ordering::Relaxed);

        {
            let mut guard = state.lock().await;
            guard.chunks[chunk.index as usize].received = received_here;
            if since_checkpoint >= CHECKPOINT_INTERVAL_BYTES {
                since_checkpoint = 0;
                let _ = guard.save(state_path);
            }
        }
    }
    file.flush().await?;

    let done = received_here == chunk.size();
    let mut guard = state.lock().await;
    guard.chunks[chunk.index as usize].received = received_here;
    guard.chunks[chunk.index as usize].done = done;
    let _ = guard.save(state_path);
    drop(guard);

    if !done {
        return Err(DownloadError::Raw(format!(
            "chunk {} ended short ({received_here} of {} bytes)",
            chunk.index,
            chunk.size()
        )));
    }
    Ok(())
}
