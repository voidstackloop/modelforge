import type { CaseResourceAttributes, ImagingResourceAttributes } from "@modelforge/contracts";
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { buildCapabilityStatement } from "../fhir/capability-statement.js";
import { fhirBundle, fhirNotFound, toFhirDiagnosticReport, toFhirDocumentReference, toFhirImagingStudy, toFhirPatient } from "../fhir/mappers.js";
import { deniedBySmartLaunchContext, resolveSmartLaunchContext } from "../fhir/smart-scopes.js";
import type { RouteDeps } from "./deps.js";
import { isPermissionAllowed, requireOrgUser, type ResolvedPrincipal } from "./guards.js";
import { organizationFhirCaseParamsSchema, organizationFhirReportParamsSchema, organizationFhirStudyParamsSchema, organizationParamsSchema } from "./params.js";

/**
 * FHIR R4 read facade — see @modelforge/contracts's fhir.ts for the full
 * scope statement and docs/FHIR_INTEGRATION.md for the architecture. Every
 * route here re-uses this codebase's *existing* IAM authorization (the same
 * patientCase:view/imagingStudy:view/diagnosticReport:view actions and
 * conditionContext shape routes/cases.ts and routes/imaging-*.ts already
 * enforce) rather than inventing a parallel FHIR-specific permission model —
 * a FHIR resource is only ever a different JSON *shape* of data this server
 * already protects, never a different trust boundary. Same "identical 404
 * for absent and unauthorized" discipline as the rest of this API.
 *
 * All responses use `application/fhir+json`, per the FHIR HTTP spec.
 */
const FHIR_CONTENT_TYPE = "application/fhir+json; charset=utf-8";

function sendFhir(reply: FastifyReply, statusCode: number, body: unknown): void {
    reply.code(statusCode).header("content-type", FHIR_CONTENT_TYPE).send(body);
}

function caseConditionContext(resource: CaseResourceAttributes, caller: ResolvedPrincipal): Record<string, string> {
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

function studyConditionContext(resource: ImagingResourceAttributes, caller: ResolvedPrincipal): Record<string, string> {
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

export function registerFhirRoutes(fastify: FastifyInstance, deps: RouteDeps): void {
    fastify.get("/organizations/:organizationId/fhir/r4/metadata", { preHandler: deps.authPreHandler }, async (request, reply) => {
        const { organizationId } = organizationParamsSchema.parse(request.params);
        await requireOrgUser(deps, request, organizationId);
        sendFhir(reply, 200, buildCapabilityStatement());
    });

    // Plain OAuth discovery JSON per the SMART App Launch spec — not itself
    // a FHIR resource, so no application/fhir+json, no OperationOutcome
    // envelope, and (unlike every other route here) no per-caller IAM check:
    // a discovery document describing where to authorize is not
    // patient/organization data. Requires deps.smartConfiguration to have
    // been resolved (index.ts, at startup, against the configured OIDC
    // issuer) — see RouteDeps's own doc comment on why this can be
    // undefined (test/dev builds that skip live OIDC discovery).
    fastify.get("/organizations/:organizationId/fhir/r4/.well-known/smart-configuration", async (_request, reply) => {
        if (!deps.smartConfiguration) {
            return reply.code(503).send({ error: "smart_configuration_unavailable", message: "This server was not started with OIDC discovery resolved; SMART on FHIR launch is unavailable." });
        }
        reply.code(200).header("content-type", "application/json; charset=utf-8").send(deps.smartConfiguration);
    });

    fastify.get("/organizations/:organizationId/fhir/r4/Patient/:caseId", { preHandler: deps.authPreHandler }, async (request, reply) => {
        const { organizationId, caseId } = organizationFhirCaseParamsSchema.parse(request.params);
        const caller = await requireOrgUser(deps, request, organizationId);
        const current = await deps.caseStore.forTenant(caller.tenantContext).getOne(caseId);
        if (!current || !(await isPermissionAllowed(deps.store, caller, "patientCase:view", `organization:${organizationId}/patientCase:${caseId}`, caseConditionContext(current.resource, caller)))) {
            return sendFhir(reply, 404, fhirNotFound("Patient", caseId));
        }
        const launchContext = resolveSmartLaunchContext(request.auth!.claims);
        if (deniedBySmartLaunchContext(launchContext, current.resource.patientId)) {
            return sendFhir(reply, 404, fhirNotFound("Patient", caseId));
        }
        sendFhir(reply, 200, toFhirPatient(current.patientCase, current.resource.patientId));
    });

    fastify.get("/organizations/:organizationId/fhir/r4/ImagingStudy/:studyId", { preHandler: deps.authPreHandler }, async (request, reply) => {
        const { organizationId, studyId } = organizationFhirStudyParamsSchema.parse(request.params);
        const caller = await requireOrgUser(deps, request, organizationId);
        const repo = deps.imagingStore.forTenant(caller.tenantContext);
        const current = await repo.getStudy(studyId);
        if (!current || !(await isPermissionAllowed(deps.store, caller, "imagingStudy:view", `organization:${organizationId}/imagingStudy:${studyId}`, studyConditionContext(current.resource, caller)))) {
            return sendFhir(reply, 404, fhirNotFound("ImagingStudy", studyId));
        }
        const launchContext = resolveSmartLaunchContext(request.auth!.claims);
        if (deniedBySmartLaunchContext(launchContext, current.study.patientIdentifier.value)) {
            return sendFhir(reply, 404, fhirNotFound("ImagingStudy", studyId));
        }
        const series = await repo.listSeriesForStudy(studyId);
        sendFhir(reply, 200, toFhirImagingStudy(current.study, series));
    });

    fastify.get("/organizations/:organizationId/fhir/r4/DiagnosticReport/:reportId", { preHandler: deps.authPreHandler }, async (request, reply) => {
        const { organizationId, reportId } = organizationFhirReportParamsSchema.parse(request.params);
        const caller = await requireOrgUser(deps, request, organizationId);
        const repo = deps.imagingStore.forTenant(caller.tenantContext);
        const report = await repo.getReport(reportId);
        if (!report) return sendFhir(reply, 404, fhirNotFound("DiagnosticReport", reportId));
        const study = await repo.getStudy(report.studyId);
        if (!study || !(await isPermissionAllowed(deps.store, caller, "imagingStudy:view", `organization:${organizationId}/imagingStudy:${report.studyId}`, studyConditionContext(study.resource, caller)))) {
            return sendFhir(reply, 404, fhirNotFound("DiagnosticReport", reportId));
        }
        if (!(await isPermissionAllowed(deps.store, caller, "diagnosticReport:view", `organization:${organizationId}/imagingStudy:${report.studyId}`))) {
            return sendFhir(reply, 404, fhirNotFound("DiagnosticReport", reportId));
        }
        const launchContext = resolveSmartLaunchContext(request.auth!.claims);
        if (deniedBySmartLaunchContext(launchContext, study.study.patientIdentifier.value)) {
            return sendFhir(reply, 404, fhirNotFound("DiagnosticReport", reportId));
        }
        sendFhir(reply, 200, toFhirDiagnosticReport(report, study.study));
    });

    // Search-type only (no by-id read route) — matches this system's own
    // store interface, which has no getDocumentReference(id), only
    // listDocumentReferencesForStudy. See capability-statement.ts.
    fastify.get("/organizations/:organizationId/fhir/r4/DocumentReference", { preHandler: deps.authPreHandler }, async (request, reply) => {
        const { organizationId } = organizationParamsSchema.parse(request.params);
        const caller = await requireOrgUser(deps, request, organizationId);
        const { studyId } = z.object({ studyId: z.string().min(1) }).parse(request.query);
        const repo = deps.imagingStore.forTenant(caller.tenantContext);
        const study = await repo.getStudy(studyId);
        if (!study || !(await isPermissionAllowed(deps.store, caller, "imagingStudy:view", `organization:${organizationId}/imagingStudy:${studyId}`, studyConditionContext(study.resource, caller)))) {
            return sendFhir(reply, 200, fhirBundle([]));
        }
        const launchContext = resolveSmartLaunchContext(request.auth!.claims);
        if (deniedBySmartLaunchContext(launchContext, study.study.patientIdentifier.value)) {
            return sendFhir(reply, 200, fhirBundle([]));
        }
        const documents = await repo.listDocumentReferencesForStudy(studyId);
        sendFhir(reply, 200, fhirBundle(documents.map(toFhirDocumentReference)));
    });
}
