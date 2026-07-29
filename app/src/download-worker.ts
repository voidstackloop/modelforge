import * as accounts from "./accounts";
import * as downloadQueue from "./download-queue";
import { getJob, listJobs, updateJob, type DownloadErrorKind, type DownloadJob, type DownloadShard } from "./download-jobs-store";
import { logger } from "./logger";
import { getDownloadManager, type JobEvent, type JsDownloadJob } from "./native-downloader";

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

function handleEvent(event: JobEvent): void {
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
            }
            break;
        case "job_state":
            if (event.jobState) {
                const state = event.jobState as DownloadJob["state"];
                const shards = state === "ready"
                    ? job.shards.map((shard) => ({ ...shard, state, verificationState: shard.sha256 ? "verified" as const : "unavailable" as const }))
                    : job.shards;
                updateJob(job.id, { state, shards, nextRetryAt: undefined, bytesPerSecond: undefined, etaSeconds: undefined });
            }
            break;
        case "job_error":
            updateJob(job.id, {
                state: "failed",
                nextRetryAt: undefined,
                retryHistory: [...job.retryHistory, {
                    attempt: job.retryCount + 1,
                    at: new Date().toISOString(),
                    errorKind: (event.errorKind ?? "unknown") as DownloadErrorKind,
                    message: event.errorMessage ?? "Download failed.",
                }],
                error: {
                    message: event.errorMessage ?? "Download failed.",
                    kind: (event.errorKind ?? "unknown") as DownloadErrorKind,
                    retryable: event.retryable ?? false,
                },
            });
            break;
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
