import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test, expect } from "@playwright/test";
import { launchApp, makeUserDataDir, stubOpenDialog, stubSaveDialog, type LaunchedApp } from "../fixtures/electron-app";

// Exercises app/src/backup-store.ts end to end through the real UI: renderer
// (Audit & Privacy's "Backup & Restore" section) -> typed preload API
// (window.api.backup) -> validated IPC -> domain logic (encrypt/decrypt,
// checksum verification) -> real save/open dialogs (stubbed to fixed paths,
// since a native file picker can't be automated). Synthetic fixtures only.

let instance: LaunchedApp | undefined;
let backupFilePath: string | undefined;

test.afterEach(async () => {
    await instance?.close();
    instance = undefined;
    if (backupFilePath) fs.rmSync(backupFilePath, { force: true });
    backupFilePath = undefined;
});

test("creates an encrypted backup file via the UI", async () => {
    backupFilePath = path.join(os.tmpdir(), `modelforge-e2e-backup-${Date.now()}.mfbackup`);
    instance = await launchApp({ userDataDir: makeUserDataDir(), settings: { onboardingComplete: true } });
    await stubSaveDialog(instance.app, backupFilePath);

    await instance.window.getByRole("button", { name: "Audit & Privacy" }).click();
    const section = instance.window.locator("div.rounded-xl", { hasText: "Backup & Restore" });
    await expect(section).toBeVisible();

    await section.getByRole("button", { name: "Create backup" }).click();
    await instance.window.getByPlaceholder("Backup passphrase (min 8 characters)", { exact: true }).fill("synthetic-e2e-passphrase");
    await instance.window.getByPlaceholder("Confirm passphrase", { exact: true }).fill("synthetic-e2e-passphrase");
    await instance.window.getByRole("button", { name: "Save backup file…" }).click();

    await expect(section.getByText(`Backup saved to ${backupFilePath}`)).toBeVisible();
    expect(fs.existsSync(backupFilePath)).toBe(true);

    // Never plaintext — the on-disk file is the encrypted envelope, not the
    // underlying settings/session content.
    const raw = fs.readFileSync(backupFilePath, "utf-8");
    const parsed = JSON.parse(raw);
    expect(parsed.modelforge).toBe("modelforge-backup-v1");
    expect(raw).not.toContain("onboardingComplete");
});

test("previews a backup's contents before committing to a destructive restore", async () => {
    backupFilePath = path.join(os.tmpdir(), `modelforge-e2e-backup-preview-${Date.now()}.mfbackup`);
    instance = await launchApp({ userDataDir: makeUserDataDir(), settings: { onboardingComplete: true } });
    await stubSaveDialog(instance.app, backupFilePath);

    await instance.window.getByRole("button", { name: "Audit & Privacy" }).click();
    const section = instance.window.locator("div.rounded-xl", { hasText: "Backup & Restore" });

    // Create a real backup first, so there's something to restore from.
    await section.getByRole("button", { name: "Create backup" }).click();
    await instance.window.getByPlaceholder("Backup passphrase (min 8 characters)", { exact: true }).fill("synthetic-e2e-passphrase");
    await instance.window.getByPlaceholder("Confirm passphrase", { exact: true }).fill("synthetic-e2e-passphrase");
    await instance.window.getByRole("button", { name: "Save backup file…" }).click();
    await expect(section.getByText(`Backup saved to ${backupFilePath}`)).toBeVisible();

    // Now walk the restore-preview flow against that same file.
    await stubOpenDialog(instance.app, backupFilePath);
    await section.getByRole("button", { name: "Restore from backup" }).click();
    await expect(section.getByText(backupFilePath, { exact: false })).toBeVisible();

    await instance.window.getByPlaceholder("Backup passphrase", { exact: true }).fill("wrong-passphrase");
    await section.getByRole("button", { name: "Preview" }).click();
    await expect(section.getByText(/incorrect passphrase/i)).toBeVisible();

    await instance.window.getByPlaceholder("Backup passphrase", { exact: true }).fill("synthetic-e2e-passphrase");
    await section.getByRole("button", { name: "Preview" }).click();

    await expect(section.getByText("This will replace current data")).toBeVisible();
    await expect(section.getByText("settings.json", { exact: false })).toBeVisible();
    await expect(section.getByRole("button", { name: "Restore now" })).toBeVisible();
});
