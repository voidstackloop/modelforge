import { test, expect } from "@playwright/test";
import { launchApp, makeUserDataDir, type LaunchedApp } from "../fixtures/electron-app";

// Exercises the real IPC path end to end — Patient Cases UI ->
// patientCases:create -> app/src/audit-log-store.ts's recordEvent() ->
// audit-log.json (via json-store.ts / the Rust addon when built) -> Audit &
// Privacy UI -> audit:list / audit:verifyIntegrity. This is the UI-level
// counterpart to audit-log-store.test.ts's unit tests: it doesn't know or
// care whether the native addon's fast-append path or the pure-Node
// fallback served the write, only that the end-to-end behavior is correct
// either way — exactly the property that change needed to preserve.

let instance: LaunchedApp;

test.afterEach(async () => {
    await instance?.close();
});

test("creating a case records an audit event that survives a relaunch and passes integrity verification", async () => {
    const userDataDir = makeUserDataDir();
    instance = await launchApp({ userDataDir, settings: { onboardingComplete: true } });

    await instance.window.getByRole("button", { name: "Patient Cases" }).click();
    await instance.window.getByLabel("New case").fill("Synthetic e2e audit test case");
    await instance.window.getByRole("button", { name: "New case" }).click();
    await expect(instance.window.getByText("Synthetic e2e audit test case")).toBeVisible();

    await instance.window.getByRole("button", { name: "Audit & Privacy" }).click();
    await expect(instance.window.getByText("Case created")).toBeVisible();

    await instance.window.getByRole("button", { name: "Verify integrity" }).click();
    await expect(instance.window.getByText(/integrity verified/i)).toBeVisible({ timeout: 10_000 });

    await instance.close();

    // Relaunch against the same profile — proves the event actually made it
    // to disk (audit-log.json) and back, not just into in-memory state that
    // happened to still be around within the same process.
    instance = await launchApp({ userDataDir });
    await instance.window.getByRole("button", { name: "Audit & Privacy" }).click();
    await expect(instance.window.getByText("Case created")).toBeVisible();
    await instance.window.getByRole("button", { name: "Verify integrity" }).click();
    await expect(instance.window.getByText(/integrity verified/i)).toBeVisible({ timeout: 10_000 });
});
