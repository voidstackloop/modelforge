-- Break-glass emergency access and admin-driven access-review campaigns —
-- see docs/ENTERPRISE_ARCHITECTURE_ROADMAP.md P1 backlog item 2, and
-- domain/types.ts's doc comments on BreakGlassGrant/AccessReviewCampaign
-- for the product decisions behind this shape (immediate self-service
-- grant + mandatory post-hoc review; one pre-configured emergency policy
-- per org, not an arbitrary caller-chosen resource/action).

ALTER TABLE policies ADD COLUMN IF NOT EXISTS is_break_glass_policy BOOLEAN NOT NULL DEFAULT false;
-- At most one per organization, enforced here rather than only in
-- application code so it holds even under a racing concurrent call to
-- setBreakGlassPolicy (store/postgres-iam-store.ts).
CREATE UNIQUE INDEX IF NOT EXISTS idx_policies_org_break_glass ON policies (organization_id) WHERE is_break_glass_policy;

CREATE TABLE IF NOT EXISTS break_glass_grants (
    id UUID PRIMARY KEY,
    organization_id UUID NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    -- Deliberately not a foreign key — see domain/types.ts's
    -- BreakGlassGrant.emergencyPolicyId doc comment: a snapshot, not a
    -- live reference, so a later reassignment/deletion of the org's
    -- emergency policy never changes what an already-issued grant meant.
    emergency_policy_id UUID NOT NULL,
    justification TEXT NOT NULL,
    granted_at TIMESTAMPTZ NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    reviewed_by_user_id UUID REFERENCES users (id),
    reviewed_at TIMESTAMPTZ,
    review_outcome TEXT CHECK (review_outcome IN ('acknowledged', 'flagged')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK ((reviewed_at IS NULL) = (review_outcome IS NULL))
);
-- The hot-path lookup (routes/guards.ts's requireOrgUser, once per
-- authenticated request): "does this user have an active, unreviewed
-- grant right now."
CREATE INDEX IF NOT EXISTS idx_break_glass_grants_org_user_active ON break_glass_grants (organization_id, user_id) WHERE reviewed_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_break_glass_grants_org_created ON break_glass_grants (organization_id, created_at DESC);

CREATE TABLE IF NOT EXISTS access_review_campaigns (
    id UUID PRIMARY KEY,
    organization_id UUID NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
    created_by_user_id UUID NOT NULL REFERENCES users (id),
    status TEXT NOT NULL CHECK (status IN ('open', 'completed')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    completed_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_access_review_campaigns_org ON access_review_campaigns (organization_id, created_at DESC);

CREATE TABLE IF NOT EXISTS access_review_items (
    id UUID PRIMARY KEY,
    campaign_id UUID NOT NULL REFERENCES access_review_campaigns (id) ON DELETE CASCADE,
    organization_id UUID NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
    membership_id UUID NOT NULL REFERENCES memberships (id) ON DELETE CASCADE,
    subject_user_id UUID NOT NULL REFERENCES users (id),
    decision TEXT NOT NULL DEFAULT 'pending' CHECK (decision IN ('pending', 'keep', 'revoke')),
    decided_by_user_id UUID REFERENCES users (id),
    decided_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK ((decision = 'pending') = (decided_at IS NULL))
);
CREATE INDEX IF NOT EXISTS idx_access_review_items_campaign ON access_review_items (campaign_id);

-- Same tenant_isolation shape as migrations/008_control_plane_rls.sql —
-- these are shared control-plane tables, not per-tenant schema objects.
-- modelforge_runtime (migrations/010) already has the privileges it needs
-- on these via its ALTER DEFAULT PRIVILEGES rule; no grant statements
-- needed here.
DO $rls$
DECLARE
    table_name TEXT;
BEGIN
    FOREACH table_name IN ARRAY ARRAY['break_glass_grants', 'access_review_campaigns', 'access_review_items']
    LOOP
        EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
        EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', table_name);
        EXECUTE format(
            'CREATE POLICY tenant_isolation ON %I USING (organization_id = nullif(current_setting(''app.tenant_id'', true), '''')::uuid) WITH CHECK (organization_id = nullif(current_setting(''app.tenant_id'', true), '''')::uuid)',
            table_name
        );
    END LOOP;
END
$rls$;
