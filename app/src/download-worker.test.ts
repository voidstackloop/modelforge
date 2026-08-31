import * as fs from "node:fs";
import * as path from "node:path";
import { app } from "electron";
import { describe, it, expect, beforeEach } from "vitest";
import { handleEvent } from "./download-worker";
import { createJob, getJob, reloadJobs, type DownloadJob } from "./download-jobs-store";
import type { JobEvent } from "./native-downloader";
import { metrics } from "./telemetry";
import { TelemetrySink } from "./telemetry/sink";

// download-worker.ts's telemetry.recordEvent() writes through the module-
// level singleton sink (index.ts), pointed at the same mocked userData
// directory every store module uses (electron-mock.ts). Reading it back
// with our own TelemetrySink instance (same default path, same file)
// exercises the real schema-validate-then-write pipeline end to end,
// exactly like a real download would — no mocking of telemetry itself.
function telemetryLogPath(): string {
    return path.join(app.getPath("userData"), "logs", "telemetry.jsonl");
}

function readTelemetryEvents(): Record<string, unknown>[] {
    return new TelemetrySink({ basePath: telemetryLogPath() }).readAll() as Record<string, unknown>[];
}

const SENSITIVE_MODEL_ID = "some-org/a-very-specific-secret-model-name";
const SENSITIVE_DEST_DIR = "/home/alice/models/secret-project";
const SENSITIVE_FILENAME = "secret-project-weights.gguf";

function makeJob(): DownloadJob {
    return createJob({
        kind: "huggingface",
        modelName: "Test Model",
        publisher: "Test Publisher",
        backend: "llamacpp",
        destinationDir: SENSITIVE_DEST_DIR,
        modelId: SENSITIVE_MODEL_ID,
        shards: [
            { filename: SENSITIVE_FILENAME, path: path.join(SENSITIVE_DEST_DIR, SENSITIVE_FILENAME), expectedBytes: 1000, receivedBytes: 0, state: "queued" },
        ],
    });
}

function jobStateEvent(job: DownloadJob, jobState: string): JobEvent {
    return { jobId: job.id, kind: "job_state", jobState } as JobEvent;
}

beforeEach(() => {
    reloadJobs();
    fs.rmSync(path.dirname(telemetryLogPath()), { recursive: true, force: true });
});

describe("download-worker telemetry", () => {
    it("records download_started (not download_resumed) on the first downloading transition, and increments the started counter", () => {
        const job = makeJob();
        const before = metrics.snapshot().downloadsStartedTotal;

        handleEvent(jobStateEvent(job, "downloading"));

        expect(metrics.snapshot().downloadsStartedTotal).toBe(before + 1);
        const events = readTelemetryEvents();
        const started = events.find((e) => e.eventName === "download_started");
        expect(started).toMatchObject({ correlationId: job.id, shardCount: 1 });
    });

    it("records download_resumed (not another download_started) when transitioning out of paused", () => {
        const job = makeJob();
        handleEvent(jobStateEvent(job, "downloading"));
        handleEvent(jobStateEvent(job, "paused"));
        const startedCountBeforeResume = metrics.snapshot().downloadsStartedTotal;

        handleEvent(jobStateEvent(job, "downloading"));

        expect(metrics.snapshot().downloadsStartedTotal).toBe(startedCountBeforeResume); // not incremented again
        const events = readTelemetryEvents();
        expect(events.filter((e) => e.eventName === "download_started")).toHaveLength(1);
        expect(events.filter((e) => e.eventName === "download_resumed")).toHaveLength(1);
    });

    it("records download_paused on a paused transition", () => {
        const job = makeJob();
        handleEvent(jobStateEvent(job, "downloading"));
        handleEvent(jobStateEvent(job, "paused"));
        const paused = readTelemetryEvents().find((e) => e.eventName === "download_paused");
        expect(paused).toMatchObject({ correlationId: job.id });
    });

    it("samples the first progress tick immediately, then coalesces rapid subsequent ticks", () => {
        const job = makeJob();
        handleEvent(jobStateEvent(job, "downloading"));

        handleEvent({ jobId: job.id, kind: "shard_progress", shardFilename: SENSITIVE_FILENAME, receivedBytes: 100, jobReceivedBytes: 100, totalBytes: 1000, bytesPerSec: 50 } as JobEvent);
        const afterFirst = readTelemetryEvents().filter((e) => e.eventName === "download_progress_sampled");
        expect(afterFirst).toHaveLength(1);
        expect(afterFirst[0]).toMatchObject({ correlationId: job.id, jobReceivedBytes: 100, totalBytes: 1000, bytesPerSecond: 50 });

        // Immediately-following ticks land well inside the 5s sampling
        // window and must not produce a second event.
        handleEvent({ jobId: job.id, kind: "shard_progress", shardFilename: SENSITIVE_FILENAME, receivedBytes: 200, jobReceivedBytes: 200, totalBytes: 1000, bytesPerSec: 60 } as JobEvent);
        expect(readTelemetryEvents().filter((e) => e.eventName === "download_progress_sampled")).toHaveLength(1);
    });

    it("records download_completed with outcome=ready and a non-negative duration on success", () => {
        const job = makeJob();
        handleEvent(jobStateEvent(job, "downloading"));
        handleEvent(jobStateEvent(job, "ready"));

        const completed = readTelemetryEvents().find((e) => e.eventName === "download_completed");
        expect(completed).toMatchObject({ correlationId: job.id, outcome: "ready", retryCount: 0 });
        expect(typeof completed?.durationMs).toBe("number");
        expect(completed?.durationMs as number).toBeGreaterThanOrEqual(0);
    });

    it("records download_completed with outcome=cancelled on a cancelled transition", () => {
        const job = makeJob();
        handleEvent(jobStateEvent(job, "downloading"));
        handleEvent(jobStateEvent(job, "cancelled"));
        expect(readTelemetryEvents().find((e) => e.eventName === "download_completed")).toMatchObject({ outcome: "cancelled" });
    });

    it("records download_checksum_failed and a failed download_completed on a verification_failed job_error, and increments both counters", () => {
        const job = makeJob();
        handleEvent(jobStateEvent(job, "downloading"));
        const beforeChecksumFailures = metrics.snapshot().downloadChecksumFailuresTotal;
        const beforeCompletedFailed = metrics.snapshot().downloadsCompletedTotal.failed;

        handleEvent({ jobId: job.id, kind: "job_error", errorMessage: "Checksum mismatch.", errorKind: "verification_failed", retryable: false } as JobEvent);

        expect(metrics.snapshot().downloadChecksumFailuresTotal).toBe(beforeChecksumFailures + 1);
        expect(metrics.snapshot().downloadsCompletedTotal.failed).toBe(beforeCompletedFailed + 1);
        const events = readTelemetryEvents();
        expect(events.find((e) => e.eventName === "download_checksum_failed")).toMatchObject({ correlationId: job.id });
        expect(events.find((e) => e.eventName === "download_completed")).toMatchObject({ outcome: "failed", errorKind: "verification_failed" });
    });

    it("does not record download_checksum_failed for a non-verification job_error", () => {
        const job = makeJob();
        handleEvent(jobStateEvent(job, "downloading"));
        handleEvent({ jobId: job.id, kind: "job_error", errorMessage: "network blip", errorKind: "network", retryable: true } as JobEvent);
        expect(readTelemetryEvents().find((e) => e.eventName === "download_checksum_failed")).toBeUndefined();
    });

    it("ignores an event for a job id that no longer exists, without throwing", () => {
        expect(() => handleEvent({ jobId: "does-not-exist", kind: "job_state", jobState: "downloading" } as JobEvent)).not.toThrow();
        expect(readTelemetryEvents()).toEqual([]);
    });

    it("never leaks a model id, destination path, or filename into any recorded telemetry event", () => {
        const job = makeJob();
        handleEvent(jobStateEvent(job, "downloading"));
        handleEvent({ jobId: job.id, kind: "shard_progress", shardFilename: SENSITIVE_FILENAME, receivedBytes: 500, jobReceivedBytes: 500, totalBytes: 1000, bytesPerSec: 100 } as JobEvent);
        handleEvent({ jobId: job.id, kind: "job_error", errorMessage: `failed to write ${path.join(SENSITIVE_DEST_DIR, SENSITIVE_FILENAME)}`, errorKind: "disk_space", retryable: false } as JobEvent);

        const rawLog = fs.readFileSync(telemetryLogPath(), "utf-8");
        expect(rawLog).not.toContain(SENSITIVE_MODEL_ID);
        expect(rawLog).not.toContain(SENSITIVE_DEST_DIR);
        expect(rawLog).not.toContain(SENSITIVE_FILENAME);
        // The raw error message (which embedded the path above) must never
        // have been recorded verbatim — only the fixed errorKind enum.
        expect(rawLog).not.toContain("failed to write");
    });

    it("still updates the persisted job state as before, unaffected by telemetry recording", () => {
        const job = makeJob();
        handleEvent(jobStateEvent(job, "downloading"));
        expect(getJob(job.id)?.state).toBe("downloading");
    });
});
