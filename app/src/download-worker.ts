import * as accounts from "./accounts";
import * as downloadQueue from "./download-queue";
import { getJob, listJobs, updateJob, type DownloadErrorKind, type DownloadJob, type DownloadShard } from "./download-jobs-store";
import { logger } from "./logger";
import { getDownloadManager, getNativeDownloaderCapabilityReport, type JobEvent, type JsDownloadJob } from "./native-downloader";
import * as telemetry from "./telemetry";

const MAX_AUTO_RETRIES = 3;
const MAX_BACKOFF_MS = 60_000;

// How often raw JobEvents get coalesced into a `downloads:update` broadcast
// — matches the ~100ms cadence the Rust side's own progress ticker already
// uses, so this never becomes the bottleneck. A job's terminal state always
// broadcasts immediately regardless (see `driveJob`'s `finally`), so the UI
// never has to wait out this throttle to see a job actually finish.
const BROADCAST_THROTTLE_MS = 250;
let lastBroadcastAt = 0;

function throttledBroadcast(): void {
    const now = Date.now();
    if (now - lastBroadcastAt < BROADCAST_THROTTLE_MS) return;
    lastBroadcastAt = now;
    downloadQueue.broadcast();
}

// Job ids currently being driven — guards against `wake()` picking up the
// same "queued" job twice; the real concurrency gate is the Rust manager's
// own semaphore, this is purely a JS-side duplicate-start guard.
const active = new Set<string>();
const retryTimers = new Map<string, NodeJS.Timeout>();

// Telemetry-only bookkeeping, kept separate from the persisted DownloadJob
// (which download-jobs-store.ts owns) since none of this needs to survive a
// restart — a job in flight when the app closes just gets a fresh start
// timestamp and progress-sample clock on the next run.
//
// Sampling cadence for download_progress_sampled — deliberately much coarser
// than BROADCAST_THROTTLE_MS above (that's for UI responsiveness; this is
// for bounded telemetry volume over a download that can run for the better
// part of an hour).
const PROGRESS_SAMPLE_INTERVAL_MS = 5_000;
const jobStartedAtMs = new Map<string, number>();
const lastProgressSampleAtMs = new Map<string, number>();

export function clearRetryTimer(jobId: string): void {
    const timer = retryTimers.get(jobId);
    if (timer) clearTimeout(timer);
    retryTimers.delete(jobId);
}

export function cancelPendingRetry(jobId: string): void {
    clearRetryTimer(jobId);
    const job = getJob(jobId);
    if (job?.nextRetryAt) updateJob(jobId, { nextRetryAt: undefined });
}

function toJsDownloadJob(job: DownloadJob): JsDownloadJob {
    return {
        id: job.id,
        modelId: job.modelId,
        token: accounts.getAccountToken("huggingface") ?? undefined,
        destinationDir: job.destinationDir,
        shards: job.shards.map((s) => ({
            filename: s.filename,
            path: s.path,
            expectedBytes: s.expectedBytes,
            receivedBytes: s.receivedBytes,
            sha256: s.sha256,
        })),
    };
}

function withShardPatch(job: DownloadJob, filename: string, patch: Partial<DownloadShard>): DownloadShard[] {
    return job.shards.map((s) => (s.filename === filename ? { ...s, ...patch } : s));
}

/** Records the job's terminal telemetry event and clears this module's
 * own (non-persisted) bookkeeping for it — shared by the "ready"/"cancelled"
 * job_state branch and the job_error branch below, so both terminal paths
 * report the same duration/outcome shape exactly once. */
function recordCompletion(job: DownloadJob, outcome: telemetry.DownloadOutcome, errorKind?: DownloadErrorKind): void {
    const startedAt = jobStartedAtMs.get(job.id);
    telemetry.recordEvent("download_completed", {
        correlationId: job.id,
        outcome,
        durationMs: startedAt !== undefined ? Date.now() - startedAt : 0,
        totalBytes: job.totalBytes,
        retryCount: job.retryCount,
        errorKind,
    });
    telemetry.metrics.downloadsCompleted.inc(outcome);
    if (job.totalBytes !== undefined) telemetry.metrics.downloadBytesTotal.inc(job.jobReceivedBytes ?? job.totalBytes);
    if (startedAt !== undefined) telemetry.metrics.downloadDurationSeconds.observe((Date.now() - startedAt) / 1000);
    jobStartedAtMs.delete(job.id);
    lastProgressSampleAtMs.delete(job.id);
}

/** Exported for download-worker.test.ts — every real caller still reaches
 * this only through driveJob's event callback above. */
export function handleEvent(event: JobEvent): void {
    const job = getJob(event.jobId);
    if (!job) return; // job was deleted while its download was in flight

    switch (event.kind) {
        case "shard_state":
            if (event.shardFilename && event.shardState) {
                const verificationState = event.shardState === "verifying" ? "verifying" as const : undefined;
                updateJob(job.id, { shards: withShardPatch(job, event.shardFilename, {
                    state: event.shardState as DownloadShard["state"],
                    ...(verificationState ? { verificationState } : {}),
                }) });
            }
            break;
        case "shard_progress":
            if (event.shardFilename && event.receivedBytes !== undefined) {
                updateJob(job.id, {
                    shards: withShardPatch(job, event.shardFilename, { receivedBytes: event.receivedBytes }),
                    jobReceivedBytes: event.jobReceivedBytes,
                    totalBytes: event.totalBytes,
                    bytesPerSecond: event.bytesPerSec,
                    etaSeconds: event.etaSeconds,
                }, "progress");

                const lastSampleAt = lastProgressSampleAtMs.get(job.id) ?? 0;
                if (event.jobReceivedBytes !== undefined && Date.now() - lastSampleAt >= PROGRESS_SAMPLE_INTERVAL_MS) {
                    lastProgressSampleAtMs.set(job.id, Date.now());
                    telemetry.recordEvent("download_progress_sampled", {
                        correlationId: job.id,
                        jobReceivedBytes: event.jobReceivedBytes,
                        totalBytes: event.totalBytes,
                        bytesPerSecond: event.bytesPerSec,
                    });
                }
            }
            break;
        case "job_state":
            if (event.jobState) {
                const state = event.jobState as DownloadJob["state"];
                const shards = state === "ready"
                    ? job.shards.map((shard) => ({ ...shard, state, verificationState: shard.sha256 ? "verified" as const : "unavailable" as const }))
                    : job.shards;
                updateJob(job.id, { state, shards, nextRetryAt: undefined, bytesPerSecond: undefined, etaSeconds: undefined });

                if (state === "downloading") {
                    const resuming = job.state === "paused";
                    if (!jobStartedAtMs.has(job.id)) jobStartedAtMs.set(job.id, Date.now());
                    telemetry.recordEvent(resuming ? "download_resumed" : "download_started", {
                        correlationId: job.id,
                        shardCount: job.shards.length,
                    });
                    if (!resuming) telemetry.metrics.downloadsStarted.inc();
                } else if (state === "paused") {
                    telemetry.recordEvent("download_paused", { correlationId: job.id });
                } else if (state === "ready" || state === "cancelled") {
                    recordCompletion(job, state);
                }
            }
            break;
        case "job_error": {
            const errorKind = (event.errorKind ?? "unknown") as DownloadErrorKind;
            updateJob(job.id, {
                state: "failed",
                nextRetryAt: undefined,
                retryHistory: [...job.retryHistory, {
                    attempt: job.retryCount + 1,
                    at: new Date().toISOString(),
                    errorKind,
                    message: event.errorMessage ?? "Download failed.",
                }],
                error: {
                    message: event.errorMessage ?? "Download failed.",
                    kind: errorKind,
                    retryable: event.retryable ?? false,
                },
            });
            if (errorKind === "verification_failed") {
                telemetry.recordEvent("download_checksum_failed", { correlationId: job.id });
                telemetry.metrics.downloadChecksumFailures.inc();
            }
            recordCompletion(job, "failed", errorKind);
            break;
        }
    }
}

// A `"failed"` job whose error is marked retryable gets a small number of
// automatic requeue attempts with exponential backoff before it's left for
// a manual retry — distinct from the Rust side's own per-chunk retry
// (MAX_ATTEMPTS_PER_CHUNK), which handles much shorter-lived transient
// failures within a single shard transfer.
function maybeAutoRetry(jobId: string): void {
    const job = getJob(jobId);
    if (!job || job.state !== "failed" || !job.error?.retryable || job.retryCount >= MAX_AUTO_RETRIES) return;

    const baseBackoffMs = Math.min(MAX_BACKOFF_MS, 1_000 * 2 ** job.retryCount);
    const jitter = 0.8 + Math.random() * 0.4;
    const backoffMs = Math.round(baseBackoffMs * jitter);
    if (retryTimers.has(jobId)) return;
    const expectedRetryCount = job.retryCount;
    updateJob(jobId, { nextRetryAt: new Date(Date.now() + backoffMs).toISOString() });
    downloadQueue.broadcast();
    const timer = setTimeout(() => {
        retryTimers.delete(jobId);
        const current = getJob(jobId);
        if (!current || current.state !== "failed" || !current.error?.retryable || current.retryCount !== expectedRetryCount) return;
        telemetry.recordEvent("download_retry", {
            correlationId: jobId,
            attempt: expectedRetryCount + 1,
            errorKind: current.error.kind,
        });
        telemetry.metrics.downloadRetries.inc(current.error.kind);
        updateJob(jobId, { state: "queued", retryCount: expectedRetryCount + 1, nextRetryAt: undefined, error: undefined });
        downloadQueue.broadcast();
        wake();
    }, backoffMs);
    timer.unref();
    retryTimers.set(jobId, timer);
}

async function driveJob(job: DownloadJob): Promise<void> {
    active.add(job.id);
    try {
        await getDownloadManager().startJob(toJsDownloadJob(job), (err, event) => {
            if (err) {
                logger.error(`Download job ${job.id}: event callback error: ${err.message}`);
                return;
            }
            handleEvent(event);
            throttledBroadcast();
        });
    } catch (err) {
        // The rejection carries the same message the "job_error" event
        // already recorded via handleEvent — this catch exists only so an
        // unexpected throw here doesn't become an unhandled rejection.
        logger.error(`Download job ${job.id}: ${(err as Error).message}`);
    } finally {
        active.delete(job.id);
        downloadQueue.broadcast();
        maybeAutoRetry(job.id);
    }
}

// Picks up every currently-"queued" Hugging Face job not already being
// driven. Safe to call repeatedly/redundantly — `active` prevents double
// starts. Called once at app-ready and again whenever something might have
// made a "queued" job appear (a fresh `downloads:create`, a manual
// retry/resume, or `download-queue.ts`'s startup requeue).
export function wake(): void {
    for (const job of listJobs()) {
        if (job.state === "queued" && job.kind === "huggingface" && !active.has(job.id)) {
            void driveJob(job);
        }
    }
}

export function start(): void {
    // First (and only — see native-downloader.ts's own doc comment: one
    // instance for the app's lifetime) real caller of this previously-
    // orphaned diagnostic. Records once at startup rather than per-download,
    // since availability doesn't change over a running process's lifetime.
    const capability = getNativeDownloaderCapabilityReport();
    telemetry.recordEvent("native_addon_capability", {
        addon: "downloader",
        available: capability.available,
        reason: capability.reason,
    });
    if (!capability.available) telemetry.metrics.nativeAddonUnavailable.inc();

    wake();
}

export function pause(jobId: string): void {
    clearRetryTimer(jobId);
    getDownloadManager().pauseJob(jobId);
}

export function cancel(jobId: string): void {
    clearRetryTimer(jobId);
    getDownloadManager().cancelJob(jobId);
}

export async function cancelAndWait(jobId: string, timeoutMs = 5_000): Promise<void> {
    cancel(jobId);
    const deadline = Date.now() + timeoutMs;
    while (active.has(jobId) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
    if (active.has(jobId)) throw new Error("The download worker did not stop in time; partial files were kept.");
}
