-- Grants the minimum privileges an optional, less-privileged "runtime" role
-- needs to run this application day to day, kept separate from whatever
-- role applies migrations (the "migration-owner" role: CURRENT_USER at the
-- time this file runs — needs CREATE SCHEMA / CREATE FUNCTION / superuser-
-- adjacent rights a runtime role must not have, since migrations/
-- 008_control_plane_rls.sql's tenant_isolation policies rely on the
-- runtime role being both NO BYPASSRLS *and* not the owner of the tables
-- it queries — table owners are exempt from row-level security by default,
-- regardless of BYPASSRLS, unless the policy owner deliberately reruns the
-- privilege grants below under a non-owning role).
--
-- Entirely conditional on a role literally named modelforge_runtime
-- already existing in the cluster. Most environments — local development,
-- and any environment that hasn't opted into role separation yet — have no
-- such role, and this migration (and the grant this adds to
-- provision_tenant_clinical_schema, below) is then a complete no-op for
-- them: DATABASE_URL keeps meaning "the one role that does everything,"
-- exactly as before this file existed. See server/README.md for how to
-- create this role and point the application at it via
-- DATABASE_URL (migrations) + RUNTIME_DATABASE_URL (everything after).
DO $grant$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'modelforge_runtime') THEN
        EXECUTE 'GRANT USAGE ON SCHEMA public TO modelforge_runtime';
        EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO modelforge_runtime';
        -- Covers every table any later migration adds to the public schema
        -- too — "FOR ROLE CURRENT_USER" because every public-schema table
        -- so far was created by whichever role is running this migration
        -- right now, and every future one will be too (the same role runs
        -- every migration in this project's deployment model).
        EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE %I GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO modelforge_runtime', CURRENT_USER);
        -- provision_tenant_clinical_schema is SECURITY DEFINER and revoked
        -- from PUBLIC (migrations/009_tenant_clinical_schemas.sql)
        -- specifically so only a role this application actually runs as
        -- can invoke it. The runtime role is exactly that role once
        -- separation is configured — organization bootstrap
        -- (routes/organizations.ts) calls this function as whatever role
        -- the app's own pool connects as.
        EXECUTE 'GRANT EXECUTE ON FUNCTION provision_tenant_clinical_schema(UUID) TO modelforge_runtime';
    END IF;
END
$grant$;

-- Re-declared (CREATE OR REPLACE preserves the existing REVOKE-from-PUBLIC/
-- SECURITY DEFINER grant state set by migration 009 — it does not reset
-- ACLs) purely to add: grant the runtime role USAGE on each *new* tenant
-- schema, and default privileges on the tables about to be created inside
-- it. Unlike the public-schema grants above (a one-time backfill covering
-- every table that already exists), tenant schemas are created on demand,
-- long after this migration has run — this logic has to live inside the
-- function itself so it re-fires for every future organization, not just
-- ones provisioned after modelforge_runtime happens to exist.
--
-- Deliberately does not attempt to retroactively grant access to tenant
-- schemas created *before* modelforge_runtime existed (e.g. a production
-- database adopting role separation after already having tenants) — every
-- environment this ships to today (CI, and any fresh deployment) creates
-- the role before the first organization is ever bootstrapped, so that
-- gap never arises there. An operator retrofitting role separation onto an
-- already-populated database needs to run the equivalent GRANT statements
-- by hand, once, against each existing tenant schema first.
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
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'modelforge_runtime') THEN
        EXECUTE format('GRANT USAGE ON SCHEMA %I TO modelforge_runtime', schema_name);
        -- Set before the CREATE TABLE statements below so every table this
        -- same function call is about to create is covered immediately —
        -- default privileges apply to objects created *after* the rule is
        -- declared, not retroactively.
        EXECUTE format(
            'ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA %I GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO modelforge_runtime',
            CURRENT_USER, schema_name
        );
    END IF;
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
