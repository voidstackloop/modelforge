import { randomUUID } from "node:crypto";
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { Pool, type PoolClient } from "pg";
import type { AuditActor } from "./audit-store.js";
import { runMigrations } from "./migrate.js";
import { PostgresIamStore } from "./postgres-iam-store.js";
import { schemaNameForTenant, type TenantContext } from "../tenant-context.js";
import { POLICY_DOCUMENT_VERSION } from "../domain/policy-evaluator.js";

// Same disclosure as the other postgres-*.test.ts files in this directory:
// no Postgres instance was reachable in the environment this was written
// in, so these tests have not actually been executed anywhere in this
// session. Unlike the others, this file also needs RUNTIME_DATABASE_URL —
// a role that is actually NO BYPASSRLS and doesn't own the tables it
// queries (see migrations/010_runtime_role_grants.sql and .github/
// workflows/ci.yml's "Create restricted runtime database role" step).
// Without a real restricted role, testing RLS would either be impossible
// (DATABASE_URL's owner role bypasses it by definition) or, worse, give a
// false sense of security by "passing" for the wrong reason. Run for real
// with both DATABASE_URL and RUNTIME_DATABASE_URL set before relying on
// tenant_isolation policies in production.
const DATABASE_URL = process.env.DATABASE_URL;
const RUNTIME_DATABASE_URL = process.env.RUNTIME_DATABASE_URL;

const ACTOR: AuditActor = { externalSubject: "idp|test-actor", userId: randomUUID() };

async function withTenant<T>(pool: Pool, tenantId: string | null, fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await pool.connect();
    try {
        if (tenantId) await client.query("SELECT set_config('app.tenant_id', $1, false)", [tenantId]);
        return await fn(client);
    } finally {
        await client.query("RESET app.tenant_id").catch(() => {});
        client.release();
    }
}

describe.skipIf(!DATABASE_URL || !RUNTIME_DATABASE_URL)(
    "Tenant isolation under the restricted runtime role (integration — requires DATABASE_URL + RUNTIME_DATABASE_URL)",
    () => {
        let ownerPool: Pool;
        let runtimePool: Pool;
        let iamStore: PostgresIamStore;
        let orgA: string;
        let orgB: string;
        let userA: string;
        let userB: string;

        beforeAll(async () => {
            ownerPool = new Pool({ connectionString: DATABASE_URL });
            await runMigrations(ownerPool);
            runtimePool = new Pool({ connectionString: RUNTIME_DATABASE_URL });
            iamStore = new PostgresIamStore(ownerPool);
        });

        afterAll(async () => {
            await ownerPool.end();
            await runtimePool.end();
        });

        beforeEach(async () => {
            // audit_chain_state is truncated alongside audit_log so the two
            // never disagree: leaving chain state behind after wiping the
            // rows it describes would make the next write chain from a tip
            // that no longer exists (migrations/013, store/audit-store.ts).
            await ownerPool.query("TRUNCATE organizations, patient_cases, case_version_counters, audit_log, audit_chain_state CASCADE");
            orgA = (await iamStore.createOrganization("Org A", ACTOR)).id;
            orgB = (await iamStore.createOrganization("Org B", ACTOR)).id;
            userA = (await iamStore.bindTenant(contextFor(orgA)).createUser({ externalSubject: "user-a", displayName: "User A" }, ACTOR)).id;
            userB = (await iamStore.bindTenant(contextFor(orgB)).createUser({ externalSubject: "user-b", displayName: "User B" }, ACTOR)).id;
        });

        function contextFor(organizationId: string): TenantContext {
            return { organizationId, schemaName: schemaNameForTenant(organizationId), issuer: "https://issuer.test", subject: "subject" };
        }

        it("the runtime role is NOSUPERUSER, NOBYPASSRLS, NOCREATEDB, and cannot create a schema", async () => {
            const role = await runtimePool.query<{ rolsuper: boolean; rolbypassrls: boolean; rolcreatedb: boolean }>(
                "SELECT rolsuper, rolbypassrls, rolcreatedb FROM pg_roles WHERE rolname = current_user"
            );
            expect(role.rows[0]).toEqual({ rolsuper: false, rolbypassrls: false, rolcreatedb: false });
            await expect(runtimePool.query("CREATE SCHEMA attempted_by_runtime_role")).rejects.toThrow(/permission denied/i);
        });

        it("the runtime role cannot UPDATE audit_log rows (P1: immutable audit ingestion — migrations/013)", async () => {
            const existing = await ownerPool.query<{ id: string }>("SELECT id FROM audit_log LIMIT 1");
            await expect(
                runtimePool.query("UPDATE audit_log SET action = 'tampered' WHERE id = $1", [existing.rows[0].id])
            ).rejects.toThrow(/permission denied/i);
        });

        it("the runtime role cannot DELETE audit_log rows (P1: immutable audit ingestion — migrations/013)", async () => {
            const existing = await ownerPool.query<{ id: string }>("SELECT id FROM audit_log LIMIT 1");
            await expect(runtimePool.query("DELETE FROM audit_log WHERE id = $1", [existing.rows[0].id])).rejects.toThrow(
                /permission denied/i
            );
        });

        it("hides every row of a shared control-plane table when app.tenant_id is unset", async () => {
            const rows = await withTenant(runtimePool, null, (client) => client.query("SELECT id FROM users"));
            expect(rows.rows).toEqual([]);
        });

        it("a tenant-scoped read sees only its own organization's rows, never the other's", async () => {
            const rows = await withTenant(runtimePool, orgA, (client) => client.query<{ id: string }>("SELECT id FROM users"));
            expect(rows.rows.map((r) => r.id)).toEqual([userA]);
        });

        it("rejects an insert claiming a different organization than app.tenant_id (WITH CHECK)", async () => {
            await expect(
                withTenant(runtimePool, orgA, (client) =>
                    client.query(
                        "INSERT INTO users (id, organization_id, external_subject, display_name, status, created_at, updated_at) VALUES ($1, $2, 'forged', 'Forged User', 'active', now(), now())",
                        [randomUUID(), orgB]
                    )
                )
            ).rejects.toThrow(/row-level security/i);
        });

        it("an update scoped to app.tenant_id cannot reach another organization's row, and leaves it untouched", async () => {
            const result = await withTenant(runtimePool, orgA, (client) =>
                client.query("UPDATE users SET display_name = 'hacked' WHERE id = $1", [userB])
            );
            expect(result.rowCount).toBe(0);
            const stillB = await ownerPool.query<{ display_name: string }>("SELECT display_name FROM users WHERE id = $1", [userB]);
            expect(stillB.rows[0].display_name).toBe("User B");
        });

        it("a cross-table join cannot surface another organization's rows through the relationship, either", async () => {
            const policyA = await iamStore.bindTenant(contextFor(orgA)).createPolicy(
                { name: "PolicyA", document: { version: POLICY_DOCUMENT_VERSION, statements: [{ effect: "Allow", actions: ["*"], resources: ["*"] }] } },
                ACTOR
            );
            await iamStore.bindTenant(contextFor(orgA)).updateUser(userA, { policyIds: [policyA.id] }, ACTOR);
            const rows = await withTenant(runtimePool, orgB, (client) =>
                client.query(
                    `SELECT u.id FROM users u JOIN user_policies up ON up.user_id = u.id WHERE up.policy_id = $1`,
                    [policyA.id]
                )
            );
            expect(rows.rows).toEqual([]);
        });

        it("bindTenant's pooled-connection reset prevents tenant context from leaking across a reused connection", async () => {
            // max: 1 forces the exact same physical connection to be reused
            // across these sequential bindTenant calls — the scenario a
            // shared request pool hits constantly under real load, not just
            // a one-off unlucky reuse.
            const smallRuntimePool = new Pool({ connectionString: RUNTIME_DATABASE_URL, max: 1 });
            try {
                const runtimeIamStore = new PostgresIamStore(smallRuntimePool);
                const usersInA = await runtimeIamStore.bindTenant(contextFor(orgA)).listUsers();
                expect(usersInA.map((u) => u.id)).toEqual([userA]);

                const usersInB = await runtimeIamStore.bindTenant(contextFor(orgB)).listUsers();
                expect(usersInB.map((u) => u.id)).toEqual([userB]);

                const raw = await smallRuntimePool.connect();
                try {
                    const setting = await raw.query<{ tenant_id: string | null }>("SELECT current_setting('app.tenant_id', true) AS tenant_id");
                    expect(setting.rows[0].tenant_id).toBeFalsy();
                } finally {
                    raw.release();
                }
            } finally {
                await smallRuntimePool.end();
            }
        });

        it("deleteOrganization's FK-cascade cleanup fully removes cascaded rows even though it never sets app.tenant_id", async () => {
            // deleteOrganization (postgres-iam-store.ts) is deliberately a
            // plain, untenanted DELETE — its own doc comment explains why:
            // it's compensating cleanup for a bootstrap that never
            // finished, so there is no membership yet to authorize a
            // tenant-scoped connection with. Under RLS, "no app.tenant_id
            // set" normally means "see nothing" for an ordinary query —
            // this proves that does not silently leave orphaned rows
            // behind, because Postgres documents FK-triggered cascade
            // actions as bypassing row security entirely (to preserve
            // referential integrity), independent of the deleting
            // session's own RLS visibility.
            const runtimeIamStore = new PostgresIamStore(runtimePool);
            await runtimeIamStore.deleteOrganization(orgA);
            const remainingUsers = await ownerPool.query("SELECT 1 FROM users WHERE organization_id = $1", [orgA]);
            expect(remainingUsers.rows).toEqual([]);
            const remainingOrg = await ownerPool.query("SELECT 1 FROM organizations WHERE id = $1", [orgA]);
            expect(remainingOrg.rows).toEqual([]);
        });
    }
);
