import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { Hl7ParseError } from "../hl7/message.js";
import { parseOruR01 } from "../hl7/inbound-parser.js";
import { buildOruR01 } from "../hl7/oru-builder.js";
import { Hl7IngestionResolutionError, ingestInboundMessage, resolveIngestionJob } from "../hl7/ingestion.js";
import type { RouteDeps } from "./deps.js";
import { isPermissionAllowed, requireOrgUser, requirePermission } from "./guards.js";
import { actorFrom } from "../store/audit-store.js";
import { organizationFhirReportParamsSchema, organizationHl7JobParamsSchema, organizationParamsSchema } from "./params.js";

/**
 * HL7 v2 outbound generation, inbound parsing, and inbound ingestion — see
 * docs/HL7_V2_INTEGRATION.md for the full architecture. Outbound reuses
 * hl7/oru-builder.ts's mapping over the same DiagnosticReport/ImagingStudy
 * data routes/fhir.ts's DiagnosticReport route already exposes as FHIR,
 * and the exact same authorization reuse principle: an HL7-shaped
 * representation of data this server already protects is not a different
 * trust boundary, so it enforces the same imagingStudy:view/
 * diagnosticReport:view checks, not a new permission. Inbound parsing/
 * ingestion have no case/patient resource of their own to reuse an
 * existing action from (parsing is a stateless format conversion; ingestion
 * matches across every case in the tenant, not one specific one) — gated
 * by new `hl7:parseInbound`/`hl7:ingest`/`hl7:reviewIngestion` actions
 * instead. Parsing never looks up/matches/writes anything; ingestion does,
 * through hl7/ingestion.ts's own deliberately conservative "ambiguous or
 * no match always requires human review, never a guess" pipeline — see
 * that file's own doc comment.
 */
const oruQuerySchema = z
    .object({
        receivingApplication: z.string().min(1).max(200),
        receivingFacility: z.string().min(1).max(200),
        sendingApplication: z.string().min(1).max(200).default("ModelForge"),
        sendingFacility: z.string().min(1).max(200).optional(),
    })
    .strict();

export function registerHl7Routes(fastify: FastifyInstance, deps: RouteDeps): void {
    fastify.get("/organizations/:organizationId/hl7/v2/DiagnosticReport/:reportId/oru-r01", { preHandler: deps.authPreHandler }, async (request, reply) => {
        const { organizationId, reportId } = organizationFhirReportParamsSchema.parse(request.params);
        const caller = await requireOrgUser(deps, request, organizationId);
        const query = oruQuerySchema.parse(request.query);
        const repo = deps.imagingStore.forTenant(caller.tenantContext);
        const report = await repo.getReport(reportId);
        if (!report) return reply.code(404).send({ error: "not_found" });
        const study = await repo.getStudy(report.studyId);
        if (!study) return reply.code(404).send({ error: "not_found" });
        const resource = study.resource;
        const canView = await isPermissionAllowed(deps.store, caller, "imagingStudy:view", `organization:${organizationId}/imagingStudy:${report.studyId}`, {
            "resource:ownerUserId": resource.ownerUserId,
            "resource:isOwner": String(resource.ownerUserId === caller.id),
            "resource:isAssigned": String(resource.assignedUserIds.includes(caller.id)),
            "resource:sensitivity": resource.sensitivity,
            "resource:workspaceId": resource.workspaceId ?? "",
            "resource:departmentId": resource.departmentId ?? "",
            "resource:caseId": resource.caseId ?? "",
        });
        if (!canView || !(await isPermissionAllowed(deps.store, caller, "diagnosticReport:view", `organization:${organizationId}/imagingStudy:${report.studyId}`))) {
            return reply.code(404).send({ error: "not_found" });
        }

        const raw = buildOruR01(report, study.study, {
            sendingApplication: query.sendingApplication,
            sendingFacility: query.sendingFacility ?? organizationId,
            receivingApplication: query.receivingApplication,
            receivingFacility: query.receivingFacility,
        });
        reply.code(200).header("content-type", "application/hl7-v2; charset=utf-8").send(raw);
    });

    // Parse-only — see this file's own top doc comment. request.body is the
    // raw HL7 v2 text handed through verbatim by app.ts's
    // application/hl7-v2 content-type parser.
    fastify.post("/organizations/:organizationId/hl7/v2/inbound/oru-r01/parse", { preHandler: deps.authPreHandler }, async (request, reply) => {
        const { organizationId } = organizationParamsSchema.parse(request.params);
        const caller = await requireOrgUser(deps, request, organizationId);
        await requirePermission(deps.store, caller, "hl7:parseInbound", `organization:${organizationId}/hl7Inbound`);
        const raw = request.body;
        if (typeof raw !== "string" || raw.length === 0) {
            return reply.code(400).send({ error: "invalid_body", message: "Request body must be a non-empty raw HL7 v2 message (content-type: application/hl7-v2)." });
        }
        try {
            reply.code(200).send(parseOruR01(raw));
        } catch (err) {
            if (err instanceof Hl7ParseError) return reply.code(422).send({ error: "hl7_parse_error", message: err.message });
            throw err;
        }
    });

    // Ingest — see hl7/ingestion.ts's own doc comment for the match/apply
    // pipeline. Unlike /parse above, this DOES touch case data (only for
    // an unambiguous single patient match), so it is gated by a separate,
    // stronger action.
    fastify.post("/organizations/:organizationId/hl7/v2/inbound/ingest", { preHandler: deps.authPreHandler }, async (request, reply) => {
        const { organizationId } = organizationParamsSchema.parse(request.params);
        const caller = await requireOrgUser(deps, request, organizationId);
        await requirePermission(deps.store, caller, "hl7:ingest", `organization:${organizationId}/hl7Inbound`);
        const raw = request.body;
        if (typeof raw !== "string" || raw.length === 0) {
            return reply.code(400).send({ error: "invalid_body", message: "Request body must be a non-empty raw HL7 v2 message (content-type: application/hl7-v2)." });
        }
        const caseRepo = deps.caseStore.forTenant(caller.tenantContext);
        const ingestionRepo = deps.hl7IngestionStore.forTenant(caller.tenantContext);
        try {
            const { job } = await ingestInboundMessage(caseRepo, ingestionRepo, raw, actorFrom(caller));
            reply.code(201).send(job);
        } catch (err) {
            if (err instanceof Hl7ParseError) return reply.code(422).send({ error: "hl7_parse_error", message: err.message });
            throw err;
        }
    });

    fastify.get("/organizations/:organizationId/hl7/v2/inbound/jobs", { preHandler: deps.authPreHandler }, async (request, reply) => {
        const { organizationId } = organizationParamsSchema.parse(request.params);
        const caller = await requireOrgUser(deps, request, organizationId);
        await requirePermission(deps.store, caller, "hl7:reviewIngestion", `organization:${organizationId}/hl7Inbound`);
        const { status } = z.object({ status: z.enum(["pending-review", "applied", "rejected"]).optional() }).parse(request.query);
        const jobs = await deps.hl7IngestionStore.forTenant(caller.tenantContext).listJobs(status ? { status } : undefined);
        reply.send({ jobs });
    });

    const resolveBodySchema = z.discriminatedUnion("action", [
        z.object({ action: z.literal("apply"), caseId: z.string().min(1) }).strict(),
        z.object({ action: z.literal("reject"), reason: z.string().min(1).max(2_000) }).strict(),
    ]);

    fastify.post("/organizations/:organizationId/hl7/v2/inbound/jobs/:jobId/resolve", { preHandler: deps.authPreHandler }, async (request, reply) => {
        const { organizationId, jobId } = organizationHl7JobParamsSchema.parse(request.params);
        const caller = await requireOrgUser(deps, request, organizationId);
        await requirePermission(deps.store, caller, "hl7:reviewIngestion", `organization:${organizationId}/hl7Inbound`);
        const decision = resolveBodySchema.parse(request.body);
        const caseRepo = deps.caseStore.forTenant(caller.tenantContext);
        const ingestionRepo = deps.hl7IngestionStore.forTenant(caller.tenantContext);
        try {
            const resolved = await resolveIngestionJob(caseRepo, ingestionRepo, jobId, decision, caller.id, actorFrom(caller));
            if (!resolved) return reply.code(404).send({ error: "not_found" });
            reply.send(resolved);
        } catch (err) {
            if (err instanceof Hl7IngestionResolutionError) return reply.code(409).send({ error: "resolution_conflict", message: err.message });
            throw err;
        }
    });
}
