import type { CaseResourceAttributes, PatientCase } from "@modelforge/contracts";
import { patientCaseSchema } from "@modelforge/contracts";
import type { FastifyInstance } from "fastify";
import { actorFrom } from "../store/audit-store.js";
import { publicFeed, type StoredCaseChange } from "../store/case-store.js";
import type { RouteDeps } from "./deps.js";
import { isPermissionAllowed, requireOrgUser, requirePermission, type ResolvedPrincipal } from "./guards.js";
import { organizationCaseParamsSchema, organizationParamsSchema } from "./params.js";
import { withIdempotencyKey } from "./idempotency.js";

const resourceName = (organizationId: string, caseId: string): string => `organization:${organizationId}/patientCase:${caseId}`;

function conditionContext(resource: CaseResourceAttributes, caller: ResolvedPrincipal): Record<string, string> {
    return {
        "resource:patientId": resource.patientId,
        "resource:ownerUserId": resource.ownerUserId,
        "resource:workspaceId": resource.workspaceId ?? "",
        "resource:departmentId": resource.departmentId ?? "",
        "resource:isOwner": String(resource.ownerUserId === caller.id),
        "resource:isAssigned": String(resource.assignedUserIds.includes(caller.id)),
        "resource:activeConsentScopes": [...resource.activeConsentScopes].sort().join(","),
    };
}

async function canRead(deps: RouteDeps, caller: ResolvedPrincipal, entry: StoredCaseChange): Promise<boolean> {
    return isPermissionAllowed(
        deps.store,
        caller,
        "patientCase:view",
        resourceName(caller.organizationId, entry.change.caseId),
        conditionContext(entry.resource, caller)
    );
}

function resourceForCreate(organizationId: string, caller: ResolvedPrincipal, patientCase: PatientCase): CaseResourceAttributes {
    return {
        organizationId,
        caseId: patientCase.id,
        patientId: patientCase.patientId ?? patientCase.id,
        ownerUserId: caller.id,
        workspaceId: patientCase.workspaceId,
        departmentId: patientCase.departmentId,
        assignedUserIds: patientCase.assignedUserIds ?? [],
        activeConsentScopes: patientCase.consentRecords.filter((record) => record.revokedAt === undefined).map((record) => record.scope),
    };
}

function resourceForUpdate(current: CaseResourceAttributes, patientCase: PatientCase): CaseResourceAttributes {
    return {
        ...current,
        patientId: patientCase.patientId ?? current.patientId,
        workspaceId: patientCase.workspaceId,
        departmentId: patientCase.departmentId,
        assignedUserIds: patientCase.assignedUserIds ?? current.assignedUserIds,
        activeConsentScopes: patientCase.consentRecords.filter((record) => record.revokedAt === undefined).map((record) => record.scope),
    };
}

function accessMetadataChanged(a: CaseResourceAttributes, b: CaseResourceAttributes): boolean {
    return a.patientId !== b.patientId || a.workspaceId !== b.workspaceId || a.departmentId !== b.departmentId || JSON.stringify([...a.assignedUserIds].sort()) !== JSON.stringify([...b.assignedUserIds].sort());
}

export function registerCaseRoutes(fastify: FastifyInstance, deps: RouteDeps): void {
    fastify.get("/organizations/:organizationId/cases", { preHandler: deps.authPreHandler }, async (request, reply) => {
        const { organizationId } = organizationParamsSchema.parse(request.params);
        const caller = await requireOrgUser(deps, request, organizationId);
        const repository = deps.caseStore.forTenant(caller.tenantContext);
        const { since } = request.query as { since?: string };
        const feed = await repository.readChanges(since ?? null);
        const visibility = await Promise.all(feed.changes.map((entry) => canRead(deps, caller, entry)));
        const visible = feed.changes.filter((_entry, index) => visibility[index]);
        reply.send(publicFeed(visible, feed.cursor));
    });

    fastify.get("/organizations/:organizationId/cases/:caseId", { preHandler: deps.authPreHandler }, async (request, reply) => {
        const { organizationId, caseId } = organizationCaseParamsSchema.parse(request.params);
        const caller = await requireOrgUser(deps, request, organizationId);
        const current = await deps.caseStore.forTenant(caller.tenantContext).getOne(caseId);
        if (!current || !(await isPermissionAllowed(deps.store, caller, "patientCase:view", resourceName(organizationId, caseId), conditionContext(current.resource, caller)))) {
            return reply.code(404).send({ error: "not_found" });
        }
        reply.send(current.patientCase);
    });

    fastify.post("/organizations/:organizationId/cases", { preHandler: deps.authPreHandler }, async (request, reply) => {
        const { organizationId } = organizationParamsSchema.parse(request.params);
        const caller = await requireOrgUser(deps, request, organizationId);
        await requirePermission(deps.store, caller, "patientCase:create", `organization:${organizationId}/patientCase:*`);
        const idempotency = await withIdempotencyKey(deps.idempotencyStore, organizationId, request, reply);
        if (idempotency.replay) return;
        const patientCase = patientCaseSchema.parse(request.body);
        const result = await deps.caseStore.forTenant(caller.tenantContext).writeOne(patientCase, null, actorFrom(caller), resourceForCreate(organizationId, caller, patientCase));
        if ("conflict" in result) {
            await idempotency.record(409, { error: "already_exists", current: result.current });
            return reply.code(409).send({ error: "already_exists", current: result.current });
        }
        await idempotency.record(201, result.patientCase);
        reply.code(201).send(result.patientCase);
    });

    fastify.put("/organizations/:organizationId/cases/:caseId", { preHandler: deps.authPreHandler }, async (request, reply) => {
        const { organizationId, caseId } = organizationCaseParamsSchema.parse(request.params);
        const caller = await requireOrgUser(deps, request, organizationId);
        const repository = deps.caseStore.forTenant(caller.tenantContext);
        const current = await repository.getOne(caseId);
        if (!current || !(await isPermissionAllowed(deps.store, caller, "patientCase:edit", resourceName(organizationId, caseId), conditionContext(current.resource, caller)))) {
            return reply.code(404).send({ error: "not_found" });
        }
        const idempotency = await withIdempotencyKey(deps.idempotencyStore, organizationId, request, reply);
        if (idempotency.replay) return;
        const patientCase = patientCaseSchema.parse(request.body);
        if (patientCase.id !== caseId) return reply.code(400).send({ error: "id_mismatch", message: "Body id must match the :caseId path parameter." });
        const nextResource = resourceForUpdate(current.resource, patientCase);
        if (accessMetadataChanged(current.resource, nextResource)) {
            await requirePermission(deps.store, caller, "patientCase:manageAccess", resourceName(organizationId, caseId), conditionContext(current.resource, caller));
        }
        const ifMatch = request.headers["if-match"];
        const expectedVersion = typeof ifMatch === "string" && ifMatch.length > 0 ? ifMatch : null;
        const result = await repository.writeOne(patientCase, expectedVersion, actorFrom(caller), nextResource);
        if ("conflict" in result) {
            await idempotency.record(412, { error: "precondition_failed", current: result.current });
            return reply.code(412).send({ error: "precondition_failed", current: result.current });
        }
        await idempotency.record(200, result.patientCase);
        reply.send(result.patientCase);
    });

    fastify.delete("/organizations/:organizationId/cases/:caseId", { preHandler: deps.authPreHandler }, async (request, reply) => {
        const { organizationId, caseId } = organizationCaseParamsSchema.parse(request.params);
        const caller = await requireOrgUser(deps, request, organizationId);
        const repository = deps.caseStore.forTenant(caller.tenantContext);
        const current = await repository.getOne(caseId);
        if (!current || !(await isPermissionAllowed(deps.store, caller, "patientCase:delete", resourceName(organizationId, caseId), conditionContext(current.resource, caller)))) {
            return reply.code(404).send({ error: "not_found" });
        }
        const ifMatch = request.headers["if-match"];
        const expectedVersion = typeof ifMatch === "string" && ifMatch.length > 0 ? ifMatch : null;
        const result = await repository.deleteOne(caseId, expectedVersion, actorFrom(caller));
        if ("notFound" in result) return reply.code(404).send({ error: "not_found" });
        if ("conflict" in result) return reply.code(412).send({ error: "precondition_failed", current: result.current });
        reply.code(204).send();
    });
}
