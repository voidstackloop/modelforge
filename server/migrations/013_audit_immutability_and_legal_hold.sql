-- Immutable audit ingestion, search, export, and legal hold — see
-- docs/ENTERPRISE_ARCHITECTURE_ROADMAP.md P1 backlog item 4 and
-- store/audit-store.ts's doc comments. Two things this migration does NOT
-- do, by design: pick a numeric retention/purge period, or swap in an
-- external immutable-storage product — both are explicitly named in the
-- roadmap's §19 "Decisions Requiring Explicit Ownership" as legal/
-- compliance and infrastructure decisions outside this codebase's
-- authority. Postgres stays the system of record.

-- Preventive control: audit_log's own doc comment already claims
-- "immutable, append-only... no update or delete is ever issued" — but
-- until now that was pure application-code discipline. modelforge_runtime
-- (migrations/010) has blanket UPDATE/DELETE on every public-schema table
-- including this one; this closes that gap for the ordinary case (an app
-- bug, or a compromised runtime credential). It cannot stop a superuser/
-- migration-owner role — nothing at the DB layer can; the hash chain below
-- is the detective control for that.
DO $revoke$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'modelforge_runtime') THEN
        EXECUTE 'REVOKE UPDATE, DELETE ON audit_log FROM modelforge_runtime';
    END IF;
END
$revoke$;

-- Detective control: a keyless SHA-256 hash chain, computed and verified
-- entirely in application code (store/audit-store.ts's insertAuditEntry/
-- verifyChain) — NOT a cryptographic signature, no keys/certificates, per
-- the same "no signing infrastructure this slice" direction as
-- migrations/012_policy_versions.sql. Detects retroactive modification or
-- deletion within one organization's own trail; does not prove authorship
-- to a third party, and does not stop an actor privileged enough to
-- rewrite a whole chain self-consistently (a DB superuser, or backup-
-- restore tampering). Nullable because the chain starts fresh from this
-- migration forward — pre-existing rows are never retroactively chained.
ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS sequence BIGINT;
ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS prev_hash TEXT;
ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS entry_hash TEXT;

-- One row per chain (chain_key = organizationId, or the fixed sentinel
-- '__no_org__' for the rare NULL-organization_id bootstrap-event rows —
-- see audit_log's own doc comment on why that column is nullable). Chained
-- per organization rather than as one global chain specifically so audit
-- writes for different organizations never serialize against each other;
-- see store/audit-store.ts's insertAuditEntry for the advisory-lock
-- concurrency control this table depends on. Mirrors
-- migrations/010_runtime_role_grants.sql's case_change_counter singleton-
-- row pattern rather than inventing a new one.
CREATE TABLE IF NOT EXISTS audit_chain_state (
    chain_key TEXT PRIMARY KEY,
    sequence BIGINT NOT NULL,
    entry_hash TEXT NOT NULL
);
DO $revoke_chain$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'modelforge_runtime') THEN
        -- UPDATE is legitimately needed here on every audit write (the
        -- chain-state upsert) — only DELETE is revoked, defense-in-depth
        -- against erasing the chain's tip (which wouldn't rewrite history,
        -- but would let a future write silently restart the sequence).
        EXECUTE 'REVOKE DELETE ON audit_chain_state FROM modelforge_runtime';
    END IF;
END
$revoke_chain$;

-- Legal hold: a fully-audited compliance record of who placed/released a
-- hold, when, and why — see domain/types.ts's AuditLegalHold doc comment
-- for why this is deliberately NOT an active blocker of anything today (no
-- retention/purge job exists anywhere in this codebase to block). Unlike
-- audit_log itself (deliberately no FK to organizations, so audit rows
-- outlive a deleted organization), a legal hold is inherently about a
-- specific *currently-existing* organization's compliance state — same
-- FK/RLS/CASCADE shape as migrations/011's break_glass_grants.
CREATE TABLE IF NOT EXISTS audit_legal_holds (
    id UUID PRIMARY KEY,
    organization_id UUID NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
    reason TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('active', 'released')),
    placed_by_user_id UUID NOT NULL REFERENCES users (id),
    placed_at TIMESTAMPTZ NOT NULL,
    released_by_user_id UUID REFERENCES users (id),
    released_at TIMESTAMPTZ,
    release_reason TEXT,
    CHECK ((status = 'active') = (released_at IS NULL AND released_by_user_id IS NULL))
);
CREATE INDEX IF NOT EXISTS idx_audit_legal_holds_org ON audit_legal_holds (organization_id, placed_at DESC);

ALTER TABLE audit_legal_holds ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON audit_legal_holds;
CREATE POLICY tenant_isolation ON audit_legal_holds USING (
    organization_id = nullif(current_setting('app.tenant_id', true), '')::uuid
) WITH CHECK (
    organization_id = nullif(current_setting('app.tenant_id', true), '')::uuid
);
