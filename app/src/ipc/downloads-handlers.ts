import { ipcMain, shell } from "electron";
import * as settingsStore from "../settings-store";
import * as downloadQueue from "../download-queue";
import { requireString, getLlamaCppModelsDir } from "../app-state";

export function registerDownloadsIpc(): void {
    ipcMain.handle("downloads:list", () => downloadQueue.getJobs());
    ipcMain.handle("downloads:create", (_event, input: { modelId: string; filename: string; expectedBytes: number; backend?: Parameters<typeof downloadQueue.createHuggingFaceJob>[0]["backend"]; sha256?: string }) =>
        downloadQueue.createHuggingFaceJob({
            ...input,
            backend: input.backend ?? settingsStore.getSettings().preferredRuntime ?? "automatic",
            destinationDir: getLlamaCppModelsDir(),
        })
    );
    ipcMain.handle("downloads:pause", (_event, id: string) => downloadQueue.pauseJob(requireString(id, "download id")));
    ipcMain.handle("downloads:resume", (_event, id: string) => downloadQueue.resumeJob(requireString(id, "download id")));
    ipcMain.handle("downloads:retry", (_event, id: string) => downloadQueue.retryJob(requireString(id, "download id")));
    ipcMain.handle("downloads:retryNow", (_event, id: string) => downloadQueue.retryNow(requireString(id, "download id")));
    ipcMain.handle("downloads:cancelRetry", (_event, id: string) => downloadQueue.cancelPendingRetry(requireString(id, "download id")));
    ipcMain.handle("downloads:cancel", (_event, id: string) => downloadQueue.cancelJob(requireString(id, "download id")));
    ipcMain.handle("downloads:pauseAll", () => downloadQueue.pauseAll());
    ipcMain.handle("downloads:resumeAll", () => downloadQueue.resumeAll());
    ipcMain.handle("downloads:describeDeletion", (_event, id: string) => downloadQueue.describeDeletion(requireString(id, "download id"), getLlamaCppModelsDir()));
    ipcMain.handle("downloads:removeRecord", (_event, id: string) => downloadQueue.removeRecord(requireString(id, "download id")));
    ipcMain.handle("downloads:removePartialData", (_event, id: string) => downloadQueue.removePartialData(requireString(id, "download id"), getLlamaCppModelsDir()));
    ipcMain.handle("downloads:removeCompletedModel", (_event, id: string) => downloadQueue.removeCompletedModel(requireString(id, "download id"), getLlamaCppModelsDir()));
    ipcMain.handle("downloads:openFolder", (_event, id: string) => shell.showItemInFolder(downloadQueue.modelPath(requireString(id, "download id"), getLlamaCppModelsDir())));
    ipcMain.handle("downloads:forecast", (_event, id: string) => downloadQueue.diskForecast(requireString(id, "download id")));
    ipcMain.handle("downloads:forecastAll", () => downloadQueue.aggregateDiskForecast());
    ipcMain.handle("downloads:recoveryStatus", () => downloadQueue.getRecoveryStatus());
    ipcMain.handle("downloads:getControls", () => {
        const settings = settingsStore.getSettings();
        return { concurrency: settings.downloadGlobalConcurrency ?? 2, bandwidthMbps: settings.downloadBandwidthMbps ?? 0 };
    });
    ipcMain.handle("downloads:setControls", (_event, controls: downloadQueue.DownloadControls) => {
        const normalized = downloadQueue.configure(controls);
        settingsStore.saveSettings({ downloadGlobalConcurrency: normalized.concurrency, downloadBandwidthMbps: normalized.bandwidthMbps });
        return normalized;
    });
}
