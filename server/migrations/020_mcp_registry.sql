-- Institutional MCP server/tool registry (docs/ENTERPRISE_ARCHITECTURE_ROADMAP.md
-- P2 item 4: "managed model/MCP registry and egress controls" — the model-
-- registry half already existed via migration 018's AiProvider/
-- AiProviderModel catalog; this is the MCP half, which the roadmap's own
-- capability matrix named as the actual gap: "Per-tool policy and audit
-- exist [locally, in the Electron app], but no institutional registry or
-- centrally managed allowlist."
--
-- Deliberately organization-scoped from the start, unlike the AI provider
-- catalog's global-catalog-plus-tenant-approval split: an MCP server (an
-- institution's own internal Confluence/filesystem/ticketing tool, say) is
-- inherently institution-specific, not a shared fact multiple unrelated
-- hospitals would ever reference the same catalog row for. A shared control-
-- plane table with RLS (this file) rather than per-tenant-schema placement
-- (migration 009's pattern) — this is configuration metadata an org's admin
-- curates, not clinical PHI, the same reasoning migration 013's
-- audit_legal_holds already applied.
--
-- `data_egress_policy` is a centrally-set, auditable POLICY STATEMENT, not a
-- live enforcement mechanism this server can itself carry out — this
-- process never proxies MCP traffic (MCP servers run as the Electron app's
-- own local subprocess/HTTP connections, entirely outside this server's
-- network path). Enforcing it is Electron-side work, out of scope for this
-- migration/slice and disclosed as such in store/mcp-registry-store.ts's own
-- doc comment.
CREATE TABLE IF NOT EXISTS mcp_registry_entries (
    id UUID PRIMARY KEY,
    organization_id UUID NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    transport TEXT NOT NULL CHECK (transport IN ('stdio', 'http')),
    -- The stdio command or HTTP URL this server is reached at — never a
    -- secret itself; any auth token/API key a transport needs stays in the
    -- desktop app's own local OS-keychain-backed secrets store (see
    -- app/src/secrets-store.ts), never round-tripped through this registry.
    endpoint TEXT NOT NULL,
    -- Either the JSON string "*" (every tool this server offers) or a JSON
    -- array of specific tool names — validated in application code
    -- (store/mcp-registry-store.ts), not a SQL CHECK, matching how policy
    -- documents elsewhere in this codebase are JSONB validated in code.
    allowed_tools JSONB NOT NULL,
    data_egress_policy TEXT NOT NULL CHECK (data_egress_policy IN ('none', 'metadata-only', 'unrestricted')),
    status TEXT NOT NULL CHECK (status IN ('active', 'disabled')),
    description TEXT,
    created_by_user_id UUID NOT NULL REFERENCES users (id),
    created_at TIMESTAMPTZ NOT NULL,
    updated_by_user_id UUID REFERENCES users (id),
    updated_at TIMESTAMPTZ NOT NULL
    -- No UNIQUE(organization_id, name): this registry has no hard-delete
    -- (store/mcp-registry-store.ts, matching AiProviderRegistryStore's own
    -- retire-don't-delete convention) — a name-uniqueness constraint would
    -- permanently block reusing a name after disabling a botched entry.
);
CREATE INDEX IF NOT EXISTS idx_mcp_registry_entries_org ON mcp_registry_entries (organization_id, status);

ALTER TABLE mcp_registry_entries ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON mcp_registry_entries;
CREATE POLICY tenant_isolation ON mcp_registry_entries USING (
    organization_id = nullif(current_setting('app.tenant_id', true), '')::uuid
) WITH CHECK (
    organization_id = nullif(current_setting('app.tenant_id', true), '')::uuid
);
