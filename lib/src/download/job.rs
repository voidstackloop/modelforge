use super::{DownloadControls, build_resolve_url, disk_space, run, verify};
use crate::error::DownloadError;
use reqwest::Url;
use std::path::Path;
use std::sync::Arc;

#[derive(Clone)]
pub struct ShardSpec {
    pub filename: String,
    /// Absolute destination path for this shard's finished file.
    pub path: String,
    pub expected_bytes: u64,
    /// Bytes already on disk from a previous attempt — informational only;
    /// `download::run` figures out the real resume point from whatever
    /// `.part` file actually exists, this is just used for the upfront
    /// disk-space estimate.
    pub received_bytes: u64,
    pub sha256: Option<String>,
}

pub struct JobSpec {
    pub model_id: String,
    pub token: Option<String>,
    pub destination_dir: String,
    pub shards: Vec<ShardSpec>,
}

pub enum ShardEvent {
    State {
        filename: String,
        state: &'static str,
    },
    /// `total` isn't carried here — the job-level rollup in `manager.rs`
    /// uses each shard's known `expectedBytes` instead, which is available
    /// upfront (before the per-shard probe even runs) and consistent across
    /// every shard, unlike the per-transfer `total` this mirrors.
    Progress { filename: String, received: u64 },
}

pub type ShardEventFn = Arc<dyn Fn(ShardEvent) + Send + Sync>;

/// Drives every shard of one job to completion, sequentially — the existing
/// per-shard chunk-worker cap (6) already saturates a connection, so
/// parallel shards would mean up to 6×N simultaneous connections per job,
/// untested load against Hugging Face. Stops at the first shard that fails,
/// is cancelled, or is paused; shards already completed before that point
/// are left on disk (they're valid, independently usable files).
pub async fn run_job(
    job: &JobSpec,
    ctl: DownloadControls,
    on_event: ShardEventFn,
) -> Result<(), DownloadError> {
    run_job_with(job, ctl, on_event, build_resolve_url).await
}

/// Same as `run_job`, but the URL-building step is an injected function
/// rather than the hardcoded `https://huggingface.co/...` builder — the same
/// "take the thing that talks to the network as a seam" discipline
/// `download::run` already established (it takes a pre-built `Url` rather
/// than building one itself, for exactly this reason). Lets tests point
/// every shard at a local mock server.
async fn run_job_with(
    job: &JobSpec,
    ctl: DownloadControls,
    on_event: ShardEventFn,
    resolve_url: impl Fn(&str, &str) -> Result<Url, DownloadError>,
) -> Result<(), DownloadError> {
    tokio::fs::create_dir_all(&job.destination_dir).await?;

    let required: u64 = job
        .shards
        .iter()
        .map(|s| s.expected_bytes.saturating_sub(s.received_bytes))
        .sum();
    let dest_dir = job.destination_dir.clone();
    disk_space::check(
        move || disk_space::available_space(Path::new(&dest_dir)),
        required,
    )?;

    for shard in &job.shards {
        on_event(ShardEvent::State {
            filename: shard.filename.clone(),
            state: "downloading",
        });

        let url = resolve_url(&job.model_id, &shard.filename)?;
        let progress_filename = shard.filename.clone();
        let progress_events = on_event.clone();
        let progress_fn: super::ProgressFn = Arc::new(move |received, _total| {
            progress_events(ShardEvent::Progress {
                filename: progress_filename.clone(),
                received,
            });
        });

        let existing_complete = tokio::fs::metadata(&shard.path)
            .await
            .is_ok_and(|metadata| {
                shard.expected_bytes == 0 || metadata.len() == shard.expected_bytes
            });
        if !existing_complete {
            run(
                url,
                shard.filename.clone(),
                shard.path.clone(),
                job.token.clone(),
                progress_fn,
                ctl.clone(),
            )
            .await?;
        } else {
            on_event(ShardEvent::Progress {
                filename: shard.filename.clone(),
                received: shard.expected_bytes,
            });
        }

        if let Some(expected_sha256) = &shard.sha256 {
            on_event(ShardEvent::State {
                filename: shard.filename.clone(),
                state: "verifying",
            });
            let verification = tokio::select! {
                biased;
                _ = ctl.cancel.cancelled() => Err(DownloadError::Cancelled { filename: shard.filename.clone() }),
                _ = ctl.pause.cancelled() => Err(DownloadError::Paused { filename: shard.filename.clone() }),
                result = verify::verify_sha256(Path::new(&shard.path), &shard.filename, expected_sha256) => result,
            };
            if let Err(e) = verification {
                // Corrupt bytes, not an incomplete transfer — the finished
                // file is not trustworthy and isn't left around to be
                // mistaken for a real, usable model.
                if matches!(
                    e,
                    DownloadError::VerificationFailed { .. } | DownloadError::Cancelled { .. }
                ) {
                    tokio::fs::remove_file(&shard.path).await.ok();
                }
                return Err(e);
            }
        }

        on_event(ShardEvent::State {
            filename: shard.filename.clone(),
            state: "ready",
        });
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;
    use tempfile::tempdir;
    use wiremock::matchers::{method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    fn recording_events() -> (ShardEventFn, Arc<Mutex<Vec<String>>>) {
        let log: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
        let recorded = log.clone();
        let f: ShardEventFn = Arc::new(move |ev| {
            let line = match ev {
                ShardEvent::State { filename, state } => format!("state:{filename}:{state}"),
                ShardEvent::Progress { filename, received } => {
                    format!("progress:{filename}:{received}")
                }
            };
            recorded.lock().unwrap().push(line);
        });
        (f, log)
    }

    #[tokio::test]
    async fn processes_shards_sequentially_and_leaves_completed_files_on_disk() {
        let server = MockServer::start().await;
        let dir = tempdir().unwrap();

        for name in ["a.gguf", "b.gguf"] {
            Mock::given(method("GET"))
                .and(path(format!("/{name}")))
                .respond_with(ResponseTemplate::new(200).set_body_bytes("hello"))
                .mount(&server)
                .await;
        }

        let job = JobSpec {
            model_id: "org/model".to_string(),
            token: None,
            destination_dir: dir.path().to_string_lossy().to_string(),
            shards: vec![
                ShardSpec {
                    filename: "a.gguf".to_string(),
                    path: dir.path().join("a.gguf").to_string_lossy().to_string(),
                    expected_bytes: 5,
                    received_bytes: 0,
                    sha256: None,
                },
                ShardSpec {
                    filename: "b.gguf".to_string(),
                    path: dir.path().join("b.gguf").to_string_lossy().to_string(),
                    expected_bytes: 5,
                    received_bytes: 0,
                    sha256: None,
                },
            ],
        };

        let (on_event, log) = recording_events();
        let server_uri = server.uri();
        run_job_with(
            &job,
            DownloadControls::default(),
            on_event,
            move |_model, filename| {
                Url::parse(&format!("{server_uri}/{filename}"))
                    .map_err(|e| DownloadError::Raw(e.to_string()))
            },
        )
        .await
        .expect("job should succeed");

        assert!(dir.path().join("a.gguf").exists());
        assert!(dir.path().join("b.gguf").exists());

        let events = log.lock().unwrap().clone();
        let a_ready = events
            .iter()
            .position(|e| e == "state:a.gguf:ready")
            .unwrap();
        let b_downloading = events
            .iter()
            .position(|e| e == "state:b.gguf:downloading")
            .unwrap();
        assert!(
            a_ready < b_downloading,
            "shard b must not start until shard a finished: {events:?}"
        );
    }

    #[tokio::test]
    async fn stops_at_the_failing_shard_and_keeps_earlier_shards_files() {
        let server = MockServer::start().await;
        let dir = tempdir().unwrap();

        Mock::given(method("GET"))
            .and(path("/a.gguf"))
            .respond_with(ResponseTemplate::new(200).set_body_bytes("hello"))
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/b.gguf"))
            .respond_with(ResponseTemplate::new(404))
            .mount(&server)
            .await;

        let job = JobSpec {
            model_id: "org/model".to_string(),
            token: None,
            destination_dir: dir.path().to_string_lossy().to_string(),
            shards: vec![
                ShardSpec {
                    filename: "a.gguf".to_string(),
                    path: dir.path().join("a.gguf").to_string_lossy().to_string(),
                    expected_bytes: 5,
                    received_bytes: 0,
                    sha256: None,
                },
                ShardSpec {
                    filename: "b.gguf".to_string(),
                    path: dir.path().join("b.gguf").to_string_lossy().to_string(),
                    expected_bytes: 5,
                    received_bytes: 0,
                    sha256: None,
                },
            ],
        };

        let (on_event, _log) = recording_events();
        let server_uri = server.uri();
        let err = run_job_with(
            &job,
            DownloadControls::default(),
            on_event,
            move |_model, filename| {
                Url::parse(&format!("{server_uri}/{filename}"))
                    .map_err(|e| DownloadError::Raw(e.to_string()))
            },
        )
        .await
        .expect_err("job should fail on the second shard");

        assert_eq!(err.kind(), "not_found");
        assert!(
            dir.path().join("a.gguf").exists(),
            "earlier shard's file should survive"
        );
        assert!(!dir.path().join("b.gguf").exists());
    }

    #[tokio::test]
    async fn a_checksum_mismatch_deletes_the_finished_file_and_is_not_resumable() {
        let server = MockServer::start().await;
        let dir = tempdir().unwrap();

        Mock::given(method("GET"))
            .and(path("/a.gguf"))
            .respond_with(ResponseTemplate::new(200).set_body_bytes("hello"))
            .mount(&server)
            .await;

        let job = JobSpec {
            model_id: "org/model".to_string(),
            token: None,
            destination_dir: dir.path().to_string_lossy().to_string(),
            shards: vec![ShardSpec {
                filename: "a.gguf".to_string(),
                path: dir.path().join("a.gguf").to_string_lossy().to_string(),
                expected_bytes: 5,
                received_bytes: 0,
                sha256: Some(
                    "0000000000000000000000000000000000000000000000000000000000000000".to_string(),
                ),
            }],
        };

        let (on_event, _log) = recording_events();
        let server_uri = server.uri();
        let err = run_job_with(
            &job,
            DownloadControls::default(),
            on_event,
            move |_model, filename| {
                Url::parse(&format!("{server_uri}/{filename}"))
                    .map_err(|e| DownloadError::Raw(e.to_string()))
            },
        )
        .await
        .expect_err("checksum mismatch should fail the job");

        assert_eq!(err.kind(), "verification_failed");
        assert!(
            !dir.path().join("a.gguf").exists(),
            "a corrupt result must not be left on disk"
        );
    }

    #[tokio::test]
    async fn refuses_to_start_when_not_enough_disk_space_and_touches_no_network() {
        let server = MockServer::start().await;
        let dir = tempdir().unwrap();

        // No mocks registered — if the job tried to make any request before
        // failing the disk-space check, wiremock would 404 it and the job
        // would fail with `not_found` instead of `disk_space`.
        let job = JobSpec {
            model_id: "org/model".to_string(),
            token: None,
            destination_dir: dir.path().to_string_lossy().to_string(),
            shards: vec![ShardSpec {
                filename: "huge.gguf".to_string(),
                path: dir.path().join("huge.gguf").to_string_lossy().to_string(),
                expected_bytes: u64::MAX / 2,
                received_bytes: 0,
                sha256: None,
            }],
        };

        let (on_event, _log) = recording_events();
        let server_uri = server.uri();
        let err = run_job_with(
            &job,
            DownloadControls::default(),
            on_event,
            move |_model, filename| {
                Url::parse(&format!("{server_uri}/{filename}"))
                    .map_err(|e| DownloadError::Raw(e.to_string()))
            },
        )
        .await
        .expect_err("an absurdly large required size should fail the disk-space check");

        assert_eq!(err.kind(), "disk_space");
    }
}
