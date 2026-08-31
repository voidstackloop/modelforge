import * as path from "node:path";
import { app } from "electron";
import { readJson, writeJson } from "./json-store";

// Config for automatic local backups (backup-scheduler.ts). Deliberately
// its own file, not part of BACKUP_FILES in backup-store.ts: destinationDir
// is a local filesystem path tied to this device, so restoring it onto a
// different machine would point at a folder that likely doesn't exist
// there — the same "device-tied, exclude from backups" reasoning
// backup-store.ts already applies to secrets.json.
export interface BackupSchedule {
    enabled: boolean;
    intervalHours: number;
    destinationDir: string | null;
    // Oldest scheduled backups beyond this count are pruned after each
    // successful run — unlike manual backups (bounded by user action),
    // automatic ones need a bound or the destination grows forever.
    retentionCount: number;
    lastRunAt: string | null;
    lastError: string | null;
    lastBackupPath: string | null;
    lastCloudError: string | null;
}

const DEFAULT_SCHEDULE: BackupSchedule = {
    enabled: false,
    intervalHours: 24,
    destinationDir: null,
    retentionCount: 14,
    lastRunAt: null,
    lastError: null,
    lastBackupPath: null,
    lastCloudError: null,
};

function filePath(): string {
    return path.join(app.getPath("userData"), "backup-schedule.json");
}

export function getSchedule(): BackupSchedule {
    return readJson<BackupSchedule>(filePath(), DEFAULT_SCHEDULE);
}

export function updateSchedule(partial: Partial<BackupSchedule>): BackupSchedule {
    const next = { ...getSchedule(), ...partial };
    writeJson(filePath(), next);
    return next;
}
