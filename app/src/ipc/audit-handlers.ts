import * as fs from "node:fs";
import { ipcMain, IpcMainInvokeEvent, dialog } from "electron";
import * as auditLogStore from "../audit-log-store";
import * as settingsStore from "../settings-store";
import { getSqliteStoreCapabilityReport } from "../native-sqlite-store";
import { getMainWindow, requireString } from "../app-state";

export function registerAuditIpc(): void {
    ipcMain.handle("audit:list", () => auditLogStore.listEvents());
    ipcMain.handle("audit:clearAll", () => auditLogStore.clearAll());
    ipcMain.handle("audit:verifyIntegrity", () => auditLogStore.verifyChainIntegrity());
    // Lets Settings explain *why* the experimental SQLite backend silently
    // stayed on JSON, rather than the toggle just appearing to do nothing.
    ipcMain.handle("audit:sqliteCapability", () => getSqliteStoreCapabilityReport());

    // Custom SQLite database location — mirrors llamacpp:pickModelsDir's own
    // picker+validate pattern. Only ever a
    // directory (never a specific file path): the -wal/-shm sidecar files
    // SQLite creates alongside audit-log.sqlite3 need to live next to it, so
    // letting the user name the file itself would just be one more way to
    // get that wrong.
    ipcMain.handle("audit:pickSqliteDir", async () => {
        const mainWindow = getMainWindow();
        const result = mainWindow
            ? await dialog.showOpenDialog(mainWindow, { properties: ["openDirectory", "createDirectory"] })
            : await dialog.showOpenDialog({ properties: ["openDirectory", "createDirectory"] });
        return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0];
    });

    ipcMain.handle("audit:setSqliteDir", (_event: IpcMainInvokeEvent, dir: string | null) => {
        if (dir) {
            requireString(dir, "SQLite database directory");
            try {
                fs.mkdirSync(dir, { recursive: true });
                fs.accessSync(dir, fs.constants.W_OK);
            } catch (err) {
                return { error: `Can't use that folder: ${(err as Error).message}` };
            }
        }
        // Read live by audit-log-store.ts's sqliteDbPath() on every call —
        // no restart, and no separate "apply" step needed beyond saving the
        // setting itself. The next recordEvent()/listEvents() call is what
        // actually reconciles anything at the old vs. new location (see
        // syncOnBackendTransition() there), not this handler.
        const saved = settingsStore.saveSettings({ auditLogSqliteDir: dir ?? undefined });
        // `null` here means "using the default userData location" — the
        // frontend displays that case itself rather than this handler
        // duplicating audit-log-store.ts's private default-path logic.
        return { customDir: saved.auditLogSqliteDir ?? null };
    });

    ipcMain.handle(
        "audit:record",
        (
            _event: IpcMainInvokeEvent,
            {
                actionCategory,
                fields,
            }: {
                actionCategory: auditLogStore.AuditActionCategory;
                fields?: {
                    targetType?: auditLogStore.AuditEvent["targetType"];
                    targetId?: string;
                    detail?: string;
                    mcpServerId?: string;
                    mcpServerName?: string;
                    mcpToolName?: string;
                    approvalOutcome?: auditLogStore.AuditEvent["approvalOutcome"];
                    durationMs?: number;
                };
            }
        ) => auditLogStore.recordEvent(actionCategory, fields ?? {})
    );
}
