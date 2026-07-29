import type { BrowserWindow } from "electron";
import * as fs from "node:fs";
import * as path from "node:path";
import * as downloadWorker from "./download-worker";
import { createJob, deleteJob, flushJobs, getJob, listJobs, updateJob, type DownloadJob } from "./download-jobs-store";
import { getDownloadManager } from "./native-downloader";
import { detectModelFormat, getSpecs, resolveAutomaticRuntime } from "./system-specs";

export interface DownloadControls { concurrency: number; bandwidthMbps: number }
export interface RecoveryStatus { recoveredJobs: number; recoveredAt: string | null }
export interface DiskForecast { requiredBytes: number; availableBytes: number | null; enough: boolean | null; reserveBytes: number; destination: string }

const FORECAST_TTL_MS = 30_000;
const DISK_RESERVE_BYTES = 512 * 1024 ** 2;
const forecastCache = new Map<string, { expiresAt: number; availableBytes: number | null }>();
let recoveryStatus: RecoveryStatus = { recoveredJobs: 0, recoveredAt: null };
let windowGetter: () => BrowserWindow | null = () => null;

export function getJobs(): DownloadJob[] { return listJobs(); }
export function init(getWindow: () => BrowserWindow | null): void { windowGetter = getWindow; }
export function broadcast(): void { windowGetter()?.webContents.send("downloads:update", listJobs()); }
export function flush(): void { flushJobs(); }

export function resumeInterruptedJobs(): void {
    let recoveredJobs = 0;
    for (const job of listJobs()) {
        if (["downloading", "resolving", "verifying", "installing"].includes(job.state)) {
            updateJob(job.id, { state: "queued", recoveredAtStartup: true, bytesPerSecond: undefined, etaSeconds: undefined });
            recoveredJobs++;
        }
    }
    broadcast();
    downloadWorker.wake();
    recoveryStatus = { recoveredJobs, recoveredAt: new Date().toISOString() };
}

export function getRecoveryStatus(): RecoveryStatus { return recoveryStatus; }

export function configure(controls: DownloadControls): DownloadControls {
    const rawConcurrency = Number(controls?.concurrency);
    const concurrency = Number.isFinite(rawConcurrency) ? Math.max(1, Math.min(8, Math.floor(rawConcurrency))) : 2;
    const rawBandwidth = Number(controls?.bandwidthMbps);
    const bandwidthMbps = Number.isFinite(rawBandwidth) ? Math.max(0, Math.min(100_000, rawBandwidth)) : 0;
    const manager = getDownloadManager();
    manager.setGlobalConcurrency(concurrency);
    manager.setBandwidthLimit(bandwidthMbps > 0 ? bandwidthMbps * 1024 * 1024 / 8 : undefined);
    return { concurrency, bandwidthMbps };
}

export async function createHuggingFaceJob(input: { modelId: string; filename: string; expectedBytes: number; destinationDir: string; backend?: "automatic" | DownloadJob["backend"]; sha256?: string }): Promise<DownloadJob> {
    const filename = input.filename.replace(/\\/g, "/").split("/").pop() || input.filename;
    const backend = !input.backend || input.backend === "automatic"
        ? resolveAutomaticRuntime(detectModelFormat(input.filename) === "unknown" ? detectModelFormat(input.modelId) : detectModelFormat(input.filename), await getSpecs())
        : input.backend;
    const job = createJob({
        kind: "huggingface", modelName: input.modelId.split("/").pop() || input.modelId,
        publisher: input.modelId.split("/")[0] || "Hugging Face", backend,
        destinationDir: input.destinationDir, modelId: input.modelId,
        quantization: filename.match(/(Q\d(?:_[A-Z0-9]+)*)/i)?.[1],
        shards: [{ filename: input.filename, path: path.join(input.destinationDir, filename), expectedBytes: Math.max(0, input.expectedBytes), receivedBytes: 0, sha256: input.sha256, state: "queued", verificationState: input.sha256 ? "pending" : "unavailable" }],
    });
    forecastCache.delete(path.resolve(input.destinationDir));
    broadcast(); downloadWorker.wake(); return job;
}

export function pauseJob(id: string): void {
    const job = getJob(id); if (!job || !["queued", "resolving", "downloading"].includes(job.state)) return;
    downloadWorker.pause(id); updateJob(id, { state: "paused", etaSeconds: undefined, bytesPerSecond: undefined, nextRetryAt: undefined }); broadcast();
}
export function resumeJob(id: string): void {
    const job = getJob(id); if (!job || !["paused", "failed", "cancelled"].includes(job.state)) return;
    downloadWorker.clearRetryTimer(id); updateJob(id, { state: "queued", error: undefined, nextRetryAt: undefined, recoveredAtStartup: false }); broadcast(); downloadWorker.wake();
}
export function retryJob(id: string): void { resumeJob(id); }
export function retryNow(id: string): void { resumeJob(id); }
export function cancelPendingRetry(id: string): void { downloadWorker.cancelPendingRetry(id); broadcast(); }
export function cancelJob(id: string): void {
    const job = getJob(id); if (!job || ["ready", "cancelled"].includes(job.state)) return;
    downloadWorker.cancel(id); updateJob(id, { state: "cancelled", etaSeconds: undefined, bytesPerSecond: undefined, nextRetryAt: undefined }); broadcast();
}
export function pauseAll(): void {
    for (const job of listJobs()) if (["queued", "resolving", "downloading"].includes(job.state)) {
        downloadWorker.pause(job.id); updateJob(job.id, { state: "paused", etaSeconds: undefined, bytesPerSecond: undefined, nextRetryAt: undefined });
    }
    broadcast();
}
export function resumeAll(): void {
    let changed = false;
    for (const job of listJobs()) if (job.state === "paused") {
        downloadWorker.clearRetryTimer(job.id); updateJob(job.id, { state: "queued", error: undefined, nextRetryAt: undefined, recoveredAtStartup: false }); changed = true;
    }
    if (changed) { broadcast(); downloadWorker.wake(); }
}

function isInside(root: string, candidate: string): boolean {
    const resolvedRoot = path.resolve(root);
    const resolvedCandidate = path.resolve(candidate);
    const relative = path.relative(resolvedRoot, resolvedCandidate);
    return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function resolvedWithoutSymlinkEscape(candidate: string): string {
    const resolved = path.resolve(candidate);
    if (fs.existsSync(resolved)) return fs.realpathSync(resolved);
    const parent = path.dirname(resolved);
    return path.join(fs.existsSync(parent) ? fs.realpathSync(parent) : parent, path.basename(resolved));
}

function validatedShardPaths(job: DownloadJob, approvedRoot: string): string[] {
    const trustedRoot = resolvedWithoutSymlinkEscape(approvedRoot);
    const trustedDestination = resolvedWithoutSymlinkEscape(job.destinationDir);
    if (!isInside(trustedRoot, trustedDestination)) throw new Error("Download destination is outside the approved models directory.");
    const paths: string[] = [];
    for (const shard of job.shards) {
        const trustedPath = resolvedWithoutSymlinkEscape(shard.path);
        if (!isInside(trustedDestination, trustedPath) || !isInside(trustedRoot, trustedPath)) throw new Error(`Unsafe download path recorded for ${shard.filename}.`);
        paths.push(trustedPath);
    }
    return paths;
}

export function describeDeletion(id: string, approvedRoot: string): { partialFiles: string[]; completedFiles: string[] } {
    const job = getJob(id); if (!job) throw new Error("Download job not found");
    const shardPaths = validatedShardPaths(job, approvedRoot);
    return {
        partialFiles: shardPaths.flatMap((file) => [`${file}.part`, `${file}.part.json`]).filter(fs.existsSync),
        completedFiles: shardPaths.filter(fs.existsSync),
    };
}

export function modelPath(id: string, approvedRoot: string): string {
    const job = getJob(id); if (!job) throw new Error("Download job not found");
    return validatedShardPaths(job, approvedRoot)[0];
}

export function removeRecord(id: string): void {
    const job = getJob(id); if (!job) return;
    if (!["ready", "failed", "cancelled", "paused"].includes(job.state)) throw new Error("Pause or cancel the transfer before removing its history record.");
    downloadWorker.cancelPendingRetry(id); deleteJob(id); broadcast();
}

export async function removePartialData(id: string, approvedRoot: string): Promise<void> {
    const job = getJob(id); if (!job) return;
    if (!["paused", "failed", "cancelled"].includes(job.state)) throw new Error("Partial files can only be removed from a paused, failed, or cancelled job.");
    const { partialFiles } = describeDeletion(id, approvedRoot);
    await downloadWorker.cancelAndWait(id);
    for (const file of partialFiles) fs.rmSync(file, { force: true });
    updateJob(id, { shards: job.shards.map((shard) => ({ ...shard, receivedBytes: 0, state: "cancelled" })), state: "cancelled", jobReceivedBytes: 0, bytesPerSecond: undefined, etaSeconds: undefined });
    forecastCache.delete(path.resolve(job.destinationDir)); broadcast();
}

export function removeCompletedModel(id: string, approvedRoot: string): void {
    const job = getJob(id); if (!job) return;
    if (job.state !== "ready") throw new Error("Only a completed model can be removed with this action.");
    const { completedFiles } = describeDeletion(id, approvedRoot);
    for (const file of completedFiles) fs.rmSync(file, { force: true });
    deleteJob(id); forecastCache.delete(path.resolve(job.destinationDir)); broadcast();
}

function availableFor(destination: string): number | null {
    const key = path.resolve(destination); const cached = forecastCache.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached.availableBytes;
    let availableBytes: number | null = null;
    try { const stats = fs.statfsSync(key); availableBytes = stats.bavail * stats.bsize; } catch { /* unknown filesystem */ }
    forecastCache.set(key, { availableBytes, expiresAt: Date.now() + FORECAST_TTL_MS });
    return availableBytes;
}

function forecastFor(jobs: DownloadJob[], destination: string): DiskForecast {
    const requiredBytes = jobs.reduce((sum, job) => sum + job.shards.reduce((shardSum, shard) => shardSum + Math.max(0, shard.expectedBytes - shard.receivedBytes), 0), 0);
    const availableBytes = availableFor(destination);
    const reservedRequired = requiredBytes + DISK_RESERVE_BYTES;
    return { requiredBytes, availableBytes, enough: availableBytes === null ? null : availableBytes >= reservedRequired, reserveBytes: DISK_RESERVE_BYTES, destination };
}

export function diskForecast(id: string): DiskForecast {
    const job = getJob(id); if (!job) throw new Error("Download job not found");
    return forecastFor([job], job.destinationDir);
}

export function aggregateDiskForecast(): DiskForecast[] {
    const groups = new Map<string, DownloadJob[]>();
    for (const job of listJobs().filter((item) => !["ready", "cancelled"].includes(item.state))) {
        const key = path.resolve(job.destinationDir); groups.set(key, [...(groups.get(key) ?? []), job]);
    }
    return [...groups].map(([destination, groupedJobs]) => forecastFor(groupedJobs, destination));
}
