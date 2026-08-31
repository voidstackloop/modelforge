import * as fs from "node:fs";
import * as path from "node:path";
import { logger } from "./logger";
import * as backupScheduleStore from "./backup-schedule-store";
import * as backupStore from "./backup-store";
import * as cloudBackupStore from "./cloud-backup-store";
import * as secretsStore from "./secrets-store";
import * as auditLogStore from "./audit-log-store";
import { mainResourceOrchestrator } from "./resource-orchestrator";

// App-open scheduling, same limitation as scheduler.ts (agent-prompt
// scheduling): timers only run while ModelForge is running and stop the
// moment it's closed — there is no OS-level task registration. Good enough
// for "back this up periodically while I'm using the app", not for "run
// this even when my computer is asleep".

const AUTO_PASSPHRASE_KEY = "backup.autoPassphrase";
const FILENAME_PREFIX = "modelforge-auto-backup-";

let timer: NodeJS.Timeout | null = null;

export function setAutoPassphrase(passphrase: string): void {
    secretsStore.setSecret(AUTO_PASSPHRASE_KEY, passphrase);
}

export function hasAutoPassphrase(): boolean {
    return secretsStore.hasSecret(AUTO_PASSPHRASE_KEY);
}

export function clearAutoPassphrase(): void {
    secretsStore.setSecret(AUTO_PASSPHRASE_KEY, "");
}

export function init(): void {
    rescheduleAll();
}

export function rescheduleAll(): void {
    if (timer) clearInterval(timer);
    timer = null;
    const schedule = backupScheduleStore.getSchedule();
    if (!schedule.enabled) return;
    const ms = Math.max(1, schedule.intervalHours) * 3_600_000;
    timer = setInterval(() => {
        void runScheduledBackup();
    }, ms);
}

function pruneOldBackups(destinationDir: string, retentionCount: number): void {
    let entries: string[];
    try {
        entries = fs.readdirSync(destinationDir).filter((name) => name.startsWith(FILENAME_PREFIX) && name.endsWith(".mfbackup"));
    } catch {
        return; // destination unreadable — nothing to prune, createWriteStream above already surfaced the real error
    }
    // Filenames embed an ISO timestamp right after the prefix, so a plain
    // string sort is also a chronological sort — no need to stat every file.
    entries.sort();
    const stale = entries.slice(0, Math.max(0, entries.length - Math.max(0, retentionCount)));
    for (const name of stale) {
        fs.rmSync(path.join(destinationDir, name), { force: true });
    }
}

/** Runs one scheduled backup: local write (required) then, if a cloud
 * destination is enabled, a best-effort upload (its failure never reverts
 * or hides the local write that already succeeded). Exported directly
 * (rather than only reachable through the interval timer) so tests and a
 * manual "back up now" action can both drive it without relying on real
 * timers. */
export async function runScheduledBackup(): Promise<void> {
    const schedule = backupScheduleStore.getSchedule();
    if (!schedule.destinationDir) {
        backupScheduleStore.updateSchedule({ lastError: "No backup destination folder configured" });
        return;
    }
    // Narrowed to a local so the property stays known-non-null once accessed
    // through the closure below — TS does not preserve `schedule.destinationDir`'s
    // narrowing across a nested function boundary.
    const destinationDir: string = schedule.destinationDir;
    const passphrase = secretsStore.getSecret(AUTO_PASSPHRASE_KEY);
    if (!passphrase) {
        backupScheduleStore.updateSchedule({ lastError: "No automatic-backup passphrase configured" });
        return;
    }

    // Item 1: "Backup/encryption — Low-priority background." Wrapped so a
    // scheduled backup never contends with active chat/inference for CPU —
    // it queues behind interactive and even indexing work, which is
    // acceptable for something that runs on an hours-long interval.
    await mainResourceOrchestrator.withLease(
        { workloadKind: "backup", priority: "maintenance", requirements: { cpuThreads: 1, accelerator: "none" } },
        async () => {
            let envelope: string;
            let filePath: string;
            try {
                envelope = backupStore.createBackup(passphrase);
                const filename = `${FILENAME_PREFIX}${new Date().toISOString().replace(/[:.]/g, "-")}.mfbackup`;
                filePath = path.join(destinationDir, filename);
                fs.mkdirSync(destinationDir, { recursive: true });
                fs.writeFileSync(filePath, envelope);
                pruneOldBackups(destinationDir, schedule.retentionCount);
                auditLogStore.recordEvent("backup-created", { targetType: "backup", detail: `scheduled-${Buffer.byteLength(envelope)}-bytes` });
                backupScheduleStore.updateSchedule({ lastRunAt: new Date().toISOString(), lastError: null, lastBackupPath: filePath });
            } catch (err) {
                const message = (err as Error).message;
                logger.error(`Scheduled backup failed: ${message}`);
                backupScheduleStore.updateSchedule({ lastRunAt: new Date().toISOString(), lastError: message });
                return;
            }

            if (cloudBackupStore.getConfig().enabled) {
                try {
                    await cloudBackupStore.uploadBackup(envelope, path.basename(filePath));
                    backupScheduleStore.updateSchedule({ lastCloudError: null });
                } catch (err) {
                    const message = (err as Error).message;
                    logger.error(`Scheduled cloud backup upload failed: ${message}`);
                    backupScheduleStore.updateSchedule({ lastCloudError: message });
                }
            }
        }
    );
}
