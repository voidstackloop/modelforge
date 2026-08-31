import { ipcMain, IpcMainInvokeEvent, dialog } from "electron";
import * as fs from "node:fs";
import * as backupStore from "../backup-store";
import * as auditLogStore from "../audit-log-store";
import * as backupScheduleStore from "../backup-schedule-store";
import * as backupScheduler from "../backup-scheduler";
import * as cloudBackupStore from "../cloud-backup-store";
import { getMainWindow, requireString } from "../app-state";

// Errors here are deliberately allowed to propagate to the renderer as
// rejected promises (matching data-transfer.ts's EncryptedExportUnreadableError
// pattern) rather than being swallowed into a generic {success: false} —
// "wrong passphrase" and "corrupted backup" need different user-facing
// messages and different remediation, so collapsing them into one boolean
// would throw away exactly the distinction that matters here. Electron's IPC
// doesn't preserve custom error classes across the process boundary (only
// `.message` survives), which is why BackupUnreadableError/BackupCorruptError
// write a fully user-readable message at the throw site rather than expecting
// the renderer to narrow by type — see Chat.tsx's handleExportChat for the
// identical established pattern with CaseDataLockedError.

export function registerBackupIpc(): void {
    ipcMain.handle("backup:create", async (_event: IpcMainInvokeEvent, passphrase: string) => {
        requireString(passphrase, "backup passphrase");
        const win = getMainWindow();
        const date = new Date().toISOString().slice(0, 10);
        const options = {
            defaultPath: `modelforge-backup-${date}.mfbackup`,
            filters: [{ name: "ModelForge Backup", extensions: ["mfbackup"] }],
        };
        const result = win ? await dialog.showSaveDialog(win, options) : await dialog.showSaveDialog(options);
        if (result.canceled || !result.filePath) return { success: false as const };

        const envelope = backupStore.createBackup(passphrase);
        fs.writeFileSync(result.filePath, envelope);
        auditLogStore.recordEvent("backup-created", { targetType: "backup", detail: `${Buffer.byteLength(envelope)}-bytes` });
        return { success: true as const, filePath: result.filePath };
    });

    // Two-step pick/verify + restore: the renderer picks a file and previews
    // it (date, app version, file list) before committing to the actually
    // destructive restore — see backup-store.ts's restoreBackup() doc
    // comment for the safety-snapshot/staging design that makes restore
    // itself reversible, independent of this preview step.
    ipcMain.handle("backup:pickFile", async () => {
        const win = getMainWindow();
        const options = { properties: ["openFile" as const], filters: [{ name: "ModelForge Backup", extensions: ["mfbackup"] }] };
        const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
        if (result.canceled || result.filePaths.length === 0) return { canceled: true as const };
        return { canceled: false as const, filePath: result.filePaths[0] };
    });

    ipcMain.handle("backup:verifyFile", (_event: IpcMainInvokeEvent, filePath: string, passphrase: string) => {
        requireString(filePath, "backup file path");
        requireString(passphrase, "backup passphrase");
        const raw = fs.readFileSync(filePath, "utf-8");
        return backupStore.verifyBackup(passphrase, raw);
    });

    ipcMain.handle("backup:restoreFile", (_event: IpcMainInvokeEvent, filePath: string, passphrase: string) => {
        requireString(filePath, "backup file path");
        requireString(passphrase, "backup passphrase");
        const raw = fs.readFileSync(filePath, "utf-8");
        const result = backupStore.restoreBackup(passphrase, raw);
        auditLogStore.recordEvent("backup-restored", { targetType: "backup", detail: `${result.filesRestored.length}-files` });
        return result;
    });

    // --- Scheduled/automatic local backups ---------------------------------

    ipcMain.handle("backup:getSchedule", () => backupScheduleStore.getSchedule());

    ipcMain.handle(
        "backup:setSchedule",
        (_event: IpcMainInvokeEvent, partial: { enabled?: boolean; intervalHours?: number; retentionCount?: number }) => {
            const result = backupScheduleStore.updateSchedule(partial);
            backupScheduler.rescheduleAll();
            return result;
        }
    );

    ipcMain.handle("backup:pickScheduleDestination", async () => {
        const win = getMainWindow();
        const options = { properties: ["openDirectory" as const] };
        const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
        if (result.canceled || result.filePaths.length === 0) return { canceled: true as const };
        const destinationDir = result.filePaths[0];
        backupScheduleStore.updateSchedule({ destinationDir });
        return { canceled: false as const, destinationDir };
    });

    ipcMain.handle("backup:hasAutoPassphrase", () => backupScheduler.hasAutoPassphrase());

    ipcMain.handle("backup:setAutoPassphrase", (_event: IpcMainInvokeEvent, passphrase: string) => {
        requireString(passphrase, "automatic-backup passphrase");
        backupScheduler.setAutoPassphrase(passphrase);
    });

    ipcMain.handle("backup:clearAutoPassphrase", () => {
        backupScheduler.clearAutoPassphrase();
        backupScheduleStore.updateSchedule({ enabled: false });
        backupScheduler.rescheduleAll();
    });

    // --- Cloud backup destination (S3-compatible) ---------------------------

    ipcMain.handle("backup:getCloudConfig", () => cloudBackupStore.getConfig());

    ipcMain.handle(
        "backup:setCloudConfig",
        (
            _event: IpcMainInvokeEvent,
            partial: { enabled?: boolean; endpoint?: string; region?: string; bucket?: string; accessKeyId?: string; pathStyle?: boolean }
        ) => cloudBackupStore.updateConfig(partial)
    );

    ipcMain.handle("backup:hasCloudSecret", () => cloudBackupStore.hasSecretAccessKey());

    ipcMain.handle("backup:setCloudSecret", (_event: IpcMainInvokeEvent, secretAccessKey: string) => {
        requireString(secretAccessKey, "cloud secret access key");
        cloudBackupStore.setSecretAccessKey(secretAccessKey);
    });

    ipcMain.handle("backup:clearCloudSecret", () => {
        cloudBackupStore.clearSecretAccessKey();
        cloudBackupStore.updateConfig({ enabled: false });
    });

    ipcMain.handle("backup:testCloudConnection", async () => {
        await cloudBackupStore.testConnection();
    });
}
