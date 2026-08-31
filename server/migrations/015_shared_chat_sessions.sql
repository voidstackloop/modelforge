-- Shared chat sessions — P1 backlog item 7 ("remaining shared clinical
-- domains"), see server/src/routes/sessions.ts's header comment for the
-- authorization model and domain/types.ts-adjacent doc comments in
-- packages/contracts for exactly which fields sync (never `params`,
-- `agentWorkspace`, or `projectId` — device/hardware-tuning or local-only
-- fields, deliberately never sent to this server at all).
--
-- Same per-tenant-schema placement as patient_cases (not a shared table
-- with organization_id) — chat sessions routinely carry the same clinical
-- detail as a case (app/src/sessions-store.ts's own doc comment), so the
-- same isolation guarantee applies.

-- Part 1: CREATE OR REPLACE provision_tenant_clinical_schema, unchanged
-- except for the three new table blocks added at the end (before RETURN)
-- — every *future* organization bootstrap gets chat_sessions from the
-- start. Everything above the new blocks is copied verbatim from
-- migrations/010_runtime_role_grants.sql's own version of this function.
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
    -- New this migration: chat_sessions + its own change-feed counter/log,
    -- same three-table shape as patient_cases/case_change_counter/
    -- case_changes above, for the exact same readSince-cursor reason.
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
    RETURN schema_name;
END
$provision$;

REVOKE ALL ON FUNCTION provision_tenant_clinical_schema(UUID) FROM PUBLIC;

-- Part 2: backfill the three new tables into every ALREADY-provisioned
-- tenant schema. provision_tenant_clinical_schema only ever runs once, at
-- an organization's bootstrap (confirmed this session, P1 item 6's
-- research) — a CREATE OR REPLACE of the function alone (Part 1) only
-- reaches organizations bootstrapped *after* this migration runs.
-- Migration 010's own CREATE OR REPLACE over migration 009 never needed
-- this: it only added grants, never a new table, to schemas that already
-- existed. This is the first migration to add a table after the
-- schema-per-tenant design shipped, so this backfill loop is genuinely
-- new territory for this codebase, not a repeat of an existing pattern.
DO $backfill$
DECLARE
    org RECORD;
BEGIN
    FOR org IN SELECT tenant_schema FROM organizations WHERE tenant_schema IS NOT NULL LOOP
        EXECUTE format(
            'CREATE TABLE IF NOT EXISTS %I.chat_sessions (
                id TEXT PRIMARY KEY,
                version BIGINT NOT NULL,
                data JSONB NOT NULL,
                owner_user_id UUID NOT NULL,
                assigned_user_ids UUID[] NOT NULL DEFAULT ''{}'',
                updated_at TIMESTAMPTZ NOT NULL
            )', org.tenant_schema
        );
        EXECUTE format(
            'CREATE TABLE IF NOT EXISTS %I.chat_session_change_counter (
                singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
                next_sequence BIGINT NOT NULL DEFAULT 1
            )', org.tenant_schema
        );
        EXECUTE format('INSERT INTO %I.chat_session_change_counter (singleton, next_sequence) VALUES (TRUE, 1) ON CONFLICT DO NOTHING', org.tenant_schema);
        EXECUTE format(
            'CREATE TABLE IF NOT EXISTS %I.chat_session_changes (
                sequence BIGINT PRIMARY KEY,
                kind TEXT NOT NULL CHECK (kind IN (''upsert'', ''delete'')),
                session_id TEXT NOT NULL,
                version BIGINT NOT NULL,
                session_data JSONB,
                resource JSONB NOT NULL,
                changed_at TIMESTAMPTZ NOT NULL
            )', org.tenant_schema
        );
        EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON %I.chat_session_changes (session_id, sequence DESC)', 'idx_' || org.tenant_schema || '_chat_session_changes_session', org.tenant_schema);

        -- Default privileges granted once at original provisioning are a
        -- standing rule keyed by (role, schema), not a one-time snapshot,
        -- so they should already cover a table created later by the same
        -- migration-owner role. This explicit grant is redundant with that
        -- reasoning but cheap insurance against getting it wrong on a
        -- table this important.
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'modelforge_runtime') THEN
            EXECUTE format(
                'GRANT SELECT, INSERT, UPDATE, DELETE ON %I.chat_sessions, %I.chat_session_change_counter, %I.chat_session_changes TO modelforge_runtime',
                org.tenant_schema, org.tenant_schema, org.tenant_schema
            );
        END IF;
    END LOOP;
END
$backfill$;
