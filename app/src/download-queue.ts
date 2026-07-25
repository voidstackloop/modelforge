import type { BrowserWindow } from "electron";
import { listJobs, updateJob } from "./download-jobs-store";

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
    for (const job of listJobs()) {
        if (job.state === "downloading" || job.state === "resolving") {
            updateJob(job.id, { state: "queued" });
        }
    }
    broadcast();
}
