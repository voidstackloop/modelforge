import { createHash, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type { TenantBackupArtifact, TenantRestoreRequest, TenantRestoreRequestStatus } from "../domain/types.js";
import { schemaNameForTenant } from "../tenant-context.js";
import { type AuditActor, insertAuditEntry } from "./audit-store.js";

/**
 * Enterprise backup, PITR, and tenant-scoped restore (P1 backlog item 6) —
 * an on-demand, application-level export/reconciliation-restore tool, not
 * real continuous PITR (WAL archiving is infrastructure this codebase has
 * no authority to provision — docs/ENTERPRISE_ARCHITECTURE_ROADMAP.md
 * §19). No `pg_dump`/`pg_restore` shell-out either: this server has never
 * shelled out to an external binary, and requiring `postgresql-client` in
 * whatever container runs it would be an undisclosed new deployment
 * assumption. Everything here goes through the same `pg` client already
 * used everywhere else.
 *
 * RESTORE SEMANTICS — read before touching this file: every table is
 * restored via `INSERT ... ON CONFLICT (...) DO NOTHING`, uniformly, no
 * per-table exceptions. This is deliberate, not a simplification I'd like
 * to "improve" later:
 *   - It can never regress a row that already exists — a naive "always
 *     overwrite" restore could silently revert `authorization_epochs`
 *     (a monotonic cache-invalidation counter — see store/iam-store.ts's
 *     doc comment; regressing it could let a stale cached policy decision
 *     look current again) or resurrect a released legal hold / already-
 *     decided access-review item to a stale prior state.
 *   - `audit_log` specifically must never be touched once a row exists —
 *     "audit is never rolled back or deleted" is a guarantee this
 *     codebase makes elsewhere (migration 013 revoked DELETE on audit_log
 *     from the runtime role for exactly this reason); a restore tool
 *     overwriting an existing audit row would quietly break that promise.
 *   - `identities` are genuinely cross-tenant (no `organization_id`
 *     column — one identity can hold memberships in other organizations
 *     this backup knows nothing about), so this tool can never legitimately
 *     claim the right to overwrite one.
 * The cost: this tool recovers data that's missing (deleted, corrupted,
 * lost) — it cannot roll back legitimate changes made after the backup was
 * taken. That's a real scope boundary, disclosed to the approver in
 * `summary` at propose time, not just in this comment.
 *
 * `audit_chain_state` is deliberately NOT part of the exported artifact at
 * all — restoreAuditChainState (below) derives it directly from whatever
 * `audit_log` rows exist for the org *after* restore, taking the highest
 * `sequence` found. This is more robust than trusting either the backup's
 * own recorded chain tip or an existing-row check: if audit_log already
 * has rows beyond what this backup captured (a corrupted chain_state row
 * gets fixed, not resurrected to a stale, too-low value that would then
 * collide with sequences already in use).
 */
export interface TenantBackupStore {
    exportTenant(organizationId: string): Promise<TenantBackupArtifact>;
    proposeRestore(
        organizationId: string,
        artifact: TenantBackupArtifact,
        proposedByUserId: string,
        actor: AuditActor
    ): Promise<TenantRestoreRequest>;
    listRestoreRequests(organizationId: string): Promise<TenantRestoreRequest[]>;
    getRestoreRequest(organizationId: string, requestId: string): Promise<TenantRestoreRequest | null>;
    /** Returns null if the request doesn't exist or isn't pending —
     * routes/tenant-backup.ts pre-checks the same thing for a clean 400;
     * this is defense in depth. */
    approveRestore(organizationId: string, requestId: string, actor: AuditActor): Promise<TenantRestoreRequest | null>;
    rejectRestore(organizationId: string, requestId: string, reason: string | undefined, actor: AuditActor): Promise<TenantRestoreRequest | null>;
    /** Called by routes/tenant-backup.ts as a separate follow-up write
     * after approveRestore throws TenantRestoreExecutionError — the
     * request's own transaction already rolled back (that's what "failure
     * rolls back everything" means), so recording the failure can only
     * happen in a fresh one. No-ops (does not throw) if the request is no
     * longer pending, since a concurrent decision could have already
     * moved it — this is a best-effort failure annotation, not itself a
     * source of truth callers should retry on. */
    markRestoreFailed(organizationId: string, requestId: string, errorMessage: string): Promise<void>;
}

// --- Table inventory (verified against every migration this session) -------
//
// Deliberately excludes: `case_version_counters` and public-schema
// `patient_cases` (migration 002) — confirmed dead, nothing in current
// store code reads or writes either, superseded by migration 009's
// per-tenant-schema versions; `idempotency_keys` — a short-lived replay-
// dedup cache, not durable business data.

interface TableSpec {
    table: string;
    columns: string[];
    conflictColumns: string[];
    /** Parameterized with $1 = organizationId. */
    exportSql: string;
}

const PUBLIC_TABLES: TableSpec[] = [
    {
        table: "organizations",
        columns: ["id", "name", "created_at", "tenant_schema"],
        conflictColumns: ["id"],
        exportSql: "SELECT id, name, created_at, tenant_schema FROM organizations WHERE id = $1",
    },
    {
        // Genuinely cross-tenant (no organization_id column) — exported via
        // this org's memberships, restored via ON CONFLICT (issuer,
        // subject) DO NOTHING (never overwritten — see this file's own
        // doc comment).
        table: "identities",
        columns: ["id", "issuer", "subject", "display_name", "email", "created_at", "updated_at"],
        conflictColumns: ["issuer", "subject"],
        exportSql: `SELECT DISTINCT i.id, i.issuer, i.subject, i.display_name, i.email, i.created_at, i.updated_at
                    FROM identities i JOIN memberships m ON m.identity_id = i.id WHERE m.organization_id = $1`,
    },
    {
        table: "policies",
        columns: ["id", "organization_id", "name", "description", "document", "builtin", "is_break_glass_policy", "created_at", "updated_at"],
        conflictColumns: ["id"],
        exportSql:
            "SELECT id, organization_id, name, description, document, builtin, is_break_glass_policy, created_at, updated_at FROM policies WHERE organization_id = $1",
    },
    {
        table: "groups",
        columns: ["id", "organization_id", "name", "created_at", "updated_at"],
        conflictColumns: ["id"],
        exportSql: "SELECT id, organization_id, name, created_at, updated_at FROM groups WHERE organization_id = $1",
    },
    {
        table: "users",
        columns: ["id", "organization_id", "external_subject", "display_name", "email", "status", "permission_boundary_policy_id", "created_at", "updated_at"],
        conflictColumns: ["id"],
        exportSql:
            "SELECT id, organization_id, external_subject, display_name, email, status, permission_boundary_policy_id, created_at, updated_at FROM users WHERE organization_id = $1",
    },
    {
        table: "group_policies",
        columns: ["group_id", "policy_id"],
        conflictColumns: ["group_id", "policy_id"],
        exportSql: "SELECT gp.group_id, gp.policy_id FROM group_policies gp JOIN groups g ON g.id = gp.group_id WHERE g.organization_id = $1",
    },
    {
        table: "user_groups",
        columns: ["user_id", "group_id"],
        conflictColumns: ["user_id", "group_id"],
        exportSql: "SELECT ug.user_id, ug.group_id FROM user_groups ug JOIN users u ON u.id = ug.user_id WHERE u.organization_id = $1",
    },
    {
        table: "user_policies",
        columns: ["user_id", "policy_id"],
        conflictColumns: ["user_id", "policy_id"],
        exportSql: "SELECT up.user_id, up.policy_id FROM user_policies up JOIN users u ON u.id = up.user_id WHERE u.organization_id = $1",
    },
    {
        table: "memberships",
        columns: ["id", "organization_id", "identity_id", "user_id", "status", "provisioning_source", "starts_at", "expires_at", "created_at", "updated_at"],
        conflictColumns: ["id"],
        exportSql:
            "SELECT id, organization_id, identity_id, user_id, status, provisioning_source, starts_at, expires_at, created_at, updated_at FROM memberships WHERE organization_id = $1",
    },
    {
        table: "invitations",
        columns: ["id", "organization_id", "email", "display_name", "status", "token_hash", "invited_by_user_id", "expires_at", "accepted_at", "created_at", "updated_at"],
        conflictColumns: ["id"],
        exportSql:
            "SELECT id, organization_id, email, display_name, status, token_hash, invited_by_user_id, expires_at, accepted_at, created_at, updated_at FROM invitations WHERE organization_id = $1",
    },
    {
        table: "service_principals",
        columns: ["id", "organization_id", "issuer", "external_subject", "display_name", "status", "policy_ids", "permission_boundary_policy_id", "created_at", "updated_at"],
        conflictColumns: ["id"],
        exportSql:
            "SELECT id, organization_id, issuer, external_subject, display_name, status, policy_ids, permission_boundary_policy_id, created_at, updated_at FROM service_principals WHERE organization_id = $1",
    },
    {
        table: "authorization_epochs",
        columns: ["organization_id", "epoch"],
        conflictColumns: ["organization_id"],
        exportSql: "SELECT organization_id, epoch FROM authorization_epochs WHERE organization_id = $1",
    },
    {
        table: "policy_versions",
        columns: ["id", "policy_id", "organization_id", "version", "document", "content_hash", "status", "proposed_by_user_id", "proposed_at", "decided_by_user_id", "decided_at", "rejection_reason"],
        conflictColumns: ["id"],
        exportSql:
            "SELECT id, policy_id, organization_id, version, document, content_hash, status, proposed_by_user_id, proposed_at, decided_by_user_id, decided_at, rejection_reason FROM policy_versions WHERE organization_id = $1",
    },
    {
        table: "break_glass_grants",
        columns: ["id", "organization_id", "user_id", "emergency_policy_id", "justification", "granted_at", "expires_at", "reviewed_by_user_id", "reviewed_at", "review_outcome", "created_at"],
        conflictColumns: ["id"],
        exportSql:
            "SELECT id, organization_id, user_id, emergency_policy_id, justification, granted_at, expires_at, reviewed_by_user_id, reviewed_at, review_outcome, created_at FROM break_glass_grants WHERE organization_id = $1",
    },
    {
        table: "access_review_campaigns",
        columns: ["id", "organization_id", "created_by_user_id", "status", "created_at", "completed_at"],
        conflictColumns: ["id"],
        exportSql: "SELECT id, organization_id, created_by_user_id, status, created_at, completed_at FROM access_review_campaigns WHERE organization_id = $1",
    },
    {
        table: "access_review_items",
        columns: ["id", "campaign_id", "organization_id", "membership_id", "subject_user_id", "decision", "decided_by_user_id", "decided_at", "created_at"],
        conflictColumns: ["id"],
        exportSql:
            "SELECT id, campaign_id, organization_id, membership_id, subject_user_id, decision, decided_by_user_id, decided_at, created_at FROM access_review_items WHERE organization_id = $1",
    },
    {
        table: "audit_legal_holds",
        columns: ["id", "organization_id", "reason", "status", "placed_by_user_id", "placed_at", "released_by_user_id", "released_at", "release_reason"],
        conflictColumns: ["id"],
        exportSql:
            "SELECT id, organization_id, reason, status, placed_by_user_id, placed_at, released_by_user_id, released_at, release_reason FROM audit_legal_holds WHERE organization_id = $1",
    },
    {
        // Never updated on conflict, deliberately — see this file's own
        // doc comment. audit_chain_state is reconciled separately, after
        // this table is restored — see restoreAuditChainState.
        table: "audit_log",
        columns: ["id", "organization_id", "actor_user_id", "actor_external_subject", "action", "target_type", "target_id", "details", "created_at", "sequence", "prev_hash", "entry_hash"],
        conflictColumns: ["id"],
        exportSql:
            "SELECT id, organization_id, actor_user_id, actor_external_subject, action, target_type, target_id, details, created_at, sequence, prev_hash, entry_hash FROM audit_log WHERE organization_id = $1",
    },
];

// Per-tenant-schema tables (provision_tenant_clinical_schema, migrations
// 009/010) — schema-qualified at use via schemaNameForTenant(organizationId).
// No organization_id column on any of these; the schema itself is the
// tenant boundary (see this session's own table-inventory research: "N/A
// (RLS not used; isolation is structural via separate schema)").
const TENANT_SCHEMA_TABLES: TableSpec[] = [
    {
        table: "patient_cases",
        columns: ["case_id", "version", "data", "patient_id", "owner_user_id", "workspace_id", "department_id", "assigned_user_ids", "active_consent_scopes", "staged_migration_id", "active", "updated_at"],
        conflictColumns: ["case_id"],
        exportSql: "", // schema-qualified at call time, see exportTenantSchemaTable
    },
    {
        table: "case_change_counter",
        columns: ["singleton", "next_sequence"],
        conflictColumns: ["singleton"],
        exportSql: "",
    },
    {
        table: "case_changes",
        columns: ["sequence", "kind", "case_id", "version", "patient_case", "resource", "changed_at"],
        conflictColumns: ["sequence"],
        exportSql: "",
    },
    {
        table: "case_migrations",
        columns: ["id", "status", "source_fingerprint", "total_items", "accepted_items", "preview", "created_by", "created_at", "updated_at"],
        conflictColumns: ["id"],
        exportSql: "",
    },
    {
        table: "case_migration_items",
        columns: ["migration_id", "item_key", "case_id", "data", "data_hash", "status", "errors"],
        conflictColumns: ["migration_id", "item_key"],
        exportSql: "",
    },
];

function digest(value: unknown): string {
    return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

interface TableRow {
    [column: string]: unknown;
}

function insertSql(spec: TableSpec, schema?: string): string {
    const table = schema ? `"${schema}".${spec.table}` : spec.table;
    const placeholders = spec.columns.map((_, i) => `$${i + 1}`).join(", ");
    return `INSERT INTO ${table} (${spec.columns.join(", ")}) VALUES (${placeholders}) ON CONFLICT (${spec.conflictColumns.join(", ")}) DO NOTHING`;
}

/** Postgres-backed. Not run against a real Postgres instance in the
 * environment this was built in — see server/README.md and this package's
 * other postgres-*.test.ts files, all gated on DATABASE_URL. */
export class PostgresTenantBackupStore implements TenantBackupStore {
    constructor(private readonly pool: Pool) {}

    private async tenantRead<T>(organizationId: string, query: (client: PoolClient) => Promise<T>): Promise<T> {
        const client = await this.pool.connect();
        try {
            await client.query("BEGIN");
            await client.query("SELECT set_config('app.tenant_id', $1, true)", [organizationId]);
            const result = await query(client);
            await client.query("COMMIT");
            return result;
        } catch (error) {
            await client.query("ROLLBACK");
            throw error;
        } finally {
            client.release();
        }
    }

    async exportTenant(organizationId: string): Promise<TenantBackupArtifact> {
        return this.tenantRead(organizationId, async (client) => {
            const tables: Record<string, TableRow[]> = {};
            for (const spec of PUBLIC_TABLES) {
                const result = await client.query<TableRow>(spec.exportSql, [organizationId]);
                tables[spec.table] = result.rows;
            }

            const org = await client.query<{ tenant_schema: string | null }>("SELECT tenant_schema FROM organizations WHERE id = $1", [
                organizationId,
            ]);
            const tenantSchema = org.rows[0]?.tenant_schema;
            if (tenantSchema) {
                for (const spec of TENANT_SCHEMA_TABLES) {
                    const result = await client.query<TableRow>(`SELECT ${spec.columns.join(", ")} FROM "${tenantSchema}".${spec.table}`);
                    tables[spec.table] = result.rows;
                }
            }
            // An org with no tenant_schema yet (never fully bootstrapped —
            // see this session's own research: tenant_schema is set lazily
            // by provision_tenant_clinical_schema, not guaranteed present)
            // simply has no per-tenant-schema tables in the artifact —
            // there is no clinical data to back up for it yet.

            return { organizationId, exportedAt: new Date().toISOString(), tables };
        });
    }

    /** Counts, per table, how many of the artifact's rows already exist
     * live (by conflict-key columns) — restore's actual DO-NOTHING
     * semantics mean this IS the real diff: `willInsert` rows are added,
     * `alreadyPresent` rows are untouched no-ops. Read-only; never mutates. */
    private async computeSummary(
        client: PoolClient,
        organizationId: string,
        artifact: TenantBackupArtifact
    ): Promise<Record<string, { willInsert: number; alreadyPresent: number }>> {
        const summary: Record<string, { willInsert: number; alreadyPresent: number }> = {};
        const allSpecs = [...PUBLIC_TABLES, ...TENANT_SCHEMA_TABLES];
        const org = await client.query<{ tenant_schema: string | null }>("SELECT tenant_schema FROM organizations WHERE id = $1", [
            organizationId,
        ]);
        const tenantSchema = org.rows[0]?.tenant_schema;

        for (const spec of allSpecs) {
            const rows = (artifact.tables[spec.table] as TableRow[] | undefined) ?? [];
            if (rows.length === 0) {
                summary[spec.table] = { willInsert: 0, alreadyPresent: 0 };
                continue;
            }
            const isTenantSchemaTable = TENANT_SCHEMA_TABLES.includes(spec);
            if (isTenantSchemaTable && !tenantSchema) {
                summary[spec.table] = { willInsert: rows.length, alreadyPresent: 0 };
                continue;
            }
            const table = isTenantSchemaTable ? `"${tenantSchema}".${spec.table}` : spec.table;
            const keyArrays = spec.conflictColumns.map((col) => rows.map((row) => row[col]));
            const unnestArgs = spec.conflictColumns.map((_, i) => `$${i + 1}::text[]`).join(", ");
            const joinCondition = spec.conflictColumns.map((col, i) => `t.${col}::text = v.c${i}`).join(" AND ");
            const selectCols = spec.conflictColumns.map((_, i) => `c${i}`).join(", ");
            const existing = await client.query(
                `SELECT COUNT(*)::int AS count FROM ${table} t JOIN (SELECT ${selectCols} FROM unnest(${unnestArgs}) AS v(${selectCols})) v ON ${joinCondition}`,
                keyArrays
            );
            const alreadyPresent = Number((existing.rows[0] as { count: number }).count);
            summary[spec.table] = { willInsert: rows.length - alreadyPresent, alreadyPresent };
        }
        return summary;
    }

    async proposeRestore(
        organizationId: string,
        artifact: TenantBackupArtifact,
        proposedByUserId: string,
        actor: AuditActor
    ): Promise<TenantRestoreRequest> {
        return this.tenantRead(organizationId, async (client) => {
            const summary = await this.computeSummary(client, organizationId, artifact);
            const id = randomUUID();
            const requestedAt = new Date();
            const result = await client.query<RequestRow>(
                `INSERT INTO tenant_restore_requests (id, organization_id, status, artifact, artifact_checksum, summary, requested_by_user_id, requested_at)
                 VALUES ($1, $2, 'pending', $3, $4, $5, $6, $7) RETURNING *`,
                [id, organizationId, JSON.stringify(artifact), digest(artifact), JSON.stringify(summary), proposedByUserId, requestedAt]
            );
            await insertAuditEntry(client, {
                organizationId, actorUserId: actor.userId, actorExternalSubject: actor.externalSubject,
                action: "tenantBackup.proposeRestore", targetType: "tenantRestoreRequest", targetId: id, details: { summary },
            });
            return mapRequest(result.rows[0]);
        });
    }

    async listRestoreRequests(organizationId: string): Promise<TenantRestoreRequest[]> {
        return this.tenantRead(organizationId, async (client) => {
            const result = await client.query<RequestRow>(
                "SELECT * FROM tenant_restore_requests WHERE organization_id = $1 ORDER BY requested_at DESC",
                [organizationId]
            );
            return result.rows.map(mapRequest);
        });
    }

    async getRestoreRequest(organizationId: string, requestId: string): Promise<TenantRestoreRequest | null> {
        return this.tenantRead(organizationId, async (client) => {
            const result = await client.query<RequestRow>("SELECT * FROM tenant_restore_requests WHERE organization_id = $1 AND id = $2", [
                organizationId,
                requestId,
            ]);
            return result.rows[0] ? mapRequest(result.rows[0]) : null;
        });
    }

    async approveRestore(organizationId: string, requestId: string, actor: AuditActor): Promise<TenantRestoreRequest | null> {
        return this.tenantRead(organizationId, async (client) => {
            const existing = await client.query<RequestRow>(
                "SELECT * FROM tenant_restore_requests WHERE organization_id = $1 AND id = $2 AND status = 'pending' FOR UPDATE",
                [organizationId, requestId]
            );
            if (!existing.rows[0]) return null;
            const artifact = existing.rows[0].artifact;

            try {
                await this.executeRestore(client, organizationId, artifact);
                const completed = await client.query<RequestRow>(
                    `UPDATE tenant_restore_requests SET status='completed', decided_by_user_id=$3, decided_at=$4, completed_at=$4
                     WHERE organization_id=$1 AND id=$2 RETURNING *`,
                    [organizationId, requestId, actor.userId, new Date()]
                );
                await insertAuditEntry(client, {
                    organizationId, actorUserId: actor.userId, actorExternalSubject: actor.externalSubject,
                    action: "tenantBackup.approveRestore", targetType: "tenantRestoreRequest", targetId: requestId, details: {},
                });
                return mapRequest(completed.rows[0]);
            } catch (err) {
                // Re-thrown after recording failure in a SEPARATE
                // transaction (this one is about to roll back) — the
                // caller (routes/tenant-backup.ts) is responsible for
                // that follow-up write; see its own comment on why it
                // can't happen inside this same client/transaction.
                throw new TenantRestoreExecutionError(requestId, (err as Error).message);
            }
        });
    }

    async rejectRestore(organizationId: string, requestId: string, reason: string | undefined, actor: AuditActor): Promise<TenantRestoreRequest | null> {
        return this.tenantRead(organizationId, async (client) => {
            const result = await client.query<RequestRow>(
                `UPDATE tenant_restore_requests SET status='rejected', decided_by_user_id=$3, decided_at=$4, rejection_reason=$5
                 WHERE organization_id=$1 AND id=$2 AND status='pending' RETURNING *`,
                [organizationId, requestId, actor.userId, new Date(), reason ?? null]
            );
            if (!result.rows[0]) return null;
            await insertAuditEntry(client, {
                organizationId, actorUserId: actor.userId, actorExternalSubject: actor.externalSubject,
                action: "tenantBackup.rejectRestore", targetType: "tenantRestoreRequest", targetId: requestId, details: { reason },
            });
            return mapRequest(result.rows[0]);
        });
    }

    async markRestoreFailed(organizationId: string, requestId: string, errorMessage: string): Promise<void> {
        await this.tenantRead(organizationId, async (client) => {
            await client.query(
                `UPDATE tenant_restore_requests SET status='failed', completed_at=$3, error_message=$4
                 WHERE organization_id=$1 AND id=$2 AND status='pending'`,
                [organizationId, requestId, new Date(), errorMessage]
            );
        });
    }

    /** The actual restore — every table via INSERT ... ON CONFLICT DO
     * NOTHING (see this file's top doc comment for why), in FK-dependency
     * order, inside the caller's already-open transaction/connection (so a
     * failure partway through rolls back everything, never a partial
     * restore). app.tenant_id is already set by tenantRead's wrapper, so
     * every RLS-enabled table's WITH CHECK clause independently enforces
     * that nothing written here can land under a different organization_id
     * than the one this restore was invoked for — the roadmap's own named
     * "cross-tenant restore attempts" test exercises exactly this. */
    private async executeRestore(client: PoolClient, organizationId: string, artifact: TenantBackupArtifact): Promise<void> {
        if (artifact.organizationId !== organizationId) {
            throw new Error("Artifact organizationId does not match the target organization — refusing to restore.");
        }
        // The migration-owner pool legitimately bypasses RLS, so RLS cannot
        // be the only cross-tenant restore boundary. Validate every explicit
        // tenant discriminator in the signed artifact before any insert.
        // Relationship-only tables are then constrained by the validated
        // users/groups/policies they reference and by their foreign keys.
        for (const spec of PUBLIC_TABLES) {
            const rows = (artifact.tables[spec.table] as TableRow[] | undefined) ?? [];
            for (const row of rows) {
                if (spec.table === "organizations" && row.id !== organizationId) {
                    throw new Error("Artifact contains an organization row for a different tenant — refusing to restore.");
                }
                if ("organization_id" in row && row.organization_id !== organizationId) {
                    throw new Error(`Artifact table ${spec.table} contains a row for a different tenant — refusing to restore.`);
                }
            }
        }
        for (const spec of PUBLIC_TABLES) {
            const rows = (artifact.tables[spec.table] as TableRow[] | undefined) ?? [];
            for (const row of rows) {
                await client.query(insertSql(spec), spec.columns.map((col) => row[col] ?? null));
            }
        }
        await this.restoreAuditChainState(client, organizationId);

        const org = await client.query<{ tenant_schema: string | null }>("SELECT tenant_schema FROM organizations WHERE id = $1", [
            organizationId,
        ]);
        const tenantSchema = org.rows[0]?.tenant_schema;
        if (tenantSchema) {
            // schemaNameForTenant validates format; tenant_schema in the DB
            // is always produced by that same function or an equivalent
            // literal (migration 007), never user input — still validated
            // here rather than trusted, matching postgres-case-migration-
            // store.ts's own schemaSql() precedent for schema identifiers.
            if (schemaNameForTenant(organizationId) !== tenantSchema) {
                throw new Error("Tenant schema name does not match the expected derivation — refusing to restore into it.");
            }
            for (const spec of TENANT_SCHEMA_TABLES) {
                const rows = (artifact.tables[spec.table] as TableRow[] | undefined) ?? [];
                for (const row of rows) {
                    await client.query(insertSql(spec, tenantSchema), spec.columns.map((col) => row[col] ?? null));
                }
            }
        }
    }

    /** Derives audit_chain_state from the live audit_log table's actual
     * max-sequence row for this org, AFTER audit_log itself has been
     * restored — see this file's top doc comment for why this is more
     * robust than restoring chain_state from the artifact directly. */
    private async restoreAuditChainState(client: PoolClient, organizationId: string): Promise<void> {
        await client.query(
            `INSERT INTO audit_chain_state (chain_key, sequence, entry_hash)
             SELECT $1::text, al.sequence, al.entry_hash FROM audit_log al
             WHERE al.organization_id = $1::uuid AND al.sequence IS NOT NULL
             ORDER BY al.sequence::bigint DESC LIMIT 1
             ON CONFLICT (chain_key) DO UPDATE
             SET sequence = EXCLUDED.sequence, entry_hash = EXCLUDED.entry_hash
             WHERE EXCLUDED.sequence::bigint > audit_chain_state.sequence::bigint`,
            [organizationId]
        );
    }
}

export class TenantRestoreExecutionError extends Error {
    constructor(
        public readonly requestId: string,
        reason: string
    ) {
        super(`Restore execution failed for request ${requestId}: ${reason}`);
        this.name = "TenantRestoreExecutionError";
    }
}

interface RequestRow {
    id: string;
    organization_id: string;
    status: TenantRestoreRequestStatus;
    artifact: TenantBackupArtifact;
    artifact_checksum: string;
    summary: Record<string, { willInsert: number; alreadyPresent: number }>;
    requested_by_user_id: string;
    requested_at: Date;
    decided_by_user_id: string | null;
    decided_at: Date | null;
    rejection_reason: string | null;
    completed_at: Date | null;
    error_message: string | null;
}

function mapRequest(row: RequestRow): TenantRestoreRequest {
    return {
        id: row.id,
        organizationId: row.organization_id,
        status: row.status,
        summary: row.summary,
        requestedByUserId: row.requested_by_user_id,
        requestedAt: row.requested_at.toISOString(),
        decidedByUserId: row.decided_by_user_id ?? undefined,
        decidedAt: row.decided_at?.toISOString(),
        rejectionReason: row.rejection_reason ?? undefined,
        completedAt: row.completed_at?.toISOString(),
        errorMessage: row.error_message ?? undefined,
    };
}

/**
 * In-memory — deliberately minimal/best-effort, not a real backup path.
 * In-memory mode is already disclosed everywhere in this codebase as
 * "everything lost on restart" (server/README.md); building full
 * cross-store export/import parity with the Postgres implementation would
 * harden a mode this project has never treated as durable. This exists so
 * the app.test.ts dual-control workflow (propose/approve/reject/
 * permissions) is exercisable without a real database, exactly like every
 * other governance feature's in-memory counterpart — it does not attempt
 * to actually move data between stores.
 */
export class InMemoryTenantBackupStore implements TenantBackupStore {
    private readonly requests = new Map<string, TenantRestoreRequest & { artifact: TenantBackupArtifact }>();

    constructor(private readonly auditStore: { record: (entry: Parameters<typeof insertAuditEntry>[1]) => Promise<void> }) {}

    async exportTenant(organizationId: string): Promise<TenantBackupArtifact> {
        return { organizationId, exportedAt: new Date().toISOString(), tables: {} };
    }

    async proposeRestore(organizationId: string, artifact: TenantBackupArtifact, proposedByUserId: string, actor: AuditActor): Promise<TenantRestoreRequest> {
        const summary: Record<string, { willInsert: number; alreadyPresent: number }> = {};
        for (const [table, rows] of Object.entries(artifact.tables)) summary[table] = { willInsert: (rows as unknown[]).length, alreadyPresent: 0 };
        const request: TenantRestoreRequest & { artifact: TenantBackupArtifact } = {
            id: randomUUID(), organizationId, status: "pending", summary,
            requestedByUserId: proposedByUserId, requestedAt: new Date().toISOString(), artifact,
        };
        this.requests.set(request.id, request);
        await this.auditStore.record({
            organizationId, actorUserId: actor.userId, actorExternalSubject: actor.externalSubject,
            action: "tenantBackup.proposeRestore", targetType: "tenantRestoreRequest", targetId: request.id, details: { summary },
        });
        return stripArtifact(request);
    }

    async listRestoreRequests(organizationId: string): Promise<TenantRestoreRequest[]> {
        return [...this.requests.values()].filter((r) => r.organizationId === organizationId).map(stripArtifact).sort((a, b) => (a.requestedAt < b.requestedAt ? 1 : -1));
    }

    async getRestoreRequest(organizationId: string, requestId: string): Promise<TenantRestoreRequest | null> {
        const request = this.requests.get(requestId);
        return request && request.organizationId === organizationId ? stripArtifact(request) : null;
    }

    async approveRestore(organizationId: string, requestId: string, actor: AuditActor): Promise<TenantRestoreRequest | null> {
        const request = this.requests.get(requestId);
        if (!request || request.organizationId !== organizationId || request.status !== "pending") return null;
        const updated = { ...request, status: "completed" as const, decidedByUserId: actor.userId, decidedAt: new Date().toISOString(), completedAt: new Date().toISOString() };
        this.requests.set(requestId, updated);
        await this.auditStore.record({
            organizationId, actorUserId: actor.userId, actorExternalSubject: actor.externalSubject,
            action: "tenantBackup.approveRestore", targetType: "tenantRestoreRequest", targetId: requestId, details: {},
        });
        return stripArtifact(updated);
    }

    async rejectRestore(organizationId: string, requestId: string, reason: string | undefined, actor: AuditActor): Promise<TenantRestoreRequest | null> {
        const request = this.requests.get(requestId);
        if (!request || request.organizationId !== organizationId || request.status !== "pending") return null;
        const updated = { ...request, status: "rejected" as const, decidedByUserId: actor.userId, decidedAt: new Date().toISOString(), rejectionReason: reason };
        this.requests.set(requestId, updated);
        await this.auditStore.record({
            organizationId, actorUserId: actor.userId, actorExternalSubject: actor.externalSubject,
            action: "tenantBackup.rejectRestore", targetType: "tenantRestoreRequest", targetId: requestId, details: { reason },
        });
        return stripArtifact(updated);
    }

    async markRestoreFailed(organizationId: string, requestId: string, errorMessage: string): Promise<void> {
        const request = this.requests.get(requestId);
        if (!request || request.organizationId !== organizationId || request.status !== "pending") return;
        this.requests.set(requestId, { ...request, status: "failed", completedAt: new Date().toISOString(), errorMessage });
    }
}

function stripArtifact(request: TenantRestoreRequest & { artifact: TenantBackupArtifact }): TenantRestoreRequest {
    const { artifact: _artifact, ...rest } = request;
    return rest;
}
