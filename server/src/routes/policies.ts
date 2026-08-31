import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { ACTION_CATALOG, ACTION_CATALOG_VERSION, RESOURCE_TYPE_CATALOG, unknownActionPatterns } from "../domain/action-catalog.js";
import { policyDocumentSchema } from "../domain/types.js";
import { actorFrom } from "../store/audit-store.js";
import type { RouteDeps } from "./deps.js";
import { requireOrgUser, requirePermission } from "./guards.js";
import { organizationParamsSchema, organizationPolicyParamsSchema } from "./params.js";

/** Shared by POST/PATCH below — 400s a document referencing an action
 * pattern that can't match anything in domain/action-catalog.ts, catching a
 * typo'd action at authoring time instead of it silently never matching
 * any real requirePermission() check. See that file's own doc comment on
 * why this is advisory (never itself a security decision). */
function rejectUnknownActions(reply: FastifyReply, document: z.infer<typeof policyDocumentSchema>): boolean {
    const unknown = unknownActionPatterns(document);
    if (unknown.length === 0) return false;
    reply.code(400).send({
        error: "unknown_action",
        message: `This policy references an action that does not match anything in the server's action catalog: ${unknown.join(", ")}. Check for a typo, or see GET /organizations/:organizationId/action-catalog for the full list.`,
        unknownActions: unknown,
    });
    return true;
}

const createPolicyBodySchema = z.object({
    name: z.string().min(1),
    description: z.string().optional(),
    document: policyDocumentSchema,
});
const updatePolicyBodySchema = z
    .object({ name: z.string().min(1).optional(), description: z.string().optional(), document: policyDocumentSchema.optional() })
    .strict();

export function registerPolicyRoutes(fastify: FastifyInstance, deps: RouteDeps): void {
    fastify.get("/organizations/:organizationId/policies", { preHandler: deps.authPreHandler }, async (request, reply) => {
        const { organizationId } = organizationParamsSchema.parse(request.params);
        const caller = await requireOrgUser(deps, request, organizationId);
        await requirePermission(deps.store, caller, "iam:listPolicies", `organization:${organizationId}`);
        reply.send(await caller.tenantStore.listPolicies());
    });

    // Not org-scoped data (the catalog is the same for every organization —
    // it describes this server build, not tenant state) but kept under the
    // organizationId path and gated the same as GET .../policies anyway:
    // there is no unauthenticated/cross-org route in this API otherwise,
    // and an org's policy authors are exactly who this is for.
    fastify.get("/organizations/:organizationId/action-catalog", { preHandler: deps.authPreHandler }, async (request, reply) => {
        const { organizationId } = organizationParamsSchema.parse(request.params);
        const caller = await requireOrgUser(deps, request, organizationId);
        await requirePermission(deps.store, caller, "iam:listPolicies", `organization:${organizationId}`);
        reply.send({ version: ACTION_CATALOG_VERSION, actions: ACTION_CATALOG, resourceTypes: RESOURCE_TYPE_CATALOG });
    });

    fastify.post("/organizations/:organizationId/policies", { preHandler: deps.authPreHandler }, async (request, reply) => {
        const { organizationId } = organizationParamsSchema.parse(request.params);
        const caller = await requireOrgUser(deps, request, organizationId);
        await requirePermission(deps.store, caller, "iam:managePolicies", `organization:${organizationId}`);

        const body = createPolicyBodySchema.parse(request.body);
        if (rejectUnknownActions(reply, body.document)) return;
        // Custom policies are never created as builtin=true — only
        // organizations.ts's bootstrap flow does that, for the one
        // OrganizationAdmin policy — so a custom policy is always
        // deletable later (see deletePolicy below).
        const policy = await caller.tenantStore.createPolicy(body, actorFrom(caller));
        reply.code(201).send(policy);
    });

    fastify.patch("/organizations/:organizationId/policies/:policyId", { preHandler: deps.authPreHandler }, async (request, reply) => {
        const { organizationId, policyId } = organizationPolicyParamsSchema.parse(request.params);
        const caller = await requireOrgUser(deps, request, organizationId);
        await requirePermission(deps.store, caller, "iam:managePolicies", `organization:${organizationId}`);

        const existing = await caller.tenantStore.getPolicy(policyId);
        if (!existing || existing.organizationId !== organizationId) {
            return reply.code(404).send({ error: "not_found", message: "Policy not found in this organization." });
        }

        const body = updatePolicyBodySchema.parse(request.body);
        if (body.document && rejectUnknownActions(reply, body.document)) return;
        const updated = await caller.tenantStore.updatePolicy(policyId, body, actorFrom(caller));
        reply.send(updated);
    });

    fastify.delete("/organizations/:organizationId/policies/:policyId", { preHandler: deps.authPreHandler }, async (request, reply) => {
        const { organizationId, policyId } = organizationPolicyParamsSchema.parse(request.params);
        const caller = await requireOrgUser(deps, request, organizationId);
        await requirePermission(deps.store, caller, "iam:managePolicies", `organization:${organizationId}`);

        const existing = await caller.tenantStore.getPolicy(policyId);
        if (!existing || existing.organizationId !== organizationId) {
            return reply.code(404).send({ error: "not_found", message: "Policy not found in this organization." });
        }
        if (existing.builtin) {
            return reply.code(400).send({ error: "builtin_policy", message: "Builtin policies cannot be deleted." });
        }

        await caller.tenantStore.deletePolicy(policyId, actorFrom(caller));
        reply.code(204).send();
    });
}
