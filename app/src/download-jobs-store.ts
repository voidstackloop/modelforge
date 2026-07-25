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

export interface DownloadJobError {
    message: string;
    kind: DownloadErrorKind;
    retryable: boolean;
}

export interface DownloadShard {
    filename: string;
    path: string;
    expectedBytes: number;
    receivedBytes: number;
    sha256?: string;
    etag?: string;
    state: DownloadJobState;
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
    jobReceivedBytes?: number;
    totalBytes?: number;
    bytesPerSecond?: number;
    etaSeconds?: number;
    recoveredAtStartup?: boolean;
    createdAt: string;
    updatedAt: string;
}

function filePath(): string {
    return path.join(app.getPath("userData"), "download-jobs.json");
}

export function listJobs(): DownloadJob[] {
    return readJson<DownloadJob[]>(filePath(), []);
}

export function getJob(id: string): DownloadJob | null {
    return listJobs().find((j) => j.id === id) ?? null;
}

export function createJob(
    partial: Pick<DownloadJob, "kind" | "modelName" | "publisher" | "backend" | "destinationDir" | "modelId" | "shards"> &
        Partial<Pick<DownloadJob, "quantization">>
): DownloadJob {
    const now = new Date().toISOString();
    const job: DownloadJob = {
        id: randomUUID(),
        state: "queued",
        retryCount: 0,
        createdAt: now,
        updatedAt: now,
        ...partial,
    };
    const all = listJobs();
    all.push(job);
    writeJson(filePath(), all);
    return job;
}

// Callers pass whole replacement `shards` arrays rather than patching one
// shard in place — the queue worker always has the full up-to-date shard
// list in memory already (it's the one mutating it), so round-tripping a
// single shard's delta through this API would just add complexity for no
// benefit.
export function updateJob(
    id: string,
    partial: Partial<Pick<DownloadJob, "state" | "error" | "retryCount" | "shards" | "jobReceivedBytes" | "totalBytes" | "bytesPerSecond" | "etaSeconds" | "recoveredAtStartup">>
): DownloadJob | null {
    const all = listJobs();
    const idx = all.findIndex((j) => j.id === id);
    if (idx === -1) return null;
    all[idx] = { ...all[idx], ...partial, updatedAt: new Date().toISOString() };
    writeJson(filePath(), all);
    return all[idx];
}

export function deleteJob(id: string): void {
    writeJson(filePath(), listJobs().filter((j) => j.id !== id));
}
