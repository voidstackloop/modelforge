-- IAM v2: authentication identities are global issuer+subject records;
-- tenant membership, invitations, and non-human principals are distinct
-- lifecycle concepts. The existing users table remains a compatibility
-- profile used by policy/group evaluation and references the v2 records.

ALTER TABLE organizations ADD COLUMN IF NOT EXISTS tenant_schema TEXT;
UPDATE organizations
SET tenant_schema = 'tenant_' || replace(id::text, '-', '')
WHERE tenant_schema IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_organizations_tenant_schema ON organizations (tenant_schema);

CREATE TABLE IF NOT EXISTS identities (
    id UUID PRIMARY KEY,
    issuer TEXT NOT NULL,
    subject TEXT NOT NULL,
    display_name TEXT NOT NULL,
    email TEXT,
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL,
    UNIQUE (issuer, subject)
);

CREATE TABLE IF NOT EXISTS memberships (
    id UUID PRIMARY KEY,
    organization_id UUID NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
    identity_id UUID NOT NULL REFERENCES identities (id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    status TEXT NOT NULL CHECK (status IN ('active', 'suspended', 'deprovisioned')),
    provisioning_source TEXT NOT NULL CHECK (provisioning_source IN ('bootstrap', 'invitation', 'admin', 'jit', 'scim')),
    starts_at TIMESTAMPTZ NOT NULL,
    expires_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL,
    UNIQUE (organization_id, identity_id),
    UNIQUE (organization_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_memberships_identity ON memberships (identity_id);

CREATE TABLE IF NOT EXISTS invitations (
    id UUID PRIMARY KEY,
    organization_id UUID NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
    email TEXT NOT NULL,
    display_name TEXT,
    status TEXT NOT NULL CHECK (status IN ('pending', 'accepted', 'revoked', 'expired')),
    token_hash TEXT NOT NULL,
    invited_by_user_id UUID NOT NULL REFERENCES users (id),
    expires_at TIMESTAMPTZ NOT NULL,
    accepted_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_invitations_org_status ON invitations (organization_id, status);

CREATE TABLE IF NOT EXISTS service_principals (
    id UUID PRIMARY KEY,
    organization_id UUID NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
    issuer TEXT NOT NULL,
    external_subject TEXT NOT NULL,
    display_name TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('active', 'suspended', 'deprovisioned')),
    policy_ids UUID[] NOT NULL DEFAULT '{}',
    permission_boundary_policy_id UUID,
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL,
    UNIQUE (organization_id, issuer, external_subject)
);
CREATE INDEX IF NOT EXISTS idx_service_principals_org ON service_principals (organization_id);

