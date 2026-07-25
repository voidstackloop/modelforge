import type { BrowserWindow } from "electron";
import * as downloadWorker from "./download-worker";
import * as fs from "node:fs";
import { createJob, deleteJob, getJob, listJobs, updateJob, type DownloadJob } from "./download-jobs-store";
import { getDownloadManager } from "./native-downloader";
import { detectModelFormat, getSpecs, resolveAutomaticRuntime } from "./system-specs";

export interface DownloadControls { concurrency: number; bandwidthMbps: number }
export interface RecoveryStatus { recoveredJobs: number; recoveredAt: string | null }
let recoveryStatus: RecoveryStatus = { recoveredJobs: 0, recoveredAt: null };
export function getJobs(): DownloadJob[] { return listJobs(); }

// Deliberately a getWindow() closure, not a captured event.sender from one
// ipcMain.handle invocation — jobs push progress at times disconnected from
// any single IPC call (a download keeps running long after the request that
// started it returned), and the window that started a job may have since
// been closed/reopened (e.g. macOS activate-with-no-windows). Mirrors the
// same pattern menu.ts and updater.ts already use for this exact reason.
let windowGetter: () => BrowserWindow | null = () => null;

export function init(getWindow: () => BrowserWindow | null): void {
    windowGetter = getWindow;
}

// The one broadcast channel in the app that isn't scoped to a requestId —
// every open window gets the full current job list whenever anything
// changes, so the download center reflects live state regardless of which
// page is open or when it mounted.
export function broadcast(): void {
    windowGetter()?.webContents.send("downloads:update", listJobs());
}

// Called once at app startup. A job left in "downloading" or "resolving"
// can only mean the app was killed mid-download last session — not a
// deliberate pause — so it goes back to "queued" for the worker to pick up
// again (the underlying .part file and its recorded progress are untouched;
// resuming is exactly what downloadGgufFile's Range-request logic already
// does for a partial file, whatever caused the interruption).
export function resumeInterruptedJobs(): void {
    let recoveredJobs = 0;
    for (const job of listJobs()) {
        if (["downloading", "resolving", "verifying", "installing"].includes(job.state)) {
            updateJob(job.id, { state: "queued", recoveredAtStartup: true });
            recoveredJobs++;
        }
    }
    broadcast();
    downloadWorker.wake();
    recoveryStatus = { recoveredJobs, recoveredAt: new Date().toISOString() };
}

export function getRecoveryStatus(): RecoveryStatus { return recoveryStatus; }

export function configure(controls: DownloadControls): DownloadControls {
    const concurrency = Math.max(1, Math.min(8, Math.floor(controls.concurrency)));
    const bandwidthMbps = Math.max(0, Number(controls.bandwidthMbps) || 0);
    const manager = getDownloadManager();
    manager.setGlobalConcurrency(concurrency);
    manager.setBandwidthLimit(bandwidthMbps > 0 ? bandwidthMbps * 1024 * 1024 / 8 : undefined);
    return { concurrency, bandwidthMbps };
}

export async function createHuggingFaceJob(input: { modelId: string; filename: string; expectedBytes: number; destinationDir: string; backend?: "automatic" | DownloadJob["backend"] }): Promise<DownloadJob> {
    const filename = input.filename.replace(/\\/g, "/").split("/").pop() || input.filename;
    // "automatic" (the default) resolves the same way the model-recommendation
    // flow does: format inferred from the filename/repo id, matched against
    // this machine's detected hardware.
    const backend = !input.backend || input.backend === "automatic"
        ? resolveAutomaticRuntime(detectModelFormat(input.filename) === "unknown" ? detectModelFormat(input.modelId) : detectModelFormat(input.filename), await getSpecs())
        : input.backend;
    const job = createJob({
        kind: "huggingface", modelName: input.modelId.split("/").pop() || input.modelId,
        publisher: input.modelId.split("/")[0] || "Hugging Face", backend,
        destinationDir: input.destinationDir, modelId: input.modelId,
        quantization: filename.match(/(Q\d(?:_[A-Z0-9]+)*)/i)?.[1],
        shards: [{ filename: input.filename, path: `${input.destinationDir}/${filename}`, expectedBytes: Math.max(0, input.expectedBytes), receivedBytes: 0, state: "queued" }],
    });
    broadcast(); downloadWorker.wake(); return job;
}

export function pauseJob(id: string): void {
    const job = getJob(id); if (!job || !["queued", "resolving", "downloading"].includes(job.state)) return;
    downloadWorker.pause(id); updateJob(id, { state: "paused", etaSeconds: undefined, bytesPerSecond: undefined }); broadcast();
}
export function resumeJob(id: string): void {
    const job = getJob(id); if (!job || !["paused", "failed", "cancelled"].includes(job.state)) return;
    downloadWorker.clearRetryTimer(id); updateJob(id, { state: "queued", error: undefined, recoveredAtStartup: false }); broadcast(); downloadWorker.wake();
}
export function retryJob(id: string): void { resumeJob(id); }
export function cancelJob(id: string): void {
    const job = getJob(id); if (!job || ["ready", "cancelled"].includes(job.state)) return;
    downloadWorker.cancel(id); updateJob(id, { state: "cancelled", etaSeconds: undefined, bytesPerSecond: undefined }); broadcast();
}
export function removeJob(id: string): void {
    const job = getJob(id); if (!job) return;
    downloadWorker.cancel(id);
    for (const shard of job.shards) {
        for (const suffix of [".part", ".part.json"]) { try { fs.rmSync(`${shard.path}${suffix}`, { force: true }); } catch { /* best effort */ } }
    }
    deleteJob(id); broadcast();
}
export function diskForecast(id: string): { requiredBytes: number; availableBytes: number | null; enough: boolean | null } {
    const job = getJob(id); if (!job) throw new Error("Download job not found");
    const requiredBytes = job.shards.reduce((sum, shard) => sum + Math.max(0, shard.expectedBytes - shard.receivedBytes), 0);
    try { const stats = fs.statfsSync(job.destinationDir); const availableBytes = stats.bavail * stats.bsize; return { requiredBytes, availableBytes, enough: availableBytes >= requiredBytes }; }
    catch { return { requiredBytes, availableBytes: null, enough: null }; }
}
