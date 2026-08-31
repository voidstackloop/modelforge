import { test, expect } from "@playwright/test";
import { launchApp, makeUserDataDir, type LaunchedApp } from "../fixtures/electron-app";

// Exercises the Settings UI toggle for the experimental SQLite audit-log
// backend (see docs/RUST_MIGRATION_ASSESSMENT.md) end to end: creating a
// case while on JSON, switching to SQLite, confirming the migrated event is
// still visible, then switching back — through the real IPC path, not a
// mock. Assumes the native addon is built (app/native present); if it
// isn't, the toggle is expected to stay disabled, which this test doesn't
// cover — see native-sqlite-store.test.ts / audit-log-store.test.ts for the
// addon-unavailable fallback behavior at the unit level.

let instance: LaunchedApp;

test.afterEach(async () => {
    await instance?.close();
});

test("switching the audit log storage backend migrates existing events and back again", async () => {
    const userDataDir = makeUserDataDir();
    instance = await launchApp({ userDataDir, settings: { onboardingComplete: true } });

    await instance.window.getByRole("button", { name: "Patient Cases" }).click();
    await instance.window.getByLabel("New case").fill("Backend toggle test case");
    await instance.window.getByRole("button", { name: "New case" }).click();
    await expect(instance.window.getByText("Backend toggle test case")).toBeVisible();

    await instance.window.getByRole("button", { name: "Audit & Privacy" }).click();
    await expect(instance.window.getByText("JSON (default)")).toBeVisible();
    await expect(instance.window.getByText("Case created")).toBeVisible();

    const toggle = instance.window.getByRole("button", { name: /Switch to experimental SQLite backend|Switch back to JSON/ });
    await expect(toggle).toBeEnabled({ timeout: 10_000 });
    await toggle.click();

    await expect(instance.window.getByText("SQLite", { exact: true })).toBeVisible();
    // The pre-existing event must have migrated in, not disappeared.
    await expect(instance.window.getByText("Case created")).toBeVisible();

    await instance.window.getByRole("button", { name: "Switch back to JSON" }).click();
    await expect(instance.window.getByText("JSON (default)")).toBeVisible();
    await expect(instance.window.getByText("Case created")).toBeVisible();
});
