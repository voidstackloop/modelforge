import type { Pool } from "pg";
import type { IdempotencyRecord, IdempotencyStore } from "./idempotency-store.js";

/** Matches InMemoryIdempotencyStore's horizon — see that file's doc comment. */
const RECORD_TTL_MS = 24 * 60 * 60 * 1000;

interface IdempotencyRow {
    request_hash: string;
    status_code: number;
    response_body: unknown;
    created_at: Date;
}

/**
 * Real, Postgres-backed IdempotencyStore. Not run against a real Postgres
 * instance in the environment this was built in — see server/README.md and
 * this package's other postgres-*.test.ts files, all gated on DATABASE_URL.
 *
 * Expiry is lazy: `get` treats a row older than RECORD_TTL_MS as absent
 * (and opportunistically deletes it) rather than requiring a scheduled
 * sweep job. A row nobody ever retries against just sits there until an
 * operator's own retention policy cleans it up — see the migration's
 * `idx_idempotency_keys_created_at` index, added for exactly that future
 * cleanup query.
 */
export class PostgresIdempotencyStore implements IdempotencyStore {
    constructor(private readonly pool: Pool) {}

    async get(organizationId: string, key: string): Promise<IdempotencyRecord | null> {
        const client = await this.pool.connect();
        try {
        await client.query("BEGIN");
        await client.query("SELECT set_config('app.tenant_id', $1, true)", [organizationId]);
        const result = await client.query<IdempotencyRow>(
            "SELECT request_hash, status_code, response_body, created_at FROM idempotency_keys WHERE organization_id = $1 AND idempotency_key = $2",
            [organizationId, key]
        );
        const row = result.rows[0];
        if (!row) { await client.query("COMMIT"); return null; }
        if (Date.now() - row.created_at.getTime() > RECORD_TTL_MS) {
            // Best-effort: a concurrent caller racing this delete just sees
            // "no record" too and proceeds fresh, same outcome either way.
            await client.query("DELETE FROM idempotency_keys WHERE organization_id = $1 AND idempotency_key = $2", [organizationId, key]);
            await client.query("COMMIT");
            return null;
        }
        await client.query("COMMIT");
        return { requestHash: row.request_hash, statusCode: row.status_code, responseBody: row.response_body };
        } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
    }

    async put(organizationId: string, key: string, record: IdempotencyRecord): Promise<void> {
        const client = await this.pool.connect();
        try {
        await client.query("BEGIN");
        await client.query("SELECT set_config('app.tenant_id', $1, true)", [organizationId]);
        await client.query(
            `INSERT INTO idempotency_keys (organization_id, idempotency_key, request_hash, status_code, response_body)
             VALUES ($1, $2, $3, $4, $5)
             ON CONFLICT (organization_id, idempotency_key) DO UPDATE
                SET request_hash = $3, status_code = $4, response_body = $5, created_at = now()`,
            [organizationId, key, record.requestHash, record.statusCode, JSON.stringify(record.responseBody)]
        );
        await client.query("COMMIT");
        } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
    }
}
