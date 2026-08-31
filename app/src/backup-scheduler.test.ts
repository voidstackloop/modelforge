import * as fs from "node:fs";
import * as path from "node:path";
import { app } from "electron";
import { describe, it, expect, beforeEach } from "vitest";
import { vi } from "vitest";
import * as backupScheduler from "./backup-scheduler";
import * as backupScheduleStore from "./backup-schedule-store";
import * as cloudBackupStore from "./cloud-backup-store";
import { mainResourceOrchestrator } from "./resource-orchestrator";

function destDir(): string {
    return path.join(app.getPath("userData"), "sched-dest");
}

describe("backup-scheduler.runScheduledBackup", () => {
    beforeEach(() => {
        fs.rmSync(destDir(), { recursive: true, force: true });
        backupScheduleStore.updateSchedule({
            destinationDir: null,
            lastError: null,
            lastRunAt: null,
            lastBackupPath: null,
            lastCloudError: null,
            retentionCount: 14,
        });
        backupScheduler.clearAutoPassphrase();
        cloudBackupStore.updateConfig({ enabled: false });
    });

    it("records an error and writes nothing when no destination folder is configured", async () => {
        backupScheduler.setAutoPassphrase("correct horse battery staple");
        await backupScheduler.runScheduledBackup();
        expect(backupScheduleStore.getSchedule().lastError).toMatch(/destination/i);
        expect(fs.existsSync(destDir())).toBe(false);
    });

    it("records an error and writes nothing when no automatic-backup passphrase is configured", async () => {
        backupScheduleStore.updateSchedule({ destinationDir: destDir() });
        await backupScheduler.runScheduledBackup();
        expect(backupScheduleStore.getSchedule().lastError).toMatch(/passphrase/i);
        expect(fs.existsSync(destDir())).toBe(false);
    });

    it("writes a timestamped .mfbackup file and records success", async () => {
        backupScheduleStore.updateSchedule({ destinationDir: destDir() });
        backupScheduler.setAutoPassphrase("correct horse battery staple");

        await backupScheduler.runScheduledBackup();

        const schedule = backupScheduleStore.getSchedule();
        expect(schedule.lastError).toBeNull();
        expect(schedule.lastRunAt).not.toBeNull();
        expect(schedule.lastBackupPath).not.toBeNull();
        expect(fs.existsSync(schedule.lastBackupPath!)).toBe(true);
        const files = fs.readdirSync(destDir());
        expect(files.some((f) => f.startsWith("modelforge-auto-backup-") && f.endsWith(".mfbackup"))).toBe(true);
    });

    it("prunes older backups past retentionCount", async () => {
        fs.mkdirSync(destDir(), { recursive: true });
        // Pre-seed old-looking backup files (name-sortable timestamps ensure
        // pruning removes the lexicographically earliest ones first).
        for (let i = 0; i < 5; i++) {
            fs.writeFileSync(path.join(destDir(), `modelforge-auto-backup-2020-01-0${i}T00-00-00-000Z.mfbackup`), "old");
        }
        backupScheduleStore.updateSchedule({ destinationDir: destDir(), retentionCount: 3 });
        backupScheduler.setAutoPassphrase("correct horse battery staple");

        await backupScheduler.runScheduledBackup(); // adds a 6th, newest file

        const files = fs.readdirSync(destDir()).filter((f) => f.startsWith("modelforge-auto-backup-"));
        expect(files.length).toBe(3); // retentionCount, not 6
        // The two oldest (2020-01-00, 2020-01-01) were pruned; newest survive.
        expect(files.some((f) => f.includes("2020-01-00"))).toBe(false);
        expect(files.some((f) => f.includes("2020-01-01"))).toBe(false);
    });

    it("records a separate lastCloudError without affecting local backup success when cloud upload fails", async () => {
        backupScheduleStore.updateSchedule({ destinationDir: destDir() });
        backupScheduler.setAutoPassphrase("correct horse battery staple");
        cloudBackupStore.updateConfig({ enabled: true, endpoint: "https://example-invalid.test", bucket: "b" });
        // No accessKeyId/secret configured -> cloudBackupStore.uploadBackup rejects before any network call.

        await backupScheduler.runScheduledBackup();

        const schedule = backupScheduleStore.getSchedule();
        expect(schedule.lastError).toBeNull(); // local write still succeeded
        expect(schedule.lastBackupPath).not.toBeNull();
        expect(schedule.lastCloudError).toMatch(/not fully configured/i);
    });

    it("item 1: runs as a maintenance-priority lease, so it queues behind interactive/background inference rather than contending with it", async () => {
        backupScheduleStore.updateSchedule({ destinationDir: destDir() });
        backupScheduler.setAutoPassphrase("correct horse battery staple");
        const withLeaseSpy = vi.spyOn(mainResourceOrchestrator, "withLease");

        await backupScheduler.runScheduledBackup();

        expect(withLeaseSpy).toHaveBeenCalledOnce();
        expect(withLeaseSpy.mock.calls[0][0]).toMatchObject({ workloadKind: "backup", priority: "maintenance" });
    });

    it("acquires no lease at all when the run short-circuits on a missing destination/passphrase — nothing to queue for", async () => {
        const withLeaseSpy = vi.spyOn(mainResourceOrchestrator, "withLease");
        await backupScheduler.runScheduledBackup(); // no destination configured (beforeEach resets it to null)
        expect(withLeaseSpy).not.toHaveBeenCalled();
    });
});
