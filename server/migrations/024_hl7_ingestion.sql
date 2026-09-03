-- HL7 v2 inbound ingestion job tracking (server/src/hl7/ingestion.ts,
-- routes/hl7.ts's POST .../inbound/ingest). See docs/HL7_V2_INTEGRATION.md.
--
-- Same three-part structure as every migration since 015/017/018/022: a
-- dedicated `provision_tenant_hl7_tables` sub-function (Part 1, this
-- domain's own tables, same split-into-its-own-function reason
-- provision_tenant_imaging_tables/provision_tenant_ai_gateway_tables were);
-- provision_tenant_clinical_schema replaced to call it for every *future*
-- organization (Part 2, copied verbatim from migration 022's version of
-- this function except the one new PERFORM line at the end); and a
-- backfill for every already-provisioned tenant schema (Part 3).

-- --- Part 1: this domain's own tables ---------------------------------------

CREATE OR REPLACE FUNCTION provision_tenant_hl7_tables(schema_name TEXT)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $hl7$
BEGIN
    EXECUTE format(
        'CREATE TABLE IF NOT EXISTS %I.hl7_ingestion_jobs (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            message_type TEXT NOT NULL,
            message_control_id TEXT NOT NULL,
            raw_message TEXT NOT NULL,
            received_at TIMESTAMPTZ NOT NULL,
            patient_identifier_value TEXT,
            patient_identifier_issuer TEXT,
            match_status TEXT NOT NULL CHECK (match_status IN (''matched'',''ambiguous'',''no-match'')),
            matched_case_id TEXT,
            candidate_case_ids TEXT[],
            status TEXT NOT NULL CHECK (status IN (''pending-review'',''applied'',''rejected'')),
            observations_added INTEGER,
            reviewed_by_user_id UUID,
            reviewed_at TIMESTAMPTZ,
            rejection_reason TEXT,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )', schema_name
    );
    EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON %I.hl7_ingestion_jobs (status, created_at DESC)', 'idx_' || schema_name || '_hl7_ingestion_jobs_status', schema_name);
    EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON %I.hl7_ingestion_jobs (patient_identifier_value)', 'idx_' || schema_name || '_hl7_ingestion_jobs_patient', schema_name);

    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'modelforge_runtime') THEN
        EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I.hl7_ingestion_jobs TO modelforge_runtime', schema_name);
    END IF;
END
$hl7$;

REVOKE ALL ON FUNCTION provision_tenant_hl7_tables(TEXT) FROM PUBLIC;

-- --- Part 2: extend provision_tenant_clinical_schema (verbatim copy of
-- migration 022's version, plus one new PERFORM line before RETURN) -------

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
    -- New this migration.
    PERFORM provision_tenant_hl7_tables(schema_name);

    RETURN schema_name;
END
$provision$;

REVOKE ALL ON FUNCTION provision_tenant_clinical_schema(UUID) FROM PUBLIC;

-- --- Part 3: backfill every already-provisioned tenant schema --------------
DO $backfill$
DECLARE
    org RECORD;
BEGIN
    FOR org IN SELECT tenant_schema FROM organizations WHERE tenant_schema IS NOT NULL LOOP
        PERFORM provision_tenant_hl7_tables(org.tenant_schema);
    END LOOP;
END
$backfill$;
