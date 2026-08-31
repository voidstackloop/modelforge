-- Enterprise backup, PITR, and tenant-scoped restore — see
-- docs/ENTERPRISE_ARCHITECTURE_ROADMAP.md P1 backlog item 6 and
-- domain/types.ts's doc comment on TenantBackupArtifact/TenantRestoreRequest.
-- Real continuous PITR (WAL archiving) is deliberately out of scope — see
-- that doc comment. This table tracks dual-control *restore* requests only;
-- an export has no server-side state at all (it streams straight to the
-- caller, same as routes/audit.ts's CSV export — nothing to track here).

CREATE TABLE IF NOT EXISTS tenant_restore_requests (
    id UUID PRIMARY KEY,
    organization_id UUID NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
    status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected', 'completed', 'failed')),
    -- The proposed backup content itself — read once by approveRestore to
    -- execute, never re-exposed over HTTP after the initial propose (see
    -- domain/types.ts's TenantRestoreRequest, which deliberately excludes
    -- this field from the shared/list-facing type).
    artifact JSONB NOT NULL,
    artifact_checksum TEXT NOT NULL,
    -- Per-table {toInsert, toUpdate} counts computed at propose time, so an
    -- approver reviews a real diff rather than a blind rubber-stamp.
    summary JSONB NOT NULL,
    requested_by_user_id UUID NOT NULL REFERENCES users (id),
    requested_at TIMESTAMPTZ NOT NULL,
    decided_by_user_id UUID REFERENCES users (id),
    decided_at TIMESTAMPTZ,
    rejection_reason TEXT,
    completed_at TIMESTAMPTZ,
    error_message TEXT,
    CHECK ((status = 'pending') = (decided_by_user_id IS NULL AND decided_at IS NULL))
);
CREATE INDEX IF NOT EXISTS idx_tenant_restore_requests_org ON tenant_restore_requests (organization_id, requested_at DESC);

ALTER TABLE tenant_restore_requests ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON tenant_restore_requests;
CREATE POLICY tenant_isolation ON tenant_restore_requests USING (
    organization_id = nullif(current_setting('app.tenant_id', true), '')::uuid
) WITH CHECK (
    organization_id = nullif(current_setting('app.tenant_id', true), '')::uuid
);
