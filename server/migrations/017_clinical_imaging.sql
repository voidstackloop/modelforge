-- Clinical imaging — a dedicated domain (X-ray/MRI/CT/ultrasound and other
-- DICOM-derived diagnostic imaging). See docs/IMAGING.md for the full
-- architecture and packages/contracts/src/imaging.ts for the shared shapes
-- these tables back.
--
-- Same two-part structure as migration 015 (its own precedent for adding
-- tables after the schema-per-tenant design shipped): Part 1 replaces
-- provision_tenant_clinical_schema so every *future* organization gets
-- these tables from the start; Part 2 backfills every already-provisioned
-- tenant schema. Every block below is copied verbatim from migration 015's
-- own version of this function except the new imaging table blocks added
-- at the end (before RETURN).
--
-- Original DICOM pixel data is never a column here — imaging_instances
-- carries only metadata (checksum, transfer syntax, sizes, an internal
-- object-storage key); the bytes live in the imaging object store
-- (server/src/imaging/object-store.ts), addressed by that key alone.
--
-- StudyInstanceUID/SeriesInstanceUID/SOPInstanceUID are unique *within
-- this tenant's own schema* only — schema-per-tenant isolation is what
-- makes two different tenants safely able to hold studies with colliding
-- DICOM UIDs (a real, adversarially-tested scenario — see
-- server/src/routes/imaging-dicomweb.test.ts). Nothing here, or anywhere
-- in the application layer, may look up an imaging resource by DICOM UID
-- alone without an organization/tenant context already having selected
-- this schema.

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

    -- New this migration: the clinical imaging domain.
    PERFORM provision_tenant_imaging_tables(schema_name);

    RETURN schema_name;
END
$provision$;

REVOKE ALL ON FUNCTION provision_tenant_clinical_schema(UUID) FROM PUBLIC;

-- Split into its own function (rather than inlined into the giant EXECUTE
-- block above, like every earlier table here) purely for readability given
-- how many tables this domain needs — SECURITY DEFINER/search_path match
-- provision_tenant_clinical_schema's own, since it runs with the same
-- migration-owner privileges via PERFORM above.
CREATE OR REPLACE FUNCTION provision_tenant_imaging_tables(schema_name TEXT)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $imaging$
BEGIN
    EXECUTE format(
        'CREATE TABLE IF NOT EXISTS %I.imaging_studies (
            id TEXT PRIMARY KEY,
            study_instance_uid TEXT NOT NULL,
            patient_identifier_value TEXT NOT NULL,
            patient_identifier_issuer TEXT NOT NULL,
            case_id TEXT,
            accession_number TEXT,
            modalities TEXT[] NOT NULL,
            description TEXT,
            body_part TEXT,
            study_date DATE,
            study_time TEXT,
            institution_name TEXT,
            referring_physician TEXT,
            number_of_series INTEGER NOT NULL DEFAULT 0,
            number_of_instances INTEGER NOT NULL DEFAULT 0,
            status TEXT NOT NULL CHECK (status IN (''registered'',''available'',''cancelled'',''entered-in-error'')),
            sensitivity TEXT NOT NULL CHECK (sensitivity IN (''normal'',''restricted'')) DEFAULT ''normal'',
            ingestion_status TEXT NOT NULL CHECK (ingestion_status IN (
                ''quarantined'',''validating'',''parsing'',''matching'',''review-required'',
                ''thumbnailing'',''publishing'',''published'',''failed'',''rejected''
            )),
            owner_user_id UUID NOT NULL,
            workspace_id TEXT,
            department_id TEXT,
            assigned_user_ids UUID[] NOT NULL DEFAULT ''{}'',
            version BIGINT NOT NULL DEFAULT 1,
            created_at TIMESTAMPTZ NOT NULL,
            updated_at TIMESTAMPTZ NOT NULL
        )', schema_name
    );
    -- Unique WITHIN this tenant schema only — see this file''s own top
    -- doc comment on why that is exactly the intended tenant-isolation
    -- property, not a gap.
    EXECUTE format('CREATE UNIQUE INDEX IF NOT EXISTS %I ON %I.imaging_studies (study_instance_uid)', 'idx_' || schema_name || '_studies_uid', schema_name);
    EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON %I.imaging_studies (patient_identifier_issuer, patient_identifier_value)', 'idx_' || schema_name || '_studies_patient', schema_name);
    EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON %I.imaging_studies (case_id) WHERE case_id IS NOT NULL', 'idx_' || schema_name || '_studies_case', schema_name);
    EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON %I.imaging_studies (ingestion_status) WHERE ingestion_status NOT IN (''published'',''rejected'')', 'idx_' || schema_name || '_studies_pending', schema_name);

    EXECUTE format(
        'CREATE TABLE IF NOT EXISTS %I.imaging_series (
            id TEXT PRIMARY KEY,
            study_id TEXT NOT NULL REFERENCES %I.imaging_studies(id) ON DELETE CASCADE,
            series_instance_uid TEXT NOT NULL,
            series_number TEXT,
            modality TEXT NOT NULL,
            body_part_examined TEXT,
            description TEXT,
            number_of_instances INTEGER NOT NULL DEFAULT 0,
            created_at TIMESTAMPTZ NOT NULL,
            updated_at TIMESTAMPTZ NOT NULL
        )', schema_name, schema_name
    );
    EXECUTE format('CREATE UNIQUE INDEX IF NOT EXISTS %I ON %I.imaging_series (series_instance_uid)', 'idx_' || schema_name || '_series_uid', schema_name);
    EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON %I.imaging_series (study_id)', 'idx_' || schema_name || '_series_study', schema_name);

    EXECUTE format(
        'CREATE TABLE IF NOT EXISTS %I.imaging_instances (
            id TEXT PRIMARY KEY,
            series_id TEXT NOT NULL REFERENCES %I.imaging_series(id) ON DELETE CASCADE,
            sop_instance_uid TEXT NOT NULL,
            sop_class_uid TEXT NOT NULL,
            instance_number TEXT,
            transfer_syntax_uid TEXT NOT NULL,
            rows INTEGER,
            columns INTEGER,
            number_of_frames INTEGER,
            checksum_sha256 TEXT NOT NULL,
            object_storage_key TEXT NOT NULL,
            size_bytes BIGINT NOT NULL,
            has_thumbnail BOOLEAN NOT NULL DEFAULT FALSE,
            created_at TIMESTAMPTZ NOT NULL
        )', schema_name, schema_name
    );
    EXECUTE format('CREATE UNIQUE INDEX IF NOT EXISTS %I ON %I.imaging_instances (sop_instance_uid)', 'idx_' || schema_name || '_instances_uid', schema_name);
    EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON %I.imaging_instances (series_id)', 'idx_' || schema_name || '_instances_series', schema_name);

    EXECUTE format(
        'CREATE TABLE IF NOT EXISTS %I.diagnostic_reports (
            id TEXT PRIMARY KEY,
            study_id TEXT NOT NULL REFERENCES %I.imaging_studies(id) ON DELETE CASCADE,
            status TEXT NOT NULL CHECK (status IN (''preliminary'',''final'',''amended'',''corrected'',''cancelled'',''entered-in-error'')),
            conclusion TEXT NOT NULL,
            conclusion_code TEXT,
            author_user_id UUID NOT NULL,
            authored_at TIMESTAMPTZ NOT NULL,
            signed_by_user_id UUID,
            signed_at TIMESTAMPTZ,
            previous_version_id TEXT REFERENCES %I.diagnostic_reports(id),
            amendment_reason TEXT,
            is_critical BOOLEAN NOT NULL DEFAULT FALSE,
            critical_acknowledged_by_user_id UUID,
            critical_acknowledged_at TIMESTAMPTZ,
            created_at TIMESTAMPTZ NOT NULL,
            updated_at TIMESTAMPTZ NOT NULL,
            CHECK ((signed_by_user_id IS NULL) = (signed_at IS NULL)),
            CHECK ((critical_acknowledged_by_user_id IS NULL) = (critical_acknowledged_at IS NULL))
        )', schema_name, schema_name, schema_name
    );
    EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON %I.diagnostic_reports (study_id, created_at DESC)', 'idx_' || schema_name || '_reports_study', schema_name);
    -- The hot-path lookup for "what is the CURRENT report for this study":
    -- the one row (per study) that is not superseded by any other row's
    -- previous_version_id — see PostgresImagingReportStore.getCurrent.
    EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON %I.diagnostic_reports (previous_version_id) WHERE previous_version_id IS NOT NULL', 'idx_' || schema_name || '_reports_prev', schema_name);

    EXECUTE format(
        'CREATE TABLE IF NOT EXISTS %I.imaging_annotations (
            id TEXT PRIMARY KEY,
            study_id TEXT NOT NULL REFERENCES %I.imaging_studies(id) ON DELETE CASCADE,
            series_id TEXT REFERENCES %I.imaging_series(id) ON DELETE CASCADE,
            instance_id TEXT REFERENCES %I.imaging_instances(id) ON DELETE CASCADE,
            frame_number INTEGER,
            kind TEXT NOT NULL CHECK (kind IN (''measurement'',''note'',''region'')),
            data JSONB NOT NULL,
            annotation_text TEXT,
            author_user_id UUID NOT NULL,
            provenance TEXT NOT NULL CHECK (provenance IN (''human'',''ai-generated'')),
            version BIGINT NOT NULL DEFAULT 1,
            created_at TIMESTAMPTZ NOT NULL,
            updated_at TIMESTAMPTZ NOT NULL
        )', schema_name, schema_name, schema_name, schema_name
    );
    EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON %I.imaging_annotations (study_id)', 'idx_' || schema_name || '_annotations_study', schema_name);

    EXECUTE format(
        'CREATE TABLE IF NOT EXISTS %I.provenance_records (
            id TEXT PRIMARY KEY,
            target_type TEXT NOT NULL CHECK (target_type IN (''instance'',''study'',''report'',''derivedArtifact'')),
            target_id TEXT NOT NULL,
            action TEXT NOT NULL CHECK (action IN (''ingested'',''thumbnail-generated'',''deidentified'',''annotated'',''ai-generated'',''exported'')),
            performed_by TEXT NOT NULL,
            performed_at TIMESTAMPTZ NOT NULL,
            source_refs TEXT[] NOT NULL DEFAULT ''{}'',
            details JSONB
        )', schema_name
    );
    EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON %I.provenance_records (target_type, target_id)', 'idx_' || schema_name || '_provenance_target', schema_name);

    EXECUTE format(
        'CREATE TABLE IF NOT EXISTS %I.derived_artifacts (
            id TEXT PRIMARY KEY,
            kind TEXT NOT NULL CHECK (kind IN (''thumbnail'',''deidentified-instance'',''annotation-overlay'',''ai-output'')),
            source_instance_id TEXT REFERENCES %I.imaging_instances(id) ON DELETE CASCADE,
            source_study_id TEXT REFERENCES %I.imaging_studies(id) ON DELETE CASCADE,
            object_storage_key TEXT NOT NULL,
            checksum_sha256 TEXT NOT NULL,
            size_bytes BIGINT NOT NULL,
            provenance_id TEXT NOT NULL REFERENCES %I.provenance_records(id),
            created_at TIMESTAMPTZ NOT NULL
        )', schema_name, schema_name, schema_name, schema_name
    );
    EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON %I.derived_artifacts (source_instance_id) WHERE source_instance_id IS NOT NULL', 'idx_' || schema_name || '_artifacts_instance', schema_name);
    EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON %I.derived_artifacts (source_study_id) WHERE source_study_id IS NOT NULL', 'idx_' || schema_name || '_artifacts_study', schema_name);

    EXECUTE format(
        'CREATE TABLE IF NOT EXISTS %I.imaging_share_grants (
            id TEXT PRIMARY KEY,
            mode TEXT NOT NULL CHECK (mode IN (''internal'',''cross-organization'',''external-portal'')),
            scope TEXT NOT NULL CHECK (scope IN (''study'',''series'',''instance'',''report'')),
            study_id TEXT NOT NULL REFERENCES %I.imaging_studies(id) ON DELETE CASCADE,
            series_id TEXT,
            instance_id TEXT,
            report_id TEXT,
            recipient_user_id UUID,
            recipient_organization_id UUID,
            recipient_email TEXT,
            recipient_name TEXT,
            purpose_of_use TEXT NOT NULL,
            message TEXT,
            expires_at TIMESTAMPTZ NOT NULL,
            allow_download BOOLEAN NOT NULL DEFAULT FALSE,
            issued_by_user_id UUID NOT NULL,
            consent_basis TEXT NOT NULL,
            status TEXT NOT NULL CHECK (status IN (''active'',''revoked'',''expired'')) DEFAULT ''active'',
            revoked_by_user_id UUID,
            revoked_at TIMESTAMPTZ,
            external_token_hash TEXT,
            external_verification_code_hash TEXT,
            created_at TIMESTAMPTZ NOT NULL,
            CHECK ((status = ''revoked'') = (revoked_at IS NOT NULL))
        )', schema_name, schema_name
    );
    EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON %I.imaging_share_grants (study_id)', 'idx_' || schema_name || '_shares_study', schema_name);
    EXECUTE format('CREATE UNIQUE INDEX IF NOT EXISTS %I ON %I.imaging_share_grants (external_token_hash) WHERE external_token_hash IS NOT NULL', 'idx_' || schema_name || '_shares_external_token', schema_name);
    -- The hot-path lookup on every viewer-session issuance/refresh: "is
    -- there a currently-active grant for this study."
    EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON %I.imaging_share_grants (study_id, status) WHERE status = ''active''', 'idx_' || schema_name || '_shares_active', schema_name);

    EXECUTE format(
        'CREATE TABLE IF NOT EXISTS %I.imaging_ingestion_jobs (
            id TEXT PRIMARY KEY,
            upload_id TEXT NOT NULL,
            file_name TEXT NOT NULL,
            size_bytes BIGINT NOT NULL,
            checksum_sha256 TEXT,
            status TEXT NOT NULL CHECK (status IN (
                ''quarantined'',''validating'',''parsing'',''matching'',''review-required'',
                ''thumbnailing'',''publishing'',''published'',''failed'',''rejected''
            )),
            study_id TEXT REFERENCES %I.imaging_studies(id),
            failure_category TEXT,
            created_by_user_id UUID NOT NULL,
            created_at TIMESTAMPTZ NOT NULL,
            updated_at TIMESTAMPTZ NOT NULL
        )', schema_name, schema_name
    );
    EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON %I.imaging_ingestion_jobs (status)', 'idx_' || schema_name || '_ingestion_status', schema_name);
    EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON %I.imaging_ingestion_jobs (created_at DESC)', 'idx_' || schema_name || '_ingestion_created', schema_name);

    EXECUTE format(
        'CREATE TABLE IF NOT EXISTS %I.viewer_sessions (
            id TEXT PRIMARY KEY,
            user_id UUID,
            study_id TEXT NOT NULL REFERENCES %I.imaging_studies(id) ON DELETE CASCADE,
            series_ids TEXT[],
            instance_ids TEXT[],
            granted_actions TEXT[] NOT NULL,
            share_grant_id TEXT REFERENCES %I.imaging_share_grants(id),
            token_hash TEXT NOT NULL,
            issued_at TIMESTAMPTZ NOT NULL,
            expires_at TIMESTAMPTZ NOT NULL,
            revoked BOOLEAN NOT NULL DEFAULT FALSE,
            CHECK (user_id IS NOT NULL OR share_grant_id IS NOT NULL)
        )', schema_name, schema_name, schema_name
    );
    -- The hot-path lookup on every DICOMweb request through a viewer
    -- session: "is this token currently valid." Partial on NOT revoked so
    -- a revoked session (item 11''s ''revocation must terminate new viewer
    -- sessions immediately'') is never found by this index again.
    EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON %I.viewer_sessions (token_hash) WHERE NOT revoked', 'idx_' || schema_name || '_viewer_sessions_token', schema_name);
    EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON %I.viewer_sessions (share_grant_id) WHERE share_grant_id IS NOT NULL', 'idx_' || schema_name || '_viewer_sessions_share', schema_name);

    EXECUTE format(
        'CREATE TABLE IF NOT EXISTS %I.deidentification_jobs (
            id TEXT PRIMARY KEY,
            source_study_id TEXT NOT NULL REFERENCES %I.imaging_studies(id) ON DELETE CASCADE,
            profile TEXT NOT NULL CHECK (profile IN (''basic'',''clean-pixel-data'',''retain-longitudinal-full-dates'',''retain-safe-private'')),
            purpose TEXT NOT NULL CHECK (purpose IN (''research'',''teaching'',''external-export'')),
            burned_in_text_suspected BOOLEAN NOT NULL DEFAULT FALSE,
            recognizable_features_flagged BOOLEAN NOT NULL DEFAULT FALSE,
            review_status TEXT NOT NULL CHECK (review_status IN (''pending-review'',''approved'',''rejected'',''auto-approved'')),
            reviewed_by_user_id UUID,
            reviewed_at TIMESTAMPTZ,
            result_artifact_id TEXT REFERENCES %I.derived_artifacts(id),
            requested_by_user_id UUID NOT NULL,
            created_at TIMESTAMPTZ NOT NULL,
            updated_at TIMESTAMPTZ NOT NULL
        )', schema_name, schema_name, schema_name
    );
    EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON %I.deidentification_jobs (source_study_id)', 'idx_' || schema_name || '_deid_study', schema_name);
    EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON %I.deidentification_jobs (review_status) WHERE review_status = ''pending-review''', 'idx_' || schema_name || '_deid_pending', schema_name);

    EXECUTE format(
        'CREATE TABLE IF NOT EXISTS %I.document_references (
            id TEXT PRIMARY KEY,
            study_id TEXT REFERENCES %I.imaging_studies(id) ON DELETE CASCADE,
            case_id TEXT,
            title TEXT NOT NULL,
            content_type TEXT NOT NULL,
            size_bytes BIGINT NOT NULL,
            checksum_sha256 TEXT NOT NULL,
            object_storage_key TEXT NOT NULL,
            author_user_id UUID NOT NULL,
            created_at TIMESTAMPTZ NOT NULL
        )', schema_name, schema_name
    );
    EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON %I.document_references (study_id) WHERE study_id IS NOT NULL', 'idx_' || schema_name || '_docref_study', schema_name);
    EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON %I.document_references (case_id) WHERE case_id IS NOT NULL', 'idx_' || schema_name || '_docref_case', schema_name);

    -- Unified change feed — study/report/shareGrant upserts and deletes
    -- only, per packages/contracts/src/imaging.ts's imagingChangeSchema.
    -- Never pixel data, never instance/series/annotation/provenance rows —
    -- those aren''t independently synced client state, they''re always
    -- fetched fresh through the study they belong to.
    EXECUTE format(
        'CREATE TABLE IF NOT EXISTS %I.imaging_change_counter (
            singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
            next_sequence BIGINT NOT NULL DEFAULT 1
        )', schema_name
    );
    EXECUTE format('INSERT INTO %I.imaging_change_counter (singleton, next_sequence) VALUES (TRUE, 1) ON CONFLICT DO NOTHING', schema_name);
    EXECUTE format(
        'CREATE TABLE IF NOT EXISTS %I.imaging_changes (
            sequence BIGINT PRIMARY KEY,
            kind TEXT NOT NULL CHECK (kind IN (''upsert'', ''delete'')),
            resource_type TEXT NOT NULL CHECK (resource_type IN (''study'',''report'',''shareGrant'')),
            resource_id TEXT NOT NULL,
            study_id TEXT NOT NULL,
            resource JSONB NOT NULL,
            changed_at TIMESTAMPTZ NOT NULL
        )', schema_name
    );
    EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON %I.imaging_changes (study_id, sequence DESC)', 'idx_' || schema_name || '_imaging_changes_study', schema_name);

    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'modelforge_runtime') THEN
        EXECUTE format(
            'GRANT SELECT, INSERT, UPDATE, DELETE ON
                %I.imaging_studies, %I.imaging_series, %I.imaging_instances, %I.diagnostic_reports,
                %I.imaging_annotations, %I.provenance_records, %I.derived_artifacts, %I.imaging_share_grants,
                %I.imaging_ingestion_jobs, %I.viewer_sessions, %I.deidentification_jobs, %I.document_references,
                %I.imaging_change_counter, %I.imaging_changes
             TO modelforge_runtime',
            schema_name, schema_name, schema_name, schema_name, schema_name, schema_name, schema_name, schema_name,
            schema_name, schema_name, schema_name, schema_name, schema_name, schema_name
        );
    END IF;
END
$imaging$;

REVOKE ALL ON FUNCTION provision_tenant_imaging_tables(TEXT) FROM PUBLIC;

-- Part 2: backfill every already-provisioned tenant schema.
DO $backfill$
DECLARE
    org RECORD;
BEGIN
    FOR org IN SELECT tenant_schema FROM organizations WHERE tenant_schema IS NOT NULL LOOP
        PERFORM provision_tenant_imaging_tables(org.tenant_schema);
    END LOOP;
END
$backfill$;
