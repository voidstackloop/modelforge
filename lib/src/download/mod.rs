mod chunk_state;
mod chunked;
pub mod disk_space;
pub mod job;
mod progress;
mod single_stream;
#[cfg(test)]
mod tests;
pub mod verify;

use crate::error::DownloadError;
use arc_swap::ArcSwapOption;
use governor::DefaultDirectRateLimiter;
use percent_encoding::{AsciiSet, CONTROLS, utf8_percent_encode};
use reqwest::header::{CONTENT_LENGTH, CONTENT_RANGE, RANGE};
use reqwest::{Client, StatusCode, Url};
use std::num::NonZeroU32;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;
use tokio_util::sync::CancellationToken;

pub use progress::{ProgressFn, SpeedTracker};

/// Bundles the three "how should this download behave" knobs that the
/// stateless per-shard primitive (`run`, and the `single_stream`/`chunked`
/// modules underneath it) needs but doesn't own: cooperative cancel/pause
/// signals and an optional shared bandwidth limiter. Grouped into one
/// cloneable struct rather than three separate parameters threaded through
/// every function — `Default` gives tokens that are never triggered and no
/// bandwidth limit, which is exactly what the original one-shot
/// `download_gguf_file` napi export (untouched by this change) needs.
pub type SharedBandwidthLimiter = Arc<ArcSwapOption<DefaultDirectRateLimiter>>;

#[derive(Clone)]
pub struct DownloadControls {
    pub cancel: CancellationToken,
    pub pause: CancellationToken,
    pub bandwidth_limiter: SharedBandwidthLimiter,
}

impl Default for DownloadControls {
    fn default() -> Self {
        Self {
            cancel: CancellationToken::new(),
            pause: CancellationToken::new(),
            bandwidth_limiter: Arc::new(ArcSwapOption::from(None)),
        }
    }
}

/// Waits for `byte_len` bytes' worth of budget from the shared limiter, if
/// one is configured. A no-op (not even a poll) when `limiter` is `None`, so
/// the unthrottled path — the common case — pays zero overhead for this.
pub async fn throttle(limiter: &SharedBandwidthLimiter, byte_len: usize) {
    let Some(limiter) = limiter.load_full() else {
        return;
    };
    let Ok(n) = NonZeroU32::try_from(byte_len.min(u32::MAX as usize) as u32) else {
        return;
    };

    if limiter.until_n_ready(n).await.is_err() {
        // The whole chunk exceeds the limiter's max burst capacity —
        // `until_n_ready` refuses outright rather than waiting, since a
        // request that large could structurally never be satisfied. Falls
        // back to one cell at a time so the limit is still honored, just
        // less efficiently; not expected to be hit at any bandwidth-limit
        // setting realistic for a multi-KB/MB network read.
        for _ in 0..byte_len {
            limiter.until_ready().await;
        }
    }
}

/// Below this, the extra round trips of chunked downloading aren't worth it
/// — a single stream finishes before N connections would even finish
/// ramping up.
const MIN_CHUNKED_SIZE: u64 = 16 * 1024 * 1024;

pub fn part_path(dest: &Path) -> PathBuf {
    let mut s = dest.as_os_str().to_owned();
    s.push(".part");
    PathBuf::from(s)
}

pub fn state_path(dest: &Path) -> PathBuf {
    let mut s = dest.as_os_str().to_owned();
    s.push(".part.json");
    PathBuf::from(s)
}

// encodeURIComponent's unreserved set: A-Za-z0-9 - _ . ! ~ * ' ( )
const COMPONENT: &AsciiSet = &CONTROLS
    .add(b' ')
    .add(b'"')
    .add(b'#')
    .add(b'$')
    .add(b'%')
    .add(b'&')
    .add(b'+')
    .add(b',')
    .add(b'/')
    .add(b':')
    .add(b';')
    .add(b'<')
    .add(b'=')
    .add(b'>')
    .add(b'?')
    .add(b'@')
    .add(b'[')
    .add(b'\\')
    .add(b']')
    .add(b'^')
    .add(b'`')
    .add(b'{')
    .add(b'|')
    .add(b'}');

pub fn build_resolve_url(model_id: &str, filename: &str) -> Result<Url, DownloadError> {
    let encoded_filename = utf8_percent_encode(filename, COMPONENT).to_string();
    let raw = format!("https://huggingface.co/{model_id}/resolve/main/{encoded_filename}");
    Url::parse(&raw).map_err(|e| DownloadError::Raw(format!("Invalid Hugging Face URL: {e}")))
}

#[derive(Debug, PartialEq, Eq)]
struct ContentRange {
    start: u64,
    end: u64,
    total: u64,
}

fn parse_content_range(value: &str) -> Option<ContentRange> {
    let value = value.strip_prefix("bytes ")?;
    let (range, total) = value.split_once('/')?;
    let (start, end) = range.split_once('-')?;
    let parsed = ContentRange {
        start: start.parse().ok()?,
        end: end.parse().ok()?,
        total: total.parse().ok()?,
    };
    (parsed.start <= parsed.end && parsed.end < parsed.total).then_some(parsed)
}

fn parse_content_range_total(value: &str) -> Option<u64> {
    Some(parse_content_range(value)?.total)
}

fn extract_etag(headers: &reqwest::header::HeaderMap) -> Option<String> {
    // HF's resolve endpoint reports the LFS blob's real etag via
    // x-linked-etag; the outer response's own `etag` (if any) reflects the
    // redirect/pointer, not the blob content, so prefer the former.
    headers
        .get("x-linked-etag")
        .or_else(|| headers.get(reqwest::header::ETAG))
        .and_then(|v| v.to_str().ok())
        .map(str::to_owned)
}

fn build_client() -> Result<Client, DownloadError> {
    Client::builder()
        .connect_timeout(Duration::from_secs(30))
        .build()
        .map_err(|e| DownloadError::Raw(format!("Couldn't build HTTP client: {e}")))
}

struct Probe {
    supports_ranges: bool,
    total_bytes: Option<u64>,
    etag: Option<String>,
}

/// A cheap `Range: bytes=0-0` request that tells us whether the server
/// supports ranges and how big the file is, without pulling the whole file
/// over the wire even when it doesn't (dropping the response before reading
/// its body aborts the transfer rather than downloading it).
///
/// Deliberately does *not* hand back the post-redirect URL for reuse: Hugging
/// Face's `resolve/main/...` redirects gated/private repos to a signed,
/// time-limited CDN URL, and empirically (confirmed against the real API)
/// that signature only covers the exact request it was issued for — reusing
/// it across chunk workers with different `Range` headers gets every one of
/// them a 403. Every subsequent request re-resolves the original URL fresh
/// instead, at the cost of one extra redirect hop each.
async fn probe(
    client: &Client,
    url: &Url,
    token: Option<&str>,
    filename: &str,
) -> Result<Probe, DownloadError> {
    let mut req = client.get(url.clone()).header(RANGE, "bytes=0-0");
    if let Some(t) = token {
        req = req.bearer_auth(t);
    }
    let res = req
        .send()
        .await
        .map_err(|e| DownloadError::Unreachable(e.to_string()))?;

    let status = res.status();
    let headers = res.headers().clone();

    if status == StatusCode::PARTIAL_CONTENT {
        Ok(Probe {
            supports_ranges: true,
            total_bytes: headers
                .get(CONTENT_RANGE)
                .and_then(|v| v.to_str().ok())
                .and_then(parse_content_range_total),
            etag: extract_etag(&headers),
        })
    } else if status.is_success() {
        Ok(Probe {
            supports_ranges: false,
            total_bytes: headers
                .get(CONTENT_LENGTH)
                .and_then(|v| v.to_str().ok())
                .and_then(|s| s.parse().ok()),
            etag: extract_etag(&headers),
        })
    } else {
        Err(DownloadError::HttpStatus {
            filename: filename.to_string(),
            status: status.as_u16(),
        })
    }
}

/// `url` is the Hugging Face `resolve/main/...` URL (or, in tests, a mock
/// server URL standing in for it) — building it from a model id + filename
/// is a separate, pure step (`build_resolve_url`) kept out of `run` itself
/// so tests can point the whole download pipeline at a local mock server.
pub async fn run(
    url: Url,
    filename: String,
    dest_path: String,
    token: Option<String>,
    tsfn: ProgressFn,
    ctl: DownloadControls,
) -> Result<(), DownloadError> {
    let dest_path = PathBuf::from(dest_path);
    let part = part_path(&dest_path);
    let state = state_path(&dest_path);

    let client = build_client()?;
    let probe = probe(&client, &url, token.as_deref(), &filename).await?;

    let use_chunked =
        probe.supports_ranges && probe.total_bytes.is_some_and(|t| t >= MIN_CHUNKED_SIZE);

    if use_chunked {
        // A leftover single-stream `.part` (no matching `.part.json`) can't
        // be trusted for positional multi-writes — its "resumable" bytes
        // aren't addressable per-chunk. Start clean rather than guess.
        if !state.exists() && part.exists() {
            let _ = tokio::fs::remove_file(&part).await;
        }
        chunked::run(
            &client,
            &url,
            &filename,
            &dest_path,
            &part,
            &state,
            token.as_deref(),
            probe.total_bytes.expect("checked above"),
            probe.etag,
            tsfn,
            ctl,
        )
        .await
    } else {
        // A leftover chunked `.part` (preallocated, possibly full of holes)
        // can't be resumed as a flat sequential stream — same reasoning,
        // reversed.
        if state.exists() {
            let _ = tokio::fs::remove_file(&state).await;
            let _ = tokio::fs::remove_file(&part).await;
        }
        single_stream::run(
            &client,
            &url,
            &filename,
            &dest_path,
            &part,
            token.as_deref(),
            tsfn,
            ctl,
        )
        .await
    }
}

#[cfg(test)]
mod content_range_tests {
    use super::{ContentRange, parse_content_range};

    #[test]
    fn parses_a_valid_content_range() {
        assert_eq!(
            parse_content_range("bytes 10-19/100"),
            Some(ContentRange {
                start: 10,
                end: 19,
                total: 100
            })
        );
    }

    #[test]
    fn rejects_malformed_or_impossible_content_ranges() {
        for value in [
            "bytes 10-19/*",
            "bytes 20-10/100",
            "bytes 0-100/100",
            "items 0-1/2",
            "bytes 0-1/2, bytes 3-4/5",
        ] {
            assert_eq!(parse_content_range(value), None, "{value}");
        }
    }
}
