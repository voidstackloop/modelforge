import * as path from "node:path";
import * as fs from "node:fs";
import { app } from "electron";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as store from "./patient-cases-store";
import * as caseEncryption from "./case-encryption";

function plaintextCasesPath(): string {
    return path.join(app.getPath("userData"), "patient-cases.json");
}
function encryptedCasesPath(): string {
    return plaintextCasesPath().replace(".json", ".enc.json");
}

// All fixtures are synthetic — no real patient data.

describe("patient-cases-store", () => {
    beforeEach(() => {
        for (const c of store.listCases()) store.deleteCase(c.id);
    });

    it("creates a case with empty, opted-out fields by default", () => {
        const created = store.createCase("Synthetic case A");
        expect(created.title).toBe("Synthetic case A");
        expect(created.allergies.includeInContext).toBe(false);
        expect(created.medications.value).toEqual([]);
    });

    it("round-trips through update", () => {
        const created = store.createCase("Synthetic case B");
        const updated = store.updateCase(created.id, {
            allergies: { value: ["Penicillin"], includeInContext: true },
        });
        expect(updated?.allergies.value).toEqual(["Penicillin"]);
        expect(store.getCase(created.id)?.allergies.includeInContext).toBe(true);
    });

    it("returns null when updating a non-existent case", () => {
        expect(store.updateCase("does-not-exist", { title: "x" })).toBeNull();
    });

    it("isolates cases from one another — reading one never returns another's data", () => {
        const a = store.createCase("Case A");
        const b = store.createCase("Case B");
        store.updateCase(a.id, { allergies: { value: ["Latex"], includeInContext: true } });
        store.updateCase(b.id, { allergies: { value: ["Sulfa"], includeInContext: true } });

        const fetchedA = store.getCase(a.id);
        const fetchedB = store.getCase(b.id);
        expect(fetchedA?.allergies.value).toEqual(["Latex"]);
        expect(fetchedB?.allergies.value).toEqual(["Sulfa"]);

        store.deleteCase(a.id);
        expect(store.getCase(a.id)).toBeNull();
        expect(store.getCase(b.id)?.allergies.value).toEqual(["Sulfa"]);
    });

    it("lists cases sorted by most recently updated", () => {
        const a = store.createCase("Older");
        const b = store.createCase("Newer");
        store.updateCase(a.id, { title: "Older (touched)" });
        const listed = store.listCases();
        expect(listed[0].id).toBe(a.id);
        expect(listed[1].id).toBe(b.id);
    });

    describe("buildContextForCase", () => {
        it("includes only fields explicitly opted in", () => {
            const created = store.createCase("Context test");
            const updated = store.updateCase(created.id, {
                presentingComplaint: { value: "Intermittent chest tightness", includeInContext: true },
                allergies: { value: ["Penicillin"], includeInContext: false },
                medications: { value: ["Metoprolol"], includeInContext: true },
            })!;
            const { text, includedFields } = store.buildContextForCase(updated);
            expect(text).toContain("Intermittent chest tightness");
            expect(text).toContain("Metoprolol");
            expect(text).not.toContain("Penicillin");
            expect(includedFields).toEqual(["Presenting complaint", "Current medications"]);
        });

        it("produces an empty context when no fields are opted in", () => {
            const created = store.createCase("Empty context test");
            const { text, includedFields } = store.buildContextForCase(created);
            expect(text).toBe("");
            expect(includedFields).toEqual([]);
        });
    });

    describe("consent", () => {
        it("a new case starts with no consent records", () => {
            const created = store.createCase("Consent test A");
            expect(created.consentRecords).toEqual([]);
            expect(store.hasActiveConsent(created, "ai-assistance")).toBe(false);
        });

        it("grantConsent records a new consent with the given scope and method", () => {
            const created = store.createCase("Consent test B");
            const updated = store.grantConsent(created.id, "ai-assistance", "verbal");
            expect(updated?.consentRecords).toHaveLength(1);
            expect(updated?.consentRecords[0]).toMatchObject({ scope: "ai-assistance", method: "verbal" });
            expect(updated?.consentRecords[0].revokedAt).toBeUndefined();
            expect(store.hasActiveConsent(updated!, "ai-assistance")).toBe(true);
        });

        it("returns null for a non-existent case", () => {
            expect(store.grantConsent("does-not-exist", "research", "written")).toBeNull();
            expect(store.revokeConsent("does-not-exist", "does-not-exist")).toBeNull();
        });

        it("revokeConsent sets revokedAt without deleting the record", () => {
            const created = store.createCase("Consent test C");
            const granted = store.grantConsent(created.id, "remote-model-use", "electronic")!;
            const consentId = granted.consentRecords[0].id;

            const revoked = store.revokeConsent(created.id, consentId)!;
            expect(revoked.consentRecords).toHaveLength(1);
            expect(revoked.consentRecords[0].revokedAt).toBeTruthy();
            expect(store.hasActiveConsent(revoked, "remote-model-use")).toBe(false);
        });

        it("tracks multiple independent consent scopes on the same case", () => {
            const created = store.createCase("Consent test D");
            store.grantConsent(created.id, "ai-assistance", "verbal");
            const updated = store.grantConsent(created.id, "research", "written form")!;
            expect(updated.consentRecords).toHaveLength(2);
            expect(store.hasActiveConsent(updated, "ai-assistance")).toBe(true);
            expect(store.hasActiveConsent(updated, "research")).toBe(true);
            expect(store.hasActiveConsent(updated, "remote-model-use")).toBe(false);
        });

        it("a case saved before consentRecords existed normalizes to an empty array, not undefined", () => {
            const created = store.createCase("Legacy consent test");
            // Simulate pre-existing on-disk data by writing the case without
            // consentRecords at all, bypassing the store's own writer.
            const plaintextPath = path.join(app.getPath("userData"), "patient-cases.json");
            const onDisk = JSON.parse(fs.readFileSync(plaintextPath, "utf-8")) as Record<string, unknown>[];
            const legacyCase = onDisk.find((c) => c.id === created.id)!;
            delete legacyCase.consentRecords;
            fs.writeFileSync(plaintextPath, JSON.stringify(onDisk));

            const reloaded = store.getCase(created.id);
            expect(reloaded?.consentRecords).toEqual([]);
        });
    });

    describe("clinical notes and review sign-off", () => {
        it("a new case starts with no clinical notes", () => {
            const created = store.createCase("Notes test A");
            expect(created.clinicalNotes).toEqual([]);
        });

        it("addClinicalNote appends a note with the given author and text", () => {
            const created = store.createCase("Notes test B");
            const updated = store.addClinicalNote(created.id, "clinician", "Patient reports improvement.")!;
            expect(updated.clinicalNotes).toHaveLength(1);
            expect(updated.clinicalNotes[0]).toMatchObject({ author: "clinician", text: "Patient reports improvement." });
            expect(updated.clinicalNotes[0].review).toBeUndefined();
        });

        it("returns null for a non-existent case", () => {
            expect(store.addClinicalNote("does-not-exist", "clinician", "x")).toBeNull();
            expect(store.reviewClinicalNote("does-not-exist", "does-not-exist", "Dr. X", "accepted")).toBeNull();
        });

        it("reviewClinicalNote records a sign-off on a model-inference note", () => {
            const created = store.createCase("Notes test C");
            const withNote = store.addClinicalNote(created.id, "model-inference", "Suggested differential: ...")!;
            const noteId = withNote.clinicalNotes[0].id;

            const reviewed = store.reviewClinicalNote(created.id, noteId, "Dr. Smith", "accepted-with-edits", "Trimmed one item")!;
            expect(reviewed.clinicalNotes[0].review).toMatchObject({
                reviewedBy: "Dr. Smith",
                outcome: "accepted-with-edits",
                comment: "Trimmed one item",
            });
            expect(reviewed.clinicalNotes[0].review?.reviewedAt).toBeTruthy();
        });

        it("refuses to set a review on a clinician-authored note", () => {
            const created = store.createCase("Notes test D");
            const withNote = store.addClinicalNote(created.id, "clinician", "Clinician's own note")!;
            const noteId = withNote.clinicalNotes[0].id;

            const reviewed = store.reviewClinicalNote(created.id, noteId, "Dr. Smith", "accepted")!;
            expect(reviewed.clinicalNotes[0].review).toBeUndefined();
        });

        it("reviewing a non-existent note id leaves existing notes untouched", () => {
            const created = store.addClinicalNote(store.createCase("Notes test E").id, "model-inference", "Note text")!;
            const reviewed = store.reviewClinicalNote(created.id, "does-not-exist", "Dr. Smith", "rejected")!;
            expect(reviewed.clinicalNotes[0].review).toBeUndefined();
        });
    });

    describe("encryption at rest", () => {
        // Full reset between tests, not just the encryption config — a
        // leftover .enc.json from a previous test's (differently-keyed)
        // setup() call would otherwise fail to decrypt under this test's key,
        // which setup() has no way to know about since it always assumes
        // it's turning encryption on for the first time.
        afterEach(() => {
            caseEncryption.clearConfig();
            fs.rmSync(plaintextCasesPath(), { force: true });
            fs.rmSync(encryptedCasesPath(), { force: true });
        });

        it("migrates existing plaintext cases to an encrypted file on setup, deleting the plaintext copy", () => {
            store.createCase("Pre-encryption case");
            expect(fs.existsSync(plaintextCasesPath())).toBe(true);

            const data = store.getAllCasesForMigration();
            caseEncryption.setup("a strong passphrase");
            store.overwriteAllCases(data);

            expect(fs.existsSync(plaintextCasesPath())).toBe(false);
            expect(fs.existsSync(encryptedCasesPath())).toBe(true);
            // The raw bytes on disk must not contain the case title in the clear.
            const raw = fs.readFileSync(encryptedCasesPath(), "utf-8");
            expect(raw).not.toContain("Pre-encryption");
        });

        it("reads and writes normally while unlocked", () => {
            caseEncryption.setup("a strong passphrase");
            const created = store.createCase("Encrypted case A");
            expect(store.getCase(created.id)?.title).toBe("Encrypted case A");
            expect(store.listCases().map((c) => c.id)).toContain(created.id);
        });

        it("throws CaseDataLockedError instead of returning an empty list when locked", () => {
            caseEncryption.setup("a strong passphrase");
            store.createCase("Encrypted case B");
            caseEncryption.lock();
            expect(() => store.listCases()).toThrow(store.CaseDataLockedError);
            expect(() => store.createCase("Should fail while locked")).toThrow(store.CaseDataLockedError);
        });

        it("recovers full access after unlocking with the correct passphrase", () => {
            caseEncryption.setup("a strong passphrase");
            const created = store.createCase("Encrypted case C");
            caseEncryption.lock();
            expect(caseEncryption.unlock("a strong passphrase")).toBe(true);
            expect(store.getCase(created.id)?.title).toBe("Encrypted case C");
        });

        it("moving back to plaintext (disable) restores a readable file and removes the encrypted one", () => {
            caseEncryption.setup("a strong passphrase");
            store.createCase("Case to decrypt back");
            const data = store.getAllCasesForMigration();
            caseEncryption.clearConfig();
            store.overwriteAllCases(data);

            expect(store.listCases().some((c) => c.title === "Case to decrypt back")).toBe(true);
            expect(fs.existsSync(plaintextCasesPath())).toBe(true);
            expect(fs.existsSync(encryptedCasesPath())).toBe(false);
        });
    });
});
