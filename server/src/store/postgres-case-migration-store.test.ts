import { randomUUID } from "node:crypto";
import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { Pool } from "pg";
import type { AuditActor } from "./audit-store.js";
import { runMigrations } from "./migrate.js";
import { PostgresIamStore } from "./postgres-iam-store.js";
import { PostgresCaseStore } from "./postgres-case-store.js";
import { PostgresCaseMigrationStore } from "./postgres-case-migration-store.js";
import type { TenantCaseMigrationRepository } from "./case-migration-store.js";
import { schemaNameForTenant, type TenantContext } from "../tenant-context.js";
import { patientCaseFixture } from "../test/patient-case-fixture.js";

// Same disclosure as postgres-iam-store.test.ts and postgres-case-store.test.ts:
// gated on DATABASE_URL, skipped (not failed) when absent — no Postgres
// instance was reachable in the environment this was written in, so these
// tests have not actually been executed anywhere in this session. Run them
// for real (DATABASE_URL=postgres://... npm test) before relying on
// PostgresCaseMigrationStore in production.
const DATABASE_URL = process.env.DATABASE_URL;

const ACTOR: AuditActor = { externalSubject: "idp|test-actor", userId: randomUUID() };

describe.skipIf(!DATABASE_URL)("PostgresCaseMigrationStore (integration — requires DATABASE_URL)", () => {
    let pool: Pool;
    let iamStore: PostgresIamStore;
    let cases: PostgresCaseStore;
    let migrations: PostgresCaseMigrationStore;
    let orgId: string;
    let ctx: TenantContext;
    let repo: TenantCaseMigrationRepository;

    beforeAll(async () => {
        pool = new Pool({ connectionString: DATABASE_URL });
        await runMigrations(pool);
        iamStore = new PostgresIamStore(pool);
        cases = new PostgresCaseStore(pool);
        migrations = new PostgresCaseMigrationStore(pool);
    });

    afterAll(async () => {
        await pool.end();
    });

    beforeEach(async () => {
        await pool.query("TRUNCATE organizations, patient_cases, case_version_counters, audit_log, audit_chain_state CASCADE");
        orgId = (await iamStore.createOrganization("Org", ACTOR)).id;
        await pool.query("SELECT provision_tenant_clinical_schema($1)", [orgId]);
        ctx = { organizationId: orgId, schemaName: schemaNameForTenant(orgId), issuer: "https://issuer.test", subject: "subject" };
        repo = migrations.forTenant(ctx, cases.forTenant(ctx));
    });

    it("stages, validates, activates, and rolls back a migration end to end", async () => {
        const session = await repo.start({ sourceFingerprint: "fp-1", totalItems: 1 }, ACTOR);
        expect(session.status).toBe("staging");
        await repo.upload(session.id, [{ itemKey: "item-1", patientCase: patientCaseFixture("case-1") }], ACTOR);

        const preview = await repo.validate(session.id, ACTOR);
        expect(preview).toMatchObject({ total: 1, valid: 1, invalid: 0, collisions: 0 });

        const activated = await repo.activate(session.id, ACTOR);
        expect(activated.status).toBe("active");
        const liveRows = await pool.query(`SELECT case_id, active FROM "${ctx.schemaName}".patient_cases WHERE case_id = 'case-1'`);
        expect(liveRows.rows).toEqual([{ case_id: "case-1", active: true }]);

        const rolledBack = await repo.rollback(session.id, ACTOR);
        expect(rolledBack.status).toBe("rolled-back");
        const afterRollback = await pool.query(`SELECT active FROM "${ctx.schemaName}".patient_cases WHERE case_id = 'case-1'`);
        expect(afterRollback.rows).toEqual([{ active: false }]);
        const tombstones = await pool.query(`SELECT kind FROM "${ctx.schemaName}".case_changes WHERE case_id = 'case-1' ORDER BY sequence`);
        expect(tombstones.rows.map((r: { kind: string }) => r.kind)).toEqual(["upsert", "delete"]);
    });

    it("start() is idempotent on source fingerprint — a retried start reuses the same session, not a duplicate", async () => {
        const first = await repo.start({ sourceFingerprint: "same-source", totalItems: 3 }, ACTOR);
        const second = await repo.start({ sourceFingerprint: "same-source", totalItems: 3 }, ACTOR);
        expect(second.id).toBe(first.id);
        const rows = await pool.query(`SELECT count(*)::int AS n FROM "${ctx.schemaName}".case_migrations WHERE source_fingerprint = 'same-source'`);
        expect(rows.rows[0].n).toBe(1);
    });

    it("start() scopes the fingerprint dedup key per user — two org members with identical local case content (e.g. both empty) get distinct sessions, not the same one", async () => {
        const otherActor: AuditActor = { externalSubject: "idp|test-actor-2", userId: randomUUID() };
        const mine = await repo.start({ sourceFingerprint: "identical-content", totalItems: 0 }, ACTOR);
        const theirs = await repo.start({ sourceFingerprint: "identical-content", totalItems: 0 }, otherActor);
        expect(theirs.id).not.toBe(mine.id);

        // Regression coverage for the real bug: activating MY session must
        // never affect the OTHER actor's still-independent session — before
        // this fix, they were the exact same row, so this validate() would
        // have failed with "cannot be validated in its current state" once
        // the shared session moved to "active".
        await repo.validate(mine.id, ACTOR);
        const activated = await repo.activate(mine.id, ACTOR);
        expect(activated.status).toBe("active");
        const theirsStillStaging = await repo.get(theirs.id);
        expect(theirsStillStaging?.status).toBe("staging");
    });

    it("upload() is idempotent per item key — replaying the same batch does not duplicate items, but reusing a key with different data is rejected", async () => {
        const session = await repo.start({ sourceFingerprint: "fp-upload", totalItems: 1 }, ACTOR);
        const original = patientCaseFixture("case-1");
        await repo.upload(session.id, [{ itemKey: "item-1", patientCase: original }], ACTOR);
        await repo.upload(session.id, [{ itemKey: "item-1", patientCase: original }], ACTOR);
        const rows = await pool.query(`SELECT count(*)::int AS n FROM "${ctx.schemaName}".case_migration_items WHERE migration_id = $1`, [session.id]);
        expect(rows.rows[0].n).toBe(1);

        await expect(
            repo.upload(session.id, [{ itemKey: "item-1", patientCase: patientCaseFixture("case-1", { title: "Different" }) }], ACTOR)
        ).rejects.toThrow(/reused with different data/i);
    });

    it("activate() rejects a migration that has not been fully, cleanly validated", async () => {
        const session = await repo.start({ sourceFingerprint: "fp-incomplete", totalItems: 1 }, ACTOR);
        await repo.upload(session.id, [{ itemKey: "item-1", patientCase: patientCaseFixture("case-1") }], ACTOR);
        await expect(repo.activate(session.id, ACTOR)).rejects.toThrow(/complete and valid/i);
    });

    it("activate() rejects and applies nothing when the destination changed after validation (concurrent case creation)", async () => {
        const session = await repo.start({ sourceFingerprint: "fp-race", totalItems: 2 }, ACTOR);
        await repo.upload(
            session.id,
            [
                { itemKey: "first", patientCase: patientCaseFixture("case-a") },
                { itemKey: "second", patientCase: patientCaseFixture("case-b") },
            ],
            ACTOR
        );
        const preview = await repo.validate(session.id, ACTOR);
        expect(preview).toMatchObject({ valid: 2, invalid: 0, collisions: 0 });

        // A completely independent request creates a live case for "case-b"
        // after validation but before activation — the exact race a real
        // concurrent case-creation call could trigger.
        await cases.writeOne(orgId, patientCaseFixture("case-b", { title: "Created independently" }), null, ACTOR);

        await expect(repo.activate(session.id, ACTOR)).rejects.toThrow(/destination changed since validation/i);

        // Nothing from this activation attempt was applied — not even
        // "case-a", which sorts (and would have been inserted) before the
        // colliding "case-b".
        const rows = await pool.query(`SELECT case_id FROM "${ctx.schemaName}".patient_cases WHERE staged_migration_id = $1`, [session.id]);
        expect(rows.rows).toEqual([]);
        const caseA = await pool.query(`SELECT case_id FROM "${ctx.schemaName}".patient_cases WHERE case_id = 'case-a'`);
        expect(caseA.rows).toEqual([]);

        const afterFailedActivate = await repo.get(session.id);
        expect(afterFailedActivate?.status).toBe("validated");
    });

    describe("audit log (see store/audit-store.ts's doc comment)", () => {
        it("records an audit row for each migration lifecycle action", async () => {
            const session = await repo.start({ sourceFingerprint: "fp-audit", totalItems: 1 }, ACTOR);
            await repo.upload(session.id, [{ itemKey: "item-1", patientCase: patientCaseFixture("case-1") }], ACTOR);
            await repo.validate(session.id, ACTOR);
            await repo.activate(session.id, ACTOR);
            await repo.rollback(session.id, ACTOR);

            const rows = await pool.query(
                "SELECT action FROM audit_log WHERE organization_id = $1 AND target_id = $2 ORDER BY sequence::bigint",
                [orgId, session.id]
            );
            expect(rows.rows.map((r: { action: string }) => r.action)).toEqual([
                "caseMigration.start",
                "caseMigration.upload",
                "caseMigration.validate",
                "caseMigration.activate",
                "caseMigration.rollback",
            ]);
        });
    });
});
