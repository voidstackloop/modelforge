import { describe, expect, it } from "vitest";
import { minimizeForTask, TASK_DATA_CATEGORIES } from "./data-minimization.js";
import { patientCaseFixture } from "../test/patient-case-fixture.js";

describe("minimizeForTask", () => {
    it("a medication-review request never receives imaging/reports or unrelated notes, even if explicitly requested — item: 'should not automatically receive complete imaging studies or unrelated historical notes'", () => {
        const patientCase = patientCaseFixture("case-1", {
            medications: { value: ["lisinopril 10mg", "metformin 500mg"], includeInContext: true },
            allergies: { value: ["penicillin"], includeInContext: true },
            imagingAndReports: { value: "Chest X-ray: no acute findings.", includeInContext: true },
            clinicalNotes: [{ id: "note-1", author: "clinician", text: "Unrelated dermatology follow-up note.", createdAt: new Date().toISOString() }],
        });
        // Caller asks for everything, including categories outside the task.
        const result = minimizeForTask(patientCase, "medication-review", ["medications", "allergies", "imagingAndReports", "clinicalNotes"]);
        expect(result.includedCategories.sort()).toEqual(["allergies", "medications"]);
        expect(result.sections.some((s) => s.category === "imagingAndReports")).toBe(false);
        expect(result.sections.some((s) => s.category === "clinicalNotes")).toBe(false);
    });

    it("only includes categories the caller actually requested, even if the task would allow more", () => {
        const patientCase = patientCaseFixture("case-1", {
            presentingComplaint: { value: "Chest pain", includeInContext: true },
            labResults: { value: [{ id: "l1", name: "Troponin", value: "0.01" }], includeInContext: true },
        });
        const result = minimizeForTask(patientCase, "diagnostic-support", ["presentingComplaint"]);
        expect(result.includedCategories).toEqual(["presentingComplaint"]);
    });

    it("respects a clinician's own explicit per-field exclusion (includeInContext: false), even when the task and the caller both want it", () => {
        const patientCase = patientCaseFixture("case-1", {
            vitalSigns: { value: "BP 200/120, HR 130", includeInContext: false },
        });
        const result = minimizeForTask(patientCase, "diagnostic-support", ["vitalSigns"]);
        expect(result.includedCategories).toEqual([]);
    });

    it("redacts identifiers out of included free-text fields", () => {
        const patientCase = patientCaseFixture("case-1", {
            presentingComplaint: { value: "Contact patient at test@example.com or 555-123-4567 for follow-up.", includeInContext: true },
        });
        const result = minimizeForTask(patientCase, "diagnostic-support", ["presentingComplaint"]);
        const section = result.sections.find((s) => s.category === "presentingComplaint")!;
        expect(section.text).toContain("[REDACTED_EMAIL]");
        expect(section.text).toContain("[REDACTED_PHONE]");
        expect(section.text).not.toContain("test@example.com");
    });

    it("includes clinical notes as individually cited resources, not one blob, and redacts each", () => {
        const patientCase = patientCaseFixture("case-1", {
            clinicalNotes: [
                { id: "note-1", author: "clinician", text: "Follow-up call: reach patient at 555-987-6543.", createdAt: new Date().toISOString() },
                { id: "note-2", author: "clinician", text: "Second note, no identifiers.", createdAt: new Date().toISOString() },
            ],
        });
        const result = minimizeForTask(patientCase, "documentation-assist", ["clinicalNotes"]);
        expect(result.resourceRefs).toEqual([{ resourceType: "clinicalNote", resourceId: "note-1" }, { resourceType: "clinicalNote", resourceId: "note-2" }]);
        expect(result.sections.find((s) => s.text.includes("Follow-up"))!.text).toContain("[REDACTED_PHONE]");
    });

    it("an unrecognized purposeOfUse resolves to an empty allowlist rather than falling back to 'everything'", () => {
        const patientCase = patientCaseFixture("case-1", { medications: { value: ["x"], includeInContext: true } });
        const result = minimizeForTask(patientCase, "not-a-real-purpose", ["medications"]);
        expect(result.includedCategories).toEqual([]);
        expect(result.sections).toEqual([]);
    });

    it("every TASK_DATA_CATEGORIES entry only names categories minimizeForTask actually knows how to select", () => {
        const knownCategories = new Set(["presentingComplaint", "symptomsTimeline", "vitalSigns", "conditions", "allergies", "medications", "labResults", "imagingAndReports", "clinicalNotes"]);
        for (const categories of Object.values(TASK_DATA_CATEGORIES)) {
            for (const category of categories) expect(knownCategories.has(category)).toBe(true);
        }
    });
});
