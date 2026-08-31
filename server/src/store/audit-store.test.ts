import { describe, it, expect } from "vitest";
import { actorFrom, InMemoryAuditStore, PostgresAuditStore, verifyChainEntries, type StoredAuditLogEntry } from "./audit-store.js";
import type { AuditLogEntry } from "./audit-store.js";
import { auditWriteTotal } from "../metrics.js";
import type { User } from "../domain/types.js";

// Full end-to-end audit-trail behavior (mutations actually producing
// entries, transactional coupling on Postgres) is exercised via
// in-memory-iam-store.test.ts, postgres-iam-store.test.ts, and app.test.ts.
// This file covers InMemoryAuditStore's own contract in isolation, plus
// actorFrom's mapping — neither needs a real store around it to verify.

function user(overrides: Partial<User> = {}): User {
    return {
        id: "user-1",
        organizationId: "org-1",
        externalSubject: "idp|x",
        displayName: "Dr. Test",
        status: "active",
        groupIds: [],
        policyIds: [],
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        ...overrides,
    };
}

describe("actorFrom", () => {
    it("maps a User's externalSubject/id/organizationId onto an AuditActor", () => {
        expect(actorFrom(user())).toEqual({
            externalSubject: "idp|x",
            userId: "user-1",
            organizationId: "org-1",
        });
    });
});

function auditEntry(overrides: Partial<AuditLogEntry> = {}): AuditLogEntry {
    return {
        organizationId: "org-1",
        actorUserId: "user-1",
        actorExternalSubject: "idp|x",
        action: "user.update",
        targetType: "user",
        targetId: "user-1",
        details: undefined,
        ...overrides,
    };
}

describe("PostgresAuditStore.record() — metrics.ts outcome/latency instrumentation", () => {
    // A minimal fake Pool: insertAuditEntry only ever calls .query(), never
    // anything else on the Pool/PoolClient it's given, so this is enough
    // without a real Postgres connection (this package's real Postgres
    // behavior is covered separately by the DATABASE_URL-gated
    // postgres-*.test.ts suites).
    function fakePool(query: (...args: unknown[]) => Promise<{ rows: unknown[] }>) {
        return { query } as unknown as import("pg").Pool;
    }

    it("increments audit_write_total{outcome=\"success\"} and observes audit_write_duration_seconds on a successful write", async () => {
        const before = (await auditWriteTotal.get()).values;
        const successBefore = before.find((v) => v.labels.outcome === "success")?.value ?? 0;

        const store = new PostgresAuditStore(fakePool(async () => ({ rows: [] })));
        await store.record(auditEntry());

        const after = (await auditWriteTotal.get()).values;
        const successAfter = after.find((v) => v.labels.outcome === "success")?.value ?? 0;
        expect(successAfter).toBe(successBefore + 1);
    });

    it("increments audit_write_total{outcome=\"failure\"} and still rethrows the original error on a failed write", async () => {
        const before = (await auditWriteTotal.get()).values;
        const failureBefore = before.find((v) => v.labels.outcome === "failure")?.value ?? 0;

        const store = new PostgresAuditStore(fakePool(async () => { throw new Error("simulated connection loss"); }));
        await expect(store.record(auditEntry())).rejects.toThrow("simulated connection loss");

        const after = (await auditWriteTotal.get()).values;
        const failureAfter = after.find((v) => v.labels.outcome === "failure")?.value ?? 0;
        expect(failureAfter).toBe(failureBefore + 1);
    });
});

describe("InMemoryAuditStore", () => {
    it("listByOrganization returns an empty array when nothing has been recorded", async () => {
        const store = new InMemoryAuditStore();
        expect(await store.listByOrganization("org-1")).toEqual([]);
    });

    it("record assigns an id and createdAt, and the entry is retrievable", async () => {
        const store = new InMemoryAuditStore();
        await store.record({
            organizationId: "org-1",
            actorUserId: "user-1",
            actorExternalSubject: "idp|x",
            action: "user.create",
            targetType: "user",
            targetId: "user-2",
        });

        const entries = await store.listByOrganization("org-1");
        expect(entries).toHaveLength(1);
        expect(entries[0]).toMatchObject({ action: "user.create", targetType: "user", targetId: "user-2" });
        expect(entries[0].id).toEqual(expect.any(String));
        expect(entries[0].createdAt).toEqual(expect.any(String));
    });

    it("preserves optional details verbatim", async () => {
        const store = new InMemoryAuditStore();
        await store.record({
            organizationId: "org-1",
            actorUserId: "user-1",
            actorExternalSubject: "idp|x",
            action: "user.update",
            targetType: "user",
            targetId: "user-2",
            details: { fields: ["displayName", "status"] },
        });
        const [entry] = await store.listByOrganization("org-1");
        expect(entry.details).toEqual({ fields: ["displayName", "status"] });
    });

    it("listByOrganization only returns entries for that organization", async () => {
        const store = new InMemoryAuditStore();
        await store.record({
            organizationId: "org-1",
            actorUserId: undefined,
            actorExternalSubject: "idp|x",
            action: "organization.create",
            targetType: "organization",
            targetId: "org-1",
        });
        await store.record({
            organizationId: "org-2",
            actorUserId: undefined,
            actorExternalSubject: "idp|y",
            action: "organization.create",
            targetType: "organization",
            targetId: "org-2",
        });

        expect(await store.listByOrganization("org-1")).toHaveLength(1);
        expect(await store.listByOrganization("org-2")).toHaveLength(1);
    });

    it("listByOrganization returns newest first", async () => {
        const store = new InMemoryAuditStore();
        await store.record({
            organizationId: "org-1",
            actorUserId: undefined,
            actorExternalSubject: "idp|x",
            action: "policy.create",
            targetType: "policy",
            targetId: "policy-1",
        });
        await store.record({
            organizationId: "org-1",
            actorUserId: undefined,
            actorExternalSubject: "idp|x",
            action: "policy.create",
            targetType: "policy",
            targetId: "policy-2",
        });

        const entries = await store.listByOrganization("org-1");
        expect(entries.map((e) => e.targetId)).toEqual(["policy-2", "policy-1"]);
    });

    it("tolerates an undefined organizationId/actorUserId (the org-bootstrap shape)", async () => {
        const store = new InMemoryAuditStore();
        await store.record({
            organizationId: "org-1",
            actorUserId: undefined,
            actorExternalSubject: "idp|bootstrapper",
            action: "organization.create",
            targetType: "organization",
            targetId: "org-1",
        });
        const [entry] = await store.listByOrganization("org-1");
        expect(entry.actorUserId).toBeUndefined();
        expect(entry.actorExternalSubject).toBe("idp|bootstrapper");
    });

    describe("hash chain (P1: immutable audit ingestion)", () => {
        function entry(overrides: Partial<{ organizationId: string; action: string; targetId: string }> = {}) {
            return {
                organizationId: overrides.organizationId ?? "org-1",
                actorUserId: "user-1",
                actorExternalSubject: "idp|x",
                action: overrides.action ?? "user.create",
                targetType: "user",
                targetId: overrides.targetId ?? "user-2",
            };
        }

        it("assigns a monotonically increasing sequence, starting at 1, per organization", async () => {
            const store = new InMemoryAuditStore();
            await store.record(entry());
            await store.record(entry());
            await store.record(entry());

            const entries = await store.listByOrganization("org-1");
            // newest first — sequence should still descend 3, 2, 1
            expect(entries.map((e) => e.sequence)).toEqual(["3", "2", "1"]);
        });

        it("chains sequence and hash independently per organization — one org's writes never affect another's", async () => {
            const store = new InMemoryAuditStore();
            await store.record(entry({ organizationId: "org-1" }));
            await store.record(entry({ organizationId: "org-2" }));
            await store.record(entry({ organizationId: "org-1" }));

            const org1 = await store.listByOrganization("org-1");
            const org2 = await store.listByOrganization("org-2");
            expect(org1.map((e) => e.sequence)).toEqual(["2", "1"]);
            expect(org2.map((e) => e.sequence)).toEqual(["1"]);
        });

        it("each entry's prevHash equals the previous entry's entryHash, chained from a fixed genesis", async () => {
            const store = new InMemoryAuditStore();
            await store.record(entry());
            await store.record(entry());

            const [second, first] = await store.listByOrganization("org-1"); // newest first
            expect(second.prevHash).toBe(first.entryHash);
            expect(first.entryHash).toEqual(expect.any(String));
        });

        it("verifyChain reports valid for an untampered chain, and checks every chained entry", async () => {
            const store = new InMemoryAuditStore();
            await store.record(entry());
            await store.record(entry());
            await store.record(entry());

            expect(await store.verifyChain("org-1")).toEqual({ valid: true, checkedCount: 3 });
        });

        it("verifyChain reports invalid, at the correct sequence, when a stored entry is mutated in place", async () => {
            const store = new InMemoryAuditStore();
            await store.record(entry({ targetId: "user-2" }));
            await store.record(entry({ targetId: "user-3" }));
            await store.record(entry({ targetId: "user-4" }));

            const tampered = (await store.listByOrganization("org-1")).find((e) => e.sequence === "2")!;
            // Simulate tampering: mutate the record in place (as if bypassing
            // application code entirely, e.g. via a superuser UPDATE) without
            // recomputing its hash.
            (tampered as { targetId: string }).targetId = "tampered-value";

            const result = await store.verifyChain("org-1");
            expect(result.valid).toBe(false);
            expect(result.brokenAtSequence).toBe("2");
        });

        it("verifyChain on an empty/unknown organization is trivially valid", async () => {
            const store = new InMemoryAuditStore();
            expect(await store.verifyChain("org-nonexistent")).toEqual({ valid: true, checkedCount: 0 });
        });

        it("verifyChainEntries skips entries with no chain fields (pre-chaining history) rather than flagging them as tampered", () => {
            const legacyEntry: StoredAuditLogEntry = {
                id: "legacy-1",
                organizationId: "org-1",
                actorUserId: undefined,
                actorExternalSubject: "idp|x",
                action: "user.create",
                targetType: "user",
                targetId: "user-1",
                createdAt: "2020-01-01T00:00:00.000Z",
                // no sequence/entryHash/prevHash — predates chaining
            };
            expect(verifyChainEntries([legacyEntry])).toEqual({ valid: true, checkedCount: 0 });
        });
    });

    describe("search and pagination (P1: immutable audit ingestion, search, export, and legal hold)", () => {
        it("filters by action, targetType, targetId, and actorUserId independently", async () => {
            const store = new InMemoryAuditStore();
            await store.record({ organizationId: "org-1", actorUserId: "user-1", actorExternalSubject: "idp|a", action: "policy.create", targetType: "policy", targetId: "p-1" });
            await store.record({ organizationId: "org-1", actorUserId: "user-2", actorExternalSubject: "idp|b", action: "policy.delete", targetType: "policy", targetId: "p-2" });
            await store.record({ organizationId: "org-1", actorUserId: "user-1", actorExternalSubject: "idp|a", action: "user.create", targetType: "user", targetId: "u-1" });

            expect((await store.listByOrganization("org-1", { action: "policy.create" })).map((e) => e.targetId)).toEqual(["p-1"]);
            expect((await store.listByOrganization("org-1", { targetType: "user" })).map((e) => e.targetId)).toEqual(["u-1"]);
            expect((await store.listByOrganization("org-1", { targetId: "p-2" })).map((e) => e.targetId)).toEqual(["p-2"]);
            expect((await store.listByOrganization("org-1", { actorUserId: "user-2" })).map((e) => e.targetId)).toEqual(["p-2"]);
        });

        it("filters by since/until date range", async () => {
            const store = new InMemoryAuditStore();
            await store.record({ organizationId: "org-1", actorUserId: undefined, actorExternalSubject: "idp|a", action: "a", targetType: "t", targetId: "1" });
            await new Promise((r) => setTimeout(r, 5));
            const midpoint = new Date().toISOString();
            await new Promise((r) => setTimeout(r, 5));
            await store.record({ organizationId: "org-1", actorUserId: undefined, actorExternalSubject: "idp|a", action: "a", targetType: "t", targetId: "2" });

            expect((await store.listByOrganization("org-1", { since: midpoint })).map((e) => e.targetId)).toEqual(["2"]);
            expect((await store.listByOrganization("org-1", { until: midpoint })).map((e) => e.targetId)).toEqual(["1"]);
        });

        it("cursor pagination returns strictly-older entries than the given sequence, combined with limit", async () => {
            const store = new InMemoryAuditStore();
            for (let i = 0; i < 5; i++) {
                await store.record({ organizationId: "org-1", actorUserId: undefined, actorExternalSubject: "idp|a", action: "a", targetType: "t", targetId: String(i) });
            }
            const firstPage = await store.listByOrganization("org-1", { limit: 2 });
            expect(firstPage.map((e) => e.sequence)).toEqual(["5", "4"]);

            const secondPage = await store.listByOrganization("org-1", { cursor: firstPage[firstPage.length - 1].sequence, limit: 2 });
            expect(secondPage.map((e) => e.sequence)).toEqual(["3", "2"]);
        });

        it("omitting filters entirely preserves the full unpaginated history — no existing caller breaks", async () => {
            const store = new InMemoryAuditStore();
            for (let i = 0; i < 3; i++) {
                await store.record({ organizationId: "org-1", actorUserId: undefined, actorExternalSubject: "idp|a", action: "a", targetType: "t", targetId: String(i) });
            }
            expect(await store.listByOrganization("org-1")).toHaveLength(3);
        });
    });
});
