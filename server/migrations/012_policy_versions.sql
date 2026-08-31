-- Policy versioning + dual-control approval + rollback — see
-- docs/ENTERPRISE_ARCHITECTURE_ROADMAP.md P1 backlog item 3 and
-- domain/types.ts's doc comment on PolicyVersion. Cryptographic
-- signing/key-custody is deliberately out of scope for this slice.

CREATE TABLE IF NOT EXISTS policy_versions (
    id UUID PRIMARY KEY,
    policy_id UUID NOT NULL REFERENCES policies (id) ON DELETE CASCADE,
    organization_id UUID NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
    version INTEGER NOT NULL,
    document JSONB NOT NULL,
    content_hash TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected', 'superseded')),
    proposed_by_user_id UUID NOT NULL REFERENCES users (id),
    proposed_at TIMESTAMPTZ NOT NULL,
    decided_by_user_id UUID REFERENCES users (id),
    decided_at TIMESTAMPTZ,
    rejection_reason TEXT,
    CHECK ((status = 'pending') = (decided_by_user_id IS NULL AND decided_at IS NULL))
);
-- At most one approved version per policy at a time — mirrors migration
-- 011's idx_policies_org_break_glass partial-unique-index pattern.
CREATE UNIQUE INDEX IF NOT EXISTS idx_policy_versions_one_approved ON policy_versions (policy_id) WHERE status = 'approved';
CREATE INDEX IF NOT EXISTS idx_policy_versions_policy ON policy_versions (policy_id, version DESC);

ALTER TABLE policy_versions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON policy_versions;
CREATE POLICY tenant_isolation ON policy_versions USING (
    organization_id = nullif(current_setting('app.tenant_id', true), '')::uuid
) WITH CHECK (
    organization_id = nullif(current_setting('app.tenant_id', true), '')::uuid
);
