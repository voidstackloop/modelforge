import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test, expect } from "@playwright/test";
import { launchApp, makeUserDataDir, stubOpenDialog, type LaunchedApp } from "../fixtures/electron-app";

// Exercises the custom SQLite database location end to end (Settings UI ->
// audit:pickSqliteDir/audit:setSqliteDir IPC -> audit-log-store.ts's
// sqliteDbPath()/syncOnBackendTransition()): a user can point the
// experimental SQLite audit backend at a directory of their own choosing,
// and a pre-existing event isn't stranded when they do.

let instance: LaunchedApp;
let customDir: string;

test.afterEach(async () => {
    await instance?.close();
    if (customDir) fs.rmSync(customDir, { recursive: true, force: true });
});

test("pointing the SQLite audit backend at a custom folder migrates existing events there", async () => {
    customDir = fs.mkdtempSync(path.join(os.tmpdir(), "modelforge-e2e-audit-custom-"));
    const userDataDir = makeUserDataDir();
    instance = await launchApp({ userDataDir, settings: { onboardingComplete: true } });

    await instance.window.getByRole("button", { name: "Patient Cases" }).click();
    await instance.window.getByLabel("New case").fill("Custom SQLite directory test case");
    await instance.window.getByRole("button", { name: "New case" }).click();
    await expect(instance.window.getByText("Custom SQLite directory test case")).toBeVisible();

    await instance.window.getByRole("button", { name: "Audit & Privacy" }).click();
    const toggle = instance.window.getByRole("button", { name: /Switch to experimental SQLite backend|Switch back to JSON/ });
    await expect(toggle).toBeEnabled({ timeout: 10_000 });
    await toggle.click();
    await expect(instance.window.getByText("SQLite", { exact: true })).toBeVisible();

    await expect(instance.window.getByText("Database location")).toBeVisible();
    await expect(instance.window.getByText("Default location (inside this app's own data folder).")).toBeVisible();

    await stubOpenDialog(instance.app, customDir);
    await instance.window.getByRole("button", { name: "Choose folder…" }).click();

    await expect(instance.window.getByText(customDir)).toBeVisible();
    // The event recorded before switching directories must still be there —
    // proves the pre-existing JSON-recorded event was migrated into the new
    // custom location, not left behind.
    await expect(instance.window.getByText("Case created")).toBeVisible();
    expect(fs.existsSync(path.join(customDir, "audit-log.sqlite3"))).toBe(true);

    await instance.window.getByRole("button", { name: "Use default location" }).click();
    await expect(instance.window.getByText("Default location (inside this app's own data folder).")).toBeVisible();
    await expect(instance.window.getByText("Case created")).toBeVisible();
});
