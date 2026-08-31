import { describe, it, expect, afterEach, vi } from "vitest";
import {
    checkForEmergencyFlags,
    checkMedicationConflicts,
    redactIdentifiers,
    checkCitations,
    builtInMedicationSafetyProvider,
    getMedicationSafetyProvider,
    setMedicationSafetyProvider,
    registerMedicationSafetyProvider,
    listMedicationSafetyProviders,
    selectMedicationSafetyProvider,
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
        const result = checkMedicationConflicts(["Penicillin"], ["Amoxicillin 500mg"]);
        expect(result.warnings.some((w) => w.kind === "allergy")).toBe(true);
    });

    it("flags a known high-risk interaction pair", () => {
        const result = checkMedicationConflicts([], ["Warfarin", "Ibuprofen"]);
        expect(result.warnings.some((w) => w.kind === "known-interaction")).toBe(true);
    });

    it("returns no warnings for an unrelated allergy/medication combination, but still reports a completed demonstration-only check", () => {
        const result = checkMedicationConflicts(["Latex"], ["Metoprolol"]);
        expect(result.warnings).toHaveLength(0);
        expect(result.applicable).toBe(true);
        expect(result.status).toBe("demonstration");
    });

    it("handles empty inputs without throwing, and reports them as not applicable rather than a clean pass", () => {
        const result = checkMedicationConflicts([], []);
        expect(result.warnings).toEqual([]);
        expect(result.applicable).toBe(false);
        // Still the provider's own declared coverage — "not applicable" is an
        // orthogonal axis, not a fifth status value.
        expect(result.status).toBe("demonstration");
    });

    it("treats allergies/medications made up entirely of blank strings as not applicable", () => {
        const result = checkMedicationConflicts(["  ", ""], ["   "]);
        expect(result.applicable).toBe(false);
    });

    it("always includes provider identity, a timestamp, and non-empty limitations text", () => {
        const result = checkMedicationConflicts(["Penicillin"], ["Amoxicillin 500mg"]);
        expect(result.providerName).toBe("modelforge-builtin-seed-list");
        expect(result.providerLabel).toBe("Built-in demonstration list");
        expect(result.evaluatedAt).toBeTruthy();
        expect(new Date(result.evaluatedAt).toString()).not.toBe("Invalid Date");
        expect(result.limitations.length).toBeGreaterThan(0);
    });

    it("the built-in provider's limitations text states that zero warnings is not evidence of safety", () => {
        const result = checkMedicationConflicts(["Latex"], ["Metoprolol"]);
        expect(result.limitations).toMatch(/not evidence/i);
    });

    it("produces the same warnings regardless of input casing/whitespace (deterministic normalization)", () => {
        const a = checkMedicationConflicts([" Penicillin "], ["AMOXICILLIN 500mg"]);
        const b = checkMedicationConflicts(["penicillin"], ["amoxicillin 500mg"]);
        expect(a.warnings).toEqual(b.warnings);
    });

    it("preserves the raw entered text in a warning's medication/conflictsWith fields rather than rewriting it beyond normalization", () => {
        const result = checkMedicationConflicts(["Penicillin"], ["  Amoxicillin 500mg  "]);
        const warning = result.warnings.find((w) => w.kind === "allergy");
        // normalize() only trims + lowercases — it must not otherwise alter
        // the clinician-entered medication name (e.g. stripping the dose).
        expect(warning?.medication).toBe("amoxicillin 500mg");
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
            label: "Stub Provider",
            coverage: "demonstration",
            limitations: "stub limitations",
            checkConflicts: () => [{ kind: "known-interaction", medication: "a", conflictsWith: "b", detail: "stubbed" }],
        };
        setMedicationSafetyProvider(stub);
        expect(getMedicationSafetyProvider().name).toBe("stub-provider");
        const result = checkMedicationConflicts(["irrelevant"], ["irrelevant"]);
        expect(result.warnings).toEqual([{ kind: "known-interaction", medication: "a", conflictsWith: "b", detail: "stubbed" }]);
        expect(result.providerName).toBe("stub-provider");
        expect(result.providerLabel).toBe("Stub Provider");
    });

    it("switching back to the built-in provider restores the seed-list behavior", () => {
        setMedicationSafetyProvider({ name: "stub", label: "Stub", coverage: "demonstration", limitations: "x", checkConflicts: () => [] });
        setMedicationSafetyProvider(builtInMedicationSafetyProvider);
        expect(checkMedicationConflicts(["Penicillin"], ["Amoxicillin 500mg"]).warnings.some((w) => w.kind === "allergy")).toBe(true);
    });

    it("a clinically-authoritative provider's coverage is reflected in the result status, never silently downgraded or upgraded", () => {
        setMedicationSafetyProvider({
            name: "licensed-vendor-stub",
            label: "Licensed Vendor (stub)",
            coverage: "clinically-authoritative",
            limitations: "stub — not a real licensed provider",
            checkConflicts: () => [],
        });
        expect(checkMedicationConflicts(["Penicillin"], ["Amoxicillin"]).status).toBe("clinically-authoritative");
    });

    it("reports isAvailable() === false as an explicit unavailable status, without ever calling checkConflicts", () => {
        const checkConflicts = vi.fn(() => []);
        setMedicationSafetyProvider({
            name: "offline-stub",
            label: "Offline Stub",
            coverage: "clinically-authoritative",
            limitations: "x",
            isAvailable: () => false,
            checkConflicts,
        });
        const result = checkMedicationConflicts(["Penicillin"], ["Amoxicillin"]);
        expect(result.status).toBe("unavailable");
        expect(result.warnings).toEqual([]);
        expect(checkConflicts).not.toHaveBeenCalled();
    });

    it("a provider that throws produces an explicit failed status, not an empty-warnings success", () => {
        setMedicationSafetyProvider({
            name: "broken-stub",
            label: "Broken Stub",
            coverage: "demonstration",
            limitations: "x",
            checkConflicts: () => {
                throw new Error("simulated provider crash");
            },
        });
        const result = checkMedicationConflicts(["Penicillin"], ["Amoxicillin"]);
        expect(result.status).toBe("failed");
        expect(result.warnings).toEqual([]);
        expect(result.error).toBeTruthy();
    });

    it("never surfaces a throwing provider's raw error message (which could echo back clinical input) to the caller", () => {
        setMedicationSafetyProvider({
            name: "leaky-stub",
            label: "Leaky Stub",
            coverage: "demonstration",
            limitations: "x",
            checkConflicts: (allergies, medications) => {
                throw new Error(`failed while processing allergies=${JSON.stringify(allergies)} medications=${JSON.stringify(medications)}`);
            },
        });
        const result = checkMedicationConflicts(["SecretAllergyXYZ"], ["SecretMedicationXYZ"]);
        expect(result.error).not.toContain("SecretAllergyXYZ");
        expect(result.error).not.toContain("SecretMedicationXYZ");
    });

    it("an unavailable/failed provider does not skip the not-applicable check — empty inputs still short-circuit first", () => {
        const checkConflicts = vi.fn(() => []);
        setMedicationSafetyProvider({
            name: "offline-stub",
            label: "Offline Stub",
            coverage: "demonstration",
            limitations: "x",
            isAvailable: () => false,
            checkConflicts,
        });
        const result = checkMedicationConflicts([], []);
        expect(result.applicable).toBe(false);
        expect(result.status).toBe("demonstration"); // provider's own coverage, not "unavailable" — isAvailable() was never consulted
        expect(checkConflicts).not.toHaveBeenCalled();
    });
});

describe("medication safety provider registry (configuration boundary)", () => {
    afterEach(() => setMedicationSafetyProvider(builtInMedicationSafetyProvider));

    it("only the built-in provider is registered by default", () => {
        expect(listMedicationSafetyProviders()).toEqual([
            { name: "modelforge-builtin-seed-list", label: "Built-in demonstration list", coverage: "demonstration" },
        ]);
    });

    it("registering a provider adds it to the list without changing which one is active", () => {
        registerMedicationSafetyProvider({
            name: "future-licensed-stub",
            label: "Future Licensed Provider (stub)",
            coverage: "clinically-authoritative",
            limitations: "stub — not a real licensed provider",
            checkConflicts: () => [],
        });
        try {
            expect(listMedicationSafetyProviders().map((p) => p.name)).toContain("future-licensed-stub");
            expect(getMedicationSafetyProvider().name).toBe("modelforge-builtin-seed-list");
        } finally {
            registerMedicationSafetyProvider(builtInMedicationSafetyProvider); // can't unregister; restore identity for other tests sharing the module-level registry
        }
    });

    it("registering under an existing name replaces that entry rather than duplicating it", () => {
        const replacement: MedicationSafetyProvider = {
            name: "modelforge-builtin-seed-list",
            label: "Replaced label",
            coverage: "demonstration",
            limitations: "x",
            checkConflicts: () => [],
        };
        registerMedicationSafetyProvider(replacement);
        try {
            const entries = listMedicationSafetyProviders().filter((p) => p.name === "modelforge-builtin-seed-list");
            expect(entries).toHaveLength(1);
            expect(entries[0].label).toBe("Replaced label");
        } finally {
            registerMedicationSafetyProvider(builtInMedicationSafetyProvider); // restore the real built-in entry
        }
    });

    it("selecting a registered provider by name makes it active", () => {
        registerMedicationSafetyProvider({
            name: "selectable-stub",
            label: "Selectable Stub",
            coverage: "clinically-authoritative",
            limitations: "x",
            checkConflicts: () => [],
        });
        const applied = selectMedicationSafetyProvider("selectable-stub");
        expect(applied).toBe(true);
        expect(getMedicationSafetyProvider().name).toBe("selectable-stub");
    });

    it("selecting an unregistered name fails safe: returns false and leaves the active provider unchanged", () => {
        const before = getMedicationSafetyProvider().name;
        const applied = selectMedicationSafetyProvider("nonexistent-vendor-id");
        expect(applied).toBe(false);
        expect(getMedicationSafetyProvider().name).toBe(before);
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
