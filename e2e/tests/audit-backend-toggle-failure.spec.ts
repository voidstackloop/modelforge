import { test, expect } from "@playwright/test";
import { launchApp, makeUserDataDir, type LaunchedApp } from "../fixtures/electron-app";

// audit-log-store.ts's SQLite migrate-in/merge-back
// (syncOnBackendTransition()) doesn't run inside the Settings toggle that
// flips auditLogBackend — it runs lazily, inside the *next* audit:list (or
// recordEvent) call. So a failure there (a locked/corrupted SQLite file, a
// disk-full write) used to be silent: the toggle already showed "SQLite" as
// active (that part genuinely succeeded) while the event list underneath it
// just never updated, with no indication to the user that their audit trail
// might not reflect reality. This proves the failure now surfaces instead.

let instance: LaunchedApp;

test.afterEach(async () => {
    await instance?.close();
});

test("a failure loading the audit log after switching backends surfaces an error instead of failing silently", async () => {
    const userDataDir = makeUserDataDir();
    instance = await launchApp({ userDataDir, settings: { onboardingComplete: true } });

    await instance.window.getByRole("button", { name: "Patient Cases" }).click();
    await instance.window.getByLabel("New case").fill("Audit list failure test case");
    await instance.window.getByRole("button", { name: "New case" }).click();
    await expect(instance.window.getByText("Audit list failure test case")).toBeVisible();

    await instance.window.getByRole("button", { name: "Audit & Privacy" }).click();
    await expect(instance.window.getByText("Case created")).toBeVisible();

    // Force the next audit:list call to fail, simulating exactly where
    // syncOnBackendTransition()'s migrate/merge can genuinely fail.
    await instance.app.evaluate(({ ipcMain }) => {
        ipcMain.removeHandler("audit:list");
        ipcMain.handle("audit:list", () => {
            throw new Error("Simulated audit store failure");
        });
    });

    const toggle = instance.window.getByRole("button", { name: /Switch to experimental SQLite backend|Switch back to JSON/ });
    await expect(toggle).toBeEnabled({ timeout: 10_000 });
    await toggle.click();

    await expect(instance.window.getByText("Couldn't load the audit log")).toBeVisible();
    await expect(instance.window.getByText(/Simulated audit store failure/)).toBeVisible();
});
