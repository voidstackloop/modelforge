import { ipcMain, IpcMainInvokeEvent } from "electron";
import * as settingsStore from "../settings-store";
import type { AppSettings } from "../settings-store";
import * as ollama from "../ollama-manager";
import * as llamacpp from "../llamacpp-manager";
import * as downloadQueue from "../download-queue";
import { setupMenu } from "../menu";
import { checkForUpdatesManually } from "../updater";
import { appSettingsSchema, parseOrThrow } from "../schemas";
import { getMainWindow } from "../app-state";

export function registerSettingsIpc(): void {
    ipcMain.handle("settings:get", () => settingsStore.getSettings());
    ipcMain.handle("settings:save", (_event: IpcMainInvokeEvent, input: unknown) => {
        const partial: Partial<AppSettings> = parseOrThrow(appSettingsSchema, input, "settings");
        const saved = settingsStore.saveSettings(partial);
        if (partial.ollamaHost !== undefined) ollama.setHost(saved.ollamaHost);
        if (partial.llamaCppMaxCachedModels !== undefined) llamacpp.setModelCacheLimit(saved.llamaCppMaxCachedModels ?? 2);
        if (partial.downloadGlobalConcurrency !== undefined || partial.downloadBandwidthMbps !== undefined) {
            downloadQueue.configure({ concurrency: saved.downloadGlobalConcurrency ?? 2, bandwidthMbps: saved.downloadBandwidthMbps ?? 0 });
        }
        if (partial.keybindings !== undefined) {
            setupMenu(() => getMainWindow(), () => checkForUpdatesManually(() => getMainWindow()), saved.keybindings);
        }
        return saved;
    });
}
