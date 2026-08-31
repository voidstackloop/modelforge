import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { mcpAllowedToolsSchema, mcpDataEgressPolicySchema, mcpTransportSchema } from "../domain/types.js";
import { actorFrom } from "../store/audit-store.js";
import type { RouteDeps } from "./deps.js";
import { requireOrgUser, requirePermission } from "./guards.js";
import { organizationMcpRegistryEntryParamsSchema, organizationParamsSchema } from "./params.js";

const createEntryBodySchema = z
    .object({
        name: z.string().min(1),
        transport: mcpTransportSchema,
        endpoint: z.string().min(1),
        allowedTools: mcpAllowedToolsSchema,
        dataEgressPolicy: mcpDataEgressPolicySchema,
        description: z.string().optional(),
    })
    .strict();

const updateEntryBodySchema = createEntryBodySchema.partial().strict();

const setStatusBodySchema = z.object({ status: z.enum(["active", "disabled"]) }).strict();

/**
 * Institutional MCP server/tool registry (docs/ENTERPRISE_ARCHITECTURE_
 * ROADMAP.md P2 item 4). See store/mcp-registry-store.ts's doc comment for
 * the full design and, importantly, its scope boundary: this is a
 * published, centrally administered allowlist, not a live traffic-shaping
 * mechanism — this server never proxies MCP traffic.
 *
 * `mcpRegistry:list` (read) is deliberately separate from `mcpRegistry:manage`
 * (write) — the same separation-of-duties shape every other registry/list
 * pair in this codebase uses (iam:listUsers vs. iam:manageUsers,
 * aiGateway:manageProviders being a single combined action being the
 * exception, not the rule this one follows). A managed-mode desktop app
 * fetching its org's allowlist only ever needs `mcpRegistry:list`.
 */
export function registerMcpRegistryRoutes(fastify: FastifyInstance, deps: RouteDeps): void {
    fastify.get("/organizations/:organizationId/mcp-registry", { preHandler: deps.authPreHandler }, async (request, reply) => {
        const { organizationId } = organizationParamsSchema.parse(request.params);
        const caller = await requireOrgUser(deps, request, organizationId);
        await requirePermission(deps.store, caller, "mcpRegistry:list", `organization:${organizationId}`);
        const rawStatus = (request.query as Record<string, unknown>)?.status;
        const filter: { status?: "active" | "disabled" } | undefined = rawStatus === "active" || rawStatus === "disabled" ? { status: rawStatus } : undefined;
        reply.send(await deps.mcpRegistryStore.listByOrganization(organizationId, filter));
    });

    fastify.get("/organizations/:organizationId/mcp-registry/:entryId", { preHandler: deps.authPreHandler }, async (request, reply) => {
        const { organizationId, entryId } = organizationMcpRegistryEntryParamsSchema.parse(request.params);
        const caller = await requireOrgUser(deps, request, organizationId);
        await requirePermission(deps.store, caller, "mcpRegistry:list", `organization:${organizationId}`);
        const entry = await deps.mcpRegistryStore.getById(organizationId, entryId);
        if (!entry) return reply.code(404).send({ error: "not_found" });
        reply.send(entry);
    });

    fastify.post("/organizations/:organizationId/mcp-registry", { preHandler: deps.authPreHandler }, async (request, reply) => {
        const { organizationId } = organizationParamsSchema.parse(request.params);
        const caller = await requireOrgUser(deps, request, organizationId);
        await requirePermission(deps.store, caller, "mcpRegistry:manage", `organization:${organizationId}`);
        const body = createEntryBodySchema.parse(request.body);
        const entry = await deps.mcpRegistryStore.create(organizationId, body, caller.id, actorFrom(caller));
        reply.code(201).send(entry);
    });

    fastify.patch("/organizations/:organizationId/mcp-registry/:entryId", { preHandler: deps.authPreHandler }, async (request, reply) => {
        const { organizationId, entryId } = organizationMcpRegistryEntryParamsSchema.parse(request.params);
        const caller = await requireOrgUser(deps, request, organizationId);
        await requirePermission(deps.store, caller, "mcpRegistry:manage", `organization:${organizationId}`);
        const body = updateEntryBodySchema.parse(request.body);
        const updated = await deps.mcpRegistryStore.update(organizationId, entryId, body, caller.id, actorFrom(caller));
        if (!updated) return reply.code(404).send({ error: "not_found" });
        reply.send(updated);
    });

    fastify.post("/organizations/:organizationId/mcp-registry/:entryId/status", { preHandler: deps.authPreHandler }, async (request, reply) => {
        const { organizationId, entryId } = organizationMcpRegistryEntryParamsSchema.parse(request.params);
        const caller = await requireOrgUser(deps, request, organizationId);
        await requirePermission(deps.store, caller, "mcpRegistry:manage", `organization:${organizationId}`);
        const body = setStatusBodySchema.parse(request.body);
        const updated = await deps.mcpRegistryStore.setStatus(organizationId, entryId, body.status, caller.id, actorFrom(caller));
        if (!updated) return reply.code(404).send({ error: "not_found" });
        reply.send(updated);
    });
}
