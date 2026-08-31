import { app, ipcMain, IpcMainInvokeEvent, shell } from "electron";
import { getLogPath, getLogTail } from "../logger";
import * as sessionsStore from "../sessions-store";
import * as dataTransfer from "../data-transfer";
import type { PromptPreset } from "../settings-store";
import { checkForUpdatesManually } from "../updater";
import { getMainWindow, requireString, setIsBusy } from "../app-state";

export function registerAppIpc(): void {
    ipcMain.handle("app:setBusy", (_event: IpcMainInvokeEvent, busy: boolean) => {
        setIsBusy(busy);
    });
    ipcMain.handle("app:getVersion", () => app.getVersion());
    ipcMain.handle("app:checkForUpdates", () => checkForUpdatesManually(() => getMainWindow()));
    ipcMain.handle("app:getDiagnostics", async () => ({
        appVersion: app.getVersion(),
        electron: process.versions.electron,
        chrome: process.versions.chrome,
        node: process.versions.node,
        platform: process.platform,
        arch: process.arch,
        logTail: getLogTail(),
    }));
    ipcMain.handle("app:openLogsFolder", () => shell.showItemInFolder(getLogPath()));

    ipcMain.handle("data:exportSession", (_event: IpcMainInvokeEvent, id: string) =>
        dataTransfer.exportSession(getMainWindow(), requireString(id, "session id"))
    );
    ipcMain.handle("data:exportSessionMarkdown", (_event: IpcMainInvokeEvent, id: string) =>
        dataTransfer.exportSessionMarkdown(getMainWindow(), requireString(id, "session id"))
    );
    ipcMain.handle("data:getSessionMarkdown", async (_event: IpcMainInvokeEvent, id: string) => {
        const session = await sessionsStore.getSession(requireString(id, "session id"));
        return session ? dataTransfer.sessionToMarkdown(session) : null;
    });
    ipcMain.handle("data:exportAll", () => dataTransfer.exportAllSessions(getMainWindow()));
    ipcMain.handle("data:import", () => dataTransfer.importSessions(getMainWindow()));
    ipcMain.handle("data:getUserDataPath", () => dataTransfer.getUserDataPath());
    ipcMain.handle("data:openUserDataFolder", () => dataTransfer.openUserDataFolder());

    ipcMain.handle("data:exportPromptPresets", (_event: IpcMainInvokeEvent, presets: PromptPreset[]) =>
        dataTransfer.exportPromptPresets(getMainWindow(), presets ?? [])
    );
    ipcMain.handle("data:importPromptPresets", () => dataTransfer.importPromptPresets(getMainWindow()));
}
