import { test, expect } from "@playwright/test";
import { launchApp, makeUserDataDir, type LaunchedApp } from "../fixtures/electron-app";

// Exercises PatientCaseDetail.tsx's medication-safety banner end to end,
// through the real IPC path (patientCases:checkConflicts ->
// medical-safety.ts's checkMedicationConflicts -> MedicationSafetyResult).
// The built-in provider is a tiny, non-authoritative demonstration list (see
// medical-safety.ts) — this proves the UI never conflates "found nothing"
// with "safe", and clearly separates that from "nothing recorded yet".

let instance: LaunchedApp;

test.afterEach(async () => {
    await instance?.close();
});

test("medication safety banner distinguishes not-applicable, no-matches, and matches-found states", async () => {
    const userDataDir = makeUserDataDir();
    instance = await launchApp({ userDataDir, settings: { onboardingComplete: true } });

    await instance.window.getByRole("button", { name: "Patient Cases" }).click();
    await instance.window.getByLabel("New case").fill("Medication safety states test case");
    await instance.window.getByRole("button", { name: "New case" }).click();

    // Creating a case navigates straight into its detail view (no allergies
    // or medications recorded yet) — not-applicable state.
    await expect(instance.window.getByText("No allergies or medications recorded")).toBeVisible();
    await expect(instance.window.getByText("Possible allergy/medication conflicts")).not.toBeVisible();
    await expect(instance.window.getByText("No matches found")).not.toBeVisible();

    // An allergy/medication pair the built-in seed list knows about ("allergy"
    // kind: penicillin/amoxicillin) — matches-found state.
    await instance.window.getByPlaceholder("Comma-separated, e.g. Penicillin, Latex").fill("Penicillin");
    await instance.window.getByPlaceholder("Comma-separated, e.g. Penicillin, Latex").blur();
    await instance.window.getByPlaceholder("Comma-separated, e.g. Metformin 500mg, Lisinopril 10mg").fill("Amoxicillin 500mg");
    await instance.window.getByPlaceholder("Comma-separated, e.g. Metformin 500mg, Lisinopril 10mg").blur();

    await expect(instance.window.getByText("Possible allergy/medication conflicts — clinician review required")).toBeVisible();
    await expect(instance.window.getByText(/Built-in demonstration list/)).toBeVisible();
    await expect(instance.window.getByText("No allergies or medications recorded")).not.toBeVisible();

    // An unrelated allergy/medication pair the seed list has no entry for —
    // no-matches state. Must never read as "safe" or "cleared".
    await instance.window.getByPlaceholder("Comma-separated, e.g. Penicillin, Latex").fill("Latex");
    await instance.window.getByPlaceholder("Comma-separated, e.g. Penicillin, Latex").blur();
    await instance.window.getByPlaceholder("Comma-separated, e.g. Metformin 500mg, Lisinopril 10mg").fill("Metoprolol");
    await instance.window.getByPlaceholder("Comma-separated, e.g. Metformin 500mg, Lisinopril 10mg").blur();

    await expect(instance.window.getByText("No matches found", { exact: true })).toBeVisible();
    await expect(instance.window.getByText(/not a clinical interaction check/)).toBeVisible();
    await expect(instance.window.getByText("Possible allergy/medication conflicts")).not.toBeVisible();
    // Never worded as an outright clearance — "safe"/"cleared" only ever
    // appear here inside an explicit negation ("...is not evidence that...
    // are safe together"), never as a standalone claim.
    await expect(instance.window.getByText(/\bcleared\b/i)).not.toBeVisible();
    await expect(instance.window.getByText(/\bno interactions\b/i)).not.toBeVisible();
});
