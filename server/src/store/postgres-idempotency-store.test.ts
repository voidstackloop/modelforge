import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { Pool } from "pg";
import type { AuditActor } from "./audit-store.js";
import { runMigrations } from "./migrate.js";
import { PostgresIamStore } from "./postgres-iam-store.js";
import { PostgresIdempotencyStore } from "./postgres-idempotency-store.js";

// Same disclosure as postgres-case-store.test.ts: gated on DATABASE_URL,
// skipped (not failed) when absent — no Postgres instance was reachable in
// the environment this was written in, so these tests have not actually
// been executed anywhere in this session. Run them for real before relying
// on PostgresIdempotencyStore in production.
const DATABASE_URL = process.env.DATABASE_URL;
const ACTOR: AuditActor = { externalSubject: "idp|test-actor" };

describe.skipIf(!DATABASE_URL)("PostgresIdempotencyStore (integration — requires DATABASE_URL)", () => {
    let pool: Pool;
    let iamStore: PostgresIamStore;
    let store: PostgresIdempotencyStore;
    let orgId: string;

    beforeAll(async () => {
        pool = new Pool({ connectionString: DATABASE_URL });
        await runMigrations(pool);
        iamStore = new PostgresIamStore(pool);
        store = new PostgresIdempotencyStore(pool);
    });

    afterAll(async () => {
        await pool.end();
    });

    beforeEach(async () => {
        await pool.query("TRUNCATE organizations, idempotency_keys, audit_log, audit_chain_state CASCADE");
        orgId = (await iamStore.createOrganization("Org", ACTOR)).id;
    });

    it("returns null for a key that was never put", async () => {
        expect(await store.get(orgId, "missing")).toBeNull();
    });

    it("returns a put record verbatim, including a JSONB response body", async () => {
        await store.put(orgId, "key-1", { requestHash: "h1", statusCode: 201, responseBody: { id: "case-1", nested: { ok: true } } });
        expect(await store.get(orgId, "key-1")).toEqual({
            requestHash: "h1",
            statusCode: 201,
            responseBody: { id: "case-1", nested: { ok: true } },
        });
    });

    it("put overwrites an existing key's record (create-or-replace, not merge)", async () => {
        await store.put(orgId, "key-1", { requestHash: "h1", statusCode: 201, responseBody: { v: 1 } });
        await store.put(orgId, "key-1", { requestHash: "h2", statusCode: 200, responseBody: { v: 2 } });
        expect(await store.get(orgId, "key-1")).toEqual({ requestHash: "h2", statusCode: 200, responseBody: { v: 2 } });
    });

    it("scopes keys by organization — the same key in a different org is a separate record", async () => {
        const otherOrgId = (await iamStore.createOrganization("Other Org", ACTOR)).id;
        await store.put(orgId, "shared-key", { requestHash: "h1", statusCode: 201, responseBody: { org: "first" } });
        await store.put(otherOrgId, "shared-key", { requestHash: "h1", statusCode: 201, responseBody: { org: "second" } });

        expect(await store.get(orgId, "shared-key")).toMatchObject({ responseBody: { org: "first" } });
        expect(await store.get(otherOrgId, "shared-key")).toMatchObject({ responseBody: { org: "second" } });
    });

    it("deleting the organization cascades to its idempotency keys (ON DELETE CASCADE)", async () => {
        await store.put(orgId, "key-1", { requestHash: "h1", statusCode: 201, responseBody: {} });
        await pool.query("DELETE FROM organizations WHERE id = $1", [orgId]);
        const row = await pool.query("SELECT 1 FROM idempotency_keys WHERE organization_id = $1", [orgId]);
        expect(row.rows).toHaveLength(0);
    });

    it("treats a row older than 24h as absent and cleans it up on read", async () => {
        await store.put(orgId, "key-1", { requestHash: "h1", statusCode: 201, responseBody: {} });
        await pool.query("UPDATE idempotency_keys SET created_at = now() - interval '25 hours' WHERE organization_id = $1 AND idempotency_key = $2", [
            orgId,
            "key-1",
        ]);

        expect(await store.get(orgId, "key-1")).toBeNull();
        const row = await pool.query("SELECT 1 FROM idempotency_keys WHERE organization_id = $1 AND idempotency_key = $2", [orgId, "key-1"]);
        expect(row.rows).toHaveLength(0); // the expired row was deleted, not just hidden
    });
});
