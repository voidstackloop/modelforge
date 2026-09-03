ALTER TABLE mcp_registry_entries
    ADD COLUMN IF NOT EXISTS integration_profile TEXT NOT NULL DEFAULT 'generic'
        CHECK (integration_profile IN ('generic', 'modelforge-clinical')),
    ADD COLUMN IF NOT EXISTS oauth_client_id TEXT,
    ADD COLUMN IF NOT EXISTS catalog_version_constraint TEXT,
    ADD COLUMN IF NOT EXISTS approval_challenge_endpoint TEXT;

CREATE TABLE IF NOT EXISTS mcp_context_grants (
    id TEXT PRIMARY KEY,
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    subject_id TEXT NOT NULL,
    client_id TEXT NOT NULL,
    case_id TEXT NOT NULL,
    allowed_tools TEXT[] NOT NULL,
    allowed_fields TEXT[] NOT NULL,
    purpose TEXT NOT NULL,
    destination TEXT NOT NULL CHECK (destination IN ('local_model_forge','managed_model_forge','approved_third_party')),
    expires_at TIMESTAMPTZ NOT NULL,
    version BIGINT NOT NULL CHECK (version > 0),
    revoked_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_mcp_context_grants_org_expiry ON mcp_context_grants(organization_id, expires_at);

CREATE TABLE IF NOT EXISTS mcp_approval_requests (
    id UUID PRIMARY KEY,
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    registry_entry_id UUID NOT NULL REFERENCES mcp_registry_entries(id),
    subject_id TEXT NOT NULL,
    client_id TEXT NOT NULL,
    tool_name TEXT NOT NULL,
    operation_digest TEXT NOT NULL,
    case_id TEXT,
    status TEXT NOT NULL CHECK (status IN ('pending','confirmed')),
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    confirmed_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_mcp_approval_requests_org_expiry ON mcp_approval_requests(organization_id, expires_at);

CREATE TABLE IF NOT EXISTS mcp_operation_reviews (
    id UUID PRIMARY KEY,
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    case_id TEXT NOT NULL,
    reviewer_subject_id TEXT NOT NULL,
    reviewed_operation_id UUID NOT NULL,
    decision TEXT NOT NULL CHECK (decision IN ('approved','rejected','needs_revision')),
    rationale TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (organization_id, reviewed_operation_id)
);

ALTER TABLE mcp_context_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE mcp_approval_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE mcp_operation_reviews ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON mcp_context_grants;
DROP POLICY IF EXISTS tenant_isolation ON mcp_approval_requests;
DROP POLICY IF EXISTS tenant_isolation ON mcp_operation_reviews;
CREATE POLICY tenant_isolation ON mcp_context_grants USING (organization_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (organization_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_isolation ON mcp_approval_requests USING (organization_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (organization_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
CREATE POLICY tenant_isolation ON mcp_operation_reviews USING (organization_id = nullif(current_setting('app.tenant_id', true), '')::uuid) WITH CHECK (organization_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
