-- Verified, immutable model artifacts and their PHI-free inference
-- deployments. Credentials are references only: secret values never enter
-- Postgres or API responses.

CREATE TABLE IF NOT EXISTS public.ai_model_artifacts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    provider_model_id UUID NOT NULL REFERENCES public.ai_provider_models(id) ON DELETE CASCADE,
    runtime TEXT NOT NULL CHECK (runtime IN ('llamacpp','vllm')),
    format TEXT NOT NULL CHECK (format IN ('gguf','safetensors')),
    source_uri TEXT NOT NULL,
    source_revision TEXT NOT NULL,
    file_name TEXT,
    sha256 TEXT NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
    configuration_hash TEXT NOT NULL CHECK (configuration_hash ~ '^[a-f0-9]{64}$'),
    license_id TEXT NOT NULL,
    license_accepted BOOLEAN NOT NULL DEFAULT FALSE,
    capabilities JSONB NOT NULL,
    chat_template TEXT,
    tool_call_parser TEXT,
    trust_remote_code BOOLEAN NOT NULL DEFAULT FALSE,
    status TEXT NOT NULL CHECK (status IN ('pending','verified','rejected','retired')) DEFAULT 'pending',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (provider_model_id, runtime, sha256, configuration_hash),
    CHECK ((runtime = 'llamacpp' AND format = 'gguf') OR (runtime = 'vllm' AND format = 'safetensors'))
);
CREATE INDEX IF NOT EXISTS idx_ai_model_artifacts_model ON public.ai_model_artifacts(provider_model_id,status);

CREATE TABLE IF NOT EXISTS public.ai_inference_deployments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    artifact_id UUID NOT NULL REFERENCES public.ai_model_artifacts(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    endpoint_url TEXT NOT NULL,
    served_model_name TEXT NOT NULL,
    credential_ref TEXT NOT NULL CHECK (credential_ref ~ '^(env:[A-Z][A-Z0-9_]*|file:/[A-Za-z0-9._/-]+)$'),
    tls_mode TEXT NOT NULL CHECK (tls_mode IN ('required','private-network')),
    pool_id UUID NOT NULL,
    max_concurrency INTEGER NOT NULL CHECK (max_concurrency > 0 AND max_concurrency <= 1024),
    priority INTEGER NOT NULL DEFAULT 100 CHECK (priority >= 0 AND priority <= 10000),
    operational_status TEXT NOT NULL CHECK (operational_status IN ('active','degraded','disabled')) DEFAULT 'disabled',
    runtime_version TEXT,
    last_verified_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (artifact_id, endpoint_url, served_model_name),
    CHECK (right(endpoint_url,3) = '/v1' OR right(endpoint_url,4) = '/v1/')
);
CREATE INDEX IF NOT EXISTS idx_ai_inference_deployments_artifact ON public.ai_inference_deployments(artifact_id,operational_status,priority);

DO $grants$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'modelforge_runtime') THEN
        GRANT SELECT, INSERT, UPDATE, DELETE ON public.ai_model_artifacts, public.ai_inference_deployments TO modelforge_runtime;
    END IF;
END
$grants$;
