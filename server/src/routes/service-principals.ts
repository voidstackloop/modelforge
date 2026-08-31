import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { actorFrom } from "../store/audit-store.js";
import type { RouteDeps } from "./deps.js";
import { requireOrgUser, requirePermission } from "./guards.js";
import { organizationParamsSchema } from "./params.js";

const paramsSchema = z.object({ organizationId: z.string().uuid(), servicePrincipalId: z.string().uuid() });
const createSchema = z
    .object({
        issuer: z.string().url(),
        externalSubject: z.string().min(1),
        displayName: z.string().min(1),
        policyIds: z.array(z.string().uuid()).optional(),
        permissionBoundaryPolicyId: z.string().uuid().optional(),
    })
    .strict();
const updateSchema = z
    .object({
        displayName: z.string().min(1).optional(),
        status: z.enum(["active", "suspended", "deprovisioned"]).optional(),
        policyIds: z.array(z.string().uuid()).optional(),
        permissionBoundaryPolicyId: z.string().uuid().optional(),
    })
    .strict();

async function assertPolicies(caller: Awaited<ReturnType<typeof requireOrgUser>>, ids: string[]): Promise<void> {
    const values = await Promise.all(ids.map((id) => caller.tenantStore.getPolicy(id)));
    if (values.some((value) => value === null)) throw Object.assign(new Error("Policy not found in this organization."), { statusCode: 400 });
}

export function registerServicePrincipalRoutes(fastify: FastifyInstance, deps: RouteDeps): void {
    fastify.get("/organizations/:organizationId/service-principals", { preHandler: deps.authPreHandler }, async (request, reply) => {
        const { organizationId } = organizationParamsSchema.parse(request.params);
        const caller = await requireOrgUser(deps, request, organizationId);
        await requirePermission(deps.store, caller, "iam:listUsers", `organization:${organizationId}`);
        reply.send(await deps.principalStore.listServicePrincipals(organizationId));
    });

    fastify.post("/organizations/:organizationId/service-principals", { preHandler: deps.authPreHandler }, async (request, reply) => {
        const { organizationId } = organizationParamsSchema.parse(request.params);
        const caller = await requireOrgUser(deps, request, organizationId);
        await requirePermission(deps.store, caller, "iam:manageUsers", `organization:${organizationId}`);
        await requirePermission(deps.store, caller, "iam:managePolicies", `organization:${organizationId}`);
        const body = createSchema.parse(request.body);
        await assertPolicies(caller, [...(body.policyIds ?? []), ...(body.permissionBoundaryPolicyId ? [body.permissionBoundaryPolicyId] : [])]);
        const principal = await deps.principalStore.createServicePrincipal({ organizationId, ...body }, actorFrom(caller));
        reply.code(201).send(principal);
    });

    fastify.patch("/organizations/:organizationId/service-principals/:servicePrincipalId", { preHandler: deps.authPreHandler }, async (request, reply) => {
        const { organizationId, servicePrincipalId } = paramsSchema.parse(request.params);
        const caller = await requireOrgUser(deps, request, organizationId);
        await requirePermission(deps.store, caller, "iam:manageUsers", `organization:${organizationId}`);
        const body = updateSchema.parse(request.body);
        if (body.policyIds !== undefined || body.permissionBoundaryPolicyId !== undefined) {
            await requirePermission(deps.store, caller, "iam:managePolicies", `organization:${organizationId}`);
            await assertPolicies(caller, [...(body.policyIds ?? []), ...(body.permissionBoundaryPolicyId ? [body.permissionBoundaryPolicyId] : [])]);
        }
        const principal = await deps.principalStore.updateServicePrincipal(organizationId, servicePrincipalId, body, actorFrom(caller));
        if (!principal) return reply.code(404).send({ error: "not_found" });
        reply.send(principal);
    });
}
