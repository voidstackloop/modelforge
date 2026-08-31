import { test, expect } from "@playwright/test";
import { launchApp, makeUserDataDir, type LaunchedApp } from "../fixtures/electron-app";

// Exercises the medication-safety provider configuration boundary end to
// end (Settings UI -> medicalSafety:listMedicationProviders IPC ->
// medical-safety.ts's provider registry): proves the Settings page reports
// the real registry state honestly — only the built-in demonstration
// provider, explicitly labeled as such — rather than fabricating vendor
// entries or implying more coverage exists than actually ships.

let instance: LaunchedApp;

test.afterEach(async () => {
    await instance?.close();
});

test("Settings shows the built-in demonstration provider as active, with no fabricated vendor entries", async () => {
    const userDataDir = makeUserDataDir();
    instance = await launchApp({ userDataDir, settings: { onboardingComplete: true } });

    await instance.window.getByRole("button", { name: "Audit & Privacy" }).click();

    // Scoped to this card specifically — "Active" alone would also match the
    // Patient case storage backend section's own badge further down the page.
    const section = instance.window.locator("div.rounded-xl", { hasText: "Medication safety provider" });
    await expect(section).toBeVisible();
    await expect(section.getByText("Built-in demonstration list")).toBeVisible();
    await expect(section.getByText("Demonstration only")).toBeVisible();
    await expect(section.getByText("Active")).toBeVisible();
    await expect(section.getByText("No additional providers are registered on this install.")).toBeVisible();

    // Never claims clinical authority for the only provider that actually ships.
    await expect(instance.window.getByText("Clinically authoritative")).not.toBeVisible();
});
