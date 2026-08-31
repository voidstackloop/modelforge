-- ClinicalAiGateway — the sole path by which any UI, model, plugin, or
-- provider may touch patient data on the way to or from an AI model. See
-- docs/CLINICAL_AI_GATEWAY.md and packages/contracts/src/ai-gateway.ts for
-- the full architecture and the shared shapes these tables back.
--
-- Two kinds of tables, deliberately split:
--
--  1. The provider/model CATALOG (ai_providers, ai_provider_models) lives in
--     the PUBLIC schema, not any tenant schema — it is global, cross-tenant,
--     control-plane data (what a model *is*), the same "lives outside every
--     tenant schema" treatment `organizations` itself gets. It is
--     deliberately PHI-free: nothing here ever names a patient, a case, or
--     any clinical content.
--  2. Everything patient-linked (ai_consents, ai_requests and everything
--     that hangs off a request) is tenant-scoped, added via
--     provision_tenant_ai_gateway_tables — same two-part structure as
--     migration 017 (its own precedent): Part 1 replaces
--     provision_tenant_clinical_schema so every *future* organization gets
--     these tables from the start; Part 2 backfills every already-
--     provisioned tenant schema. Every block in Part 1 below is copied
--     verbatim from migration 017's own version of this function except the
--     new PERFORM line added at the end (before RETURN).
--
-- A tenant-scoped table may hold a plain (cross-schema) foreign key into the
-- public ai_provider_models table — that is reading the global catalog, not
-- crossing a tenant boundary; nothing here ever reads a *different tenant
-- schema's* rows.

-- --- Part 0: the global, PHI-free provider/model catalog -------------------

CREATE TABLE IF NOT EXISTS public.ai_providers (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('local', 'on-premises', 'tenant-managed', 'cloud')),
    kill_switch_engaged BOOLEAN NOT NULL DEFAULT FALSE,
    kill_switch_reason TEXT,
    operational_status TEXT NOT NULL CHECK (operational_status IN ('active', 'degraded', 'suspended', 'retired')) DEFAULT 'active',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.ai_provider_models (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    provider_id UUID NOT NULL REFERENCES public.ai_providers(id) ON DELETE CASCADE,
    model_id TEXT NOT NULL,
    model_version TEXT NOT NULL,
    api_version TEXT,
    intended_use TEXT NOT NULL,
    prohibited_use TEXT,
    supported_data_types TEXT[] NOT NULL,
    max_context_tokens INTEGER NOT NULL CHECK (max_context_tokens > 0),
    hosting_region TEXT NOT NULL,
    processing_location TEXT NOT NULL,
    -- Every governance flag defaults to the safe/closed value at the
    -- database level too, not just in the zod schema — belt and suspenders
    -- for "default to denying PHI access."
    phi_permitted BOOLEAN NOT NULL DEFAULT FALSE,
    retains_prompts BOOLEAN NOT NULL DEFAULT FALSE,
    retains_outputs BOOLEAN NOT NULL DEFAULT FALSE,
    training_use_allowed BOOLEAN NOT NULL DEFAULT FALSE,
    zero_retention_support BOOLEAN NOT NULL DEFAULT FALSE,
    approvals JSONB NOT NULL DEFAULT '{"baaSigned":false,"dpaSigned":false,"contractualApproval":false,"securityReviewApproval":false}',
    encryption_in_transit BOOLEAN NOT NULL DEFAULT FALSE,
    encryption_at_rest BOOLEAN NOT NULL DEFAULT FALSE,
    validation_status TEXT NOT NULL CHECK (validation_status IN ('unvalidated', 'shadow', 'canary', 'validated', 'deprecated')) DEFAULT 'unvalidated',
    safety_status TEXT NOT NULL CHECK (safety_status IN ('nominal', 'watch', 'restricted', 'disabled')) DEFAULT 'nominal',
    approved_roles TEXT[] NOT NULL DEFAULT '{}',
    rate_limit_per_minute INTEGER,
    cost_per_input_token_usd NUMERIC(12, 8),
    cost_per_output_token_usd NUMERIC(12, 8),
    cpu_threads INTEGER,
    ram_mb INTEGER,
    vram_mb INTEGER,
    effective_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    retired_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (provider_id, model_id, model_version)
);
CREATE INDEX IF NOT EXISTS idx_ai_provider_models_provider ON public.ai_provider_models (provider_id);

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

    -- New this migration: the clinical imaging domain (unchanged from 017).
    PERFORM provision_tenant_imaging_tables(schema_name);

    -- New this migration: the ClinicalAiGateway domain.
    PERFORM provision_tenant_ai_gateway_tables(schema_name);

    RETURN schema_name;
END
$provision$;

REVOKE ALL ON FUNCTION provision_tenant_clinical_schema(UUID) FROM PUBLIC;

-- Split into its own function for the same readability reason
-- provision_tenant_imaging_tables was (migration 017) — SECURITY
-- DEFINER/search_path match provision_tenant_clinical_schema's own, since
-- it runs with the same migration-owner privileges via PERFORM above.
CREATE OR REPLACE FUNCTION provision_tenant_ai_gateway_tables(schema_name TEXT)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $aigateway$
BEGIN
    -- Per-tenant opt-in/override on top of the global catalog. A model
    -- existing globally with phi_permitted=true does NOT by itself let any
    -- tenant send it PHI — the *effective* permission the gateway enforces
    -- is "global.phi_permitted AND tenant.phi_allowed," always the AND of
    -- both, never either alone (see server/src/ai-gateway/provider-registry.ts).
    EXECUTE format(
        'CREATE TABLE IF NOT EXISTS %I.ai_provider_tenant_settings (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            provider_model_id UUID NOT NULL REFERENCES public.ai_provider_models(id),
            enabled BOOLEAN NOT NULL DEFAULT FALSE,
            phi_allowed BOOLEAN NOT NULL DEFAULT FALSE,
            allowed_roles TEXT[] NOT NULL DEFAULT ''{}'',
            approved_by_user_id UUID NOT NULL,
            approved_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            notes TEXT,
            UNIQUE (provider_model_id)
        )', schema_name
    );

    EXECUTE format(
        'CREATE TABLE IF NOT EXISTS %I.ai_consents (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            patient_case_id TEXT NOT NULL,
            version INTEGER NOT NULL,
            purpose TEXT NOT NULL CHECK (purpose IN (''treatment'',''research'',''teaching'',''quality-improvement'')),
            data_categories TEXT[] NOT NULL,
            status TEXT NOT NULL CHECK (status IN (''active'',''revoked'',''expired'')) DEFAULT ''active'',
            granted_by_user_id UUID NOT NULL,
            granted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            expires_at TIMESTAMPTZ,
            revoked_by_user_id UUID,
            revoked_at TIMESTAMPTZ,
            revoked_reason TEXT,
            UNIQUE (patient_case_id, version)
        )', schema_name
    );
    EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON %I.ai_consents (patient_case_id, status)', 'idx_' || schema_name || '_ai_consents_case', schema_name);

    EXECUTE format(
        'CREATE TABLE IF NOT EXISTS %I.ai_requests (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            patient_case_id TEXT NOT NULL,
            requested_by_user_id UUID NOT NULL,
            provider_model_id UUID NOT NULL REFERENCES public.ai_provider_models(id),
            purpose_of_use TEXT NOT NULL,
            consent_id UUID NOT NULL REFERENCES %I.ai_consents(id),
            policy_snapshot_hash TEXT NOT NULL,
            data_scope JSONB NOT NULL,
            deidentification_applied BOOLEAN NOT NULL DEFAULT FALSE,
            status TEXT NOT NULL CHECK (status IN (
                ''draft'',''pending-authorization'',''scanning'',''queued'',''running'',
                ''awaiting-review'',''accepted'',''rejected'',''corrected'',''escalated'',
                ''failed'',''cancelled'',''expired''
            )) DEFAULT ''draft'',
            rejection_reason TEXT,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            expires_at TIMESTAMPTZ NOT NULL,
            completed_at TIMESTAMPTZ
        )', schema_name, schema_name
    );
    EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON %I.ai_requests (patient_case_id, created_at DESC)', 'idx_' || schema_name || '_ai_requests_case', schema_name);
    EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON %I.ai_requests (status) WHERE status NOT IN (''accepted'',''rejected'',''failed'',''cancelled'',''expired'')', 'idx_' || schema_name || '_ai_requests_open', schema_name);

    EXECUTE format(
        'CREATE TABLE IF NOT EXISTS %I.ai_request_inputs (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            request_id UUID NOT NULL REFERENCES %I.ai_requests(id) ON DELETE CASCADE,
            resource_type TEXT NOT NULL,
            resource_id TEXT NOT NULL,
            resource_version_hash TEXT,
            included_in_prompt BOOLEAN NOT NULL DEFAULT TRUE
        )', schema_name, schema_name
    );
    EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON %I.ai_request_inputs (request_id)', 'idx_' || schema_name || '_ai_request_inputs_req', schema_name);

    EXECUTE format(
        'CREATE TABLE IF NOT EXISTS %I.ai_data_transformations (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            request_id UUID NOT NULL REFERENCES %I.ai_requests(id) ON DELETE CASCADE,
            kind TEXT NOT NULL CHECK (kind IN (''minimization'',''redaction'',''deidentification'',''pseudonymization'',''content-scan'')),
            applied_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            details JSONB
        )', schema_name, schema_name
    );
    EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON %I.ai_data_transformations (request_id)', 'idx_' || schema_name || '_ai_transformations_req', schema_name);

    EXECUTE format(
        'CREATE TABLE IF NOT EXISTS %I.ai_outputs (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            request_id UUID NOT NULL REFERENCES %I.ai_requests(id) ON DELETE CASCADE,
            provider_model_id UUID NOT NULL REFERENCES public.ai_provider_models(id),
            model_version TEXT NOT NULL,
            generated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            summary TEXT NOT NULL,
            evidence TEXT[] NOT NULL DEFAULT ''{}'',
            uncertainty TEXT,
            follow_up TEXT[] NOT NULL DEFAULT ''{}'',
            abstained BOOLEAN NOT NULL DEFAULT FALSE,
            abstain_reason TEXT,
            confidence REAL,
            output_hash TEXT NOT NULL,
            review_status TEXT NOT NULL CHECK (review_status IN (''unreviewed'',''accepted'',''rejected'',''corrected'',''escalated'')) DEFAULT ''unreviewed''
        )', schema_name, schema_name
    );
    EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON %I.ai_outputs (request_id)', 'idx_' || schema_name || '_ai_outputs_req', schema_name);

    EXECUTE format(
        'CREATE TABLE IF NOT EXISTS %I.ai_citations (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            output_id UUID NOT NULL REFERENCES %I.ai_outputs(id) ON DELETE CASCADE,
            resource_type TEXT NOT NULL,
            resource_id TEXT NOT NULL,
            resource_version_hash TEXT,
            locator TEXT
        )', schema_name, schema_name
    );
    EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON %I.ai_citations (output_id)', 'idx_' || schema_name || '_ai_citations_output', schema_name);

    EXECUTE format(
        'CREATE TABLE IF NOT EXISTS %I.ai_reviews (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            output_id UUID NOT NULL REFERENCES %I.ai_outputs(id) ON DELETE CASCADE,
            reviewed_by_user_id UUID NOT NULL,
            decision TEXT NOT NULL CHECK (decision IN (''accepted'',''rejected'',''corrected'',''escalated'')),
            corrected_text TEXT,
            escalation_reason TEXT,
            reviewed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            UNIQUE (output_id)
        )', schema_name, schema_name
    );

    EXECUTE format(
        'CREATE TABLE IF NOT EXISTS %I.ai_safety_events (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            request_id UUID,
            kind TEXT NOT NULL CHECK (kind IN (
                ''prompt-injection-detected'',''secret-detected'',''unsupported-content-detected'',
                ''dlp-block'',''abstained'',''provider-failure'',''consent-violation-blocked'',
                ''quota-exceeded'',''kill-switch-blocked''
            )),
            severity TEXT NOT NULL CHECK (severity IN (''info'',''warning'',''critical'')),
            details TEXT,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )', schema_name
    );
    EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON %I.ai_safety_events (created_at DESC)', 'idx_' || schema_name || '_ai_safety_events_time', schema_name);
    EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON %I.ai_safety_events (severity) WHERE severity = ''critical''', 'idx_' || schema_name || '_ai_safety_events_critical', schema_name);

    -- Metadata-only change feed (never prompt/output text) — same shape as
    -- imaging_changes / case_changes for a future sync client.
    EXECUTE format(
        'CREATE TABLE IF NOT EXISTS %I.ai_gateway_change_counter (
            singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
            next_sequence BIGINT NOT NULL DEFAULT 1
        )', schema_name
    );
    EXECUTE format('INSERT INTO %I.ai_gateway_change_counter (singleton, next_sequence) VALUES (TRUE, 1) ON CONFLICT DO NOTHING', schema_name);
    EXECUTE format(
        'CREATE TABLE IF NOT EXISTS %I.ai_gateway_changes (
            sequence BIGINT PRIMARY KEY,
            kind TEXT NOT NULL CHECK (kind IN (''upsert'', ''delete'')),
            resource_type TEXT NOT NULL CHECK (resource_type IN (''request'',''output'',''review'',''consent'')),
            resource_id TEXT NOT NULL,
            resource JSONB NOT NULL,
            changed_at TIMESTAMPTZ NOT NULL
        )', schema_name
    );
    EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON %I.ai_gateway_changes (resource_type, sequence DESC)', 'idx_' || schema_name || '_ai_gateway_changes_type', schema_name);

    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'modelforge_runtime') THEN
        EXECUTE format(
            'GRANT SELECT, INSERT, UPDATE, DELETE ON
                %I.ai_provider_tenant_settings, %I.ai_consents, %I.ai_requests, %I.ai_request_inputs,
                %I.ai_data_transformations, %I.ai_outputs, %I.ai_citations, %I.ai_reviews,
                %I.ai_safety_events, %I.ai_gateway_change_counter, %I.ai_gateway_changes
             TO modelforge_runtime',
            schema_name, schema_name, schema_name, schema_name, schema_name, schema_name,
            schema_name, schema_name, schema_name, schema_name, schema_name
        );
    END IF;
END
$aigateway$;

REVOKE ALL ON FUNCTION provision_tenant_ai_gateway_tables(TEXT) FROM PUBLIC;

-- Part 2: backfill every already-provisioned tenant schema.
DO $backfill$
DECLARE
    org RECORD;
BEGIN
    FOR org IN SELECT tenant_schema FROM organizations WHERE tenant_schema IS NOT NULL LOOP
        PERFORM provision_tenant_ai_gateway_tables(org.tenant_schema);
    END LOOP;
END
$backfill$;
