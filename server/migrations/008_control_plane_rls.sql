-- Defense-in-depth for shared IAM/control-plane metadata. Tenant-bound
-- repository transactions set app.tenant_id locally. Migration/bootstrap
-- roles own these tables and are kept separate from the NO BYPASSRLS
-- runtime role in production.

DO $rls$
DECLARE
    table_name TEXT;
BEGIN
    FOREACH table_name IN ARRAY ARRAY[
        'policies', 'groups', 'users', 'authorization_epochs',
        'memberships', 'invitations', 'service_principals',
        'idempotency_keys'
    ]
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

-- Join tables derive their tenant through the owning record.
ALTER TABLE group_policies ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON group_policies;
CREATE POLICY tenant_isolation ON group_policies USING (
    EXISTS (SELECT 1 FROM groups g WHERE g.id = group_id AND g.organization_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
);

ALTER TABLE user_groups ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON user_groups;
CREATE POLICY tenant_isolation ON user_groups USING (
    EXISTS (SELECT 1 FROM users u WHERE u.id = user_id AND u.organization_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
);

ALTER TABLE user_policies ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON user_policies;
CREATE POLICY tenant_isolation ON user_policies USING (
    EXISTS (SELECT 1 FROM users u WHERE u.id = user_id AND u.organization_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
);

CREATE OR REPLACE FUNCTION list_memberships_for_identity(identity_issuer TEXT, identity_subject TEXT)
RETURNS SETOF memberships
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $memberships$
    SELECT m.* FROM public.memberships m
    JOIN public.identities i ON i.id = m.identity_id
    WHERE i.issuer = identity_issuer AND i.subject = identity_subject
$memberships$;
