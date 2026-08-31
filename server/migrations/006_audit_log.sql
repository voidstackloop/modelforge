-- Immutable, append-only audit trail for IAM and case mutations — see
-- store/audit-store.ts's doc comment for the full contract. No update or
-- delete is ever issued against this table by application code.
--
-- organization_id/actor_user_id are nullable specifically for the
-- org-bootstrap event (IamStore.createOrganization): the organization
-- doesn't exist yet when that row is written, and the acting identity has
-- no User record in it yet either — only its OIDC subject
-- (actor_external_subject, always present) is known at that point.
--
-- No foreign key to organizations: an audit row must survive an
-- organization being deleted (ON DELETE CASCADE elsewhere in this schema
-- would otherwise erase the very record of that deletion having happened),
-- which is the opposite of every other per-organization table here.

CREATE TABLE IF NOT EXISTS audit_log (
    id UUID PRIMARY KEY,
    organization_id UUID,
    actor_user_id UUID,
    actor_external_subject TEXT NOT NULL,
    action TEXT NOT NULL,
    target_type TEXT NOT NULL,
    target_id TEXT NOT NULL,
    details JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_audit_log_organization_id_created_at ON audit_log (organization_id, created_at DESC);
