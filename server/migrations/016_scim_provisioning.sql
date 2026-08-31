-- SCIM provisioning (P2 backlog item 1: "SCIM and external group
-- reconciliation") — see domain/types.ts's scimTokenSchema doc comment and
-- docs/SCIM.md for the full design (why a static bearer token, why "create
-- user" maps onto the existing Invitation mechanism rather than a new
-- identity-less User concept).
--
-- No default-privileges GRANT needed here — migration 010 already set
-- `ALTER DEFAULT PRIVILEGES FOR ROLE <owner> GRANT ... ON TABLES TO
-- modelforge_runtime` at the public-schema level, which covers every table
-- created afterward by the migration-owner role, this one included.

CREATE TABLE IF NOT EXISTS scim_tokens (
    id UUID PRIMARY KEY,
    organization_id UUID NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    token_hash TEXT NOT NULL,
    created_by_user_id UUID NOT NULL REFERENCES users (id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_used_at TIMESTAMPTZ,
    revoked_at TIMESTAMPTZ
);

-- The hot-path lookup (routes/scim.ts's auth check, on every SCIM request):
-- "is there a non-revoked token in this org matching this hash." Partial
-- (WHERE revoked_at IS NULL) since a revoked token is never looked up by
-- this query again.
CREATE INDEX IF NOT EXISTS idx_scim_tokens_org_hash_active ON scim_tokens (organization_id, token_hash) WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_scim_tokens_org_created ON scim_tokens (organization_id, created_at DESC);
