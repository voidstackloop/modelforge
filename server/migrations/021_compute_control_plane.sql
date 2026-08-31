-- Enterprise hybrid CPU/GPU control plane. Inventory and scheduling data is
-- PHI-free but organization-scoped, so it lives in shared control-plane
-- tables with the same app.tenant_id RLS boundary as other admin metadata.

CREATE TABLE IF NOT EXISTS compute_nodes (
    id UUID PRIMARY KEY,
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    region TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('online','offline','cordoned','draining','quarantined')),
    certificate_fingerprint TEXT NOT NULL,
    inventory_version TEXT NOT NULL,
    last_heartbeat_at TIMESTAMPTZ NOT NULL,
    document JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL,
    UNIQUE (organization_id, certificate_fingerprint)
);
CREATE INDEX IF NOT EXISTS idx_compute_nodes_org_region_state ON compute_nodes(organization_id,region,state);
CREATE INDEX IF NOT EXISTS idx_compute_nodes_heartbeat ON compute_nodes(last_heartbeat_at) WHERE state = 'online';

CREATE TABLE IF NOT EXISTS compute_accelerator_devices (
    id TEXT PRIMARY KEY,
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    node_id UUID NOT NULL REFERENCES compute_nodes(id) ON DELETE CASCADE,
    health TEXT NOT NULL CHECK (health IN ('healthy','degraded','unhealthy','quarantined')),
    vendor TEXT NOT NULL,
    total_vram_mb INTEGER NOT NULL CHECK (total_vram_mb >= 0),
    free_vram_mb INTEGER NOT NULL CHECK (free_vram_mb >= 0),
    document JSONB NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_compute_devices_node_health ON compute_accelerator_devices(node_id,health);

CREATE TABLE IF NOT EXISTS compute_resource_pools (
    id UUID PRIMARY KEY,
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    region TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('active','draining','disabled')),
    document JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_compute_pools_org_region ON compute_resource_pools(organization_id,region,status);

CREATE TABLE IF NOT EXISTS compute_pool_nodes (
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    pool_id UUID NOT NULL REFERENCES compute_resource_pools(id) ON DELETE CASCADE,
    node_id UUID NOT NULL REFERENCES compute_nodes(id) ON DELETE CASCADE,
    PRIMARY KEY (pool_id,node_id)
);

CREATE TABLE IF NOT EXISTS compute_tenant_quotas (
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    pool_id UUID NOT NULL REFERENCES compute_resource_pools(id) ON DELETE CASCADE,
    document JSONB NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (organization_id,pool_id)
);

CREATE TABLE IF NOT EXISTS compute_resource_policies (
    id UUID PRIMARY KEY,
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    pool_id UUID REFERENCES compute_resource_pools(id) ON DELETE CASCADE,
    version INTEGER NOT NULL CHECK (version > 0),
    status TEXT NOT NULL CHECK (status IN ('draft','active','retired')),
    document JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL,
    UNIQUE (organization_id,pool_id,version)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_compute_active_policy ON compute_resource_policies(organization_id,COALESCE(pool_id,'00000000-0000-0000-0000-000000000000'::uuid)) WHERE status='active';

CREATE TABLE IF NOT EXISTS compute_resource_requests (
    id UUID PRIMARY KEY,
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    pool_id UUID NOT NULL REFERENCES compute_resource_pools(id) ON DELETE RESTRICT,
    state TEXT NOT NULL CHECK (state IN ('queued','assigned','running','preempting','completed','failed','cancelled')),
    priority TEXT NOT NULL CHECK (priority IN ('interactive','imaging','scheduled','background','maintenance')),
    document JSONB NOT NULL,
    queued_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_compute_requests_queue ON compute_resource_requests(pool_id,state,priority,queued_at);

CREATE SEQUENCE IF NOT EXISTS compute_fencing_token_seq AS BIGINT;
CREATE TABLE IF NOT EXISTS compute_resource_leases (
    id UUID PRIMARY KEY,
    request_id UUID NOT NULL UNIQUE REFERENCES compute_resource_requests(id) ON DELETE CASCADE,
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    pool_id UUID NOT NULL REFERENCES compute_resource_pools(id) ON DELETE RESTRICT,
    node_id UUID NOT NULL REFERENCES compute_nodes(id) ON DELETE RESTRICT,
    state TEXT NOT NULL CHECK (state IN ('offered','acknowledged','running','released','expired','failed')),
    fencing_token BIGINT NOT NULL UNIQUE,
    acknowledgment_deadline_at TIMESTAMPTZ NOT NULL,
    renewal_deadline_at TIMESTAMPTZ NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    document JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_compute_leases_active ON compute_resource_leases(pool_id,node_id,state,expires_at);

CREATE TABLE IF NOT EXISTS compute_node_heartbeats (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    node_id UUID NOT NULL REFERENCES compute_nodes(id) ON DELETE CASCADE,
    captured_at TIMESTAMPTZ NOT NULL,
    document JSONB NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_compute_heartbeats_node_time ON compute_node_heartbeats(node_id,captured_at DESC);

CREATE TABLE IF NOT EXISTS compute_allocation_events (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    request_id UUID NOT NULL REFERENCES compute_resource_requests(id) ON DELETE CASCADE,
    lease_id UUID REFERENCES compute_resource_leases(id) ON DELETE SET NULL,
    event_type TEXT NOT NULL,
    occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    details JSONB NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS idx_compute_events_request ON compute_allocation_events(request_id,occurred_at);

-- Cross-tenant maintenance is intentionally confined to two narrow
-- SECURITY DEFINER functions. The restricted runtime role cannot SELECT
-- arbitrary tenants through RLS; these functions disclose only affected
-- ids and perform fixed state transitions, never return tenant documents.
CREATE OR REPLACE FUNCTION sweep_stale_compute_nodes(p_cutoff TIMESTAMPTZ)
RETURNS UUID[]
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fn$
DECLARE affected UUID[];
BEGIN
    WITH changed AS (
        UPDATE public.compute_nodes
        SET state='offline', updated_at=now(),
            -- to_jsonb() applied directly to a timestamptz produces a real
            -- ISO-8601 string ("2026-08-31T13:45:00.123456+00:00"); casting
            -- to ::text first (the bug this replaced) instead captures
            -- Postgres's own default text format ("2026-08-31
            -- 13:45:00.123456+00" -- space-separated, no colon in the
            -- offset), which fails the strict z.string().datetime({offset:
            -- true}) this document's own updatedAt field is re-validated
            -- against on every subsequent read.
            document=jsonb_set(jsonb_set(document,'{state}','"offline"'::jsonb),'{updatedAt}',to_jsonb(now()))
        WHERE state='online' AND last_heartbeat_at < p_cutoff
        RETURNING id
    ) SELECT COALESCE(array_agg(id),'{}'::uuid[]) INTO affected FROM changed;
    RETURN affected;
END
$fn$;

CREATE OR REPLACE FUNCTION reclaim_expired_compute_leases(p_now TIMESTAMPTZ)
RETURNS UUID[]
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fn$
DECLARE affected UUID[];
BEGIN
    WITH expired AS (
        UPDATE public.compute_resource_leases
        SET state='expired', updated_at=p_now,
            -- See sweep_stale_compute_nodes() above for why this must not
            -- cast p_now to ::text before to_jsonb().
            document=jsonb_set(jsonb_set(document,'{state}','"expired"'::jsonb),'{updatedAt}',to_jsonb(p_now))
        WHERE state IN ('offered','acknowledged','running')
          AND (expires_at <= p_now OR (state='offered' AND acknowledgment_deadline_at <= p_now))
        RETURNING id,request_id
    ), requeued AS (
        UPDATE public.compute_resource_requests request
        SET state='queued',updated_at=p_now,
            -- See sweep_stale_compute_nodes() above for why this must not
            -- cast p_now to ::text before to_jsonb().
            document=jsonb_set(jsonb_set(request.document - 'assignedAt','{state}','"queued"'::jsonb),'{updatedAt}',to_jsonb(p_now))
        FROM expired WHERE request.id=expired.request_id AND request.state <> 'cancelled'
        RETURNING request.id
    ) SELECT COALESCE(array_agg(id),'{}'::uuid[]) INTO affected FROM expired;
    RETURN affected;
END
$fn$;

DO $rls$
DECLARE table_name TEXT;
BEGIN
    FOREACH table_name IN ARRAY ARRAY[
        'compute_nodes','compute_accelerator_devices','compute_resource_pools','compute_pool_nodes',
        'compute_tenant_quotas','compute_resource_policies','compute_resource_requests',
        'compute_resource_leases','compute_node_heartbeats','compute_allocation_events'
    ] LOOP
        EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
        EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', table_name);
        EXECUTE format(
            'CREATE POLICY tenant_isolation ON %I USING (organization_id = nullif(current_setting(''app.tenant_id'', true), '''')::uuid) WITH CHECK (organization_id = nullif(current_setting(''app.tenant_id'', true), '''')::uuid)',
            table_name
        );
    END LOOP;
END
$rls$;

-- Enforce new deployment references immediately while allowing an operator
-- to reconcile any legacy placeholder pool ids before validating old rows.
DO $fk$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='ai_inference_deployments_pool_fk') THEN
        ALTER TABLE ai_inference_deployments
            ADD CONSTRAINT ai_inference_deployments_pool_fk
            FOREIGN KEY (pool_id) REFERENCES compute_resource_pools(id) NOT VALID;
    END IF;
END
$fk$;

DO $grants$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='modelforge_runtime') THEN
        GRANT SELECT,INSERT,UPDATE,DELETE ON
            compute_nodes,compute_accelerator_devices,compute_resource_pools,compute_pool_nodes,
            compute_tenant_quotas,compute_resource_policies,compute_resource_requests,
            compute_resource_leases,compute_node_heartbeats,compute_allocation_events
            TO modelforge_runtime;
        GRANT USAGE,SELECT ON SEQUENCE compute_fencing_token_seq,compute_node_heartbeats_id_seq,compute_allocation_events_id_seq TO modelforge_runtime;
        GRANT EXECUTE ON FUNCTION sweep_stale_compute_nodes(TIMESTAMPTZ),reclaim_expired_compute_leases(TIMESTAMPTZ) TO modelforge_runtime;
    END IF;
END
$grants$;
