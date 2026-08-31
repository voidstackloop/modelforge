import { createHash, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type { AuthorizationPrincipal, User } from "../domain/types.js";
import { auditWriteDuration, auditWriteTotal, startTimer } from "../metrics.js";

/**
 * Identifies who performed a mutation, for the audit log. `externalSubject`
 * (the OIDC `sub` claim) is always present — the one thing that survives
 * even a since-deleted User record. `userId`/`organizationId` are absent
 * only for the org-bootstrap action (POST /organizations, IamStore.
 * createOrganization), which precedes any User record or organization
 * existing to attribute the action to.
 */
export interface AuditActor {
    externalSubject: string;
    userId?: string;
    organizationId?: string;
}

/** Builds the AuditActor for every route except POST /organizations (which
 * has no `caller: User` yet — see organizations.ts's own bootstrap-specific
 * actor construction) — the common case, once requireOrgUser has already
 * resolved the caller. */
export function actorFrom(caller: AuthorizationPrincipal | User): AuditActor {
    return { externalSubject: caller.externalSubject, userId: caller.id, organizationId: caller.organizationId };
}

export interface AuditLogEntry {
    organizationId: string | undefined;
    actorUserId: string | undefined;
    actorExternalSubject: string;
    /** Dot-separated `<resource>.<verb>`, e.g. "organization.create",
     * "user.update", "policy.delete" — a fixed, small vocabulary this
     * codebase controls (never a caller-supplied string), unlike policy
     * action strings which are open-ended by design. */
    action: string;
    targetType: string;
    targetId: string;
    /** Caller-supplied additional detail (e.g. which fields changed on an
     * update) — deliberately never a full policy document or patient-case
     * payload; see each write site's own comment for exactly what it
     * includes. This is an audit trail of *that a change happened*, not a
     * second copy of the data itself. */
    details?: Record<string, unknown>;
}

export interface StoredAuditLogEntry extends AuditLogEntry {
    id: string;
    createdAt: string;
    /**
     * Chain fields (P1: immutable audit ingestion — see verifyChainEntries
     * below). Absent only for rows written before this organization's chain
     * existed, i.e. audit_log rows from before migration 013 ran against an
     * already-populated database — every fresh environment (local dev, CI,
     * a brand-new deployment) has none of these, since the chain applies
     * from the very first write onward. `sequence` is a decimal string, not
     * a number, to avoid float-precision loss on a BIGINT column — same
     * convention as postgres-case-store.ts's own `sequence`/`version`
     * fields.
     */
    sequence?: string;
    entryHash?: string;
    prevHash?: string;
}

/** Search/pagination for `AuditStore.listByOrganization` — every field
 * optional and omitting `filters` entirely preserves the pre-P1-item-4
 * behavior exactly (return the org's full unpaginated history), so no
 * existing caller or test needed to change. `cursor` pairs with the
 * default newest-first order: "give me entries with a strictly smaller
 * sequence than this," i.e. continue further back in history — the
 * natural semantics for a "load more" button on a list that starts at the
 * newest entry. */
export interface AuditSearchFilters {
    action?: string;
    targetType?: string;
    targetId?: string;
    actorUserId?: string;
    /** ISO 8601 date-time, inclusive lower bound on createdAt. */
    since?: string;
    /** ISO 8601 date-time, exclusive upper bound on createdAt. */
    until?: string;
    /** Decimal string — see StoredAuditLogEntry.sequence. */
    cursor?: string;
    limit?: number;
}

export interface ChainVerificationResult {
    valid: boolean;
    checkedCount: number;
    brokenAtSequence?: string;
}

/**
 * Immutable, append-only audit log — no update/delete method is exposed by
 * design; `record` is the only write. Two implementations, same shape as
 * every other store in this service: InMemoryAuditStore (lost on restart,
 * disclosed the same way as InMemoryIamStore/InMemoryCaseStore) and
 * PostgresAuditStore (a real `audit_log` table).
 *
 * `record`'s standalone insert (via `this.pool` directly) is what
 * PostgresAuditStore itself uses; PostgresIamStore/PostgresCaseStore's own
 * mutations call `insertAuditEntry` below directly with their *own already-
 * open transaction's* PoolClient instead of going through this interface —
 * that's what makes the audit row commit/roll back atomically with the
 * mutation it records (the actual "transactional outbox" property
 * docs/ENTERPRISE_ARCHITECTURE_ROADMAP.md's P0 item 11 asks for), which a
 * standalone `record()` call after the fact could never guarantee (a crash
 * between the mutation committing and a separate audit write would lose
 * the audit record for a mutation that genuinely happened).
 */
export interface AuditStore {
    record(entry: AuditLogEntry): Promise<void>;
    listByOrganization(organizationId: string, filters?: AuditSearchFilters): Promise<StoredAuditLogEntry[]>;
    /** Detects retroactive modification or deletion within one
     * organization's own chain (P1: immutable audit ingestion — see
     * verifyChainEntries's doc comment for exactly what this does and does
     * not guarantee). */
    verifyChain(organizationId: string): Promise<ChainVerificationResult>;
    /** P2 item 2 (SIEM export): entries strictly after `afterSequence` (or
     * from the start of the chain if undefined), ordered ascending by
     * `sequence` — the opposite direction from listByOrganization's
     * newest-first `cursor`, since a SIEM connector polls forward through
     * history rather than paging backward from "now." The connector owns
     * its own cursor between calls (the last `sequence` it saw), matching
     * routes/cases.ts's `?since=` change-feed contract; this server tracks
     * no per-connector export state of its own. Entries missing `sequence`
     * (pre-migration-013 history, before chaining existed) are skipped, the
     * same disclosed boundary verifyChain already has — a SIEM export
     * starting fresh from the chain's first entry onward, not the
     * organization's entire history. */
    listForExport(organizationId: string, afterSequence: string | undefined, limit: number): Promise<StoredAuditLogEntry[]>;
}

const sha256Hex = (input: string): string => createHash("sha256").update(input).digest("hex");

/** Deterministic JSON serialization: object keys sorted recursively, arrays
 * keep their (semantically meaningful) order. Needed because Postgres's
 * JSONB storage does NOT preserve the original key order of an inserted
 * object — a plain `JSON.stringify` of `details` re-read from a JSONB
 * column can come back with keys in a different order than they went in,
 * which would make a naive hash recomputation falsely report tampering on
 * every untouched row with a multi-key `details` object. Canonicalizing
 * before hashing, at both write and verify time, makes the hash immune to
 * that reordering rather than working around it. */
function canonicalJson(value: unknown): string {
    if (value === null || typeof value !== "object") return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}

/** Fixed no-organization chain key for the rare bootstrap-event rows where
 * `organizationId` is undefined (the org doesn't exist yet) — lives only in
 * audit_chain_state's chain_key, never touches audit_log.organization_id's
 * own nullability/meaning. */
const NO_ORG_CHAIN_KEY = "__no_org__";
const chainKeyFor = (organizationId: string | undefined): string => organizationId ?? NO_ORG_CHAIN_KEY;

/** Fixed, public, non-secret starting point for every chain — not a key,
 * just a well-known constant so the very first entry in any chain has a
 * defined `prevHash` to point at. */
const GENESIS_HASH = sha256Hex("modelforge-audit-chain-genesis");

function buildHashInput(prevHash: string, id: string, entry: AuditLogEntry, createdAt: Date): string {
    return [
        prevHash,
        id,
        entry.organizationId ?? "",
        entry.actorUserId ?? "",
        entry.actorExternalSubject,
        entry.action,
        entry.targetType,
        entry.targetId,
        canonicalJson(entry.details ?? null),
        createdAt.toISOString(),
    ].join("|");
}

/**
 * Walks entries **already sorted by sequence ascending** and recomputes
 * each hash from scratch, confirming both `prevHash` chains correctly from
 * the prior entry (or GENESIS_HASH for the first) and `entryHash` matches
 * what the stored fields actually hash to. Entries missing chain fields
 * (pre-migration-013 history) are skipped, not treated as broken — they
 * predate chaining, which is disclosed, not hidden.
 *
 * This is tamper-**evident**, not tamper-**proof**: it detects retroactive
 * modification or deletion of a chained row. It does not prove authorship
 * to a third party, and does not stop an actor privileged enough to
 * rewrite a whole chain self-consistently (a DB superuser, or backup-
 * restore tampering) — that requires real cryptographic signing, which is
 * deliberately out of scope for this slice (no keys/certificates, per the
 * same product direction as PolicyVersion.contentHash).
 */
export function verifyChainEntries(entriesAscendingBySequence: StoredAuditLogEntry[]): ChainVerificationResult {
    let expectedPrevHash = GENESIS_HASH;
    let checkedCount = 0;
    for (const entry of entriesAscendingBySequence) {
        if (entry.sequence === undefined || entry.entryHash === undefined || entry.prevHash === undefined) continue;
        const recomputed = sha256Hex(buildHashInput(expectedPrevHash, entry.id, entry, new Date(entry.createdAt)));
        if (entry.prevHash !== expectedPrevHash || entry.entryHash !== recomputed) {
            return { valid: false, checkedCount, brokenAtSequence: entry.sequence };
        }
        expectedPrevHash = entry.entryHash;
        checkedCount++;
    }
    return { valid: true, checkedCount };
}

interface AuditLogRow {
    id: string;
    organization_id: string | null;
    actor_user_id: string | null;
    actor_external_subject: string;
    action: string;
    target_type: string;
    target_id: string;
    details: Record<string, unknown> | null;
    created_at: Date;
    sequence: string | null;
    prev_hash: string | null;
    entry_hash: string | null;
}

function mapRow(row: AuditLogRow): StoredAuditLogEntry {
    return {
        id: row.id,
        organizationId: row.organization_id ?? undefined,
        actorUserId: row.actor_user_id ?? undefined,
        actorExternalSubject: row.actor_external_subject,
        action: row.action,
        targetType: row.target_type,
        targetId: row.target_id,
        details: row.details ?? undefined,
        createdAt: row.created_at.toISOString(),
        sequence: row.sequence ?? undefined,
        entryHash: row.entry_hash ?? undefined,
        prevHash: row.prev_hash ?? undefined,
    };
}

/**
 * Shared by PostgresAuditStore.record (standalone) and every
 * PostgresIamStore/PostgresCaseStore mutation that writes its audit row
 * inside its own already-open transaction. `queryable` is either a `Pool`
 * (standalone — its own implicit transaction) or a `PoolClient` (joins the
 * caller's transaction) — both satisfy the same `.query()` shape, so this
 * one function serves both cases without the callers needing an
 * AuditStore instance at all for the transactional path.
 *
 * Also the one place the per-organization hash chain advances (P1:
 * immutable audit ingestion). `pg_advisory_xact_lock` is a transaction-
 * scoped advisory lock, auto-released at COMMIT/ROLLBACK, taken *before*
 * reading chain state specifically so it also correctly serializes an
 * organization's very first-ever write, where no audit_chain_state row
 * exists yet to lock via `FOR UPDATE`. `hashtextextended(_, 0)` (64-bit)
 * over `hashtext` (32-bit) purely for a larger key space — a hash
 * collision between two different chain keys here only causes unrelated
 * organizations' writes to occasionally, harmlessly serialize against each
 * other; it can never corrupt a chain, since chain state itself is still
 * looked up by the real string key, not the hash.
 *
 * MUST always be the *last* lock a transaction acquires — true at every
 * current call site (this function always runs immediately before
 * commit). Taking further row locks afterward risks a lock-order deadlock
 * against a concurrent chain write for the same organization.
 *
 * Requires READ COMMITTED isolation (Postgres's default, and what every
 * current caller uses: postgres-case-store.ts's writeBound/deleteBound and
 * postgres-access-governance-store.ts's tenantRead all use plain `BEGIN`;
 * only the read-only, never-audits readChangesBound opts into REPEATABLE
 * READ). Under READ COMMITTED, each statement takes a fresh snapshot, so
 * the plain SELECT below is guaranteed to see whichever transaction most
 * recently held this lock's just-committed write. This chaining logic is
 * UNSAFE under REPEATABLE READ/SERIALIZABLE (a fixed-at-BEGIN snapshot
 * could read stale chain state after acquiring the lock) — revisit this if
 * a future call site ever wraps an audit write in one of those.
 */
export async function insertAuditEntry(queryable: Pick<Pool | PoolClient, "query">, entry: AuditLogEntry): Promise<void> {
    const chainKey = chainKeyFor(entry.organizationId);
    await queryable.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [chainKey]);
    const chainState = await queryable.query<{ sequence: string; entry_hash: string }>(
        "SELECT sequence, entry_hash FROM audit_chain_state WHERE chain_key = $1",
        [chainKey]
    );
    const prevSequence = chainState.rows[0] ? BigInt(chainState.rows[0].sequence) : 0n;
    const prevHash = chainState.rows[0]?.entry_hash ?? GENESIS_HASH;
    const sequence = (prevSequence + 1n).toString();

    const id = randomUUID();
    const createdAt = new Date();
    const entryHash = sha256Hex(buildHashInput(prevHash, id, entry, createdAt));

    await queryable.query(
        `INSERT INTO audit_log (id, organization_id, actor_user_id, actor_external_subject, action, target_type, target_id, details, created_at, sequence, prev_hash, entry_hash)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
        [
            id,
            entry.organizationId ?? null,
            entry.actorUserId ?? null,
            entry.actorExternalSubject,
            entry.action,
            entry.targetType,
            entry.targetId,
            entry.details ? JSON.stringify(entry.details) : null,
            createdAt,
            sequence,
            prevHash,
            entryHash,
        ]
    );
    await queryable.query(
        `INSERT INTO audit_chain_state (chain_key, sequence, entry_hash) VALUES ($1, $2, $3)
         ON CONFLICT (chain_key) DO UPDATE SET sequence = EXCLUDED.sequence, entry_hash = EXCLUDED.entry_hash`,
        [chainKey, sequence, entryHash]
    );
}

/**
 * Real, Postgres-backed AuditStore. Not run against a real Postgres
 * instance in the environment this was built in — see server/README.md and
 * this package's other postgres-*.test.ts files, all gated on DATABASE_URL.
 */
export class PostgresAuditStore implements AuditStore {
    constructor(private readonly pool: Pool) {}

    async record(entry: AuditLogEntry): Promise<void> {
        // The only outcome/latency instrumentation point for the real audit
        // path — see metrics.ts's audit_write_total/audit_write_duration
        // doc comments and the roadmap's "zero acknowledged mutation loss"
        // objective. Deliberately not inside insertAuditEntry itself: that
        // function is a plain data-access primitive other code may call
        // directly (e.g. in a future migration/backfill tool) without that
        // call meaning "a production audit-outbox write happened."
        const elapsed = startTimer();
        try {
            await insertAuditEntry(this.pool, entry);
            auditWriteTotal.inc({ outcome: "success" });
        } catch (err) {
            auditWriteTotal.inc({ outcome: "failure" });
            throw err;
        } finally {
            auditWriteDuration.observe(elapsed());
        }
    }

    async listByOrganization(organizationId: string, filters: AuditSearchFilters = {}): Promise<StoredAuditLogEntry[]> {
        const conditions: string[] = ["organization_id = $1"];
        const params: unknown[] = [organizationId];
        const addFilter = (sqlWithPlaceholder: string, value: unknown): void => {
            params.push(value);
            conditions.push(sqlWithPlaceholder.replace("$N", `$${params.length}`));
        };
        if (filters.action) addFilter("action = $N", filters.action);
        if (filters.targetType) addFilter("target_type = $N", filters.targetType);
        if (filters.targetId) addFilter("target_id = $N", filters.targetId);
        if (filters.actorUserId) addFilter("actor_user_id = $N", filters.actorUserId);
        if (filters.since) addFilter("created_at >= $N", new Date(filters.since));
        if (filters.until) addFilter("created_at < $N", new Date(filters.until));
        if (filters.cursor) addFilter("sequence < $N::bigint", filters.cursor);

        // sequence is the tiebreak, not just decoration: two entries can
        // share a created_at down to the millisecond, and an unstable order
        // between them would let cursor pagination (which advances by
        // sequence) skip or repeat a row at a page boundary. NULLS LAST
        // keeps pre-chaining rows at the end rather than Postgres's default
        // of sorting them first under DESC.
        let sql = `SELECT * FROM audit_log WHERE ${conditions.join(" AND ")} ORDER BY created_at DESC, sequence DESC NULLS LAST`;
        if (filters.limit !== undefined) {
            params.push(filters.limit);
            sql += ` LIMIT $${params.length}`;
        }
        const result = await this.pool.query<AuditLogRow>(sql, params);
        return result.rows.map(mapRow);
    }

    async verifyChain(organizationId: string): Promise<ChainVerificationResult> {
        const result = await this.pool.query<AuditLogRow>(
            "SELECT * FROM audit_log WHERE organization_id = $1 AND sequence IS NOT NULL ORDER BY sequence ASC",
            [organizationId]
        );
        return verifyChainEntries(result.rows.map(mapRow));
    }

    async listForExport(organizationId: string, afterSequence: string | undefined, limit: number): Promise<StoredAuditLogEntry[]> {
        const conditions = ["organization_id = $1", "sequence IS NOT NULL"];
        const params: unknown[] = [organizationId];
        if (afterSequence !== undefined) {
            params.push(afterSequence);
            conditions.push(`sequence > $${params.length}::bigint`);
        }
        params.push(limit);
        const result = await this.pool.query<AuditLogRow>(
            `SELECT * FROM audit_log WHERE ${conditions.join(" AND ")} ORDER BY sequence ASC LIMIT $${params.length}`,
            params
        );
        return result.rows.map(mapRow);
    }
}

/**
 * In-memory only — same disclosed scope boundary as InMemoryIamStore and
 * InMemoryCaseStore (see server/README.md): everything is lost on restart.
 * A single shared instance is meant to be passed to both InMemoryIamStore
 * and InMemoryCaseStore (see index.ts) so a `GET /organizations/:id/audit`
 * read sees mutations from both in one merged, chronological trail — the
 * same thing PostgresIamStore/PostgresCaseStore achieve by both writing
 * into one shared `audit_log` table.
 */
export class InMemoryAuditStore implements AuditStore {
    private entries: StoredAuditLogEntry[] = [];
    private chainState = new Map<string, { sequence: bigint; entryHash: string }>();

    async record(entry: AuditLogEntry): Promise<void> {
        const chainKey = chainKeyFor(entry.organizationId);
        const prior = this.chainState.get(chainKey);
        const prevSequence = prior?.sequence ?? 0n;
        const prevHash = prior?.entryHash ?? GENESIS_HASH;
        const sequence = prevSequence + 1n;

        const id = randomUUID();
        const createdAt = new Date();
        const entryHash = sha256Hex(buildHashInput(prevHash, id, entry, createdAt));

        this.chainState.set(chainKey, { sequence, entryHash });
        this.entries.push({ ...entry, id, createdAt: createdAt.toISOString(), sequence: sequence.toString(), prevHash, entryHash });
    }

    async listByOrganization(organizationId: string, filters: AuditSearchFilters = {}): Promise<StoredAuditLogEntry[]> {
        let results = this.entries.filter((e) => e.organizationId === organizationId);
        if (filters.action) results = results.filter((e) => e.action === filters.action);
        if (filters.targetType) results = results.filter((e) => e.targetType === filters.targetType);
        if (filters.targetId) results = results.filter((e) => e.targetId === filters.targetId);
        if (filters.actorUserId) results = results.filter((e) => e.actorUserId === filters.actorUserId);
        if (filters.since) results = results.filter((e) => e.createdAt >= filters.since!);
        if (filters.until) results = results.filter((e) => e.createdAt < filters.until!);
        results = results.slice().reverse();
        if (filters.cursor !== undefined) {
            const cursor = BigInt(filters.cursor);
            results = results.filter((e) => e.sequence !== undefined && BigInt(e.sequence) < cursor);
        }
        if (filters.limit !== undefined) results = results.slice(0, filters.limit);
        return results;
    }

    async verifyChain(organizationId: string): Promise<ChainVerificationResult> {
        const ascending = this.entries
            .filter((e) => e.organizationId === organizationId && e.sequence !== undefined)
            .slice()
            .sort((a, b) => (BigInt(a.sequence!) < BigInt(b.sequence!) ? -1 : 1));
        return verifyChainEntries(ascending);
    }

    async listForExport(organizationId: string, afterSequence: string | undefined, limit: number): Promise<StoredAuditLogEntry[]> {
        let ascending = this.entries
            .filter((e) => e.organizationId === organizationId && e.sequence !== undefined)
            .slice()
            .sort((a, b) => (BigInt(a.sequence!) < BigInt(b.sequence!) ? -1 : 1));
        if (afterSequence !== undefined) {
            const after = BigInt(afterSequence);
            ascending = ascending.filter((e) => BigInt(e.sequence!) > after);
        }
        return ascending.slice(0, limit);
    }
}
