-- Initial IAM schema. Shared tables (organization_id foreign keys), not
-- schema-per-tenant — a deliberate, disclosed simplification for this
-- control-plane metadata specifically (organizations/users/groups/policy
-- *documents*, no PHI), distinct from
-- docs/ENTERPRISE_MULTIUSER_ARCHITECTURE.md §2's schema-per-tenant default
-- for patient-case data. Every query in postgres-iam-store.ts is already
-- constrained by organizationId per the IamStore interface's own method
-- signatures, and every query here is parameterized — there is no raw
-- dynamic SQL for a tenant_id filter to be accidentally omitted from. See
-- server/README.md's "Known gaps" for why this isn't schema-per-tenant yet.

CREATE TABLE IF NOT EXISTS organizations (
    id UUID PRIMARY KEY,
    name TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS policies (
    id UUID PRIMARY KEY,
    organization_id UUID NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    description TEXT,
    -- The full PolicyDocument (domain/types.ts), stored whole rather than
    -- normalized into a statements table — policy-evaluator.ts consumes it
    -- as one JSON document, never queries into individual statements, so
    -- there is nothing normalization would buy here.
    document JSONB NOT NULL,
    builtin BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_policies_organization_id ON policies (organization_id);

CREATE TABLE IF NOT EXISTS groups (
    id UUID PRIMARY KEY,
    organization_id UUID NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_groups_organization_id ON groups (organization_id);

CREATE TABLE IF NOT EXISTS group_policies (
    group_id UUID NOT NULL REFERENCES groups (id) ON DELETE CASCADE,
    policy_id UUID NOT NULL REFERENCES policies (id) ON DELETE CASCADE,
    PRIMARY KEY (group_id, policy_id)
);

CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY,
    organization_id UUID NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
    -- The OIDC `sub` claim. Unique per (organization_id, external_subject),
    -- not globally unique — the same identity can hold a distinct User row
    -- (distinct permissions) in more than one organization; see
    -- domain/types.ts's User.externalSubject doc comment.
    external_subject TEXT NOT NULL,
    display_name TEXT NOT NULL,
    email TEXT,
    status TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL,
    UNIQUE (organization_id, external_subject)
);
CREATE INDEX IF NOT EXISTS idx_users_organization_id ON users (organization_id);

CREATE TABLE IF NOT EXISTS user_groups (
    user_id UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    group_id UUID NOT NULL REFERENCES groups (id) ON DELETE CASCADE,
    PRIMARY KEY (user_id, group_id)
);

CREATE TABLE IF NOT EXISTS user_policies (
    user_id UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    policy_id UUID NOT NULL REFERENCES policies (id) ON DELETE CASCADE,
    PRIMARY KEY (user_id, policy_id)
);
