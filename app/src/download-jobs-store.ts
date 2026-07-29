import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { app } from "electron";
import { readJson, writeJson } from "./json-store";

export type DownloadJobState =
    | "queued"
    | "resolving"
    | "downloading"
    | "paused"
    | "verifying"
    | "installing"
    | "ready"
    | "failed"
    | "cancelled";

export type DownloadErrorKind =
    | "auth_required"
    | "license_required"
    | "not_found"
    | "disk_space"
    | "permission"
    | "verification_failed"
    | "network"
    | "unknown";

export type VerificationState = "pending" | "verifying" | "verified" | "unavailable" | "failed";

export interface DownloadJobError {
    message: string;
    kind: DownloadErrorKind;
    retryable: boolean;
}

export interface RetryAttempt {
    attempt: number;
    at: string;
    errorKind: DownloadErrorKind;
    message: string;
}

export interface DownloadShard {
    filename: string;
    path: string;
    expectedBytes: number;
    receivedBytes: number;
    sha256?: string;
    etag?: string;
    state: DownloadJobState;
    verificationState?: VerificationState;
}

export interface DownloadJob {
    id: string;
    kind: "huggingface" | "ollama";
    modelName: string;
    publisher: string;
    quantization?: string;
    backend: "llamacpp" | "mlx" | "vllm" | "ollama" | "transformers";
    destinationDir: string;
    modelId: string;
    shards: DownloadShard[];
    state: DownloadJobState;
    error?: DownloadJobError;
    retryCount: number;
    maxAttempts: number;
    nextRetryAt?: string;
    retryHistory: RetryAttempt[];
    jobReceivedBytes?: number;
    totalBytes?: number;
    bytesPerSecond?: number;
    etaSeconds?: number;
    recoveredAtStartup?: boolean;
    createdAt: string;
    updatedAt: string;
}

const PROGRESS_PERSIST_DELAY_MS = 1_000;
let jobs: DownloadJob[] | null = null;
let progressFlushTimer: NodeJS.Timeout | null = null;

function filePath(): string {
    return path.join(app.getPath("userData"), "download-jobs.json");
}

function normalizeJob(job: DownloadJob): DownloadJob {
    return {
        ...job,
        maxAttempts: job.maxAttempts ?? 4,
        retryHistory: job.retryHistory ?? [],
        shards: job.shards.map((shard) => ({
            ...shard,
            verificationState: shard.verificationState ?? (shard.sha256 ? "pending" : "unavailable"),
        })),
    };
}

function currentJobs(): DownloadJob[] {
    if (!jobs) jobs = readJson<DownloadJob[]>(filePath(), []).map(normalizeJob);
    return jobs;
}

function persistNow(): void {
    if (progressFlushTimer) clearTimeout(progressFlushTimer);
    progressFlushTimer = null;
    writeJson(filePath(), currentJobs());
}

function scheduleProgressPersist(): void {
    if (progressFlushTimer) return;
    progressFlushTimer = setTimeout(persistNow, PROGRESS_PERSIST_DELAY_MS);
    progressFlushTimer.unref();
}

export function flushJobs(): void {
    if (jobs && progressFlushTimer) persistNow();
}

export function listJobs(): DownloadJob[] {
    return currentJobs();
}

export function getJob(id: string): DownloadJob | null {
    return currentJobs().find((job) => job.id === id) ?? null;
}

export function createJob(
    partial: Pick<DownloadJob, "kind" | "modelName" | "publisher" | "backend" | "destinationDir" | "modelId" | "shards"> &
        Partial<Pick<DownloadJob, "quantization" | "maxAttempts">>
): DownloadJob {
    const now = new Date().toISOString();
    const job: DownloadJob = normalizeJob({
        id: randomUUID(),
        state: "queued",
        retryCount: 0,
        maxAttempts: partial.maxAttempts ?? 4,
        retryHistory: [],
        createdAt: now,
        updatedAt: now,
        ...partial,
    });
    currentJobs().push(job);
    persistNow();
    return job;
}

type DownloadJobPatch = Partial<Pick<DownloadJob,
    "state" | "error" | "retryCount" | "maxAttempts" | "nextRetryAt" | "retryHistory" | "shards" |
    "jobReceivedBytes" | "totalBytes" | "bytesPerSecond" | "etaSeconds" | "recoveredAtStartup"
>>;

export function updateJob(id: string, partial: DownloadJobPatch, persistence: "immediate" | "progress" = "immediate"): DownloadJob | null {
    const all = currentJobs();
    const index = all.findIndex((job) => job.id === id);
    if (index === -1) return null;
    all[index] = normalizeJob({ ...all[index], ...partial, updatedAt: new Date().toISOString() });
    if (persistence === "progress") scheduleProgressPersist();
    else persistNow();
    return all[index];
}

export function deleteJob(id: string): void {
    jobs = currentJobs().filter((job) => job.id !== id);
    persistNow();
}

/** Test/support seam used when a different user-data directory is activated. */
export function reloadJobs(): void {
    if (progressFlushTimer) clearTimeout(progressFlushTimer);
    progressFlushTimer = null;
    jobs = null;
}
