import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { Pool } from "pg";
import type { AuditActor } from "./audit-store.js";
import { runMigrations } from "./migrate.js";
import { PostgresIamStore } from "./postgres-iam-store.js";
import { PostgresCaseStore } from "./postgres-case-store.js";
import type { PatientCaseEnvelope } from "../domain/case-types.js";
import { patientCaseFixture } from "../test/patient-case-fixture.js";

// Same disclosure as postgres-iam-store.test.ts: gated on DATABASE_URL,
// skipped (not failed) when absent — no Postgres instance was reachable in
// the environment this was written in, so these tests have not actually
// been executed anywhere in this session. Run them for real before relying
// on PostgresCaseStore in production.
const DATABASE_URL = process.env.DATABASE_URL;

function envelope(id: string, extra?: Record<string, unknown>): PatientCaseEnvelope {
    return patientCaseFixture(id, extra);
}

// Every mutation now requires an AuditActor (see case-store.ts's doc
// comment) — none of these tests are about auditing itself, so one shared
// dummy actor covers every call site here.
const ACTOR: AuditActor = { externalSubject: "idp|test-actor" };

describe.skipIf(!DATABASE_URL)("PostgresCaseStore (integration — requires DATABASE_URL)", () => {
    let pool: Pool;
    let iamStore: PostgresIamStore;
    let store: PostgresCaseStore;
    let orgId: string;

    beforeAll(async () => {
        pool = new Pool({ connectionString: DATABASE_URL });
        await runMigrations(pool);
        iamStore = new PostgresIamStore(pool);
        store = new PostgresCaseStore(pool);
    });

    afterAll(async () => {
        await pool.end();
    });

    beforeEach(async () => {
        await pool.query("TRUNCATE organizations, patient_cases, case_version_counters, audit_log, audit_chain_state CASCADE");
        orgId = (await iamStore.createOrganization("Org", ACTOR)).id;
        await pool.query("SELECT provision_tenant_clinical_schema($1)", [orgId]);
    });

    it("readAll/readSince return nothing for an organization with no cases", async () => {
        expect(await store.readAll(orgId)).toEqual([]);
        expect((await store.readSince(orgId, null)).cases).toEqual([]);
        expect((await store.readSince(orgId, null)).cursor).toBe("0");
    });

    it("writeOne with expectedVersion: null creates a case and assigns version 1", async () => {
        const result = await store.writeOne(orgId, envelope("case-1"), null, ACTOR);
        expect("conflict" in result).toBe(false);
        if (!("conflict" in result)) {
            expect(result.version).toBe("1");
            expect(result.patientCase.title).toBe("Synthetic case");
        }
    });

    it("writeOne rejects a create when the id already exists (expectedVersion: null but a row is present)", async () => {
        await store.writeOne(orgId, envelope("case-1"), null, ACTOR);
        const result = await store.writeOne(orgId, envelope("case-1", { title: "Collision" }), null, ACTOR);
        expect("conflict" in result && result.conflict).toBe(true);
    });

    it("writeOne with a matching expectedVersion updates the case and bumps the version", async () => {
        const created = await store.writeOne(orgId, envelope("case-1"), null, ACTOR);
        if ("conflict" in created) throw new Error("unexpected conflict");

        const updated = await store.writeOne(orgId, envelope("case-1", { title: "Renamed" }), created.version, ACTOR);
        expect("conflict" in updated).toBe(false);
        if (!("conflict" in updated)) {
            expect(updated.version).toBe("2");
            expect(updated.patientCase.title).toBe("Renamed");
        }
    });

    it("writeOne with a stale expectedVersion returns conflict with the current row, and never applies the write", async () => {
        const created = await store.writeOne(orgId, envelope("case-1"), null, ACTOR);
        if ("conflict" in created) throw new Error("unexpected conflict");
        await store.writeOne(orgId, envelope("case-1", { title: "First edit" }), created.version, ACTOR);

        const staleAttempt = await store.writeOne(orgId, envelope("case-1", { title: "Conflicting edit" }), created.version, ACTOR);
        expect("conflict" in staleAttempt && staleAttempt.conflict).toBe(true);
        if ("conflict" in staleAttempt) expect(staleAttempt.current.title).toBe("First edit");
    });

    it("version numbers are per-organization and never reused after a delete", async () => {
        const created = await store.writeOne(orgId, envelope("case-1"), null, ACTOR);
        if ("conflict" in created) throw new Error("unexpected conflict");
        await store.deleteOne(orgId, "case-1", created.version, ACTOR);

        // Delete itself is sequence 2, so the recreation is sequence 3 —
        // proves the counter is independent of what's currently present in
        // patient_cases, not derived from MAX(version).
        const recreated = await store.writeOne(orgId, envelope("case-1"), null, ACTOR);
        if ("conflict" in recreated) throw new Error("unexpected conflict");
        expect(recreated.version).toBe("3");
    });

    it("deleteOne succeeds with a matching version and the case is actually gone", async () => {
        const created = await store.writeOne(orgId, envelope("case-1"), null, ACTOR);
        if ("conflict" in created) throw new Error("unexpected conflict");

        const result = await store.deleteOne(orgId, "case-1", created.version, ACTOR);
        expect(result).toEqual({ deleted: true });
        expect(await store.readAll(orgId)).toEqual([]);
    });

    it("deleteOne returns conflict on a stale version, and the case remains", async () => {
        const created = await store.writeOne(orgId, envelope("case-1"), null, ACTOR);
        if ("conflict" in created) throw new Error("unexpected conflict");
        await store.writeOne(orgId, envelope("case-1", { title: "Edited" }), created.version, ACTOR);

        const result = await store.deleteOne(orgId, "case-1", created.version, ACTOR);
        expect("conflict" in result && result.conflict).toBe(true);
        expect(await store.readAll(orgId)).toHaveLength(1);
    });

    it("deleteOne returns notFound for an id that was never created", async () => {
        expect(await store.deleteOne(orgId, "never-existed", null, ACTOR)).toEqual({ notFound: true });
    });

    it("readSince(orgId, cursor) returns only cases created after that cursor", async () => {
        const first = await store.writeOne(orgId, envelope("case-1"), null, ACTOR);
        if ("conflict" in first) throw new Error("unexpected conflict");
        const second = await store.writeOne(orgId, envelope("case-2"), null, ACTOR);
        if ("conflict" in second) throw new Error("unexpected conflict");

        const sinceFirst = await store.readSince(orgId, first.version);
        expect(sinceFirst.cases.map((c) => c.id)).toEqual(["case-2"]);

        const sinceNothing = await store.readSince(orgId, null);
        expect(sinceNothing.cases.map((c) => c.id).sort()).toEqual(["case-1", "case-2"]);
    });

    it("readSince with a malformed cursor fails open to returning everything", async () => {
        await store.writeOne(orgId, envelope("case-1"), null, ACTOR);
        const result = await store.readSince(orgId, "not-a-number");
        expect(result.cases.map((c) => c.id)).toEqual(["case-1"]);
    });

    it("cases are isolated per organization", async () => {
        const otherOrgId = (await iamStore.createOrganization("Other Org", ACTOR)).id;
        await pool.query("SELECT provision_tenant_clinical_schema($1)", [otherOrgId]);
        await store.writeOne(orgId, envelope("case-1"), null, ACTOR);
        await store.writeOne(otherOrgId, envelope("case-2"), null, ACTOR);

        expect((await store.readAll(orgId)).map((c) => c.id)).toEqual(["case-1"]);
        expect((await store.readAll(otherOrgId)).map((c) => c.id)).toEqual(["case-2"]);
    });

    it("does not silently purge the tenant clinical schema when control-plane metadata is removed", async () => {
        await store.writeOne(orgId, envelope("case-1"), null, ACTOR);
        await pool.query("DELETE FROM organizations WHERE id = $1", [orgId]);
        const schema = `tenant_${orgId.replaceAll("-", "")}`;
        const remainingCases = await pool.query(`SELECT case_id FROM "${schema}".patient_cases`);
        expect(remainingCases.rows).toEqual([{ case_id: "case-1" }]);
    });

    describe("audit log (see store/audit-store.ts's doc comment)", () => {
        it("writeOne (create) and writeOne (update) write distinct audit actions", async () => {
            const created = await store.writeOne(orgId, envelope("case-1"), null, ACTOR);
            if ("conflict" in created) throw new Error("unexpected conflict");
            await store.writeOne(orgId, envelope("case-1", { title: "Edited" }), created.version, ACTOR);

            const rows = await pool.query("SELECT action FROM audit_log WHERE organization_id = $1 AND target_id = 'case-1' ORDER BY created_at", [
                orgId,
            ]);
            expect(rows.rows.map((r: { action: string }) => r.action)).toEqual(["patientCase.create", "patientCase.update"]);
        });

        it("deleteOne writes an audit row", async () => {
            const created = await store.writeOne(orgId, envelope("case-1"), null, ACTOR);
            if ("conflict" in created) throw new Error("unexpected conflict");
            await store.deleteOne(orgId, "case-1", created.version, ACTOR);

            const rows = await pool.query(
                "SELECT 1 FROM audit_log WHERE organization_id = $1 AND target_id = 'case-1' AND action = 'patientCase.delete'",
                [orgId]
            );
            expect(rows.rows).toHaveLength(1);
        });

        it("a conflicting writeOne (stale version) writes no audit row", async () => {
            const created = await store.writeOne(orgId, envelope("case-1"), null, ACTOR);
            if ("conflict" in created) throw new Error("unexpected conflict");
            await store.writeOne(orgId, envelope("case-1", { title: "First edit" }), created.version, ACTOR);

            // Reuses the stale version — a real conflict, no write applied.
            await store.writeOne(orgId, envelope("case-1", { title: "Conflicting" }), created.version, ACTOR);

            const rows = await pool.query("SELECT action FROM audit_log WHERE organization_id = $1 AND target_id = 'case-1' ORDER BY created_at", [
                orgId,
            ]);
            expect(rows.rows.map((r: { action: string }) => r.action)).toEqual(["patientCase.create", "patientCase.update"]); // not a third row for the conflict
        });
    });
});
