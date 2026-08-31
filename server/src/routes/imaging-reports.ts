import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { actorFrom } from "../store/audit-store.js";
import type { RouteDeps } from "./deps.js";
import { isPermissionAllowed, requireOrgUser, requirePermission } from "./guards.js";
import { organizationReportParamsSchema, organizationStudyParamsSchema } from "./params.js";

/**
 * Diagnostic report workflow (item 12) — preliminary/final/amended/
 * corrected/cancelled states, author/signer attribution, immutable
 * amendments (see store/imaging-store.ts's createReport doc comment: a new
 * row, never an in-place edit), and critical-result acknowledgement.
 *
 * Visibility follows the study's own authorization (diagnosticReport:view
 * against the study's resource attributes) rather than a separate report-
 * level ACL — a report with no readable study is unreachable by
 * construction, and every report route below 404s identically for "study
 * doesn't exist" and "study exists but caller can't see it," per item 7.
 */
const studyResourceName = (organizationId: string, studyId: string): string => `organization:${organizationId}/imagingStudy:${studyId}`;

const createReportBodySchema = z
    .object({
        conclusion: z.string().min(1).max(100_000),
        conclusionCode: z.string().max(200).optional(),
        isCritical: z.boolean().default(false),
        status: z.enum(["preliminary", "final"]).default("preliminary"),
    })
    .strict();

const amendReportBodySchema = z
    .object({
        conclusion: z.string().min(1).max(100_000),
        conclusionCode: z.string().max(200).optional(),
        amendmentReason: z.string().min(1).max(5_000),
        status: z.enum(["amended", "corrected"]),
        isCritical: z.boolean().default(false),
    })
    .strict();

async function requireReadableStudy(deps: RouteDeps, caller: Awaited<ReturnType<typeof requireOrgUser>>, organizationId: string, studyId: string) {
    const repo = deps.imagingStore.forTenant(caller.tenantContext);
    const study = await repo.getStudy(studyId);
    if (!study) return null;
    const canView = await isPermissionAllowed(deps.store, caller, "imagingStudy:view", studyResourceName(organizationId, studyId), {
        "resource:ownerUserId": study.resource.ownerUserId,
        "resource:isOwner": String(study.resource.ownerUserId === caller.id),
        "resource:isAssigned": String(study.resource.assignedUserIds.includes(caller.id)),
        "resource:sensitivity": study.resource.sensitivity,
    });
    return canView ? { repo, study } : null;
}

export function registerImagingReportRoutes(fastify: FastifyInstance, deps: RouteDeps): void {
    fastify.get("/organizations/:organizationId/imaging/studies/:studyId/reports", { preHandler: deps.authPreHandler }, async (request, reply) => {
        const { organizationId, studyId } = organizationStudyParamsSchema.parse(request.params);
        const caller = await requireOrgUser(deps, request, organizationId);
        const readable = await requireReadableStudy(deps, caller, organizationId, studyId);
        if (!readable) return reply.code(404).send({ error: "not_found" });
        await requirePermission(deps.store, caller, "diagnosticReport:view", studyResourceName(organizationId, studyId));
        const [current, history] = await Promise.all([readable.repo.getCurrentReport(studyId), readable.repo.listReportHistory(studyId)]);
        reply.send({ current, history });
    });

    fastify.post("/organizations/:organizationId/imaging/studies/:studyId/reports", { preHandler: deps.authPreHandler }, async (request, reply) => {
        const { organizationId, studyId } = organizationStudyParamsSchema.parse(request.params);
        const caller = await requireOrgUser(deps, request, organizationId);
        const readable = await requireReadableStudy(deps, caller, organizationId, studyId);
        if (!readable) return reply.code(404).send({ error: "not_found" });
        await requirePermission(deps.store, caller, "diagnosticReport:author", studyResourceName(organizationId, studyId));
        const body = createReportBodySchema.parse(request.body);
        const report = await readable.repo.createReport(
            { studyId, status: body.status, conclusion: body.conclusion, conclusionCode: body.conclusionCode, authorUserId: caller.id, authoredAt: new Date().toISOString(), isCritical: body.isCritical },
            actorFrom(caller)
        );
        reply.code(201).send(report);
    });

    fastify.post("/organizations/:organizationId/imaging/studies/:studyId/reports/:reportId/amend", { preHandler: deps.authPreHandler }, async (request, reply) => {
        const { organizationId, studyId, reportId } = organizationReportParamsSchema.parse(request.params);
        const caller = await requireOrgUser(deps, request, organizationId);
        const readable = await requireReadableStudy(deps, caller, organizationId, studyId);
        if (!readable) return reply.code(404).send({ error: "not_found" });
        await requirePermission(deps.store, caller, "diagnosticReport:author", studyResourceName(organizationId, studyId));
        const previous = await readable.repo.getReport(reportId);
        if (!previous || previous.studyId !== studyId) return reply.code(404).send({ error: "not_found" });
        const body = amendReportBodySchema.parse(request.body);
        const amended = await readable.repo.createReport(
            {
                studyId, status: body.status, conclusion: body.conclusion, conclusionCode: body.conclusionCode,
                authorUserId: caller.id, authoredAt: new Date().toISOString(), previousVersionId: reportId,
                amendmentReason: body.amendmentReason, isCritical: body.isCritical,
            },
            actorFrom(caller)
        );
        reply.code(201).send(amended);
    });

    fastify.post("/organizations/:organizationId/imaging/studies/:studyId/reports/:reportId/sign", { preHandler: deps.authPreHandler }, async (request, reply) => {
        const { organizationId, studyId, reportId } = organizationReportParamsSchema.parse(request.params);
        const caller = await requireOrgUser(deps, request, organizationId);
        const readable = await requireReadableStudy(deps, caller, organizationId, studyId);
        if (!readable) return reply.code(404).send({ error: "not_found" });
        const existing = await readable.repo.getReport(reportId);
        if (!existing || existing.studyId !== studyId) return reply.code(404).send({ error: "not_found" });
        await requirePermission(deps.store, caller, "diagnosticReport:sign", studyResourceName(organizationId, studyId));
        const signed = await readable.repo.signReport(reportId, caller.id, actorFrom(caller));
        reply.send(signed);
    });

    fastify.post("/organizations/:organizationId/imaging/studies/:studyId/reports/:reportId/acknowledge-critical", { preHandler: deps.authPreHandler }, async (request, reply) => {
        const { organizationId, studyId, reportId } = organizationReportParamsSchema.parse(request.params);
        const caller = await requireOrgUser(deps, request, organizationId);
        const readable = await requireReadableStudy(deps, caller, organizationId, studyId);
        if (!readable) return reply.code(404).send({ error: "not_found" });
        const existing = await readable.repo.getReport(reportId);
        if (!existing || existing.studyId !== studyId) return reply.code(404).send({ error: "not_found" });
        if (!existing.isCritical) return reply.code(400).send({ error: "not_critical", message: "This report is not marked critical." });
        await requirePermission(deps.store, caller, "diagnosticReport:acknowledgeCritical", studyResourceName(organizationId, studyId));
        const acknowledged = await readable.repo.acknowledgeCriticalReport(reportId, caller.id, actorFrom(caller));
        reply.send(acknowledged);
    });
}
