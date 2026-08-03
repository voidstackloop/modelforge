import { describe, it, expect, afterEach } from "vitest";
import {
    checkForEmergencyFlags,
    checkMedicationConflicts,
    redactIdentifiers,
    checkCitations,
    builtInMedicationSafetyProvider,
    getMedicationSafetyProvider,
    setMedicationSafetyProvider,
    type MedicationSafetyProvider,
} from "./medical-safety";

// All fixtures below are synthetic — no real patient data.

describe("checkForEmergencyFlags", () => {
    it("flags plain-language stroke symptoms", () => {
        const result = checkForEmergencyFlags("My face is drooping and I have slurred speech since this morning.");
        expect(result.isEmergency).toBe(true);
        expect(result.flags.some((f) => f.category === "possible stroke")).toBe(true);
    });

    it("flags difficulty breathing", () => {
        const result = checkForEmergencyFlags("Patient reports they can't breathe and are gasping for air.");
        expect(result.isEmergency).toBe(true);
        expect(result.flags.some((f) => f.category === "difficulty breathing")).toBe(true);
    });

    it("flags immediate self-harm risk", () => {
        const result = checkForEmergencyFlags("I am actively suicidal and planning to end my life tonight.");
        expect(result.isEmergency).toBe(true);
        expect(result.flags.some((f) => f.category === "immediate self-harm risk")).toBe(true);
    });

    it("does not flag routine, non-urgent questions", () => {
        const result = checkForEmergencyFlags("What are common side effects of starting lisinopril?");
        expect(result.isEmergency).toBe(false);
        expect(result.flags).toHaveLength(0);
    });

    it("does not flag mild/historical mentions without acute framing", () => {
        const result = checkForEmergencyFlags("Patient has a history of asthma but is currently stable.");
        expect(result.isEmergency).toBe(false);
    });
});

describe("checkMedicationConflicts", () => {
    it("flags a medication matching a recorded allergy", () => {
        const warnings = checkMedicationConflicts(["Penicillin"], ["Amoxicillin 500mg"]);
        expect(warnings.some((w) => w.kind === "allergy")).toBe(true);
    });

    it("flags a known high-risk interaction pair", () => {
        const warnings = checkMedicationConflicts([], ["Warfarin", "Ibuprofen"]);
        expect(warnings.some((w) => w.kind === "known-interaction")).toBe(true);
    });

    it("returns no warnings for an unrelated allergy/medication combination", () => {
        const warnings = checkMedicationConflicts(["Latex"], ["Metoprolol"]);
        expect(warnings).toHaveLength(0);
    });

    it("handles empty inputs without throwing", () => {
        expect(checkMedicationConflicts([], [])).toEqual([]);
    });
});

describe("MedicationSafetyProvider abstraction", () => {
    afterEach(() => {
        setMedicationSafetyProvider(builtInMedicationSafetyProvider);
    });

    it("defaults to the built-in seed-list provider", () => {
        expect(getMedicationSafetyProvider().name).toBe("modelforge-builtin-seed-list");
    });

    it("checkMedicationConflicts delegates to whichever provider is currently active", () => {
        const stub: MedicationSafetyProvider = {
            name: "stub-provider",
            checkConflicts: () => [{ kind: "known-interaction", medication: "a", conflictsWith: "b", detail: "stubbed" }],
        };
        setMedicationSafetyProvider(stub);
        expect(getMedicationSafetyProvider().name).toBe("stub-provider");
        expect(checkMedicationConflicts(["irrelevant"], ["irrelevant"])).toEqual([
            { kind: "known-interaction", medication: "a", conflictsWith: "b", detail: "stubbed" },
        ]);
    });

    it("switching back to the built-in provider restores the seed-list behavior", () => {
        setMedicationSafetyProvider({ name: "stub", checkConflicts: () => [] });
        setMedicationSafetyProvider(builtInMedicationSafetyProvider);
        expect(checkMedicationConflicts(["Penicillin"], ["Amoxicillin 500mg"]).some((w) => w.kind === "allergy")).toBe(true);
    });
});

describe("redactIdentifiers", () => {
    it("redacts email, phone, and SSN patterns", () => {
        const result = redactIdentifiers(
            "Contact patient at jane.doe@example.com or 555-123-4567. SSN on file: 123-45-6789."
        );
        expect(result.redacted).not.toContain("jane.doe@example.com");
        expect(result.redacted).not.toContain("555-123-4567");
        expect(result.redacted).not.toContain("123-45-6789");
        expect(result.counts.email).toBe(1);
        expect(result.counts.phone).toBe(1);
        expect(result.counts.ssn).toBe(1);
    });

    it("leaves clinically meaningful text without identifiers unchanged", () => {
        const input = "Patient reports intermittent chest tightness for two days.";
        expect(redactIdentifiers(input).redacted).toBe(input);
    });
});

describe("checkCitations", () => {
    it("marks a citation with no matching known source as unverified", () => {
        const result = checkCitations("This treatment is supported by evidence [1].", []);
        expect(result.unverifiedMarkers).toContain("[1]");
    });

    it("does not flag a citation that matches a known source id", () => {
        const result = checkCitations("This treatment is supported by evidence [1].", ["[1]"]);
        expect(result.unverifiedMarkers).toHaveLength(0);
    });

    it("flags missing citations on a clinical assertion with no markers", () => {
        const result = checkCitations("This medication is contraindicated in pregnancy.", []);
        expect(result.missingCitations).toBe(true);
    });

    it("does not flag missing citations on plain non-clinical text", () => {
        const result = checkCitations("Thanks, that's helpful context.", []);
        expect(result.missingCitations).toBe(false);
    });
});
