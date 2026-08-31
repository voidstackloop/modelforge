import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { Pool } from "pg";
import type { AuditActor } from "./audit-store.js";
import { runMigrations } from "./migrate.js";
import { PostgresIamStore } from "./postgres-iam-store.js";
import { InvalidReferenceError } from "./iam-store.js";
import { POLICY_DOCUMENT_VERSION } from "../domain/policy-evaluator.js";
import type { PolicyDocument } from "../domain/types.js";

// Integration tests against a *real* Postgres — deliberately not run
// against a mock or an in-memory SQL engine, since the whole point is to
// verify the actual SQL in postgres-iam-store.ts and migrations/001_init.sql
// against a real server. Skipped (not failed) when DATABASE_URL isn't set,
// following the same honest-disclosure pattern this monorepo already uses
// for its Playwright e2e suite ("wasn't run in the environment this was
// built in — no GUI available"): no Postgres instance was reachable in the
// environment this file was written in, so these tests have not actually
// been executed anywhere in this session. Run them (`DATABASE_URL=postgres://...
// npm test`) against a real instance before relying on PostgresIamStore in
// production — the SQL has been reviewed carefully but not proven by
// execution.
const DATABASE_URL = process.env.DATABASE_URL;

function allowAllDocument(): PolicyDocument {
    return { version: POLICY_DOCUMENT_VERSION, statements: [{ effect: "Allow", actions: ["*"], resources: ["*"] }] };
}

// Every mutation now requires an AuditActor (see iam-store.ts's doc
// comment) — none of these tests are about auditing itself, so one shared
// dummy actor covers every call site here.
const ACTOR: AuditActor = { externalSubject: "idp|test-actor" };

describe.skipIf(!DATABASE_URL)("PostgresIamStore (integration — requires DATABASE_URL)", () => {
    let pool: Pool;
    let store: PostgresIamStore;

    beforeAll(async () => {
        pool = new Pool({ connectionString: DATABASE_URL });
        await runMigrations(pool);
        store = new PostgresIamStore(pool);
    });

    afterAll(async () => {
        await pool.end();
    });

    beforeEach(async () => {
        // TRUNCATE ... CASCADE clears every join table transitively —
        // faster and simpler than per-table DELETE ordering for a test
        // fixture reset between cases.
        await pool.query(
            "TRUNCATE organizations, users, groups, policies, user_groups, user_policies, group_policies, authorization_epochs, audit_log, audit_chain_state CASCADE"
        );
    });

    it("runMigrations is idempotent — a second run against an already-migrated database applies nothing", async () => {
        const result = await runMigrations(pool);
        expect(result.applied).toEqual([]);
    });

    it("creates an organization and reads it back by id", async () => {
        const org = await store.createOrganization("Example Health System", ACTOR);
        expect(await store.getOrganization(org.id)).toEqual(org);
    });

    it("returns null for an unknown organization/user/group/policy id", async () => {
        expect(await store.getOrganization("00000000-0000-0000-0000-000000000000")).toBeNull();
        expect(await store.getUser("00000000-0000-0000-0000-000000000000")).toBeNull();
        expect(await store.getGroup("00000000-0000-0000-0000-000000000000")).toBeNull();
        expect(await store.getPolicy("00000000-0000-0000-0000-000000000000")).toBeNull();
    });

    it("findUserByExternalSubject is scoped per organization — the same subject in two orgs is two distinct users", async () => {
        const orgA = await store.createOrganization("Org A", ACTOR);
        const orgB = await store.createOrganization("Org B", ACTOR);
        const userA = await store.createUser(
            { organizationId: orgA.id, externalSubject: "idp|shared-subject", displayName: "Dr. Shared" },
            ACTOR
        );
        const userB = await store.createUser(
            { organizationId: orgB.id, externalSubject: "idp|shared-subject", displayName: "Dr. Shared" },
            ACTOR
        );

        expect(userA.id).not.toBe(userB.id);
        expect((await store.findUserByExternalSubject(orgA.id, "idp|shared-subject"))?.id).toBe(userA.id);
        expect((await store.findUserByExternalSubject(orgB.id, "idp|shared-subject"))?.id).toBe(userB.id);
    });

    it("createUser with initial groupIds/policyIds persists the associations", async () => {
        const org = await store.createOrganization("Org", ACTOR);
        const policy = await store.createPolicy({ organizationId: org.id, name: "P", document: allowAllDocument() }, ACTOR);
        const group = await store.createGroup({ organizationId: org.id, name: "G", policyIds: [policy.id] }, ACTOR);
        const user = await store.createUser(
            {
                organizationId: org.id,
                externalSubject: "idp|x",
                displayName: "X",
                groupIds: [group.id],
                policyIds: [policy.id],
            },
            ACTOR
        );

        const reloaded = await store.getUser(user.id);
        expect(reloaded?.groupIds).toEqual([group.id]);
        expect(reloaded?.policyIds).toEqual([policy.id]);
    });

    it("updateUser replaces groupIds/policyIds atomically when provided, and leaves them alone when omitted", async () => {
        const org = await store.createOrganization("Org", ACTOR);
        const policyA = await store.createPolicy({ organizationId: org.id, name: "A", document: allowAllDocument() }, ACTOR);
        const policyB = await store.createPolicy({ organizationId: org.id, name: "B", document: allowAllDocument() }, ACTOR);
        const user = await store.createUser(
            { organizationId: org.id, externalSubject: "idp|x", displayName: "X", policyIds: [policyA.id] },
            ACTOR
        );

        const afterDisplayNameChange = await store.updateUser(user.id, { displayName: "Renamed" }, ACTOR);
        expect(afterDisplayNameChange?.policyIds).toEqual([policyA.id]); // untouched, since policyIds wasn't in the partial

        const afterPolicySwap = await store.updateUser(user.id, { policyIds: [policyB.id] }, ACTOR);
        expect(afterPolicySwap?.policyIds).toEqual([policyB.id]); // fully replaced, not merged/appended
        expect(afterPolicySwap?.displayName).toBe("Renamed");
    });

    it("createUser rejects a policyId/groupId belonging to a different organization, and persists nothing", async () => {
        const orgA = await store.createOrganization("Org A", ACTOR);
        const orgB = await store.createOrganization("Org B", ACTOR);
        const foreignPolicy = await store.createPolicy({ organizationId: orgB.id, name: "Foreign", document: allowAllDocument() }, ACTOR);

        await expect(
            store.createUser({ organizationId: orgA.id, externalSubject: "idp|x", displayName: "X", policyIds: [foreignPolicy.id] }, ACTOR)
        ).rejects.toThrow(InvalidReferenceError);

        const users = await store.listUsersByOrganization(orgA.id);
        expect(users).toHaveLength(0); // the whole transaction rolled back, not just the association
    });

    it("updateUser rejects attaching a policyId belonging to a different organization", async () => {
        const orgA = await store.createOrganization("Org A", ACTOR);
        const orgB = await store.createOrganization("Org B", ACTOR);
        const user = await store.createUser({ organizationId: orgA.id, externalSubject: "idp|x", displayName: "X" }, ACTOR);
        const foreignPolicy = await store.createPolicy({ organizationId: orgB.id, name: "Foreign", document: allowAllDocument() }, ACTOR);

        await expect(store.updateUser(user.id, { policyIds: [foreignPolicy.id] }, ACTOR)).rejects.toThrow(InvalidReferenceError);
        expect((await store.getUser(user.id))?.policyIds).toEqual([]);
    });

    it("createGroup/updateGroup reject a policyId belonging to a different organization", async () => {
        const orgA = await store.createOrganization("Org A", ACTOR);
        const orgB = await store.createOrganization("Org B", ACTOR);
        const foreignPolicy = await store.createPolicy({ organizationId: orgB.id, name: "Foreign", document: allowAllDocument() }, ACTOR);

        await expect(store.createGroup({ organizationId: orgA.id, name: "G", policyIds: [foreignPolicy.id] }, ACTOR)).rejects.toThrow(
            InvalidReferenceError
        );

        const group = await store.createGroup({ organizationId: orgA.id, name: "G" }, ACTOR);
        await expect(store.updateGroup(group.id, { policyIds: [foreignPolicy.id] }, ACTOR)).rejects.toThrow(InvalidReferenceError);
    });

    it("deletePolicy refuses to delete a builtin policy, allows a non-builtin one", async () => {
        const org = await store.createOrganization("Org", ACTOR);
        const builtin = await store.createPolicy({ organizationId: org.id, name: "Builtin", document: allowAllDocument(), builtin: true }, ACTOR);
        const custom = await store.createPolicy({ organizationId: org.id, name: "Custom", document: allowAllDocument() }, ACTOR);

        expect(await store.deletePolicy(builtin.id, ACTOR)).toBe(false);
        expect(await store.getPolicy(builtin.id)).not.toBeNull();

        expect(await store.deletePolicy(custom.id, ACTOR)).toBe(true);
        expect(await store.getPolicy(custom.id)).toBeNull();
    });

    it("resolveEffectivePolicies unions direct and group-attached policies, de-duplicated", async () => {
        const org = await store.createOrganization("Org", ACTOR);
        const shared = await store.createPolicy({ organizationId: org.id, name: "Shared", document: allowAllDocument() }, ACTOR);
        const directOnly = await store.createPolicy({ organizationId: org.id, name: "DirectOnly", document: allowAllDocument() }, ACTOR);
        const group = await store.createGroup({ organizationId: org.id, name: "G", policyIds: [shared.id] }, ACTOR);
        const user = await store.createUser(
            {
                organizationId: org.id,
                externalSubject: "idp|x",
                displayName: "X",
                groupIds: [group.id],
                policyIds: [shared.id, directOnly.id],
            },
            ACTOR
        );

        const effective = await store.resolveEffectivePolicies(user.id);
        expect(effective.map((p) => p.id).sort()).toEqual([directOnly.id, shared.id].sort());
    });

    it("deleting an organization cascades to its users/groups/policies (ON DELETE CASCADE)", async () => {
        const org = await store.createOrganization("Org to delete", ACTOR);
        const policy = await store.createPolicy({ organizationId: org.id, name: "P", document: allowAllDocument() }, ACTOR);
        const user = await store.createUser({ organizationId: org.id, externalSubject: "idp|x", displayName: "X" }, ACTOR);

        await pool.query("DELETE FROM organizations WHERE id = $1", [org.id]);

        expect(await store.getPolicy(policy.id)).toBeNull();
        expect(await store.getUser(user.id)).toBeNull();
    });

    describe("permissionBoundaryPolicyId (see domain/types.ts's userSchema doc comment)", () => {
        it("createUser persists and reads back a same-organization boundary", async () => {
            const org = await store.createOrganization("Org", ACTOR);
            const policy = await store.createPolicy({ organizationId: org.id, name: "Boundary", document: allowAllDocument() }, ACTOR);
            const user = await store.createUser(
                {
                    organizationId: org.id,
                    externalSubject: "idp|x",
                    displayName: "X",
                    permissionBoundaryPolicyId: policy.id,
                },
                ACTOR
            );
            expect(user.permissionBoundaryPolicyId).toBe(policy.id);
            expect((await store.getUser(user.id))?.permissionBoundaryPolicyId).toBe(policy.id);
        });

        it("updateUser sets and persists a boundary on an existing user", async () => {
            const org = await store.createOrganization("Org", ACTOR);
            const policy = await store.createPolicy({ organizationId: org.id, name: "Boundary", document: allowAllDocument() }, ACTOR);
            const user = await store.createUser({ organizationId: org.id, externalSubject: "idp|x", displayName: "X" }, ACTOR);

            await store.updateUser(user.id, { permissionBoundaryPolicyId: policy.id }, ACTOR);
            expect((await store.getUser(user.id))?.permissionBoundaryPolicyId).toBe(policy.id);
        });

        it("rejects a permissionBoundaryPolicyId belonging to a different organization", async () => {
            const orgA = await store.createOrganization("Org A", ACTOR);
            const orgB = await store.createOrganization("Org B", ACTOR);
            const foreignPolicy = await store.createPolicy({ organizationId: orgB.id, name: "Foreign", document: allowAllDocument() }, ACTOR);

            await expect(
                store.createUser(
                    {
                        organizationId: orgA.id,
                        externalSubject: "idp|x",
                        displayName: "X",
                        permissionBoundaryPolicyId: foreignPolicy.id,
                    },
                    ACTOR
                )
            ).rejects.toThrow(InvalidReferenceError);
        });

        it("deleting the referenced policy leaves the reference dangling, not nulled out (fails closed, per the field's doc comment)", async () => {
            const org = await store.createOrganization("Org", ACTOR);
            const policy = await store.createPolicy({ organizationId: org.id, name: "Boundary", document: allowAllDocument() }, ACTOR);
            const user = await store.createUser(
                {
                    organizationId: org.id,
                    externalSubject: "idp|x",
                    displayName: "X",
                    permissionBoundaryPolicyId: policy.id,
                },
                ACTOR
            );

            await store.deletePolicy(policy.id, ACTOR);

            expect((await store.getUser(user.id))?.permissionBoundaryPolicyId).toBe(policy.id); // still set, now dangling
            expect(await store.getPolicy(policy.id)).toBeNull(); // genuinely gone — routes/guards.ts must fail closed on this combination
        });
    });

    describe("getAuthorizationEpoch (see iam-store.ts's doc comment)", () => {
        it("starts at 1 for an organization with no row yet", async () => {
            const org = await store.createOrganization("Fresh Org", ACTOR);
            expect(await store.getAuthorizationEpoch(org.id)).toBe(1);
        });

        it("updatePolicy bumps the epoch, atomically with the mutation (lazily creating the row)", async () => {
            const org = await store.createOrganization("Org", ACTOR);
            const policy = await store.createPolicy({ organizationId: org.id, name: "P", document: allowAllDocument() }, ACTOR);
            await store.updatePolicy(policy.id, { name: "Renamed" }, ACTOR);
            expect(await store.getAuthorizationEpoch(org.id)).toBe(2);
        });

        it("deletePolicy bumps the epoch", async () => {
            const org = await store.createOrganization("Org", ACTOR);
            const policy = await store.createPolicy({ organizationId: org.id, name: "P", document: allowAllDocument() }, ACTOR);
            await store.deletePolicy(policy.id, ACTOR);
            expect(await store.getAuthorizationEpoch(org.id)).toBe(2);
        });

        it("updateGroup bumps the epoch", async () => {
            const org = await store.createOrganization("Org", ACTOR);
            const group = await store.createGroup({ organizationId: org.id, name: "G" }, ACTOR);
            await store.updateGroup(group.id, { name: "Renamed" }, ACTOR);
            expect(await store.getAuthorizationEpoch(org.id)).toBe(2);
        });

        it("updateUser does NOT bump the epoch", async () => {
            const org = await store.createOrganization("Org", ACTOR);
            const user = await store.createUser({ organizationId: org.id, externalSubject: "idp|x", displayName: "X" }, ACTOR);
            await store.updateUser(user.id, { displayName: "Renamed" }, ACTOR);
            expect(await store.getAuthorizationEpoch(org.id)).toBe(1);
        });

        it("a failed updatePolicy (e.g. an invalid partial) does not advance the epoch — bump and mutation commit or roll back together", async () => {
            const org = await store.createOrganization("Org", ACTOR);
            const policy = await store.createPolicy({ organizationId: org.id, name: "P", document: allowAllDocument() }, ACTOR);
            // updatePolicy on a nonexistent id returns null without ever
            // opening a transaction — confirms the epoch is untouched by a
            // no-op, not just by a genuine rollback (which would need a
            // real constraint violation to trigger from the outside).
            expect(await store.updatePolicy("00000000-0000-0000-0000-000000000000", { name: "X" }, ACTOR)).toBeNull();
            expect(await store.getAuthorizationEpoch(org.id)).toBe(1);
            expect(await store.getPolicy(policy.id)).not.toBeNull();
        });

        it("deleting an organization cascades to its authorization_epochs row (ON DELETE CASCADE)", async () => {
            const org = await store.createOrganization("Org to delete", ACTOR);
            const policy = await store.createPolicy({ organizationId: org.id, name: "P", document: allowAllDocument() }, ACTOR);
            await store.updatePolicy(policy.id, { name: "Renamed" }, ACTOR); // creates the epoch row
            await pool.query("DELETE FROM organizations WHERE id = $1", [org.id]);
            const row = await pool.query("SELECT 1 FROM authorization_epochs WHERE organization_id = $1", [org.id]);
            expect(row.rows).toHaveLength(0);
        });
    });

    describe("audit log (see store/audit-store.ts's doc comment)", () => {
        it("createOrganization writes an audit_log row inside the same transaction", async () => {
            const org = await store.createOrganization("Org", { externalSubject: "idp|creator" });
            const rows = await pool.query("SELECT * FROM audit_log WHERE organization_id = $1", [org.id]);
            expect(rows.rows).toHaveLength(1);
            expect(rows.rows[0].action).toBe("organization.create");
            expect(rows.rows[0].actor_external_subject).toBe("idp|creator");
            expect(rows.rows[0].actor_user_id).toBeNull(); // no User exists yet at bootstrap
        });

        it("createUser/updateUser/deletePolicy each write their own audit row with the acting user's id", async () => {
            const org = await store.createOrganization("Org", ACTOR);
            const actorUser = await store.createUser({ organizationId: org.id, externalSubject: "idp|admin", displayName: "Admin" }, ACTOR);
            const asAdmin: AuditActor = { externalSubject: "idp|admin", userId: actorUser.id, organizationId: org.id };

            const target = await store.createUser({ organizationId: org.id, externalSubject: "idp|target", displayName: "Target" }, asAdmin);
            await store.updateUser(target.id, { displayName: "Renamed" }, asAdmin);
            const policy = await store.createPolicy({ organizationId: org.id, name: "P", document: allowAllDocument() }, asAdmin);
            await store.deletePolicy(policy.id, asAdmin);

            const rows = await pool.query("SELECT action, actor_user_id, target_id FROM audit_log WHERE organization_id = $1 ORDER BY created_at", [
                org.id,
            ]);
            const actions = rows.rows.map((r: { action: string }) => r.action);
            expect(actions).toContain("user.update");
            expect(actions).toContain("policy.create");
            expect(actions).toContain("policy.delete");
            for (const row of rows.rows) {
                if (row.action === "user.update" || row.action === "policy.create" || row.action === "policy.delete") {
                    expect(row.actor_user_id).toBe(actorUser.id);
                }
            }
        });

        it("a rolled-back mutation (e.g. an invalid policyId reference) writes no audit row", async () => {
            const orgA = await store.createOrganization("Org A", ACTOR);
            const orgB = await store.createOrganization("Org B", ACTOR);
            const foreignPolicy = await store.createPolicy({ organizationId: orgB.id, name: "Foreign", document: allowAllDocument() }, ACTOR);

            await expect(
                store.createUser({ organizationId: orgA.id, externalSubject: "idp|x", displayName: "X", policyIds: [foreignPolicy.id] }, ACTOR)
            ).rejects.toThrow(InvalidReferenceError);

            const rows = await pool.query("SELECT 1 FROM audit_log WHERE organization_id = $1 AND action = 'user.create'", [orgA.id]);
            expect(rows.rows).toHaveLength(0); // the whole transaction rolled back, audit row included
        });

        it("does not delete an audit row when its organization is deleted (no ON DELETE CASCADE, unlike every other per-organization table)", async () => {
            const org = await store.createOrganization("Org to delete", ACTOR);
            await pool.query("DELETE FROM organizations WHERE id = $1", [org.id]);
            const rows = await pool.query("SELECT 1 FROM audit_log WHERE organization_id = $1", [org.id]);
            expect(rows.rows).toHaveLength(1); // the create-organization audit row survives its own subject's deletion
        });
    });
});
