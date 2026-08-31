-- The application calls this fixed SECURITY DEFINER provisioning function;
-- it never interpolates client input into an identifier. Schema names are
-- deterministically derived from an organization UUID and validated again
-- in server/src/tenant-context.ts before repository construction.

CREATE OR REPLACE FUNCTION provision_tenant_clinical_schema(target_org UUID)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $provision$
DECLARE
    schema_name TEXT := 'tenant_' || replace(target_org::text, '-', '');
BEGIN
    IF NOT EXISTS (SELECT 1 FROM public.organizations WHERE id = target_org) THEN
        RAISE EXCEPTION 'Unknown organization';
    END IF;
    UPDATE public.organizations SET tenant_schema = schema_name WHERE id = target_org;
    EXECUTE format('CREATE SCHEMA IF NOT EXISTS %I', schema_name);
    EXECUTE format(
        'CREATE TABLE IF NOT EXISTS %I.patient_cases (
            case_id TEXT PRIMARY KEY,
            version BIGINT NOT NULL,
            data JSONB NOT NULL,
            patient_id TEXT NOT NULL,
            owner_user_id UUID NOT NULL,
            workspace_id TEXT,
            department_id TEXT,
            assigned_user_ids UUID[] NOT NULL DEFAULT ''{}'',
            active_consent_scopes TEXT[] NOT NULL DEFAULT ''{}'',
            staged_migration_id UUID,
            active BOOLEAN NOT NULL DEFAULT TRUE,
            updated_at TIMESTAMPTZ NOT NULL
        )', schema_name
    );
    EXECUTE format(
        'CREATE TABLE IF NOT EXISTS %I.case_change_counter (
            singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
            next_sequence BIGINT NOT NULL DEFAULT 1
        )', schema_name
    );
    EXECUTE format('INSERT INTO %I.case_change_counter (singleton, next_sequence) VALUES (TRUE, 1) ON CONFLICT DO NOTHING', schema_name);
    EXECUTE format(
        'CREATE TABLE IF NOT EXISTS %I.case_changes (
            sequence BIGINT PRIMARY KEY,
            kind TEXT NOT NULL CHECK (kind IN (''upsert'', ''delete'')),
            case_id TEXT NOT NULL,
            version BIGINT NOT NULL,
            patient_case JSONB,
            resource JSONB NOT NULL,
            changed_at TIMESTAMPTZ NOT NULL
        )', schema_name
    );
    EXECUTE format('ALTER TABLE %I.case_changes ADD COLUMN IF NOT EXISTS resource JSONB', schema_name);
    EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON %I.case_changes (case_id, sequence DESC)', 'idx_' || schema_name || '_case_changes_case', schema_name);
    EXECUTE format(
        'CREATE TABLE IF NOT EXISTS %I.case_migrations (
            id UUID PRIMARY KEY,
            status TEXT NOT NULL CHECK (status IN (''staging'', ''validated'', ''active'', ''rolled-back'')),
            source_fingerprint TEXT NOT NULL,
            total_items INTEGER NOT NULL,
            accepted_items INTEGER NOT NULL DEFAULT 0,
            preview JSONB,
            created_by UUID NOT NULL,
            created_at TIMESTAMPTZ NOT NULL,
            updated_at TIMESTAMPTZ NOT NULL,
            UNIQUE (source_fingerprint)
        )', schema_name
    );
    EXECUTE format(
        'CREATE TABLE IF NOT EXISTS %I.case_migration_items (
            migration_id UUID NOT NULL REFERENCES %I.case_migrations(id) ON DELETE CASCADE,
            item_key TEXT NOT NULL,
            case_id TEXT NOT NULL,
            data JSONB NOT NULL,
            data_hash TEXT NOT NULL,
            status TEXT NOT NULL CHECK (status IN (''pending'', ''accepted'', ''invalid'', ''collision'')),
            errors JSONB NOT NULL DEFAULT ''[]'',
            PRIMARY KEY (migration_id, item_key)
        )', schema_name, schema_name
    );
    RETURN schema_name;
END
$provision$;

REVOKE ALL ON FUNCTION provision_tenant_clinical_schema(UUID) FROM PUBLIC;
