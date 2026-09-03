-- Model/prompt versioning (docs/CLINICAL_AI_GATEWAY.md's own disclosed gap:
-- "the system prompt is a single hardcoded SYSTEM_PROMPT constant in
-- gateway.ts with no version/hash tracked per request"). Adds
-- ai_outputs.prompt_version, populated going forward by
-- server/src/ai-gateway/prompt-registry.ts's getCurrentSystemPrompt().
--
-- Same two-part structure as migrations 017/018's own precedent, but
-- lighter: rather than replacing the whole provision_tenant_ai_gateway_tables
-- function body just to add one column to its CREATE TABLE statement, this
-- adds a single idempotent `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` call
-- inside that function (via CREATE OR REPLACE, since PL/pgSQL functions
-- have no ALTER-in-place). That one statement is correct for BOTH cases at
-- once: a brand new tenant (the CREATE TABLE just above it in the same
-- function still runs first and creates the table without this column; the
-- ALTER TABLE immediately adds it) and an already-provisioned tenant (the
-- CREATE TABLE is a no-op since the table exists; the ALTER TABLE adds the
-- missing column, backfilling every existing row with the DEFAULT below).
-- Part 2 re-runs the existing backfill loop, which already calls this same
-- function for every tenant schema — nothing new to add there.
--
-- Every other line of the function body below is copied verbatim from
-- migration 018's own version of this function.

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
    -- New this migration: see this file's own top comment for why a single
    -- idempotent ALTER TABLE here (rather than adding the column to the
    -- CREATE TABLE statement above) correctly covers both new and existing
    -- tenants with one statement.
    EXECUTE format('ALTER TABLE %I.ai_outputs ADD COLUMN IF NOT EXISTS prompt_version TEXT NOT NULL DEFAULT ''clinical-gateway-prompt-v1''', schema_name);

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

-- Backfill: re-run the (now-updated) function for every already-provisioned
-- tenant schema — same loop as migration 018's own Part 2, safe to re-run
-- since every statement in the function is idempotent (IF NOT EXISTS /
-- ADD COLUMN IF NOT EXISTS).
DO $backfill$
DECLARE
    org RECORD;
BEGIN
    FOR org IN SELECT tenant_schema FROM organizations WHERE tenant_schema IS NOT NULL LOOP
        PERFORM provision_tenant_ai_gateway_tables(org.tenant_schema);
    END LOOP;
END
$backfill$;
