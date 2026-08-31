import { randomUUID } from "node:crypto";
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { Pool } from "pg";
import type { AuditActor } from "./audit-store.js";
import { insertAuditEntry } from "./audit-store.js";
import { runMigrations } from "./migrate.js";
import { PostgresIamStore } from "./postgres-iam-store.js";
import { PostgresPrincipalStore } from "./postgres-principal-store.js";
import { PostgresTenantBackupStore, TenantRestoreExecutionError } from "./tenant-backup-store.js";
import { POLICY_DOCUMENT_VERSION } from "../domain/policy-evaluator.js";
import { schemaNameForTenant } from "../tenant-context.js";

// Same disclosure as every other postgres-*.test.ts file in this
// directory: gated on DATABASE_URL, skipped (not failed) when absent — no
// Postgres instance was reachable in the environment this was written in,
// so these tests have not actually been executed anywhere in this session.
// Run for real (DATABASE_URL=postgres://... npm test) before relying on
// PostgresTenantBackupStore in production — this is the highest-blast-
// radius store in this codebase (it writes across ~20 tables in one
// transaction), so that live run matters more here than almost anywhere
// else.
const DATABASE_URL = process.env.DATABASE_URL;

const ACTOR: AuditActor = { externalSubject: "idp|test-actor", userId: randomUUID() };

describe.skipIf(!DATABASE_URL)("PostgresTenantBackupStore (integration — requires DATABASE_URL)", () => {
    let pool: Pool;
    let iamStore: PostgresIamStore;
    let principalStore: PostgresPrincipalStore;
    let backupStore: PostgresTenantBackupStore;

    beforeAll(async () => {
        pool = new Pool({ connectionString: DATABASE_URL });
        await runMigrations(pool);
        iamStore = new PostgresIamStore(pool);
        principalStore = new PostgresPrincipalStore(pool);
        backupStore = new PostgresTenantBackupStore(pool);
    });

    afterAll(async () => {
        await pool.end();
    });

    beforeEach(async () => {
        await pool.query(
            "TRUNCATE organizations, patient_cases, case_version_counters, audit_log, audit_chain_state, identities, tenant_restore_requests CASCADE"
        );
    });

    async function seedOrg(name: string): Promise<{ orgId: string; userId: string; policyId: string }> {
        const org = await iamStore.createOrganization(name, ACTOR);
        await pool.query("SELECT provision_tenant_clinical_schema($1)", [org.id]);
        const tenant = { organizationId: org.id, schemaName: schemaNameForTenant(org.id), issuer: "https://issuer.test", subject: `subject-${randomUUID()}` };
        const user = await iamStore.bindTenant(tenant).createUser({ externalSubject: tenant.subject, displayName: "Seed User" }, ACTOR);
        await iamStore.bindTenant(tenant).createPolicy(
            { name: "OrganizationAdmin", builtin: true, document: { version: POLICY_DOCUMENT_VERSION, statements: [{ effect: "Allow", actions: ["*"], resources: ["*"] }] } },
            ACTOR
        );
        const policy = await iamStore.bindTenant(tenant).createPolicy(
            { name: "SeedPolicy", document: { version: POLICY_DOCUMENT_VERSION, statements: [{ effect: "Allow", actions: ["*"], resources: ["*"] }] } },
            ACTOR
        );
        const identity = await principalStore.upsertIdentity({ issuer: tenant.issuer, subject: tenant.subject, displayName: user.displayName });
        await principalStore.ensureMembership(
            { organizationId: org.id, identityId: identity.id, userId: user.id, provisioningSource: "jit" },
            actorFor(user.id)
        );
        return { orgId: org.id, userId: user.id, policyId: policy.id };
    }

    function actorFor(userId: string): AuditActor {
        return { externalSubject: `idp|${userId}`, userId };
    }

    it("export then restore into a wiped copy of the same org reproduces every table's rows", async () => {
        const { orgId, userId, policyId } = await seedOrg("Org A");
        await iamStore
            .bindTenant({ organizationId: orgId, schemaName: schemaNameForTenant(orgId), issuer: "x", subject: "y" })
            .updateUser(userId, { policyIds: [policyId] }, ACTOR);

        const artifact = await backupStore.exportTenant(orgId);
        expect(artifact.tables.users).toHaveLength(1);
        expect(artifact.tables.policies).toHaveLength(2); // seed policy + builtin OrganizationAdmin

        // A restore must be proposed and approved by a user that still
        // exists after the simulated loss. This operator was created after
        // the backup, so it is deliberately not part of the artifact.
        const restoreOperator = await iamStore
            .bindTenant({ organizationId: orgId, schemaName: schemaNameForTenant(orgId), issuer: "x", subject: "restore-operator" })
            .createUser({ externalSubject: "restore-operator", displayName: "Restore Operator" }, ACTOR);

        // Simulate data loss while retaining the organization, tenant
        // schema, and the post-backup operator needed for dual control.
        await pool.query("DELETE FROM users WHERE organization_id = $1 AND id = $2", [orgId, userId]);
        await pool.query("DELETE FROM policies WHERE organization_id = $1", [orgId]);

        const proposed = await backupStore.proposeRestore(orgId, artifact, restoreOperator.id, actorFor(restoreOperator.id));
        expect(proposed.summary.users).toEqual({ willInsert: 1, alreadyPresent: 0 });
        const approved = await backupStore.approveRestore(orgId, proposed.id, actorFor(restoreOperator.id));
        expect(approved?.status).toBe("completed");

        const usersAfter = await pool.query("SELECT id FROM users WHERE organization_id = $1", [orgId]);
        expect(usersAfter.rows.map((r: { id: string }) => r.id)).toContain(userId);
        const policiesAfter = await pool.query("SELECT id FROM policies WHERE organization_id = $1", [orgId]);
        expect(policiesAfter.rows).toHaveLength(2);
    });

    it("executeRestore's own guard refuses when the artifact's recorded organizationId doesn't match the target (cross-tenant safety, layer 1)", async () => {
        const { orgId: orgA } = await seedOrg("Org A");
        const { orgId: orgB, userId: userB } = await seedOrg("Org B");
        const artifactFromA = await backupStore.exportTenant(orgA);

        // Bypasses the route's own pre-check deliberately (routes/tenant-
        // backup.ts refuses this mismatch before ever calling the store) —
        // this proves the store's executeRestore is a second, independent
        // line of defense, not something relying solely on the route
        // never being buggy.
        const proposed = await backupStore.proposeRestore(orgB, artifactFromA, userB, actorFor(userB));
        await expect(backupStore.approveRestore(orgB, proposed.id, actorFor(userB))).rejects.toBeInstanceOf(TenantRestoreExecutionError);

        const orgBUsers = await pool.query("SELECT id FROM users WHERE organization_id = $1", [orgB]);
        expect(orgBUsers.rows).toHaveLength(1); // only orgB's own seed user — nothing from org A landed
    });

    it("per-row tenant validation refuses a forged top-level organizationId even when the migration-owner pool bypasses RLS", async () => {
        const { orgId: orgA } = await seedOrg("Org A");
        const { orgId: orgB, userId: userB } = await seedOrg("Org B");
        const artifactFromA = await backupStore.exportTenant(orgA);

        // A maliciously (or buggily) reconstructed artifact that lies
        // about its own top-level organizationId to slip past
        // executeRestore's first check — its per-row `organization_id`
        // columns still say org A, since that's real exported data. The
        // store validates those discriminators explicitly because the
        // migration-owner connection legitimately bypasses RLS; the
        // runtime role's RLS remains an additional boundary.
        const forged = { ...artifactFromA, organizationId: orgB };
        const proposed = await backupStore.proposeRestore(orgB, forged, userB, actorFor(userB));
        await expect(backupStore.approveRestore(orgB, proposed.id, actorFor(userB))).rejects.toBeInstanceOf(TenantRestoreExecutionError);

        const orgBUsers = await pool.query("SELECT id FROM users WHERE organization_id = $1", [orgB]);
        expect(orgBUsers.rows).toHaveLength(1); // only orgB's own seed user — nothing from org A landed
    });

    it("an identity shared across organizations survives a restore untouched if it changed after the backup", async () => {
        const { orgId: orgA, userId: userA } = await seedOrg("Org A");
        const membershipA = await pool.query<{ identity_id: string }>("SELECT identity_id FROM memberships WHERE user_id = $1", [userA]);
        const identityId = membershipA.rows[0].identity_id;

        const artifact = await backupStore.exportTenant(orgA);
        expect(artifact.tables.identities).toHaveLength(1);

        // A change to the shared identity happens *after* the backup —
        // e.g. the person updated their display name via a different
        // organization's membership, or a profile sync.
        await pool.query("UPDATE identities SET display_name = 'Updated After Backup' WHERE id = $1", [identityId]);

        const proposed = await backupStore.proposeRestore(orgA, artifact, userA, actorFor(userA));
        await backupStore.approveRestore(orgA, proposed.id, actorFor(userA));

        const identityAfter = await pool.query<{ display_name: string }>("SELECT display_name FROM identities WHERE id = $1", [identityId]);
        expect(identityAfter.rows[0].display_name).toBe("Updated After Backup"); // never reverted by the restore
    });

    it("audit_log/audit_chain_state restore preserves sequence and hashes exactly, and the chain correctly continues on the next write", async () => {
        const { orgId, userId } = await seedOrg("Org A");
        // seedOrg's own createOrganization/createUser/createPolicy calls
        // already wrote several chained audit_log rows for this org.
        const beforeChain = await pool.query<{ sequence: string }>(
            "SELECT sequence FROM audit_log WHERE organization_id = $1 ORDER BY sequence::bigint DESC LIMIT 1",
            [orgId]
        );
        const lastSequenceBeforeWipe = BigInt(beforeChain.rows[0].sequence);

        const artifact = await backupStore.exportTenant(orgId);
        await pool.query("DELETE FROM audit_log WHERE organization_id = $1", [orgId]);
        await pool.query("DELETE FROM audit_chain_state WHERE chain_key = $1", [orgId]);

        const proposed = await backupStore.proposeRestore(orgId, artifact, userId, actorFor(userId));
        await backupStore.approveRestore(orgId, proposed.id, actorFor(userId));

        const chainState = await pool.query<{ sequence: string }>("SELECT sequence FROM audit_chain_state WHERE chain_key = $1", [orgId]);
        // approveRestore appends its own audited decision immediately after
        // restoring the captured chain tip.
        expect(BigInt(chainState.rows[0].sequence)).toBe(lastSequenceBeforeWipe + 1n);

        // A brand-new mutation after restore must continue the real chain,
        // not restart it at 1 (which would collide with restored rows).
        const client = await pool.connect();
        try {
            await client.query("BEGIN");
            await insertAuditEntry(client, {
                organizationId: orgId, actorUserId: userId, actorExternalSubject: "idp|post-restore",
                action: "test.postRestoreWrite", targetType: "test", targetId: "1",
            });
            await client.query("COMMIT");
        } finally {
            client.release();
        }
        const newest = await pool.query<{ sequence: string }>(
            "SELECT sequence FROM audit_log WHERE organization_id = $1 ORDER BY sequence::bigint DESC LIMIT 1",
            [orgId]
        );
        expect(BigInt(newest.rows[0].sequence)).toBe(lastSequenceBeforeWipe + 2n);
    });

    it("restoring the same artifact twice is idempotent — no duplicate rows, no error", async () => {
        const { orgId, userId } = await seedOrg("Org A");
        const artifact = await backupStore.exportTenant(orgId);

        const first = await backupStore.proposeRestore(orgId, artifact, userId, actorFor(userId));
        await backupStore.approveRestore(orgId, first.id, actorFor(userId));
        const second = await backupStore.proposeRestore(orgId, artifact, userId, actorFor(userId));
        expect(second.summary.users.willInsert).toBe(0);
        expect(second.summary.users.alreadyPresent).toBe(1);
        const approvedSecond = await backupStore.approveRestore(orgId, second.id, actorFor(userId));
        expect(approvedSecond?.status).toBe("completed"); // no unique-violation, no error

        const users = await pool.query("SELECT id FROM users WHERE organization_id = $1", [orgId]);
        expect(users.rows).toHaveLength(1); // still exactly one row, not duplicated
    });

    it("rejecting a pending request never executes it", async () => {
        const { orgId, userId } = await seedOrg("Org A");
        const artifact = await backupStore.exportTenant(orgId);
        await pool.query("DELETE FROM users WHERE organization_id = $1 AND id != $2", [orgId, userId]);

        const proposed = await backupStore.proposeRestore(orgId, artifact, userId, actorFor(userId));
        const rejected = await backupStore.rejectRestore(orgId, proposed.id, "Not needed.", actorFor(userId));
        expect(rejected?.status).toBe("rejected");

        const stillPending = await backupStore.getRestoreRequest(orgId, proposed.id);
        expect(stillPending?.status).toBe("rejected");
        expect(await backupStore.approveRestore(orgId, proposed.id, actorFor(userId))).toBeNull(); // not_pending, refuses
    });
});
