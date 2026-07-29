use crate::download::job::{JobSpec, ShardEvent, ShardEventFn, ShardSpec, run_job};
use crate::download::{DownloadControls, SpeedTracker};
use arc_swap::ArcSwapOption;
use dashmap::{DashMap, mapref::entry::Entry};
use governor::{DefaultDirectRateLimiter, Quota, RateLimiter};
use napi::threadsafe_function::{ThreadsafeFunction, ThreadsafeFunctionCallMode};
use napi_derive::napi;
use std::collections::HashMap;
use std::num::NonZeroU32;
use std::sync::{Arc, Mutex as StdMutex};
use tokio::sync::{OwnedSemaphorePermit, Semaphore};
use tokio_util::sync::CancellationToken;

/// Default number of jobs allowed to run their network I/O simultaneously —
/// independent of the per-job chunk-worker cap of 6. Deliberately small: a
/// handful of multi-GB model downloads competing for the same link doesn't
/// help any of them finish sooner.
const DEFAULT_GLOBAL_CONCURRENCY: usize = 2;

struct JobHandle {
    cancel: CancellationToken,
    pause: CancellationToken,
}

struct ResizableSemaphoreState {
    limit: usize,
    pending_shrink: usize,
}

struct ResizableSemaphore {
    semaphore: Arc<Semaphore>,
    state: StdMutex<ResizableSemaphoreState>,
}

struct ResizablePermit {
    permit: Option<OwnedSemaphorePermit>,
    owner: Arc<ResizableSemaphore>,
}

impl ResizableSemaphore {
    fn new(limit: usize) -> Arc<Self> {
        Arc::new(Self {
            semaphore: Arc::new(Semaphore::new(limit.max(1))),
            state: StdMutex::new(ResizableSemaphoreState {
                limit: limit.max(1),
                pending_shrink: 0,
            }),
        })
    }

    fn set_limit(&self, requested: usize) {
        let limit = requested.max(1);
        let mut state = self.state.lock().unwrap();
        if limit > state.limit {
            let mut increase = limit - state.limit;
            let cancelled_shrink = increase.min(state.pending_shrink);
            state.pending_shrink -= cancelled_shrink;
            increase -= cancelled_shrink;
            if increase > 0 {
                self.semaphore.add_permits(increase);
            }
        } else if limit < state.limit {
            let decrease = state.limit - limit;
            let removed = self.semaphore.forget_permits(decrease);
            state.pending_shrink += decrease - removed;
        }
        state.limit = limit;
    }

    async fn acquire(self: &Arc<Self>) -> Result<ResizablePermit, tokio::sync::AcquireError> {
        let permit = self.semaphore.clone().acquire_owned().await?;
        Ok(ResizablePermit {
            permit: Some(permit),
            owner: self.clone(),
        })
    }
}

impl Drop for ResizablePermit {
    fn drop(&mut self) {
        let Some(permit) = self.permit.take() else {
            return;
        };
        let mut state = self.owner.state.lock().unwrap();
        if state.pending_shrink > 0 {
            state.pending_shrink -= 1;
            permit.forget();
        }
    }
}

#[napi(object)]
pub struct JsShard {
    pub filename: String,
    pub path: String,
    pub expected_bytes: f64,
    pub received_bytes: f64,
    pub sha256: Option<String>,
}

#[napi(object)]
pub struct JsDownloadJob {
    pub id: String,
    pub model_id: String,
    pub token: Option<String>,
    pub destination_dir: String,
    pub shards: Vec<JsShard>,
}

#[napi(object)]
pub struct JobEvent {
    pub job_id: String,
    /// "shard_progress" | "shard_state" | "job_state" | "job_error"
    pub kind: String,
    pub shard_filename: Option<String>,
    /// Mirrors `DownloadShard.state` in download-jobs-store.ts.
    pub shard_state: Option<String>,
    /// Mirrors `DownloadJobState`.
    pub job_state: Option<String>,
    pub received_bytes: Option<f64>,
    pub job_received_bytes: Option<f64>,
    pub total_bytes: Option<f64>,
    pub bytes_per_sec: Option<f64>,
    pub eta_seconds: Option<f64>,
    pub error_message: Option<String>,
    /// Mirrors `DownloadErrorKind`.
    pub error_kind: Option<String>,
    pub retryable: Option<bool>,
}

impl JobEvent {
    fn shard_state(job_id: &str, filename: &str, state: &str) -> Self {
        Self {
            job_id: job_id.to_string(),
            kind: "shard_state".to_string(),
            shard_filename: Some(filename.to_string()),
            shard_state: Some(state.to_string()),
            job_state: None,
            received_bytes: None,
            job_received_bytes: None,
            total_bytes: None,
            bytes_per_sec: None,
            eta_seconds: None,
            error_message: None,
            error_kind: None,
            retryable: None,
        }
    }

    fn job_state(job_id: &str, state: &str) -> Self {
        Self {
            job_id: job_id.to_string(),
            kind: "job_state".to_string(),
            shard_filename: None,
            shard_state: None,
            job_state: Some(state.to_string()),
            received_bytes: None,
            job_received_bytes: None,
            total_bytes: None,
            bytes_per_sec: None,
            eta_seconds: None,
            error_message: None,
            error_kind: None,
            retryable: None,
        }
    }

    fn job_error(job_id: &str, message: String, kind: &str, retryable: bool) -> Self {
        Self {
            job_id: job_id.to_string(),
            kind: "job_error".to_string(),
            shard_filename: None,
            shard_state: None,
            job_state: Some("failed".to_string()),
            received_bytes: None,
            job_received_bytes: None,
            total_bytes: None,
            bytes_per_sec: None,
            eta_seconds: None,
            error_message: Some(message),
            error_kind: Some(kind.to_string()),
            retryable: Some(retryable),
        }
    }
}

/// Stateful engine for running one or more `DownloadJob`s to completion.
/// Instantiated once (from the JS side, at module load) and held for the
/// app's lifetime — its concurrency semaphore and bandwidth limiter are only
/// meaningfully "global" if there's exactly one instance. `app/src/download-
/// jobs-store.ts` remains the single source of truth for persisted job
/// state; this class doesn't persist anything itself — it drives one job's
/// network I/O and reports progress/terminal state back through `on_event`
/// for the JS caller to persist.
#[napi]
pub struct DownloadManager {
    jobs: Arc<DashMap<String, JobHandle>>,
    job_semaphore: Arc<ResizableSemaphore>,
    bandwidth_limiter: Arc<ArcSwapOption<DefaultDirectRateLimiter>>,
}

#[napi]
impl DownloadManager {
    #[napi(constructor)]
    pub fn new() -> Self {
        // Non-panicking: a second `DownloadManager` (shouldn't happen given
        // the one-instance-for-app-lifetime contract above, but tests may
        // construct more than one) must not crash the process.
        let _ = tracing_subscriber::fmt().try_init();

        Self {
            jobs: Arc::new(DashMap::new()),
            job_semaphore: ResizableSemaphore::new(DEFAULT_GLOBAL_CONCURRENCY),
            bandwidth_limiter: Arc::new(ArcSwapOption::from(None)),
        }
    }

    #[napi]
    pub fn set_global_concurrency(&self, limit: u32) {
        self.job_semaphore.set_limit(limit.max(1) as usize);
    }

    #[napi]
    pub fn set_bandwidth_limit(&self, bytes_per_sec: Option<f64>) {
        match bytes_per_sec {
            None => self.bandwidth_limiter.store(None),
            Some(n) => {
                let n = NonZeroU32::new(n.max(1.0) as u32).unwrap_or(NonZeroU32::MIN);
                self.bandwidth_limiter
                    .store(Some(Arc::new(RateLimiter::direct(Quota::per_second(n)))));
            }
        }
    }

    #[napi]
    pub fn pause_job(&self, job_id: String) {
        if let Some(handle) = self.jobs.get(&job_id) {
            handle.pause.cancel();
        }
    }

    #[napi]
    pub fn cancel_job(&self, job_id: String) {
        if let Some(handle) = self.jobs.get(&job_id) {
            handle.cancel.cancel();
        }
    }

    /// Drives `job`'s shards to completion, resolving once the job reaches a
    /// terminal state (ready/failed/cancelled/paused) — terminal state is
    /// reported both as the resolved/rejected promise *and* as a final
    /// `job_state` event through `on_event`, so callers that only watch
    /// events (rather than awaiting the promise) still see it.
    ///
    /// There's no separate `resume_job`: to resume a paused or failed job,
    /// callers just call `start_job` again with the same job id — `download
    /// ::run` already resumes from whatever `.part`/`.part.json` exists on
    /// disk for each shard.
    #[napi]
    pub async fn start_job(
        &self,
        job: JsDownloadJob,
        on_event: ThreadsafeFunction<JobEvent>,
    ) -> napi::Result<()> {
        let cancel = CancellationToken::new();
        let pause = CancellationToken::new();
        match self.jobs.entry(job.id.clone()) {
            Entry::Occupied(_) => {
                return Err(napi::Error::from_reason(format!(
                    "job \"{}\" is already running",
                    job.id
                )));
            }
            Entry::Vacant(entry) => {
                entry.insert(JobHandle {
                    cancel: cancel.clone(),
                    pause: pause.clone(),
                });
            }
        }

        let permit = tokio::select! {
            biased;
            _ = cancel.cancelled() => {
                self.jobs.remove(&job.id);
                on_event.call(Ok(JobEvent::job_state(&job.id, "cancelled")), ThreadsafeFunctionCallMode::Blocking);
                return Ok(());
            }
            _ = pause.cancelled() => {
                self.jobs.remove(&job.id);
                on_event.call(Ok(JobEvent::job_state(&job.id, "paused")), ThreadsafeFunctionCallMode::Blocking);
                return Ok(());
            }
            permit = self.job_semaphore.acquire() => permit,
        };
        let Ok(_permit) = permit else {
            self.jobs.remove(&job.id);
            return Err(napi::Error::from_reason(
                "download manager is shutting down",
            ));
        };

        let ctl = DownloadControls {
            cancel,
            pause,
            bandwidth_limiter: self.bandwidth_limiter.clone(),
        };

        let job_id = job.id.clone();
        let span = tracing::info_span!("download_job", job_id = %job_id);
        let _enter = span.enter();
        tracing::info!("job starting");

        let on_event = Arc::new(on_event);
        let job_id_for_events = job_id.clone();
        on_event.call(
            Ok(JobEvent::job_state(&job_id_for_events, "downloading")),
            ThreadsafeFunctionCallMode::NonBlocking,
        );

        let spec = to_job_spec(&job);
        let shard_event_fn =
            build_shard_event_fn(job_id_for_events.clone(), &job.shards, on_event.clone());

        let result = run_job(&spec, ctl, shard_event_fn).await;
        self.jobs.remove(&job.id);

        match result {
            Ok(()) => {
                tracing::info!("job finished");
                on_event.call(
                    Ok(JobEvent::job_state(&job_id, "ready")),
                    ThreadsafeFunctionCallMode::Blocking,
                );
                Ok(())
            }
            Err(crate::error::DownloadError::Cancelled { .. }) => {
                tracing::info!("job cancelled");
                on_event.call(
                    Ok(JobEvent::job_state(&job_id, "cancelled")),
                    ThreadsafeFunctionCallMode::Blocking,
                );
                Ok(())
            }
            Err(crate::error::DownloadError::Paused { .. }) => {
                tracing::info!("job paused");
                on_event.call(
                    Ok(JobEvent::job_state(&job_id, "paused")),
                    ThreadsafeFunctionCallMode::Blocking,
                );
                Ok(())
            }
            Err(e) => {
                let kind = e.kind();
                let retryable = e.retryable();
                tracing::warn!(error = %e, kind, retryable, "job failed");
                let message = e.to_string();
                on_event.call(
                    Ok(JobEvent::job_error(
                        &job_id,
                        message.clone(),
                        kind,
                        retryable,
                    )),
                    ThreadsafeFunctionCallMode::Blocking,
                );
                Err(napi::Error::from_reason(message))
            }
        }
    }
}

impl Default for DownloadManager {
    fn default() -> Self {
        Self::new()
    }
}

fn to_job_spec(job: &JsDownloadJob) -> JobSpec {
    JobSpec {
        model_id: job.model_id.clone(),
        token: job.token.clone(),
        destination_dir: job.destination_dir.clone(),
        shards: job
            .shards
            .iter()
            .map(|s| ShardSpec {
                filename: s.filename.clone(),
                path: s.path.clone(),
                expected_bytes: s.expected_bytes as u64,
                received_bytes: s.received_bytes as u64,
                sha256: s.sha256.clone(),
            })
            .collect(),
    }
}

/// Builds the closure `run_job` reports shard-level events through,
/// translating them into job-level `JobEvent`s (rolling per-shard progress
/// up into a job-wide received/total using each shard's known
/// `expectedBytes`, and computing job-level speed/ETA over a short sliding
/// window) and pushing them through the real napi `ThreadsafeFunction`.
fn build_shard_event_fn(
    job_id: String,
    shards: &[JsShard],
    tsfn: Arc<ThreadsafeFunction<JobEvent>>,
) -> ShardEventFn {
    let job_total_bytes = shards.iter().map(|s| s.expected_bytes as u64).sum();
    let shard_progress: Arc<StdMutex<HashMap<String, u64>>> = Arc::new(StdMutex::new(
        shards
            .iter()
            .map(|s| {
                (
                    s.filename.clone(),
                    (s.received_bytes as u64).min(s.expected_bytes as u64),
                )
            })
            .collect(),
    ));
    let speed_tracker = Arc::new(StdMutex::new(SpeedTracker::new()));

    Arc::new(move |event| match event {
        ShardEvent::State { filename, state } => {
            tsfn.call(
                Ok(JobEvent::shard_state(&job_id, &filename, state)),
                ThreadsafeFunctionCallMode::NonBlocking,
            );
        }
        ShardEvent::Progress { filename, received } => {
            let job_received = {
                let mut progress = shard_progress.lock().unwrap();
                progress.insert(filename.clone(), received);
                progress.values().sum()
            };
            let (bytes_per_sec, eta_seconds) = {
                let mut tracker = speed_tracker.lock().unwrap();
                tracker.record(job_received);
                (
                    tracker.bytes_per_sec(),
                    tracker.eta_seconds(Some(job_total_bytes), job_received),
                )
            };
            tsfn.call(
                Ok(JobEvent {
                    job_id: job_id.clone(),
                    kind: "shard_progress".to_string(),
                    shard_filename: Some(filename),
                    shard_state: None,
                    job_state: None,
                    received_bytes: Some(received as f64),
                    job_received_bytes: Some(job_received as f64),
                    total_bytes: Some(job_total_bytes as f64),
                    bytes_per_sec,
                    eta_seconds,
                    error_message: None,
                    error_kind: None,
                    retryable: None,
                }),
                ThreadsafeFunctionCallMode::NonBlocking,
            );
        }
    })
}

#[cfg(test)]
mod concurrency_tests {
    use super::*;

    #[tokio::test]
    async fn increasing_limit_releases_waiters_without_replacing_the_queue() {
        let gate = ResizableSemaphore::new(1);
        let first = gate.acquire().await.unwrap();
        let waiting_gate = gate.clone();
        let waiter = tokio::spawn(async move { waiting_gate.acquire().await.unwrap() });
        tokio::task::yield_now().await;
        assert!(!waiter.is_finished());
        gate.set_limit(2);
        let second = tokio::time::timeout(std::time::Duration::from_millis(100), waiter)
            .await
            .unwrap()
            .unwrap();
        drop(second);
        drop(first);
    }

    #[tokio::test]
    async fn decreasing_limit_is_applied_as_active_permits_return() {
        let gate = ResizableSemaphore::new(2);
        let first = gate.acquire().await.unwrap();
        let second = gate.acquire().await.unwrap();
        gate.set_limit(1);
        drop(first);
        let waiting_gate = gate.clone();
        let waiter = tokio::spawn(async move { waiting_gate.acquire().await.unwrap() });
        tokio::task::yield_now().await;
        assert!(!waiter.is_finished());
        drop(second);
        tokio::time::timeout(std::time::Duration::from_millis(100), waiter)
            .await
            .unwrap()
            .unwrap();
    }
}
