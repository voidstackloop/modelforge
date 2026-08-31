import type { ImagingResourceAttributes } from "@modelforge/contracts";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { actorFrom } from "../store/audit-store.js";
import { publicImagingFeed, type StoredImagingStudy } from "../store/imaging-store.js";
import type { RouteDeps } from "./deps.js";
import { isPermissionAllowed, requireOrgUser, requirePermission, type ResolvedPrincipal } from "./guards.js";
import { organizationParamsSchema, organizationStudyParamsSchema } from "./params.js";

/**
 * Imaging studies — item 6's authorization model, item 7's "identical 404
 * for absent and unauthorized." Structurally the same shape as
 * routes/cases.ts (owner/assignedUserIds visibility, server-derived
 * resource attributes, nondisclosing 404), applied to imagingStudy instead
 * of patientCase — see that file for the precedent this follows.
 */
const resourceName = (organizationId: string, studyId: string): string => `organization:${organizationId}/imagingStudy:${studyId}`;

function conditionContext(resource: ImagingResourceAttributes, caller: ResolvedPrincipal): Record<string, string> {
    return {
        "resource:ownerUserId": resource.ownerUserId,
        "resource:isOwner": String(resource.ownerUserId === caller.id),
        "resource:isAssigned": String(resource.assignedUserIds.includes(caller.id)),
        "resource:sensitivity": resource.sensitivity,
        "resource:workspaceId": resource.workspaceId ?? "",
        "resource:departmentId": resource.departmentId ?? "",
        "resource:caseId": resource.caseId ?? "",
    };
}

async function canRead(deps: RouteDeps, caller: ResolvedPrincipal, stored: StoredImagingStudy): Promise<boolean> {
    return isPermissionAllowed(deps.store, caller, "imagingStudy:view", resourceName(caller.organizationId, stored.study.id), conditionContext(stored.resource, caller));
}

const updateStudyBodySchema = z
    .object({
        sensitivity: z.enum(["normal", "restricted"]).optional(),
        workspaceId: z.string().min(1).optional(),
        departmentId: z.string().min(1).optional(),
        assignedUserIds: z.array(z.string().min(1)).max(1_000).optional(),
        caseId: z.string().min(1).optional(),
    })
    .strict();

const createAnnotationBodySchema = z
    .object({
        seriesId: z.string().min(1).optional(),
        instanceId: z.string().min(1).optional(),
        frameNumber: z.number().int().positive().optional(),
        kind: z.enum(["measurement", "note", "region"]),
        data: z.unknown(),
        text: z.string().max(20_000).optional(),
    })
    .strict();

export function registerImagingStudyRoutes(fastify: FastifyInstance, deps: RouteDeps): void {
    fastify.get("/organizations/:organizationId/imaging/studies", { preHandler: deps.authPreHandler }, async (request, reply) => {
        const { organizationId } = organizationParamsSchema.parse(request.params);
        const caller = await requireOrgUser(deps, request, organizationId);
        const repo = deps.imagingStore.forTenant(caller.tenantContext);
        const { caseId } = request.query as { caseId?: string };
        const all = await repo.listStudies(caseId ? { caseId } : undefined);
        const visibility = await Promise.all(all.map((s) => canRead(deps, caller, s)));
        const visible = all.filter((_s, i) => visibility[i]);
        reply.send(visible.map((s) => s.study));
    });

    fastify.get("/organizations/:organizationId/imaging/studies/:studyId", { preHandler: deps.authPreHandler }, async (request, reply) => {
        const { organizationId, studyId } = organizationStudyParamsSchema.parse(request.params);
        const caller = await requireOrgUser(deps, request, organizationId);
        const repo = deps.imagingStore.forTenant(caller.tenantContext);
        const current = await repo.getStudy(studyId);
        if (!current || !(await canRead(deps, caller, current))) {
            return reply.code(404).send({ error: "not_found" });
        }
        const series = await repo.listSeriesForStudy(studyId);
        const instances = await Promise.all(series.map((s) => repo.listInstancesForSeries(s.id)));
        // Instance objectStorageKey is server-internal — strip it before
        // this ever reaches a client response (see imaging.ts's own doc
        // comment on why the public contract type never carries it).
        const publicInstances = instances.map((list) => list.map(({ objectStorageKey: _k, ...pub }) => pub));
        reply.send({ study: current.study, series, instances: publicInstances });
    });

    fastify.patch("/organizations/:organizationId/imaging/studies/:studyId", { preHandler: deps.authPreHandler }, async (request, reply) => {
        const { organizationId, studyId } = organizationStudyParamsSchema.parse(request.params);
        const caller = await requireOrgUser(deps, request, organizationId);
        const repo = deps.imagingStore.forTenant(caller.tenantContext);
        const current = await repo.getStudy(studyId);
        if (!current || !(await canRead(deps, caller, current))) {
            return reply.code(404).send({ error: "not_found" });
        }
        await requirePermission(deps.store, caller, "imagingStudy:manageAccess", resourceName(organizationId, studyId), conditionContext(current.resource, caller));
        const body = updateStudyBodySchema.parse(request.body);
        const updated = await repo.updateStudy(studyId, body, actorFrom(caller));
        reply.send(updated!.study);
    });

    fastify.get("/organizations/:organizationId/imaging/changes", { preHandler: deps.authPreHandler }, async (request, reply) => {
        const { organizationId } = organizationParamsSchema.parse(request.params);
        const caller = await requireOrgUser(deps, request, organizationId);
        const repo = deps.imagingStore.forTenant(caller.tenantContext);
        const { since } = request.query as { since?: string };
        const feed = await repo.readChanges(since ?? null);
        const visibility = await Promise.all(
            feed.changes.map(async (entry) => {
                const study = await repo.getStudy(entry.change.studyId);
                return study ? canRead(deps, caller, study) : false;
            })
        );
        const visible = feed.changes.filter((_e, i) => visibility[i]);
        reply.send(publicImagingFeed(visible, feed.cursor));
    });

    fastify.get("/organizations/:organizationId/imaging/studies/:studyId/annotations", { preHandler: deps.authPreHandler }, async (request, reply) => {
        const { organizationId, studyId } = organizationStudyParamsSchema.parse(request.params);
        const caller = await requireOrgUser(deps, request, organizationId);
        const repo = deps.imagingStore.forTenant(caller.tenantContext);
        const current = await repo.getStudy(studyId);
        if (!current || !(await canRead(deps, caller, current))) {
            return reply.code(404).send({ error: "not_found" });
        }
        reply.send(await repo.listAnnotationsForStudy(studyId));
    });

    fastify.post("/organizations/:organizationId/imaging/studies/:studyId/annotations", { preHandler: deps.authPreHandler }, async (request, reply) => {
        const { organizationId, studyId } = organizationStudyParamsSchema.parse(request.params);
        const caller = await requireOrgUser(deps, request, organizationId);
        const repo = deps.imagingStore.forTenant(caller.tenantContext);
        const current = await repo.getStudy(studyId);
        if (!current || !(await canRead(deps, caller, current))) {
            return reply.code(404).send({ error: "not_found" });
        }
        await requirePermission(deps.store, caller, "imagingAnnotation:create", resourceName(organizationId, studyId), conditionContext(current.resource, caller));
        const body = createAnnotationBodySchema.parse(request.body);
        const annotation = await repo.createAnnotation({ studyId, seriesId: body.seriesId, instanceId: body.instanceId, frameNumber: body.frameNumber, kind: body.kind, data: body.data, text: body.text, authorUserId: caller.id, provenance: "human" }, actorFrom(caller));
        reply.code(201).send(annotation);
    });
}
