import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { actorFrom } from "../store/audit-store.js";
import type { RouteDeps } from "./deps.js";
import { requireOrgUser, requirePermission } from "./guards.js";
import { organizationGroupParamsSchema, organizationParamsSchema } from "./params.js";

// .uuid() (not just z.string()) — see routes/users.ts's identical schemas
// for why: every policy id here is a server-generated randomUUID(), and a
// non-UUID value silently no-ops in InMemoryIamStore or 500s in
// PostgresIamStore instead of the clean 400 a malformed request should get.
const createGroupBodySchema = z.object({ name: z.string().min(1), policyIds: z.array(z.string().uuid()).optional() });
const updateGroupBodySchema = z
    .object({ name: z.string().min(1).optional(), policyIds: z.array(z.string().uuid()).optional() })
    .strict();

export function registerGroupRoutes(fastify: FastifyInstance, deps: RouteDeps): void {
    fastify.get("/organizations/:organizationId/groups", { preHandler: deps.authPreHandler }, async (request, reply) => {
        const { organizationId } = organizationParamsSchema.parse(request.params);
        const caller = await requireOrgUser(deps, request, organizationId);
        await requirePermission(deps.store, caller, "iam:listGroups", `organization:${organizationId}`);
        reply.send(await caller.tenantStore.listGroups());
    });

    fastify.post("/organizations/:organizationId/groups", { preHandler: deps.authPreHandler }, async (request, reply) => {
        const { organizationId } = organizationParamsSchema.parse(request.params);
        const caller = await requireOrgUser(deps, request, organizationId);
        await requirePermission(deps.store, caller, "iam:manageGroups", `organization:${organizationId}`);

        const body = createGroupBodySchema.parse(request.body);
        // See routes/users.ts's POST handler for the full rationale —
        // attaching a policyId is a security-posture change and must not
        // be reachable with iam:manageGroups alone.
        if (body.policyIds !== undefined) {
            await requirePermission(deps.store, caller, "iam:managePolicies", `organization:${organizationId}`);
        }
        const group = await caller.tenantStore.createGroup(body, actorFrom(caller));
        reply.code(201).send(group);
    });

    fastify.patch("/organizations/:organizationId/groups/:groupId", { preHandler: deps.authPreHandler }, async (request, reply) => {
        const { organizationId, groupId } = organizationGroupParamsSchema.parse(request.params);
        const caller = await requireOrgUser(deps, request, organizationId);
        await requirePermission(deps.store, caller, "iam:manageGroups", `organization:${organizationId}`);

        const existing = await caller.tenantStore.getGroup(groupId);
        if (!existing || existing.organizationId !== organizationId) {
            return reply.code(404).send({ error: "not_found", message: "Group not found in this organization." });
        }

        const body = updateGroupBodySchema.parse(request.body);
        if (body.policyIds !== undefined) {
            await requirePermission(deps.store, caller, "iam:managePolicies", `organization:${organizationId}`);
        }
        const updated = await caller.tenantStore.updateGroup(groupId, body, actorFrom(caller));
        reply.send(updated);
    });
}
