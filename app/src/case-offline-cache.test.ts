import { describe, it, expect, beforeEach, vi } from "vitest";
import { setSharedBackendConfig } from "./shared-backend-config-store";
import { SharedBackendUnavailableError, type PatientCase, type PatientCasesBackend } from "./patient-cases-store";
import { wrapWithOfflineCache, getSyncStatus, clearOfflineCache } from "./case-offline-cache";

// Vitest can't spy on a native ESM module's own export directly ("Module
// namespace is not configurable in ESM") — this is the documented
// workaround: re-export the real node:fs, replacing just writeFileSync with
// a spy that defaults to the real implementation, so every test's normal
// writes still hit disk exactly as before, and only the one test that
// wants a genuine disk-write failure overrides it for that call.
vi.mock("node:fs", async (importOriginal) => {
    const actual = await importOriginal<typeof import("node:fs")>();
    return { ...actual, writeFileSync: vi.fn(actual.writeFileSync) };
});
import * as fs from "node:fs";
// json-store.ts's writeJson tries this Rust addon before the pure-fs path
// above — confirmed live in this dev environment (the fs.writeFileSync mock
// alone was silently bypassed, the native write succeeding underneath it).
// Forcing "not available" here is what actually routes a test through the
// pure-fs path/mock instead of around it, matching what a real environment
// without the addon (or the addon genuinely failing) would do — see
// json-store.ts's own catch-and-fall-through for that exact case.
vi.mock("./native-datastore", async (importOriginal) => {
    const actual = await importOriginal<typeof import("./native-datastore")>();
    return { ...actual, writeJsonFileAtomicNative: () => false };
});

const ORG_ID = "11111111-1111-1111-1111-111111111111";

function syntheticCase(id: string, overrides?: Partial<PatientCase>): PatientCase {
    return {
        id,
        title: "Synthetic case",
        demographics: { value: {}, includeInContext: false },
        presentingComplaint: { value: "", includeInContext: false },
        symptomsTimeline: { value: "", includeInContext: false },
        vitalSigns: { value: "", includeInContext: false },
        conditions: { value: [], includeInContext: false },
        allergies: { value: [], includeInContext: false },
        medications: { value: [], includeInContext: false },
        labResults: { value: [], includeInContext: false },
        imagingAndReports: { value: "", includeInContext: false },
        clinicalNotes: [],
        attachments: [],
        consentRecords: [],
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        ...overrides,
    };
}

/** A controllable in-memory stand-in for the real HTTP backend — `online`
 * toggles between normal behavior and throwing SharedBackendUnavailableError
 * on every call, simulating a network drop/restore mid-test.
 * `forceConflictOnce` makes exactly the next writeOne/deleteOne call return
 * a conflict regardless of version, simulating a real concurrent edit
 * server-side. Records every idempotencyKey it was called with, so a test
 * can confirm a replay reused the original key rather than minting a new
 * one. */
function makeControllableBackend() {
    const byId = new Map<string, PatientCase>();
    let counter = 0;
    let online = true;
    let forceConflictOnce = false;
    const idempotencyKeysSeen: (string | undefined)[] = [];

    const backend: PatientCasesBackend = {
        name: "controllable-stub",
        label: "Controllable Stub",
        scope: "shared",
        limitations: "test double",
        readAll: async () => [...byId.values()],
        writeAll: async (cases) => {
            for (const c of cases) byId.set(c.id, c);
        },
        readSince: async () => {
            if (!online) throw new SharedBackendUnavailableError();
            return { cases: [...byId.values()], cursor: String(counter) };
        },
        writeOne: async (patientCase, expectedVersion, idempotencyKey) => {
            idempotencyKeysSeen.push(idempotencyKey);
            if (!online) throw new SharedBackendUnavailableError();
            const existing = byId.get(patientCase.id) ?? null;
            if (forceConflictOnce) {
                forceConflictOnce = false;
                return { conflict: true, current: existing ?? patientCase };
            }
            if ((existing?.version ?? null) !== expectedVersion) return { conflict: true, current: existing! };
            const version = String(++counter);
            const saved: PatientCase = { ...patientCase, version };
            byId.set(saved.id, saved);
            return { patientCase: saved, version };
        },
        deleteOne: async (id, expectedVersion, idempotencyKey) => {
            idempotencyKeysSeen.push(idempotencyKey);
            if (!online) throw new SharedBackendUnavailableError();
            const existing = byId.get(id) ?? null;
            if (existing && existing.version !== expectedVersion) return { conflict: true, current: existing };
            byId.delete(id);
            return { deleted: true };
        },
    };

    return {
        backend,
        byId,
        setOnline: (value: boolean) => {
            online = value;
        },
        forceNextConflict: () => {
            forceConflictOnce = true;
        },
        idempotencyKeysSeen,
    };
}

describe("case-offline-cache", () => {
    beforeEach(() => {
        setSharedBackendConfig({ baseUrl: "https://x", issuer: "https://y", clientId: "z", organizationId: ORG_ID });
        clearOfflineCache(ORG_ID);
    });

    it("passes reads and writes straight through while online, with no queueing", async () => {
        const stub = makeControllableBackend();
        const wrapped = wrapWithOfflineCache(stub.backend);

        const created = await wrapped.writeOne!(syntheticCase("case-1"), null);
        expect("conflict" in created).toBe(false);
        expect(getSyncStatus(ORG_ID).pendingCount).toBe(0);
    });

    it("a network failure on writeOne queues the edit and returns success instead of throwing", async () => {
        const stub = makeControllableBackend();
        stub.setOnline(false);
        const wrapped = wrapWithOfflineCache(stub.backend);

        const result = await wrapped.writeOne!(syntheticCase("case-1", { title: "Offline edit" }), null);
        expect("conflict" in result).toBe(false);
        expect(getSyncStatus(ORG_ID).pendingCount).toBe(1);
    });

    it("a queued write is visible on the next readSince, even while still offline", async () => {
        const stub = makeControllableBackend();
        stub.setOnline(false);
        const wrapped = wrapWithOfflineCache(stub.backend);

        await wrapped.writeOne!(syntheticCase("case-1", { title: "Queued case" }), null);
        const feed = await wrapped.readSince!(null);
        expect(feed.cases.map((c) => c.title)).toContain("Queued case");
    });

    it("a queued write survives constructing a fresh wrapper over the same organization (restart-safety)", async () => {
        const stub = makeControllableBackend();
        stub.setOnline(false);
        const firstProcess = wrapWithOfflineCache(stub.backend);
        await firstProcess.writeOne!(syntheticCase("case-1", { title: "Survives restart" }), null);

        // A fresh wrapper instance, as if the app had restarted — reads the
        // same encrypted file on disk rather than any in-memory state.
        const secondProcess = wrapWithOfflineCache(stub.backend);
        expect(getSyncStatus(ORG_ID).pendingCount).toBe(1);
        const feed = await secondProcess.readSince!(null);
        expect(feed.cases.map((c) => c.title)).toContain("Survives restart");
    });

    it("flush replays a queued write using its original idempotency key once the backend is reachable again", async () => {
        const stub = makeControllableBackend();
        stub.setOnline(false);
        const wrapped = wrapWithOfflineCache(stub.backend);
        await wrapped.writeOne!(syntheticCase("case-1"), null);
        const queuedKey = stub.idempotencyKeysSeen[0];
        expect(queuedKey).toEqual(expect.any(String));

        stub.setOnline(true);
        // The opportunistic flush at the top of the next writeOne call
        // drains the queue before doing anything else.
        await wrapped.writeOne!(syntheticCase("case-2"), null);

        expect(getSyncStatus(ORG_ID).pendingCount).toBe(0);
        expect(stub.byId.has("case-1")).toBe(true);
        // Same key reused on replay, not a fresh one minted for the retry.
        expect(stub.idempotencyKeysSeen.filter((k) => k === queuedKey)).toHaveLength(2);
    });

    it("a real conflict during flush is recorded and never retried, without blocking other cases' entries", async () => {
        const stub = makeControllableBackend();
        stub.setOnline(false);
        const wrapped = wrapWithOfflineCache(stub.backend);
        await wrapped.writeOne!(syntheticCase("case-conflict"), null);
        await wrapped.writeOne!(syntheticCase("case-fine"), null);

        stub.setOnline(true);
        stub.forceNextConflict(); // hits whichever entry flushes first (case-conflict, queued first)
        await wrapped.writeOne!(syntheticCase("case-3"), null); // triggers the opportunistic flush

        const status = getSyncStatus(ORG_ID);
        expect(status.conflicts.map((c) => c.caseId)).toContain("case-conflict");
        expect(stub.byId.has("case-fine")).toBe(true); // the other case still flushed
        expect(status.pendingCount).toBe(0);
    });

    it("refuses a non-UUID organizationId rather than using it as a filesystem path component", async () => {
        const stub = makeControllableBackend();
        stub.setOnline(false);
        const wrapped = wrapWithOfflineCache(stub.backend);

        // A malformed organizationId (however it got that way — a
        // compromised or buggy server response, a hand-edited
        // shared-backend-config.json) must never reach path.join()
        // unchecked; see case-offline-cache.ts's filePath() and
        // shared-cache-key.ts's secretKeyFor(), both of which validate this
        // independently. Blocking the save this way is itself an instance
        // of this slice's "storage can't be used safely -> block, don't
        // silently hold in memory" rule.
        setSharedBackendConfig({ baseUrl: "https://x", issuer: "https://y", clientId: "z", organizationId: "../../escape" });
        await expect(wrapped.writeOne!(syntheticCase("case-1"), null)).rejects.toThrow(/UUID/);
    });

    it("a genuine disk write failure while queuing propagates and blocks the save, rather than holding the edit only in memory", async () => {
        const stub = makeControllableBackend();
        stub.setOnline(false);
        const wrapped = wrapWithOfflineCache(stub.backend);

        vi.mocked(fs.writeFileSync).mockImplementationOnce(() => {
            throw Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" });
        });
        await expect(wrapped.writeOne!(syntheticCase("case-1"), null)).rejects.toThrow(/ENOSPC/);
        // The failed write must not have landed anywhere recoverable either.
        expect(getSyncStatus(ORG_ID).pendingCount).toBe(0);
    });

    it("readSince falls back to the cached snapshot when the backend is unreachable, and reports staleness via getSyncStatus", async () => {
        const stub = makeControllableBackend();
        const wrapped = wrapWithOfflineCache(stub.backend);
        await wrapped.writeOne!(syntheticCase("case-1", { title: "Synced before going offline" }), null);
        await wrapped.readSince!(null); // establishes lastSyncedAt

        stub.setOnline(false);
        const feed = await wrapped.readSince!(null);
        expect(feed.cases.map((c) => c.title)).toContain("Synced before going offline");
        expect(getSyncStatus(ORG_ID).lastSyncedAt).toEqual(expect.any(String));
    });

    it("clearOfflineCache removes the queue and snapshot for that organization", async () => {
        const stub = makeControllableBackend();
        stub.setOnline(false);
        const wrapped = wrapWithOfflineCache(stub.backend);
        await wrapped.writeOne!(syntheticCase("case-1"), null);
        expect(getSyncStatus(ORG_ID).pendingCount).toBe(1);

        clearOfflineCache(ORG_ID);
        expect(getSyncStatus(ORG_ID).pendingCount).toBe(0);
    });

    it("throws immediately, with no wrapping, if the wrapped backend doesn't implement readSince/writeOne/deleteOne", () => {
        expect(() => wrapWithOfflineCache({ name: "bare", label: "Bare", scope: "shared", limitations: "", readAll: async () => [], writeAll: async () => {} })).toThrow();
    });
});
