use super::{DownloadControls, run};
use crate::download::progress::ProgressFn;
use arc_swap::ArcSwapOption;
use governor::{Quota, RateLimiter};
use reqwest::Url;
use std::num::NonZeroU32;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tempfile::tempdir;
use tokio_util::sync::CancellationToken;
use wiremock::matchers::{header, method, path};
use wiremock::{Mock, MockServer, Request, ResponseTemplate};

/// Matches requests that carry no `Range` header at all — wiremock's
/// built-in matchers only assert a header's *presence with a given value*,
/// not its absence, which the "fresh download" / "ignored-Range" scenarios
/// both need to distinguish from a resume request.
struct NoRangeHeader;
impl wiremock::Match for NoRangeHeader {
    fn matches(&self, request: &Request) -> bool {
        !request.headers.contains_key("range")
    }
}

type ProgressEvents = Arc<Mutex<Vec<(u64, Option<u64>)>>>;

fn recording_progress() -> (ProgressFn, ProgressEvents) {
    let events: ProgressEvents = Arc::new(Mutex::new(Vec::new()));
    let recorded = events.clone();
    let tsfn: ProgressFn = Arc::new(move |received, total| {
        recorded.lock().unwrap().push((received, total));
    });
    (tsfn, events)
}

fn part_path(dest: &std::path::Path) -> PathBuf {
    super::part_path(dest)
}

fn state_path(dest: &std::path::Path) -> PathBuf {
    super::state_path(dest)
}

// ---------------------------------------------------------------------
// Single-stream path (file size kept well under the 16MiB chunking
// threshold so `run`'s probe->dispatch always lands here regardless of
// whether the mock server reports range support).
// ---------------------------------------------------------------------

/// Every single-stream scenario needs a mock answering the initial
/// `Range: bytes=0-0` probe `run` always sends first, regardless of which
/// path it ends up dispatching to. Its own content doesn't matter here — the
/// file sizes in these tests are always kept under the chunking threshold —
/// only that it's a legitimate response (wiremock/hyper reject a
/// Content-Length that doesn't match the actual body length).
fn mount_probe(server: &MockServer) -> impl std::future::Future<Output = ()> + '_ {
    Mock::given(method("GET"))
        .and(path("/model.gguf"))
        .and(header("range", "bytes=0-0"))
        .respond_with(ResponseTemplate::new(200).set_body_bytes("p"))
        .mount(server)
}

#[tokio::test]
async fn single_stream_fresh_download_reports_progress_and_renames() {
    let server = MockServer::start().await;
    let dir = tempdir().unwrap();
    let dest = dir.path().join("model.gguf");
    mount_probe(&server).await;

    Mock::given(method("GET"))
        .and(path("/model.gguf"))
        .and(NoRangeHeader)
        .respond_with(ResponseTemplate::new(200).set_body_bytes("helloworld"))
        .mount(&server)
        .await;

    let url = Url::parse(&format!("{}/model.gguf", server.uri())).unwrap();
    let (tsfn, events) = recording_progress();

    run(
        url,
        "model.gguf".to_string(),
        dest.to_string_lossy().to_string(),
        None,
        tsfn,
        DownloadControls::default(),
    )
    .await
    .expect("download should succeed");

    assert_eq!(std::fs::read_to_string(&dest).unwrap(), "helloworld");
    assert!(!part_path(&dest).exists());
    assert!(!state_path(&dest).exists());
    let last = *events.lock().unwrap().last().unwrap();
    assert_eq!(last, (10, Some(10)));
}

#[tokio::test]
async fn single_stream_resumes_via_range_request() {
    let server = MockServer::start().await;
    let dir = tempdir().unwrap();
    let dest = dir.path().join("model.gguf");
    std::fs::write(part_path(&dest), "hello").unwrap();
    mount_probe(&server).await;

    Mock::given(method("GET"))
        .and(path("/model.gguf"))
        .and(header("range", "bytes=5-"))
        .respond_with(
            ResponseTemplate::new(206)
                .insert_header("content-range", "bytes 5-9/10")
                .set_body_bytes("world"),
        )
        .mount(&server)
        .await;

    let url = Url::parse(&format!("{}/model.gguf", server.uri())).unwrap();
    let (tsfn, _events) = recording_progress();

    run(
        url,
        "model.gguf".to_string(),
        dest.to_string_lossy().to_string(),
        None,
        tsfn,
        DownloadControls::default(),
    )
    .await
    .expect("resumed download should succeed");

    assert_eq!(std::fs::read_to_string(&dest).unwrap(), "helloworld");
}

#[tokio::test]
async fn single_stream_discards_stale_partial_on_416_and_restarts() {
    let server = MockServer::start().await;
    let dir = tempdir().unwrap();
    let dest = dir.path().join("model.gguf");
    std::fs::write(part_path(&dest), "stale").unwrap();
    mount_probe(&server).await;

    Mock::given(method("GET"))
        .and(path("/model.gguf"))
        .and(header("range", "bytes=5-"))
        .respond_with(ResponseTemplate::new(416))
        .mount(&server)
        .await;

    Mock::given(method("GET"))
        .and(path("/model.gguf"))
        .and(NoRangeHeader)
        .respond_with(ResponseTemplate::new(200).set_body_bytes("fresh"))
        .mount(&server)
        .await;

    let url = Url::parse(&format!("{}/model.gguf", server.uri())).unwrap();
    let (tsfn, _events) = recording_progress();

    run(
        url,
        "model.gguf".to_string(),
        dest.to_string_lossy().to_string(),
        None,
        tsfn,
        DownloadControls::default(),
    )
    .await
    .expect("download should restart cleanly after a 416");

    assert_eq!(std::fs::read_to_string(&dest).unwrap(), "fresh");
}

#[tokio::test]
async fn single_stream_ignored_range_falls_back_to_fresh_download() {
    let server = MockServer::start().await;
    let dir = tempdir().unwrap();
    let dest = dir.path().join("model.gguf");
    std::fs::write(part_path(&dest), "OLD-STALE-DATA").unwrap();

    // Every request — probe or resume — gets a plain 200 with the full
    // body, as a server with no Range support would: it ignores whatever
    // Range header it was sent.
    Mock::given(method("GET"))
        .and(path("/model.gguf"))
        .respond_with(ResponseTemplate::new(200).set_body_bytes("fresh"))
        .mount(&server)
        .await;

    let url = Url::parse(&format!("{}/model.gguf", server.uri())).unwrap();
    let (tsfn, _events) = recording_progress();

    run(
        url,
        "model.gguf".to_string(),
        dest.to_string_lossy().to_string(),
        None,
        tsfn,
        DownloadControls::default(),
    )
    .await
    .expect("download should discard the stale partial and succeed");

    assert_eq!(std::fs::read_to_string(&dest).unwrap(), "fresh");
}

#[tokio::test]
async fn single_stream_keeps_partial_and_errors_when_stream_ends_short() {
    let server = MockServer::start().await;
    let dir = tempdir().unwrap();
    let dest = dir.path().join("model.gguf");
    std::fs::write(part_path(&dest), "hello").unwrap();
    mount_probe(&server).await;

    // Content-Range claims a 100-byte total, but this response's actual
    // body (whose real Content-Length wiremock computes honestly) only
    // carries 3 more bytes — the same shape a connection that dies partway
    // through a long resumed download would leave behind.
    Mock::given(method("GET"))
        .and(path("/model.gguf"))
        .and(header("range", "bytes=5-"))
        .respond_with(
            ResponseTemplate::new(206)
                .insert_header("content-range", "bytes 5-9/100")
                .set_body_bytes("wor"),
        )
        .mount(&server)
        .await;

    let url = Url::parse(&format!("{}/model.gguf", server.uri())).unwrap();
    let (tsfn, _events) = recording_progress();

    let err = run(
        url,
        "model.gguf".to_string(),
        dest.to_string_lossy().to_string(),
        None,
        tsfn,
        DownloadControls::default(),
    )
    .await
    .expect_err("short stream should error");

    assert!(
        err.to_string().contains("incomplete"),
        "unexpected message: {err}"
    );
    assert!(
        part_path(&dest).exists(),
        ".part must survive so a retry can resume"
    );
    assert!(!dest.exists());
}

// ---------------------------------------------------------------------
// Chunked path (file size at/above the 16MiB threshold, server reports
// range support so `run`'s probe->dispatch picks the parallel path).
// ---------------------------------------------------------------------

const CHUNK_TOTAL: usize = 20 * 1024 * 1024;
const CHUNK_SPLIT: usize = 10 * 1024 * 1024;

#[tokio::test]
async fn chunked_fresh_download_assembles_correct_bytes() {
    let server = MockServer::start().await;
    let dir = tempdir().unwrap();
    let dest = dir.path().join("model.gguf");

    let first_half = vec![0xAAu8; CHUNK_SPLIT];
    let second_half = vec![0xBBu8; CHUNK_TOTAL - CHUNK_SPLIT];

    Mock::given(method("GET"))
        .and(path("/model.gguf"))
        .and(header("range", "bytes=0-0"))
        .respond_with(
            ResponseTemplate::new(206)
                .insert_header("content-range", format!("bytes 0-0/{CHUNK_TOTAL}"))
                .set_body_bytes(vec![0xAA]),
        )
        .mount(&server)
        .await;

    Mock::given(method("GET"))
        .and(path("/model.gguf"))
        .and(header("range", format!("bytes=0-{}", CHUNK_SPLIT - 1)))
        .respond_with(
            ResponseTemplate::new(206)
                .insert_header(
                    "content-range",
                    format!("bytes 0-{}/{CHUNK_TOTAL}", CHUNK_SPLIT - 1),
                )
                .set_body_bytes(first_half.clone()),
        )
        .mount(&server)
        .await;

    Mock::given(method("GET"))
        .and(path("/model.gguf"))
        .and(header(
            "range",
            format!("bytes={CHUNK_SPLIT}-{}", CHUNK_TOTAL - 1),
        ))
        .respond_with(
            ResponseTemplate::new(206)
                .insert_header(
                    "content-range",
                    format!("bytes {CHUNK_SPLIT}-{}/{CHUNK_TOTAL}", CHUNK_TOTAL - 1),
                )
                .set_body_bytes(second_half.clone()),
        )
        .mount(&server)
        .await;

    let url = Url::parse(&format!("{}/model.gguf", server.uri())).unwrap();
    let (tsfn, events) = recording_progress();

    run(
        url,
        "model.gguf".to_string(),
        dest.to_string_lossy().to_string(),
        None,
        tsfn,
        DownloadControls::default(),
    )
    .await
    .expect("chunked download should succeed");

    let bytes = std::fs::read(&dest).unwrap();
    assert_eq!(bytes.len(), CHUNK_TOTAL);
    assert_eq!(&bytes[..CHUNK_SPLIT], &first_half[..]);
    assert_eq!(&bytes[CHUNK_SPLIT..], &second_half[..]);
    assert!(!part_path(&dest).exists());
    assert!(!state_path(&dest).exists());

    let last = *events.lock().unwrap().last().unwrap();
    assert_eq!(last, (CHUNK_TOTAL as u64, Some(CHUNK_TOTAL as u64)));
}

#[tokio::test]
async fn chunked_ignores_mismatched_sidecar_and_restarts_clean() {
    let server = MockServer::start().await;
    let dir = tempdir().unwrap();
    let dest = dir.path().join("model.gguf");

    // A `.part.json` left over from a different (smaller / different-etag)
    // attempt — must not be trusted, since its chunk boundaries don't match
    // this file's real size.
    std::fs::write(
        state_path(&dest),
        r#"{"version":1,"totalBytes":999,"etag":null,"chunks":[]}"#,
    )
    .unwrap();
    std::fs::write(part_path(&dest), vec![0u8; 999]).unwrap();

    let first_half = vec![0x11u8; CHUNK_SPLIT];
    let second_half = vec![0x22u8; CHUNK_TOTAL - CHUNK_SPLIT];

    Mock::given(method("GET"))
        .and(path("/model.gguf"))
        .and(header("range", "bytes=0-0"))
        .respond_with(
            ResponseTemplate::new(206)
                .insert_header("content-range", format!("bytes 0-0/{CHUNK_TOTAL}"))
                .set_body_bytes(vec![0x11]),
        )
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path("/model.gguf"))
        .and(header("range", format!("bytes=0-{}", CHUNK_SPLIT - 1)))
        .respond_with(
            ResponseTemplate::new(206)
                .insert_header(
                    "content-range",
                    format!("bytes 0-{}/{CHUNK_TOTAL}", CHUNK_SPLIT - 1),
                )
                .set_body_bytes(first_half.clone()),
        )
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path("/model.gguf"))
        .and(header(
            "range",
            format!("bytes={CHUNK_SPLIT}-{}", CHUNK_TOTAL - 1),
        ))
        .respond_with(
            ResponseTemplate::new(206)
                .insert_header(
                    "content-range",
                    format!("bytes {CHUNK_SPLIT}-{}/{CHUNK_TOTAL}", CHUNK_TOTAL - 1),
                )
                .set_body_bytes(second_half.clone()),
        )
        .mount(&server)
        .await;

    let url = Url::parse(&format!("{}/model.gguf", server.uri())).unwrap();
    let (tsfn, _events) = recording_progress();

    run(
        url,
        "model.gguf".to_string(),
        dest.to_string_lossy().to_string(),
        None,
        tsfn,
        DownloadControls::default(),
    )
    .await
    .expect("should discard the mismatched sidecar and download clean");

    let bytes = std::fs::read(&dest).unwrap();
    assert_eq!(bytes.len(), CHUNK_TOTAL);
    assert_eq!(&bytes[..CHUNK_SPLIT], &first_half[..]);
    assert_eq!(&bytes[CHUNK_SPLIT..], &second_half[..]);
}

#[tokio::test]
async fn chunked_leaves_partial_and_errors_when_a_chunk_never_succeeds() {
    let server = MockServer::start().await;
    let dir = tempdir().unwrap();
    let dest = dir.path().join("model.gguf");

    Mock::given(method("GET"))
        .and(path("/model.gguf"))
        .and(header("range", "bytes=0-0"))
        .respond_with(
            ResponseTemplate::new(206)
                .insert_header("content-range", format!("bytes 0-0/{CHUNK_TOTAL}"))
                .set_body_bytes(vec![0x11]),
        )
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path("/model.gguf"))
        .and(header("range", format!("bytes=0-{}", CHUNK_SPLIT - 1)))
        .respond_with(
            ResponseTemplate::new(206)
                .insert_header(
                    "content-range",
                    format!("bytes 0-{}/{CHUNK_TOTAL}", CHUNK_SPLIT - 1),
                )
                .set_body_bytes(vec![0x11u8; CHUNK_SPLIT]),
        )
        .mount(&server)
        .await;
    // Second chunk always fails — the download should still finish (rather
    // than hang) with the first chunk's bytes on disk and an error.
    Mock::given(method("GET"))
        .and(path("/model.gguf"))
        .and(header(
            "range",
            format!("bytes={CHUNK_SPLIT}-{}", CHUNK_TOTAL - 1),
        ))
        .respond_with(ResponseTemplate::new(503))
        .mount(&server)
        .await;

    let url = Url::parse(&format!("{}/model.gguf", server.uri())).unwrap();
    let (tsfn, _events) = recording_progress();

    let err = run(
        url,
        "model.gguf".to_string(),
        dest.to_string_lossy().to_string(),
        None,
        tsfn,
        DownloadControls::default(),
    )
    .await
    .expect_err("a permanently failing chunk should surface as an error");

    assert!(
        err.to_string().contains("incomplete"),
        "unexpected message: {err}"
    );
    assert!(part_path(&dest).exists());
    assert!(state_path(&dest).exists());
    assert!(!dest.exists());
}

// ---------------------------------------------------------------------
// Cancellation / pause / bandwidth limiting. `tokio::select!`'s `biased;`
// ordering in single_stream.rs/chunked.rs means a token cancelled *before*
// the download starts is guaranteed to win the very first loop iteration
// over `stream.next()`, even if data is already available — a
// deterministic way to exercise the cancel/pause code paths without
// needing to race real network timing.
// ---------------------------------------------------------------------

#[tokio::test]
async fn cancelling_before_the_stream_starts_deletes_the_partial_and_errors() {
    let server = MockServer::start().await;
    let dir = tempdir().unwrap();
    let dest = dir.path().join("model.gguf");
    std::fs::write(part_path(&dest), "not-really-resumable-once-cancelled").unwrap();
    mount_probe(&server).await;

    Mock::given(method("GET"))
        .and(path("/model.gguf"))
        .respond_with(ResponseTemplate::new(200).set_body_bytes("helloworld"))
        .mount(&server)
        .await;

    let url = Url::parse(&format!("{}/model.gguf", server.uri())).unwrap();
    let (tsfn, _events) = recording_progress();

    let cancel = CancellationToken::new();
    cancel.cancel();
    let ctl = DownloadControls {
        cancel,
        ..DownloadControls::default()
    };

    let err = run(
        url,
        "model.gguf".to_string(),
        dest.to_string_lossy().to_string(),
        None,
        tsfn,
        ctl,
    )
    .await
    .expect_err("a pre-cancelled download should error");

    assert!(
        matches!(err, crate::error::DownloadError::Cancelled { .. }),
        "unexpected error: {err}"
    );
    assert!(
        !part_path(&dest).exists(),
        "a cancelled download's .part must not survive"
    );
    assert!(!dest.exists());
}

#[tokio::test]
async fn pausing_before_the_stream_starts_keeps_the_partial_and_errors() {
    let server = MockServer::start().await;
    let dir = tempdir().unwrap();
    let dest = dir.path().join("model.gguf");
    std::fs::write(part_path(&dest), "hello").unwrap();
    mount_probe(&server).await;

    Mock::given(method("GET"))
        .and(path("/model.gguf"))
        .and(header("range", "bytes=5-"))
        .respond_with(
            ResponseTemplate::new(206)
                .insert_header("content-range", "bytes 5-9/10")
                .set_body_bytes("world"),
        )
        .mount(&server)
        .await;

    let url = Url::parse(&format!("{}/model.gguf", server.uri())).unwrap();
    let (tsfn, _events) = recording_progress();

    let pause = CancellationToken::new();
    pause.cancel();
    let ctl = DownloadControls {
        pause,
        ..DownloadControls::default()
    };

    let err = run(
        url,
        "model.gguf".to_string(),
        dest.to_string_lossy().to_string(),
        None,
        tsfn,
        ctl,
    )
    .await
    .expect_err("a pre-paused download should error");

    assert!(
        matches!(err, crate::error::DownloadError::Paused { .. }),
        "unexpected error: {err}"
    );
    assert!(
        part_path(&dest).exists(),
        "a paused download's .part must stay — it's resumable"
    );
}

#[tokio::test]
async fn a_paused_download_resumes_correctly_on_the_next_attempt() {
    let server = MockServer::start().await;
    let dir = tempdir().unwrap();
    let dest = dir.path().join("model.gguf");
    std::fs::write(part_path(&dest), "hello").unwrap();
    mount_probe(&server).await;

    Mock::given(method("GET"))
        .and(path("/model.gguf"))
        .and(header("range", "bytes=5-"))
        .respond_with(
            ResponseTemplate::new(206)
                .insert_header("content-range", "bytes 5-9/10")
                .set_body_bytes("world"),
        )
        .mount(&server)
        .await;

    let url = Url::parse(&format!("{}/model.gguf", server.uri())).unwrap();

    let pause = CancellationToken::new();
    pause.cancel();
    let (tsfn, _events) = recording_progress();
    run(
        url.clone(),
        "model.gguf".to_string(),
        dest.to_string_lossy().to_string(),
        None,
        tsfn,
        DownloadControls {
            pause,
            ..DownloadControls::default()
        },
    )
    .await
    .expect_err("should be paused, not succeed");

    let (tsfn, _events) = recording_progress();
    run(
        url,
        "model.gguf".to_string(),
        dest.to_string_lossy().to_string(),
        None,
        tsfn,
        DownloadControls::default(),
    )
    .await
    .expect("resuming after a pause should succeed");

    assert_eq!(std::fs::read_to_string(&dest).unwrap(), "helloworld");
}

#[tokio::test]
async fn a_bandwidth_limit_measurably_slows_a_download() {
    let server = MockServer::start().await;
    let dir = tempdir().unwrap();
    let dest = dir.path().join("model.gguf");
    mount_probe(&server).await;

    let body = "x".repeat(100);
    Mock::given(method("GET"))
        .and(path("/model.gguf"))
        .and(NoRangeHeader)
        .respond_with(ResponseTemplate::new(200).set_body_bytes(body))
        .mount(&server)
        .await;

    let url = Url::parse(&format!("{}/model.gguf", server.uri())).unwrap();
    let (tsfn, _events) = recording_progress();

    // The whole 100-byte body arrives from wiremock as a single chunk,
    // bigger than this limiter's 50-cell burst capacity — that pushes
    // `throttle()` onto its one-cell-at-a-time fallback path (see mod.rs),
    // which at 50 bytes/sec takes ~2s for 100 bytes. Comfortably
    // distinguishable from an unthrottled transfer of the same tiny body,
    // which finishes in milliseconds. Only asserting a floor, not a
    // ceiling: no timing assertion on the unthrottled path elsewhere in
    // this file, since that direction is what's actually flake-prone on a
    // loaded CI runner.
    let limiter = Arc::new(RateLimiter::direct(Quota::per_second(
        NonZeroU32::new(50).unwrap(),
    )));
    let ctl = DownloadControls {
        bandwidth_limiter: Arc::new(ArcSwapOption::from(Some(limiter))),
        ..DownloadControls::default()
    };

    let start = Instant::now();
    run(
        url,
        "model.gguf".to_string(),
        dest.to_string_lossy().to_string(),
        None,
        tsfn,
        ctl,
    )
    .await
    .expect("throttled download should still succeed");

    assert!(
        start.elapsed() >= Duration::from_secs(1),
        "expected the bandwidth limit to slow this down, took {:?}",
        start.elapsed()
    );
}
