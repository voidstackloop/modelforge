-- Fixes a real cross-user bug found via live multi-user testing of the
-- local-to-shared case migration flow: case_migrations.source_fingerprint
-- (sha256 of the caller's local case list) was UNIQUE on its own, with no
-- per-user scoping. Two different members of the same organization who
-- both stage with identical local case content — most commonly, both
-- having zero local cases, the ordinary state for anyone new to a shared
-- org — collide onto the exact same migration session via the store's
-- `ON CONFLICT (source_fingerprint) DO UPDATE`. The second caller silently
-- inherits the first caller's session (possibly already validated or even
-- activated), and their own client never recognizes it as a session they
-- can activate — case-migration.ts's stageLocalCases() only proceeds past
-- "resume" for a session with a preview, and the "Activate shared dataset"
-- button (AuditPrivacy.tsx) only renders for status "validated" — so the
-- second user's own activation silently never becomes available even
-- though the request nominally "succeeded."
--
-- Fix: scope the same idempotency-on-retry behavior (a caller repeating
-- their own start() call with the same content reuses their own session,
-- unchanged) to (source_fingerprint, created_by) instead of
-- source_fingerprint alone. See postgres-case-migration-store.ts's start()
-- and in-memory-case-migration-store.ts's start() for the matching
-- application-side fix.
--
-- Same two-part structure as every migration since 015: Part 1 replaces
-- provision_tenant_clinical_schema so every *future* organization's
-- case_migrations table is created with the corrected constraint; Part 2
-- backfills every already-provisioned tenant schema in place. Every block
-- in Part 1 below is copied verbatim from migration 018's version of this
-- function except the one UNIQUE clause called out inline.

-- --- Part 1: extend provision_tenant_clinical_schema -----------------------

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
            UNIQUE (source_fingerprint, created_by)
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
    EXECUTE format(
        'CREATE TABLE IF NOT EXISTS %I.chat_sessions (
            id TEXT PRIMARY KEY,
            version BIGINT NOT NULL,
            data JSONB NOT NULL,
            owner_user_id UUID NOT NULL,
            assigned_user_ids UUID[] NOT NULL DEFAULT ''{}'',
            updated_at TIMESTAMPTZ NOT NULL
        )', schema_name
    );
    EXECUTE format(
        'CREATE TABLE IF NOT EXISTS %I.chat_session_change_counter (
            singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
            next_sequence BIGINT NOT NULL DEFAULT 1
        )', schema_name
    );
    EXECUTE format('INSERT INTO %I.chat_session_change_counter (singleton, next_sequence) VALUES (TRUE, 1) ON CONFLICT DO NOTHING', schema_name);
    EXECUTE format(
        'CREATE TABLE IF NOT EXISTS %I.chat_session_changes (
            sequence BIGINT PRIMARY KEY,
            kind TEXT NOT NULL CHECK (kind IN (''upsert'', ''delete'')),
            session_id TEXT NOT NULL,
            version BIGINT NOT NULL,
            session_data JSONB,
            resource JSONB NOT NULL,
            changed_at TIMESTAMPTZ NOT NULL
        )', schema_name
    );
    EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON %I.chat_session_changes (session_id, sequence DESC)', 'idx_' || schema_name || '_chat_session_changes_session', schema_name);

    PERFORM provision_tenant_imaging_tables(schema_name);
    PERFORM provision_tenant_ai_gateway_tables(schema_name);

    RETURN schema_name;
END
$provision$;

REVOKE ALL ON FUNCTION provision_tenant_clinical_schema(UUID) FROM PUBLIC;

-- --- Part 2: backfill every already-provisioned tenant schema --------------
DO $backfill$
DECLARE
    org RECORD;
BEGIN
    FOR org IN SELECT tenant_schema FROM organizations WHERE tenant_schema IS NOT NULL LOOP
        -- "case_migrations_source_fingerprint_key" is Postgres's default
        -- autogenerated name for the original inline UNIQUE (source_fingerprint)
        -- column constraint declared in migrations 009 through 018.
        EXECUTE format('ALTER TABLE %I.case_migrations DROP CONSTRAINT IF EXISTS case_migrations_source_fingerprint_key', org.tenant_schema);
        EXECUTE format(
            'ALTER TABLE %I.case_migrations ADD CONSTRAINT case_migrations_source_fingerprint_created_by_key UNIQUE (source_fingerprint, created_by)',
            org.tenant_schema
        );
    END LOOP;
END
$backfill$;
