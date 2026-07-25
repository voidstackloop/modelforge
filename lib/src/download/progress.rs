use std::collections::VecDeque;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

/// Internal progress-reporting seam, deliberately decoupled from
/// `napi::threadsafe_function::ThreadsafeFunction` — that type can only be
/// constructed from a live JS environment, which makes the download logic
/// untestable from plain `cargo test`. `lib.rs` adapts the real
/// `ThreadsafeFunction` into one of these at the napi boundary; tests supply
/// a plain closure instead.
pub type ProgressFn = Arc<dyn Fn(u64, Option<u64>) + Send + Sync>;

/// How often the background ticker checks the counter and (if it moved)
/// pushes an update through the progress callback. Chosen to be frequent
/// enough to feel live in the UI without turning every chunk write into an
/// IPC call — a parallel chunked download can produce thousands of chunk
/// writes/sec, far more than any progress bar needs to redraw.
pub const TICK_INTERVAL: Duration = Duration::from_millis(100);

pub fn emit(tsfn: &ProgressFn, received: u64, total: Option<u64>) {
    tsfn(received, total);
}

/// Spawns a task that polls `received` on a fixed interval and emits through
/// `tsfn` whenever it changed since the last tick. Callers should abort the
/// returned handle once the download settles, then call `emit` once more
/// directly with the definitive final numbers so the last event reflects
/// reality exactly (a skipped in-flight tick is fine; the final state is not
/// allowed to be).
pub fn spawn_ticker(
    tsfn: ProgressFn,
    received: Arc<AtomicU64>,
    total: Option<u64>,
) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        let mut last = u64::MAX;
        let mut ticker = tokio::time::interval(TICK_INTERVAL);
        loop {
            ticker.tick().await;
            let now = received.load(Ordering::Relaxed);
            if now != last {
                last = now;
                emit(&tsfn, now, total);
            }
        }
    })
}

/// Job-level (not per-shard) bytes/sec + ETA, computed over a short sliding
/// window rather than the whole job's lifetime — reacts to a live
/// bandwidth-limit change or a network slowdown within a couple of seconds
/// instead of being dragged down by the job's entire history.
pub struct SpeedTracker {
    // (timestamp, cumulative received bytes) samples, oldest first.
    samples: VecDeque<(Instant, u64)>,
}

/// Number of samples kept — at the 100ms tick cadence `spawn_ticker` already
/// uses, 20 samples is a ~2s smoothing window: long enough to absorb
/// chunk-boundary burstiness, short enough to stay responsive.
const WINDOW_SAMPLES: usize = 20;

impl SpeedTracker {
    pub fn new() -> Self {
        Self {
            samples: VecDeque::with_capacity(WINDOW_SAMPLES),
        }
    }

    pub fn record(&mut self, received: u64) {
        if self.samples.len() == WINDOW_SAMPLES {
            self.samples.pop_front();
        }
        self.samples.push_back((Instant::now(), received));
    }

    /// `None` until at least two samples spanning nonzero time exist —
    /// honest "no rate yet" rather than a fabricated number.
    pub fn bytes_per_sec(&self) -> Option<f64> {
        let (first_t, first_b) = *self.samples.front()?;
        let (last_t, last_b) = *self.samples.back()?;
        let elapsed = last_t.duration_since(first_t).as_secs_f64();
        if elapsed <= 0.0 || last_b < first_b {
            return None;
        }
        Some((last_b - first_b) as f64 / elapsed)
    }

    pub fn eta_seconds(&self, total: Option<u64>, received: u64) -> Option<f64> {
        let total = total?;
        let rate = self.bytes_per_sec()?;
        if rate <= 0.0 || received >= total {
            return None;
        }
        Some((total - received) as f64 / rate)
    }
}

impl Default for SpeedTracker {
    fn default() -> Self {
        Self::new()
    }
}
