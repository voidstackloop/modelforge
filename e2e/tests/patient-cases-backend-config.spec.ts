import { test, expect } from "@playwright/test";
import { launchApp, makeUserDataDir, type LaunchedApp } from "../fixtures/electron-app";

// Exercises the patient-cases persistence backend configuration boundary end
// to end (Settings UI -> patientCases:listBackends IPC ->
// patient-cases-store.ts's backend registry): proves the Settings page
// reports the real registry state honestly: local storage is active, while
// the registered institutional adapter is visible but cannot be selected
// until enterprise authentication and organization setup are complete.

let instance: LaunchedApp;

test.afterEach(async () => {
    await instance?.close();
});

test("Settings keeps local patient-case storage active until the shared backend is connected", async () => {
    const userDataDir = makeUserDataDir();
    instance = await launchApp({ userDataDir, settings: { onboardingComplete: true } });

    await instance.window.getByRole("button", { name: "Audit & Privacy" }).click();

    const section = instance.window.locator("div.rounded-xl", { hasText: "Patient case storage backend" });
    await expect(section).toBeVisible();
    await expect(section.getByText("Local (this device)", { exact: true })).toBeVisible();
    await expect(section.getByText("Local only", { exact: true })).toBeVisible();
    await expect(section.getByText("Shared (institutional backend)", { exact: true })).toBeVisible();
    await expect(section.getByRole("button", { name: "Connect first" })).toBeDisabled();
    await expect(section.getByText(/connect the shared backend and choose an organization/i)).toBeVisible();
});
