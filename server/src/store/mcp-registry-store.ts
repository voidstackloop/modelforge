import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type { McpAllowedTools, McpDataEgressPolicy, McpIntegrationProfile, McpRegistryEntry, McpRegistryStatus, McpTransport } from "../domain/types.js";
import { type AuditActor, type AuditStore, InMemoryAuditStore, insertAuditEntry } from "./audit-store.js";

/**
 * Institutional MCP server/tool registry (docs/ENTERPRISE_ARCHITECTURE_
 * ROADMAP.md P2 item 4: "managed model/MCP registry and egress controls").
 * The "managed model" half of that item already existed before this file —
 * see AiProviderRegistryStore (server/src/store/ai-provider-registry-
 * store.ts), a global provider/model/deployment catalog built as part of
 * the separate ClinicalAiGateway effort (docs/CLINICAL_AI_GATEWAY.md). This
 * is the MCP half, which the roadmap's own capability matrix named as the
 * actual gap: "Per-tool policy and audit exist [locally, in the Electron
 * app's agent-tools.ts], but no institutional registry or centrally managed
 * allowlist."
 *
 * Organization-scoped from the start, unlike AiProviderRegistryStore's
 * global-catalog-plus-tenant-approval split — an MCP server (an
 * institution's own internal Confluence/filesystem/ticketing tool, say) is
 * inherently institution-specific, not a shared fact unrelated hospitals
 * would reference the same catalog row for.
 *
 * IMPORTANT SCOPE BOUNDARY, stated here because it's easy to overclaim: this
 * store is a *published, centrally administered allowlist* — a source of
 * truth an institution's admins curate and audit. It does not itself
 * enforce anything. This server never proxies MCP traffic; MCP servers run
 * as the Electron desktop app's own local subprocess/HTTP connections,
 * entirely outside this process's network path. `dataEgressPolicy` is a
 * policy STATEMENT this registry publishes for a managed-mode desktop app
 * to fetch and enforce locally (matching docs/ENTERPRISE_ARCHITECTURE_
 * ROADMAP.md §4 trust boundary 6: "a centrally governed tool allowlist in
 * managed mode... and explicit data-egress policy") — wiring an actual
 * Electron-side consumer of this registry is a separate, disclosed, not-yet-
 * done piece of work.
 *
 * No hard-delete method, deliberately — matches AiProviderRegistryStore's
 * own retire-don't-delete convention (retireProviderModel,
 * setProviderKillSwitch) and this codebase's broader standing pattern
 * (SCIM's DELETE suspends rather than removing, MasterVault/tenant-backup
 * never hard-delete). `setStatus` to "disabled" is how an entry is retired.
 */
export interface CreateMcpRegistryEntryInput {
    name: string;
    transport: McpTransport;
    endpoint: string;
    allowedTools: McpAllowedTools;
    dataEgressPolicy: McpDataEgressPolicy;
    integrationProfile?: McpIntegrationProfile;
    oauthClientId?: string;
    catalogVersionConstraint?: string;
    approvalChallengeEndpoint?: string;
    description?: string;
}

export type UpdateMcpRegistryEntryInput = Partial<CreateMcpRegistryEntryInput>;

export interface McpRegistryStore {
    create(organizationId: string, input: CreateMcpRegistryEntryInput, createdByUserId: string, actor: AuditActor): Promise<McpRegistryEntry>;
    listByOrganization(organizationId: string, filter?: { status?: McpRegistryStatus }): Promise<McpRegistryEntry[]>;
    getById(organizationId: string, id: string): Promise<McpRegistryEntry | null>;
    update(organizationId: string, id: string, partial: UpdateMcpRegistryEntryInput, updatedByUserId: string, actor: AuditActor): Promise<McpRegistryEntry | null>;
    setStatus(organizationId: string, id: string, status: McpRegistryStatus, updatedByUserId: string, actor: AuditActor): Promise<McpRegistryEntry | null>;
}

export class InMemoryMcpRegistryStore implements McpRegistryStore {
    private readonly entries = new Map<string, McpRegistryEntry>();

    constructor(private readonly auditStore: AuditStore = new InMemoryAuditStore()) {}

    async create(organizationId: string, input: CreateMcpRegistryEntryInput, createdByUserId: string, actor: AuditActor): Promise<McpRegistryEntry> {
        const now = new Date().toISOString();
        const entry: McpRegistryEntry = {
            id: randomUUID(),
            organizationId,
            status: "active",
            createdByUserId,
            createdAt: now,
            updatedAt: now,
            ...input,
            integrationProfile: input.integrationProfile ?? "generic",
        };
        this.entries.set(entry.id, entry);
        await this.auditStore.record({
            organizationId, actorUserId: actor.userId, actorExternalSubject: actor.externalSubject,
            action: "mcpRegistry.create", targetType: "mcpRegistryEntry", targetId: entry.id, details: { name: input.name, transport: input.transport },
        });
        return entry;
    }

    async listByOrganization(organizationId: string, filter?: { status?: McpRegistryStatus }): Promise<McpRegistryEntry[]> {
        let results = [...this.entries.values()].filter((e) => e.organizationId === organizationId);
        if (filter?.status) results = results.filter((e) => e.status === filter.status);
        return results.sort((a, b) => (a.name < b.name ? -1 : 1));
    }

    async getById(organizationId: string, id: string): Promise<McpRegistryEntry | null> {
        const entry = this.entries.get(id);
        return entry && entry.organizationId === organizationId ? entry : null;
    }

    async update(organizationId: string, id: string, partial: UpdateMcpRegistryEntryInput, updatedByUserId: string, actor: AuditActor): Promise<McpRegistryEntry | null> {
        const existing = await this.getById(organizationId, id);
        if (!existing) return null;
        const updated: McpRegistryEntry = { ...existing, ...partial, updatedByUserId, updatedAt: new Date().toISOString() };
        this.entries.set(id, updated);
        await this.auditStore.record({
            organizationId, actorUserId: actor.userId, actorExternalSubject: actor.externalSubject,
            action: "mcpRegistry.update", targetType: "mcpRegistryEntry", targetId: id, details: { fields: Object.keys(partial) },
        });
        return updated;
    }

    async setStatus(organizationId: string, id: string, status: McpRegistryStatus, updatedByUserId: string, actor: AuditActor): Promise<McpRegistryEntry | null> {
        const existing = await this.getById(organizationId, id);
        if (!existing) return null;
        const updated: McpRegistryEntry = { ...existing, status, updatedByUserId, updatedAt: new Date().toISOString() };
        this.entries.set(id, updated);
        await this.auditStore.record({
            organizationId, actorUserId: actor.userId, actorExternalSubject: actor.externalSubject,
            action: "mcpRegistry.statusChange", targetType: "mcpRegistryEntry", targetId: id, details: { status },
        });
        return updated;
    }
}

interface McpRegistryRow {
    id: string;
    organization_id: string;
    name: string;
    transport: McpTransport;
    endpoint: string;
    allowed_tools: McpAllowedTools;
    data_egress_policy: McpDataEgressPolicy;
    integration_profile: McpIntegrationProfile;
    oauth_client_id: string | null;
    catalog_version_constraint: string | null;
    approval_challenge_endpoint: string | null;
    status: McpRegistryStatus;
    description: string | null;
    created_by_user_id: string;
    created_at: Date;
    updated_by_user_id: string | null;
    updated_at: Date;
}

function mapRow(row: McpRegistryRow): McpRegistryEntry {
    return {
        id: row.id,
        organizationId: row.organization_id,
        name: row.name,
        transport: row.transport,
        endpoint: row.endpoint,
        allowedTools: row.allowed_tools,
        dataEgressPolicy: row.data_egress_policy,
        integrationProfile: row.integration_profile,
        oauthClientId: row.oauth_client_id ?? undefined,
        catalogVersionConstraint: row.catalog_version_constraint ?? undefined,
        approvalChallengeEndpoint: row.approval_challenge_endpoint ?? undefined,
        status: row.status,
        description: row.description ?? undefined,
        createdByUserId: row.created_by_user_id,
        createdAt: row.created_at.toISOString(),
        updatedByUserId: row.updated_by_user_id ?? undefined,
        updatedAt: row.updated_at.toISOString(),
    };
}

export class PostgresMcpRegistryStore implements McpRegistryStore {
    constructor(private readonly pool: Pool) {}

    private async tenantRead<T>(organizationId: string, query: (client: PoolClient) => Promise<T>): Promise<T> {
        const client = await this.pool.connect();
        try {
            await client.query("BEGIN");
            await client.query("SELECT set_config('app.tenant_id', $1, true)", [organizationId]);
            const result = await query(client);
            await client.query("COMMIT");
            return result;
        } catch (error) {
            await client.query("ROLLBACK");
            throw error;
        } finally {
            client.release();
        }
    }

    async create(organizationId: string, input: CreateMcpRegistryEntryInput, createdByUserId: string, actor: AuditActor): Promise<McpRegistryEntry> {
        return this.tenantRead(organizationId, async (client) => {
            const id = randomUUID();
            const now = new Date();
            const result = await client.query<McpRegistryRow>(
                `INSERT INTO mcp_registry_entries (id, organization_id, name, transport, endpoint, allowed_tools, data_egress_policy, integration_profile, oauth_client_id, catalog_version_constraint, approval_challenge_endpoint, status, description, created_by_user_id, created_at, updated_at)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'active', $12, $13, $14, $14) RETURNING *`,
                [id, organizationId, input.name, input.transport, input.endpoint, JSON.stringify(input.allowedTools), input.dataEgressPolicy, input.integrationProfile ?? "generic", input.oauthClientId ?? null, input.catalogVersionConstraint ?? null, input.approvalChallengeEndpoint ?? null, input.description ?? null, createdByUserId, now]
            );
            await insertAuditEntry(client, {
                organizationId, actorUserId: actor.userId, actorExternalSubject: actor.externalSubject,
                action: "mcpRegistry.create", targetType: "mcpRegistryEntry", targetId: id, details: { name: input.name, transport: input.transport },
            });
            return mapRow(result.rows[0]);
        });
    }

    async listByOrganization(organizationId: string, filter?: { status?: McpRegistryStatus }): Promise<McpRegistryEntry[]> {
        return this.tenantRead(organizationId, async (client) => {
            const result = filter?.status
                ? await client.query<McpRegistryRow>(
                      "SELECT * FROM mcp_registry_entries WHERE organization_id = $1 AND status = $2 ORDER BY name ASC",
                      [organizationId, filter.status]
                  )
                : await client.query<McpRegistryRow>("SELECT * FROM mcp_registry_entries WHERE organization_id = $1 ORDER BY name ASC", [organizationId]);
            return result.rows.map(mapRow);
        });
    }

    async getById(organizationId: string, id: string): Promise<McpRegistryEntry | null> {
        return this.tenantRead(organizationId, async (client) => {
            const result = await client.query<McpRegistryRow>("SELECT * FROM mcp_registry_entries WHERE organization_id = $1 AND id = $2", [organizationId, id]);
            return result.rows[0] ? mapRow(result.rows[0]) : null;
        });
    }

    async update(organizationId: string, id: string, partial: UpdateMcpRegistryEntryInput, updatedByUserId: string, actor: AuditActor): Promise<McpRegistryEntry | null> {
        return this.tenantRead(organizationId, async (client) => {
            const existing = await client.query<McpRegistryRow>("SELECT * FROM mcp_registry_entries WHERE organization_id = $1 AND id = $2", [organizationId, id]);
            if (!existing.rows[0]) return null;
            const current = mapRow(existing.rows[0]);
            const merged: CreateMcpRegistryEntryInput = {
                name: partial.name ?? current.name,
                transport: partial.transport ?? current.transport,
                endpoint: partial.endpoint ?? current.endpoint,
                allowedTools: partial.allowedTools ?? current.allowedTools,
                dataEgressPolicy: partial.dataEgressPolicy ?? current.dataEgressPolicy,
                integrationProfile: partial.integrationProfile ?? current.integrationProfile,
                oauthClientId: partial.oauthClientId ?? current.oauthClientId,
                catalogVersionConstraint: partial.catalogVersionConstraint ?? current.catalogVersionConstraint,
                approvalChallengeEndpoint: partial.approvalChallengeEndpoint ?? current.approvalChallengeEndpoint,
                description: partial.description ?? current.description,
            };
            const updatedAt = new Date();
            const result = await client.query<McpRegistryRow>(
                `UPDATE mcp_registry_entries SET name=$3, transport=$4, endpoint=$5, allowed_tools=$6, data_egress_policy=$7, integration_profile=$8, oauth_client_id=$9, catalog_version_constraint=$10, approval_challenge_endpoint=$11, description=$12, updated_by_user_id=$13, updated_at=$14
                 WHERE organization_id=$1 AND id=$2 RETURNING *`,
                [organizationId, id, merged.name, merged.transport, merged.endpoint, JSON.stringify(merged.allowedTools), merged.dataEgressPolicy, merged.integrationProfile, merged.oauthClientId ?? null, merged.catalogVersionConstraint ?? null, merged.approvalChallengeEndpoint ?? null, merged.description ?? null, updatedByUserId, updatedAt]
            );
            await insertAuditEntry(client, {
                organizationId, actorUserId: actor.userId, actorExternalSubject: actor.externalSubject,
                action: "mcpRegistry.update", targetType: "mcpRegistryEntry", targetId: id, details: { fields: Object.keys(partial) },
            });
            return mapRow(result.rows[0]);
        });
    }

    async setStatus(organizationId: string, id: string, status: McpRegistryStatus, updatedByUserId: string, actor: AuditActor): Promise<McpRegistryEntry | null> {
        return this.tenantRead(organizationId, async (client) => {
            const result = await client.query<McpRegistryRow>(
                `UPDATE mcp_registry_entries SET status=$3, updated_by_user_id=$4, updated_at=$5 WHERE organization_id=$1 AND id=$2 RETURNING *`,
                [organizationId, id, status, updatedByUserId, new Date()]
            );
            if (!result.rows[0]) return null;
            await insertAuditEntry(client, {
                organizationId, actorUserId: actor.userId, actorExternalSubject: actor.externalSubject,
                action: "mcpRegistry.statusChange", targetType: "mcpRegistryEntry", targetId: id, details: { status },
            });
            return mapRow(result.rows[0]);
        });
    }
}
