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
    beforeEach(async () => {
        for (const c of await store.listCases()) await store.deleteCase(c.id);
    });

    it("creates a case with empty, opted-out fields by default", async () => {
        const created = await store.createCase("Synthetic case A");
        expect(created.title).toBe("Synthetic case A");
        expect(created.allergies.includeInContext).toBe(false);
        expect(created.medications.value).toEqual([]);
    });

    it("round-trips through update", async () => {
        const created = await store.createCase("Synthetic case B");
        const updated = await store.updateCase(created.id, {
            allergies: { value: ["Penicillin"], includeInContext: true },
        });
        expect(updated?.allergies.value).toEqual(["Penicillin"]);
        expect((await store.getCase(created.id))?.allergies.includeInContext).toBe(true);
    });

    it("returns null when updating a non-existent case", async () => {
        expect(await store.updateCase("does-not-exist", { title: "x" })).toBeNull();
    });

    it("isolates cases from one another — reading one never returns another's data", async () => {
        const a = await store.createCase("Case A");
        const b = await store.createCase("Case B");
        await store.updateCase(a.id, { allergies: { value: ["Latex"], includeInContext: true } });
        await store.updateCase(b.id, { allergies: { value: ["Sulfa"], includeInContext: true } });

        const fetchedA = await store.getCase(a.id);
        const fetchedB = await store.getCase(b.id);
        expect(fetchedA?.allergies.value).toEqual(["Latex"]);
        expect(fetchedB?.allergies.value).toEqual(["Sulfa"]);

        await store.deleteCase(a.id);
        expect(await store.getCase(a.id)).toBeNull();
        expect((await store.getCase(b.id))?.allergies.value).toEqual(["Sulfa"]);
    });

    it("lists cases sorted by most recently updated", async () => {
        const a = await store.createCase("Older");
        const b = await store.createCase("Newer");
        await store.updateCase(a.id, { title: "Older (touched)" });
        const listed = await store.listCases();
        expect(listed[0].id).toBe(a.id);
        expect(listed[1].id).toBe(b.id);
    });

    describe("buildContextForCase", () => {
        it("includes only fields explicitly opted in", async () => {
            const created = await store.createCase("Context test");
            const updated = (await store.updateCase(created.id, {
                presentingComplaint: { value: "Intermittent chest tightness", includeInContext: true },
                allergies: { value: ["Penicillin"], includeInContext: false },
                medications: { value: ["Metoprolol"], includeInContext: true },
            }))!;
            const { text, includedFields } = store.buildContextForCase(updated);
            expect(text).toContain("Intermittent chest tightness");
            expect(text).toContain("Metoprolol");
            expect(text).not.toContain("Penicillin");
            expect(includedFields).toEqual(["Presenting complaint", "Current medications"]);
        });

        it("produces an empty context when no fields are opted in", async () => {
            const created = await store.createCase("Empty context test");
            const { text, includedFields } = store.buildContextForCase(created);
            expect(text).toBe("");
            expect(includedFields).toEqual([]);
        });
    });

    describe("consent", () => {
        it("a new case starts with no consent records", async () => {
            const created = await store.createCase("Consent test A");
            expect(created.consentRecords).toEqual([]);
            expect(store.hasActiveConsent(created, "ai-assistance")).toBe(false);
        });

        it("grantConsent records a new consent with the given scope and method", async () => {
            const created = await store.createCase("Consent test B");
            const updated = await store.grantConsent(created.id, "ai-assistance", "verbal");
            expect(updated?.consentRecords).toHaveLength(1);
            expect(updated?.consentRecords[0]).toMatchObject({ scope: "ai-assistance", method: "verbal" });
            expect(updated?.consentRecords[0].revokedAt).toBeUndefined();
            expect(store.hasActiveConsent(updated!, "ai-assistance")).toBe(true);
        });

        it("returns null for a non-existent case", async () => {
            expect(await store.grantConsent("does-not-exist", "research", "written")).toBeNull();
            expect(await store.revokeConsent("does-not-exist", "does-not-exist")).toBeNull();
        });

        it("revokeConsent sets revokedAt without deleting the record", async () => {
            const created = await store.createCase("Consent test C");
            const granted = (await store.grantConsent(created.id, "remote-model-use", "electronic"))!;
            const consentId = granted.consentRecords[0].id;

            const revoked = (await store.revokeConsent(created.id, consentId))!;
            expect(revoked.consentRecords).toHaveLength(1);
            expect(revoked.consentRecords[0].revokedAt).toBeTruthy();
            expect(store.hasActiveConsent(revoked, "remote-model-use")).toBe(false);
        });

        it("tracks multiple independent consent scopes on the same case", async () => {
            const created = await store.createCase("Consent test D");
            await store.grantConsent(created.id, "ai-assistance", "verbal");
            const updated = (await store.grantConsent(created.id, "research", "written form"))!;
            expect(updated.consentRecords).toHaveLength(2);
            expect(store.hasActiveConsent(updated, "ai-assistance")).toBe(true);
            expect(store.hasActiveConsent(updated, "research")).toBe(true);
            expect(store.hasActiveConsent(updated, "remote-model-use")).toBe(false);
        });

        it("a case saved before consentRecords existed normalizes to an empty array, not undefined", async () => {
            const created = await store.createCase("Legacy consent test");
            // Simulate pre-existing on-disk data by writing the case without
            // consentRecords at all, bypassing the store's own writer.
            const plaintextPath = path.join(app.getPath("userData"), "patient-cases.json");
            const onDisk = JSON.parse(fs.readFileSync(plaintextPath, "utf-8")) as Record<string, unknown>[];
            const legacyCase = onDisk.find((c) => c.id === created.id)!;
            delete legacyCase.consentRecords;
            fs.writeFileSync(plaintextPath, JSON.stringify(onDisk));

            const reloaded = await store.getCase(created.id);
            expect(reloaded?.consentRecords).toEqual([]);
        });
    });

    describe("clinical notes and review sign-off", () => {
        it("a new case starts with no clinical notes", async () => {
            const created = await store.createCase("Notes test A");
            expect(created.clinicalNotes).toEqual([]);
        });

        it("addClinicalNote appends a note with the given author and text", async () => {
            const created = await store.createCase("Notes test B");
            const updated = (await store.addClinicalNote(created.id, "clinician", "Patient reports improvement."))!;
            expect(updated.clinicalNotes).toHaveLength(1);
            expect(updated.clinicalNotes[0]).toMatchObject({ author: "clinician", text: "Patient reports improvement." });
            expect(updated.clinicalNotes[0].review).toBeUndefined();
        });

        it("returns null for a non-existent case", async () => {
            expect(await store.addClinicalNote("does-not-exist", "clinician", "x")).toBeNull();
            expect(await store.reviewClinicalNote("does-not-exist", "does-not-exist", "Dr. X", "accepted")).toBeNull();
        });

        it("reviewClinicalNote records a sign-off on a model-inference note", async () => {
            const created = await store.createCase("Notes test C");
            const withNote = (await store.addClinicalNote(created.id, "model-inference", "Suggested differential: ..."))!;
            const noteId = withNote.clinicalNotes[0].id;

            const reviewed = (await store.reviewClinicalNote(created.id, noteId, "Dr. Smith", "accepted-with-edits", "Trimmed one item"))!;
            expect(reviewed.clinicalNotes[0].review).toMatchObject({
                reviewedBy: "Dr. Smith",
                outcome: "accepted-with-edits",
                comment: "Trimmed one item",
            });
            expect(reviewed.clinicalNotes[0].review?.reviewedAt).toBeTruthy();
        });

        it("refuses to set a review on a clinician-authored note", async () => {
            const created = await store.createCase("Notes test D");
            const withNote = (await store.addClinicalNote(created.id, "clinician", "Clinician's own note"))!;
            const noteId = withNote.clinicalNotes[0].id;

            const reviewed = (await store.reviewClinicalNote(created.id, noteId, "Dr. Smith", "accepted"))!;
            expect(reviewed.clinicalNotes[0].review).toBeUndefined();
        });

        it("reviewing a non-existent note id leaves existing notes untouched", async () => {
            const created = (await store.addClinicalNote((await store.createCase("Notes test E")).id, "model-inference", "Note text"))!;
            const reviewed = (await store.reviewClinicalNote(created.id, "does-not-exist", "Dr. Smith", "rejected"))!;
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

        it("migrates existing plaintext cases to an encrypted file on setup, deleting the plaintext copy", async () => {
            await store.createCase("Pre-encryption case");
            expect(fs.existsSync(plaintextCasesPath())).toBe(true);

            const data = await store.getAllCasesForMigration();
            caseEncryption.setup("a strong passphrase");
            await store.overwriteAllCases(data);

            expect(fs.existsSync(plaintextCasesPath())).toBe(false);
            expect(fs.existsSync(encryptedCasesPath())).toBe(true);
            // The raw bytes on disk must not contain the case title in the clear.
            const raw = fs.readFileSync(encryptedCasesPath(), "utf-8");
            expect(raw).not.toContain("Pre-encryption");
        });

        it("reads and writes normally while unlocked", async () => {
            caseEncryption.setup("a strong passphrase");
            const created = await store.createCase("Encrypted case A");
            expect((await store.getCase(created.id))?.title).toBe("Encrypted case A");
            expect((await store.listCases()).map((c) => c.id)).toContain(created.id);
        });

        it("throws CaseDataLockedError instead of returning an empty list when locked", async () => {
            caseEncryption.setup("a strong passphrase");
            await store.createCase("Encrypted case B");
            caseEncryption.lock();
            await expect(store.listCases()).rejects.toThrow(store.CaseDataLockedError);
            await expect(store.createCase("Should fail while locked")).rejects.toThrow(store.CaseDataLockedError);
        });

        it("recovers full access after unlocking with the correct passphrase", async () => {
            caseEncryption.setup("a strong passphrase");
            const created = await store.createCase("Encrypted case C");
            caseEncryption.lock();
            expect(caseEncryption.unlock("a strong passphrase")).toBe(true);
            expect((await store.getCase(created.id))?.title).toBe("Encrypted case C");
        });

        it("moving back to plaintext (disable) restores a readable file and removes the encrypted one", async () => {
            caseEncryption.setup("a strong passphrase");
            await store.createCase("Case to decrypt back");
            const data = await store.getAllCasesForMigration();
            caseEncryption.clearConfig();
            await store.overwriteAllCases(data);

            expect((await store.listCases()).some((c) => c.title === "Case to decrypt back")).toBe(true);
            expect(fs.existsSync(plaintextCasesPath())).toBe(true);
            expect(fs.existsSync(encryptedCasesPath())).toBe(false);
        });
    });

    // Same in-process read cache as sessions-store.ts, and the same reason:
    // every read used to re-parse (and, under encryption, decrypt) every
    // stored case's full contents plus re-run schema validation, even for a
    // single-field update to one case.
    describe("in-process read cache", () => {
        afterEach(async () => {
            caseEncryption.clearConfig();
            for (const c of await store.listCases()) await store.deleteCase(c.id);
            fs.rmSync(plaintextCasesPath(), { force: true });
            fs.rmSync(encryptedCasesPath(), { force: true });
        });

        it("serves cached data on a repeated call instead of re-reading a file changed out from under it", async () => {
            await store.createCase("Cached case A");
            expect((await store.listCases()).length).toBe(1); // populates the cache

            // Bypasses the store entirely — if listCases() actually hit disk
            // again, it would see this instead of the cached value.
            fs.writeFileSync(plaintextCasesPath(), JSON.stringify([]));

            expect((await store.listCases()).length).toBe(1);
        });

        it("clearCache() forces the next read to pick up what's actually on disk", async () => {
            await store.createCase("Cached case B");
            expect((await store.listCases()).length).toBe(1); // populates the cache

            fs.writeFileSync(plaintextCasesPath(), JSON.stringify([]));
            store.clearCache();

            expect((await store.listCases()).length).toBe(0);
        });

        it("a write refreshes the cache with the written value, so a following read never needs to touch disk", async () => {
            const created = await store.createCase("Cached case C");
            await store.updateCase(created.id, { title: "Written, then read from cache" });

            // Corrupts the on-disk file — if getCase() had to re-read it to
            // answer, this would throw or return something else instead.
            fs.writeFileSync(plaintextCasesPath(), "not valid json{{{");

            expect((await store.getCase(created.id))?.title).toBe("Written, then read from cache");
        });
    });
});

describe("patient-cases-store: backend registry (configuration boundary)", () => {
    afterEach(() => store.selectPatientCasesBackend(store.localPatientCasesBackend.name));

    it("only the local backend is registered by default", () => {
        expect(store.listPatientCasesBackends()).toEqual([
            { name: "modelforge-local-json", label: "Local (this device)", scope: "local", available: true },
        ]);
        expect(store.getPatientCasesBackend().name).toBe("modelforge-local-json");
    });

    it("registering a backend adds it to the list without changing which one is active", () => {
        store.registerPatientCasesBackend({
            name: "future-shared-stub",
            label: "Future Shared Backend (stub)",
            scope: "shared",
            limitations: "stub — not a real networked backend",
            readAll: async () => [],
            writeAll: async () => {},
        });
        try {
            expect(store.listPatientCasesBackends().map((b) => b.name)).toContain("future-shared-stub");
            expect(store.getPatientCasesBackend().name).toBe("modelforge-local-json");
        } finally {
            store.registerPatientCasesBackend(store.localPatientCasesBackend); // can't unregister; restore identity for other tests sharing the module-level registry
        }
    });

    it("selecting a registered backend by name makes it active, and business logic goes through it", async () => {
        const written: store.PatientCase[][] = [];
        let backing: store.PatientCase[] = [];
        store.registerPatientCasesBackend({
            name: "selectable-stub",
            label: "Selectable Stub",
            scope: "shared",
            limitations: "x",
            readAll: async () => backing,
            writeAll: async (cases) => {
                written.push(cases);
                backing = cases;
            },
        });
        const applied = store.selectPatientCasesBackend("selectable-stub");
        expect(applied).toBe(true);
        expect(store.getPatientCasesBackend().name).toBe("selectable-stub");

        const created = await store.createCase("Case via stub backend");
        expect(written.length).toBeGreaterThan(0);
        expect((await store.listCases()).map((c) => c.id)).toContain(created.id);

        // Never touched the real local file — proves business logic actually
        // dispatched through the stub, not just reported its name as active.
        expect(fs.existsSync(plaintextCasesPath())).toBe(false);
    });

    it("selecting an unregistered name fails safe: returns false and leaves the active backend unchanged", () => {
        const before = store.getPatientCasesBackend().name;
        const applied = store.selectPatientCasesBackend("nonexistent-vendor-id");
        expect(applied).toBe(false);
        expect(store.getPatientCasesBackend().name).toBe(before);
    });

    it("reports an unavailable backend and refuses to make it active", () => {
        store.registerPatientCasesBackend({
            name: "unavailable-shared-stub",
            label: "Unavailable Shared Stub",
            scope: "shared",
            limitations: "requires configuration",
            isAvailable: () => false,
            readAll: async () => [],
            writeAll: async () => {},
        });
        const before = store.getPatientCasesBackend().name;

        expect(store.listPatientCasesBackends().find((backend) => backend.name === "unavailable-shared-stub")?.available).toBe(false);
        expect(store.selectPatientCasesBackend("unavailable-shared-stub")).toBe(false);
        expect(store.getPatientCasesBackend().name).toBe(before);
    });

    it("getAllCasesForMigration/overwriteAllCases always operate on the local file regardless of the active backend", async () => {
        const created = await store.createCase("Local case before switching");
        store.registerPatientCasesBackend({
            name: "irrelevant-to-migration-stub",
            label: "Irrelevant Stub",
            scope: "shared",
            limitations: "x",
            readAll: async () => [],
            writeAll: async () => {},
        });
        store.selectPatientCasesBackend("irrelevant-to-migration-stub");
        try {
            // Encryption setup/rotation's own migration path is local-file-only
            // by design (see the doc comment on getAllCasesForMigration) — it
            // must still see the real local data, not the stub's (empty) view.
            const migrated = await store.getAllCasesForMigration();
            expect(migrated.some((c) => c.title === "Local case before switching")).toBe(true);
        } finally {
            store.selectPatientCasesBackend(store.localPatientCasesBackend.name);
            await store.deleteCase(created.id); // avoid leaking local-file state into any test that runs after this one
        }
    });
});

describe("patient-cases-store: readSince/writeOne/deleteOne (optimistic concurrency, docs/SHARED_BACKEND_DESIGN.md §3/§5)", () => {
    afterEach(() => store.selectPatientCasesBackend(store.localPatientCasesBackend.name));

    // A minimal in-memory stand-in for a real shared backend: assigns a
    // monotonically increasing version string on every accepted write and
    // enforces the same reject-on-mismatch semantics a real server would.
    function makeVersionedStub() {
        const byId = new Map<string, store.PatientCase>();
        let counter = 0;
        const backend: store.PatientCasesBackend = {
            name: "versioned-stub",
            label: "Versioned Stub",
            scope: "shared",
            limitations: "stub — not a real networked backend",
            readAll: async () => [...byId.values()],
            writeAll: async (cases) => {
                byId.clear();
                for (const c of cases) byId.set(c.id, c);
            },
            readSince: async () => ({ cases: [...byId.values()], cursor: String(counter) }),
            writeOne: async (patientCase, expectedVersion) => {
                const existing = byId.get(patientCase.id) ?? null;
                if ((existing?.version ?? null) !== expectedVersion) {
                    return { conflict: true, current: existing! };
                }
                const version = String(++counter);
                const saved: store.PatientCase = { ...patientCase, version };
                byId.set(saved.id, saved);
                return { patientCase: saved, version };
            },
            deleteOne: async (id, expectedVersion) => {
                const existing = byId.get(id) ?? null;
                if (!existing || existing.version !== expectedVersion) {
                    return { conflict: true, current: existing! };
                }
                byId.delete(id);
                return { deleted: true };
            },
        };
        return { backend, byId };
    }

    it("createCase uses writeOne (expectedVersion: null) and returns the backend-assigned version", async () => {
        const { backend } = makeVersionedStub();
        store.registerPatientCasesBackend(backend);
        store.selectPatientCasesBackend(backend.name);

        const created = await store.createCase("Case via versioned stub");
        expect(created.version).toBe("1");
    });

    it("listCases/getCase prefer readSince over readAll when the backend implements both", async () => {
        const { backend } = makeVersionedStub();
        let readAllCalls = 0;
        const originalReadAll = backend.readAll;
        backend.readAll = async () => {
            readAllCalls++;
            return originalReadAll();
        };
        store.registerPatientCasesBackend(backend);
        store.selectPatientCasesBackend(backend.name);

        await store.createCase("Case A"); // via writeOne — must not touch readAll either
        await store.listCases();
        await store.getCase("some-id");

        expect(readAllCalls).toBe(0);
    });

    it("updateCase bumps the version and returns the backend's accepted copy when the version matches", async () => {
        const { backend } = makeVersionedStub();
        store.registerPatientCasesBackend(backend);
        store.selectPatientCasesBackend(backend.name);

        const created = await store.createCase("Case B");
        const updated = await store.updateCase(created.id, { title: "Case B, renamed" });

        expect(updated?.title).toBe("Case B, renamed");
        expect(updated?.version).toBe("2");
    });

    it("updateCase throws CaseWriteConflictError carrying the backend's current copy when a caller-supplied expectedVersion is stale", async () => {
        const { backend } = makeVersionedStub();
        store.registerPatientCasesBackend(backend);
        store.selectPatientCasesBackend(backend.name);

        const created = await store.createCase("Case C"); // version "1"
        await store.updateCase(created.id, { title: "Changed by someone else" }); // version bumps to "2"

        // Simulates a clinician whose UI loaded the case back at version "1" —
        // the caller-supplied expectedVersion, not whatever a fresh internal
        // read would show — is what must trigger the conflict.
        await expect(store.updateCase(created.id, { title: "My stale-based edit" }, "1")).rejects.toThrowError(store.CaseWriteConflictError);

        try {
            await store.updateCase(created.id, { title: "My stale-based edit" }, "1");
            expect.unreachable();
        } catch (err) {
            expect(err).toBeInstanceOf(store.CaseWriteConflictError);
            expect((err as store.CaseWriteConflictError).current.title).toBe("Changed by someone else");
            expect((err as store.CaseWriteConflictError).current.version).toBe("2");
        }

        // The rejected write must never have taken effect.
        expect((await store.getCase(created.id))?.title).toBe("Changed by someone else");
    });

    it("deleteCase succeeds via deleteOne when the version matches", async () => {
        const { backend, byId } = makeVersionedStub();
        store.registerPatientCasesBackend(backend);
        store.selectPatientCasesBackend(backend.name);

        const created = await store.createCase("Case D");
        await store.deleteCase(created.id);

        expect(byId.has(created.id)).toBe(false);
    });

    it("deleteCase throws CaseWriteConflictError on a stale caller-supplied expectedVersion, and never deletes", async () => {
        const { backend, byId } = makeVersionedStub();
        store.registerPatientCasesBackend(backend);
        store.selectPatientCasesBackend(backend.name);

        const created = await store.createCase("Case E"); // version "1"
        await store.updateCase(created.id, { title: "Edited after load" }); // version "2"

        await expect(store.deleteCase(created.id, "1")).rejects.toThrowError(store.CaseWriteConflictError);
        expect(byId.has(created.id)).toBe(true);
    });

    it("a backend without writeOne/readSince/deleteOne (the local backend) is unaffected — existing bulk read/write path still runs", async () => {
        expect(store.getPatientCasesBackend().name).toBe(store.localPatientCasesBackend.name);
        const created = await store.createCase("Local, unversioned case");
        expect(created.version).toBeUndefined();
        const updated = await store.updateCase(created.id, { title: "Still works without a shared backend" });
        expect(updated?.title).toBe("Still works without a shared backend");
        await store.deleteCase(created.id);
        expect(await store.getCase(created.id)).toBeNull();
    });
});
