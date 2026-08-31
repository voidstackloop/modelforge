import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Pool } from "pg";

// Resolves to server/migrations/ regardless of whether this runs from
// src/ (tsx, dev/test) or dist/ (compiled) — both are exactly two
// directories under the server/ package root (src/store or dist/store).
function migrationsDir(): string {
    const here = dirname(fileURLToPath(import.meta.url));
    return join(here, "..", "..", "migrations");
}

/**
 * Applies every `*.sql` file in server/migrations/, in filename order, that
 * hasn't already been recorded in `schema_migrations` — each migration runs
 * inside its own transaction, and its filename is recorded only after it
 * commits, so a failed migration never gets silently marked applied. Safe
 * to call on every process start (idempotent): a fresh database applies
 * everything, a database already at the latest migration is a no-op.
 */
export async function runMigrations(pool: Pool): Promise<{ applied: string[] }> {
    await pool.query(
        `CREATE TABLE IF NOT EXISTS schema_migrations (
            filename TEXT PRIMARY KEY,
            applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )`
    );

    const alreadyApplied = new Set((await pool.query<{ filename: string }>("SELECT filename FROM schema_migrations")).rows.map((r) => r.filename));

    const files = readdirSync(migrationsDir())
        .filter((f) => f.endsWith(".sql"))
        .sort();

    const applied: string[] = [];
    for (const file of files) {
        if (alreadyApplied.has(file)) continue;
        const sql = readFileSync(join(migrationsDir(), file), "utf-8");
        const client = await pool.connect();
        try {
            await client.query("BEGIN");
            await client.query(sql);
            await client.query("INSERT INTO schema_migrations (filename) VALUES ($1)", [file]);
            await client.query("COMMIT");
            applied.push(file);
        } catch (err) {
            await client.query("ROLLBACK");
            throw new Error(`Migration ${file} failed: ${(err as Error).message}`, { cause: err });
        } finally {
            client.release();
        }
    }

    return { applied };
}
