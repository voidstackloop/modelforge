import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { aiConsentPurposeSchema, aiProviderKindSchema, aiProviderOperationalStatusSchema, aiPurposeOfUseSchema, aiReviewDecisionSchema, inferenceCapabilitiesSchema, inferenceRuntimeIdSchema } from "@modelforge/contracts";
import { actorFrom } from "../store/audit-store.js";
import type { RouteDeps } from "./deps.js";
import { isPermissionAllowed, requireOrgUser, requirePermission, type ResolvedPrincipal } from "./guards.js";
import {
    organizationAiConsentParamsSchema,
    organizationAiOutputParamsSchema,
    organizationAiProviderModelParamsSchema,
    organizationAiProviderParamsSchema,
    organizationAiModelArtifactParamsSchema,
    organizationAiInferenceDeploymentParamsSchema,
    organizationAiRequestParamsSchema,
    organizationCaseParamsSchema,
    organizationParamsSchema,
} from "./params.js";
import { withIdempotencyKey } from "./idempotency.js";
import { ClinicalAiGateway } from "../ai-gateway/gateway.js";
import { SCALAR_CASE_FIELD_CATEGORIES } from "../ai-gateway/data-minimization.js";
import { computeProductionQualitySnapshot, detectProductionQualityDrift } from "../eval-harness/production-monitor.js";
import { clientForDeployment } from "../ai-gateway/provider-client.js";

/**
 * HTTP surface for ClinicalAiGateway (server/src/ai-gateway/gateway.ts) —
 * see that file's own doc comment for the full 15-step lifecycle these
 * routes trigger. Every route here reuses the existing patientCase
 * resource identity (`organization:{orgId}/patientCase:{caseId}`) for its
 * IAM check rather than inventing a parallel one, so an org's existing case-
 * level policies (owner/assigned/department conditions) apply to AI actions
 * on that same case without any additional configuration — "can this user
 * touch this case at all" is answered once, by the same mechanism as every
 * other case route.
 *
 * Disclosed scope for this pass:
 *  - The provider/model catalog (`ai-providers`/`ai-provider-models`) is
 *    global, cross-tenant control-plane data (see ai-provider-registry-
 *    store.ts's own doc comment) — but IAM permissions are inherently per-
 *    organization. Gating catalog-management routes on
 *    `aiGateway:manageProviders` in the CALLER's own organization means any
 *    organization whose administrator has been granted that permission can
 *    affect the catalog every other tenant also reads. A real multi-tenant
 *    deployment should restrict this permission to a small, trusted set of
 *    platform-admin accounts (e.g. via policy, not a code change) until a
 *    genuinely separate platform-admin authentication path exists — tracked
 *    as a follow-up, not solved here.
 *  - Citation re-authorization at read time ("reject citations the
 *    requesting user cannot access") is not yet implemented — GET routes
 *    below return citations exactly as stored, re-checked only against the
 *    case's own current view permission, not against each individual cited
 *    resource's own current authorization state.
 */

const caseResourceName = (organizationId: string, caseId: string): string => `organization:${organizationId}/patientCase:${caseId}`;
const globalCatalogResourceName = (organizationId: string): string => `organization:${organizationId}/aiProviderCatalog`;

const submitRequestBodySchema = z
    .object({
        // Omit to auto-route across every enabled, eligible provider model
        // for this tenant — see ai-gateway/model-router.ts and
        // ClinicalAiGateway.submitRequest's own doc comment.
        providerModelId: z.string().min(1).optional(),
        purposeOfUse: aiPurposeOfUseSchema,
        requestedCategories: z.array(z.string().min(1).max(100)).min(1).max(50),
        selectedDeidentificationJobIds: z.array(z.string().min(1).max(200)).max(10).default([]),
        maxTokens: z.number().int().positive().max(32_000).optional(),
    })
    .strict();

const reviewBodySchema = z
    .object({
        decision: aiReviewDecisionSchema,
        correctedText: z.string().max(20_000).optional(),
        escalationReason: z.string().max(2_000).optional(),
    })
    .strict();

const createConsentBodySchema = z
    .object({
        purpose: aiConsentPurposeSchema,
        dataCategories: z.array(z.string().min(1).max(100)).min(1),
        expiresAt: z.string().datetime({ offset: true }).optional(),
    })
    .strict();

const revokeConsentBodySchema = z.object({ reason: z.string().min(1).max(2_000) }).strict();

const createProviderBodySchema = z.object({ name: z.string().min(1).max(200), kind: aiProviderKindSchema }).strict();
const killSwitchBodySchema = z.object({ engaged: z.boolean(), reason: z.string().max(2_000).optional() }).strict();
const operationalStatusBodySchema = z.object({ status: aiProviderOperationalStatusSchema }).strict();

const approvalsBodySchema = z
    .object({ baaSigned: z.boolean().default(false), dpaSigned: z.boolean().default(false), contractualApproval: z.boolean().default(false), securityReviewApproval: z.boolean().default(false), notes: z.string().max(2_000).optional() })
    .strict();

const createProviderModelBodySchema = z
    .object({
        modelId: z.string().min(1).max(200),
        modelVersion: z.string().min(1).max(100),
        apiVersion: z.string().min(1).max(100).optional(),
        intendedUse: z.string().min(1).max(2_000),
        prohibitedUse: z.string().max(2_000).optional(),
        supportedDataTypes: z.array(z.enum(["text", "structured-data", "image", "dicom", "audio"])).min(1),
        maxContextTokens: z.number().int().positive(),
        hostingRegion: z.string().min(1).max(100),
        processingLocation: z.string().min(1).max(100),
        phiPermitted: z.boolean().optional(),
        retainsPrompts: z.boolean().optional(),
        retainsOutputs: z.boolean().optional(),
        trainingUseAllowed: z.boolean().optional(),
        zeroRetentionSupport: z.boolean().optional(),
        approvals: approvalsBodySchema.optional(),
        encryptionInTransit: z.boolean().optional(),
        encryptionAtRest: z.boolean().optional(),
        validationStatus: z.enum(["unvalidated", "shadow", "canary", "validated", "deprecated"]).optional(),
        approvedRoles: z.array(z.string().min(1).max(100)).optional(),
        rateLimitPerMinute: z.number().int().positive().optional(),
        costPerInputTokenUsd: z.number().nonnegative().optional(),
        costPerOutputTokenUsd: z.number().nonnegative().optional(),
        cpuThreads: z.number().int().positive().optional(),
        ramMB: z.number().int().nonnegative().optional(),
        vramMB: z.number().int().nonnegative().optional(),
        effectiveAt: z.string().datetime({ offset: true }).optional(),
    })
    .strict();

const safetyStatusBodySchema = z.object({ status: z.enum(["nominal", "watch", "restricted", "disabled"]) }).strict();

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const createArtifactBodySchema = z.object({
    runtime: inferenceRuntimeIdSchema,
    format: z.enum(["gguf", "safetensors"]),
    sourceUri: z.string().min(1).max(2_000),
    sourceRevision: z.string().min(1).max(200),
    fileName: z.string().min(1).max(500).optional(),
    sha256: sha256Schema,
    configurationHash: sha256Schema,
    licenseId: z.string().min(1).max(200),
    licenseAccepted: z.boolean(),
    capabilities: inferenceCapabilitiesSchema,
    chatTemplate: z.string().min(1).max(500).optional(),
    toolCallParser: z.string().min(1).max(100).optional(),
    trustRemoteCode: z.boolean().default(false),
}).strict().superRefine((value, context) => {
    if (value.runtime === "llamacpp" && value.format !== "gguf") context.addIssue({ code: "custom", path: ["format"], message: "llama.cpp artifacts must use GGUF" });
    if (value.runtime === "vllm" && value.format !== "safetensors") context.addIssue({ code: "custom", path: ["format"], message: "vLLM artifacts must use Safetensors" });
    if (value.runtime === "vllm" && value.capabilities.tools && !value.toolCallParser) context.addIssue({ code: "custom", path: ["toolCallParser"], message: "vLLM tool-capable artifacts require a verified parser" });
});
const createDeploymentBodySchema = z.object({
    name: z.string().min(1).max(200), endpointUrl: z.string().url().max(2_000), servedModelName: z.string().min(1).max(500),
    credentialRef: z.string().regex(/^(env:[A-Z][A-Z0-9_]*|file:\/[A-Za-z0-9._\/-]+)$/), tlsMode: z.enum(["required", "private-network"]),
    poolId: z.string().uuid(), maxConcurrency: z.number().int().positive().max(1_024), priority: z.number().int().min(0).max(10_000).default(100),
}).strict().superRefine((value, context) => {
    const url = new URL(value.endpointUrl);
    if (value.tlsMode === "required" && url.protocol !== "https:") context.addIssue({ code: "custom", path: ["endpointUrl"], message: "TLS-required deployments must use HTTPS" });
    if (!url.pathname.endsWith("/v1") && !url.pathname.endsWith("/v1/")) context.addIssue({ code: "custom", path: ["endpointUrl"], message: "Inference endpoint must end with /v1" });
});
const deploymentStatusBodySchema = z.object({ status: z.enum(["active", "degraded", "disabled"]) }).strict();
const artifactStatusBodySchema = z.object({ status: z.enum(["pending", "verified", "rejected", "retired"]) }).strict();

const tenantSettingsBodySchema = z
    .object({ enabled: z.boolean(), phiAllowed: z.boolean(), allowedRoles: z.array(z.string().min(1).max(100)).default([]), notes: z.string().max(2_000).optional() })
    .strict();

async function requireReadableCase(deps: RouteDeps, caller: ResolvedPrincipal, organizationId: string, caseId: string) {
    const repo = deps.caseStore.forTenant(caller.tenantContext);
    const current = await repo.getOne(caseId);
    if (!current) return null;
    const canView = await isPermissionAllowed(deps.store, caller, "patientCase:view", caseResourceName(organizationId, caseId), {
        "resource:patientId": current.resource.patientId,
        "resource:ownerUserId": current.resource.ownerUserId,
        "resource:isOwner": String(current.resource.ownerUserId === caller.id),
        "resource:isAssigned": String(current.resource.assignedUserIds.includes(caller.id)),
    });
    return canView ? { repo, current } : null;
}

function buildGateway(deps: RouteDeps, caller: ResolvedPrincipal): ClinicalAiGateway {
    return new ClinicalAiGateway({
        caseRepo: deps.caseStore.forTenant(caller.tenantContext),
        gatewayRepo: deps.aiGatewayStore.forTenant(caller.tenantContext),
        registry: deps.aiProviderRegistryStore,
        admission: deps.aiAdmission,
        resolveProviderClient: deps.resolveAiProviderClient,
    });
}

async function resolveImagingSelections(
    deps: RouteDeps,
    caller: ResolvedPrincipal,
    organizationId: string,
    caseId: string,
    jobIds: string[]
) {
    const repo = deps.imagingStore.forTenant(caller.tenantContext);
    const selections: Array<{ studyId: string; deidentificationJobId: string; artifactIds: string[]; safeSummary: string }> = [];
    for (const jobId of [...new Set(jobIds)]) {
        const job = await repo.getDeidentificationJob(jobId);
        if (!job || !["approved", "auto-approved"].includes(job.reviewStatus) || !job.resultArtifactId) return null;
        const stored = await repo.getStudy(job.sourceStudyId);
        if (!stored || stored.study.caseId !== caseId) return null;
        const resource = `organization:${organizationId}/imagingStudy:${stored.study.id}`;
        const attributes = {
            "resource:patientId": stored.resource.patientIdentifier.value,
            "resource:ownerUserId": stored.resource.ownerUserId,
            "resource:isOwner": String(stored.resource.ownerUserId === caller.id),
            "resource:isAssigned": String(stored.resource.assignedUserIds.includes(caller.id)),
        };
        if (!(await isPermissionAllowed(deps.store, caller, "imagingStudy:view", resource, attributes))) return null;
        if (!(await isPermissionAllowed(deps.store, caller, "imagingInstance:retrieve", resource, attributes))) return null;
        const artifacts = (await repo.listDerivedArtifactsForSource("deidentified-instance", undefined, stored.study.id))
            .filter((artifact) => artifact.objectStorageKey.includes(`/derived/deidentified/${job.id}/`));
        if (artifacts.length === 0 || !artifacts.some((artifact) => artifact.id === job.resultArtifactId)) return null;
        selections.push({
            studyId: stored.study.id,
            deidentificationJobId: job.id,
            artifactIds: artifacts.map((artifact) => artifact.id),
            safeSummary: [
                "Reviewed de-identified imaging study manifest.",
                `Modalities: ${stored.study.modalities.join(", ") || "unspecified"}.`,
                `Series: ${stored.study.numberOfSeries}; instances: ${stored.study.numberOfInstances}; derived de-identified instances: ${artifacts.length}.`,
                `De-identification profile: ${job.profile}; review status: ${job.reviewStatus}.`,
                "Pixel content is not embedded in this text request; do not infer visual findings from this manifest.",
            ].join(" "),
        });
    }
    return selections;
}

/** Maps a non-"completed" GatewaySubmitResult outcome to an HTTP status —
 * every one of these represents a real, expected safety/governance gate
 * failing closed, never a 500. */
function statusForDeniedOutcome(outcome: string): number {
    switch (outcome) {
        case "case-not-found":
            return 404;
        case "authorization-denied":
            return 403;
        case "content-blocked":
            return 422;
        case "admission-rejected":
            return 503;
        case "provider-failed":
            return 502;
        case "no-eligible-provider-model":
            return 503;
        default:
            return 500;
    }
}

export function registerAiGatewayRoutes(fastify: FastifyInstance, deps: RouteDeps): void {
    // --- Preview and submit (steps 1-14) -----------------------------------

    fastify.post("/organizations/:organizationId/cases/:caseId/ai-requests/preview", { preHandler: deps.authPreHandler }, async (request, reply) => {
        const { organizationId, caseId } = organizationCaseParamsSchema.parse(request.params);
        const caller = await requireOrgUser(deps, request, organizationId);
        const readable = await requireReadableCase(deps, caller, organizationId, caseId);
        if (!readable) return reply.code(404).send({ error: "not_found" });
        await requirePermission(deps.store, caller, "aiGateway:invoke", caseResourceName(organizationId, caseId));
        const body = submitRequestBodySchema.parse(request.body);
        const imagingSelections = await resolveImagingSelections(deps, caller, organizationId, caseId, body.selectedDeidentificationJobIds);
        if (!imagingSelections) return reply.code(409).send({ error: "imaging_not_ready", message: "Every selected study must belong to this case and have an authorized approved de-identification result." });
        const preview = await buildGateway(deps, caller).previewRequest({ patientCaseId: caseId, requestedByUserId: caller.id, callerRoles: caller.groupIds, providerModelId: body.providerModelId, purposeOfUse: body.purposeOfUse, requestedCategories: body.requestedCategories, imagingSelections });
        if (!preview) return reply.code(404).send({ error: "not_found" });
        reply.send(preview);
    });

    fastify.post("/organizations/:organizationId/cases/:caseId/ai-requests", { preHandler: deps.authPreHandler }, async (request, reply) => {
        const { organizationId, caseId } = organizationCaseParamsSchema.parse(request.params);
        const caller = await requireOrgUser(deps, request, organizationId);
        const readable = await requireReadableCase(deps, caller, organizationId, caseId);
        if (!readable) return reply.code(404).send({ error: "not_found" });
        await requirePermission(deps.store, caller, "aiGateway:invoke", caseResourceName(organizationId, caseId));

        const idempotency = await withIdempotencyKey(deps.idempotencyStore, organizationId, request, reply);
        if (idempotency.replay) return;

        const body = submitRequestBodySchema.parse(request.body);
        const imagingSelections = await resolveImagingSelections(deps, caller, organizationId, caseId, body.selectedDeidentificationJobIds);
        if (!imagingSelections) return reply.code(409).send({ error: "imaging_not_ready", message: "Every selected study must belong to this case and have an authorized approved de-identification result." });
        // "Role" here means IAM group id — this codebase has no separate
        // human-readable role taxonomy, so AiProviderTenantSettings.allowedRoles
        // is expected to be populated with the same group-id strings a
        // deployment already uses for policy conditions, not a new concept.
        const result = await buildGateway(deps, caller).submitRequest(
            { patientCaseId: caseId, requestedByUserId: caller.id, callerRoles: caller.groupIds, providerModelId: body.providerModelId, purposeOfUse: body.purposeOfUse, requestedCategories: body.requestedCategories, imagingSelections, maxTokens: body.maxTokens },
            actorFrom(caller)
        );

        const status = result.outcome === "completed" ? 201 : statusForDeniedOutcome(result.outcome);
        await idempotency.record(status, result);
        reply.code(status).send(result);
    });

    fastify.get("/organizations/:organizationId/cases/:caseId/ai-requests", { preHandler: deps.authPreHandler }, async (request, reply) => {
        const { organizationId, caseId } = organizationCaseParamsSchema.parse(request.params);
        const caller = await requireOrgUser(deps, request, organizationId);
        const readable = await requireReadableCase(deps, caller, organizationId, caseId);
        if (!readable) return reply.code(404).send({ error: "not_found" });
        await requirePermission(deps.store, caller, "aiGateway:viewAuditTrail", caseResourceName(organizationId, caseId));
        const requests = await deps.aiGatewayStore.forTenant(caller.tenantContext).listRequestsForCase(caseId);
        reply.send({ requests });
    });

    fastify.get("/organizations/:organizationId/cases/:caseId/ai-imaging-options", { preHandler: deps.authPreHandler }, async (request, reply) => {
        const { organizationId, caseId } = organizationCaseParamsSchema.parse(request.params);
        const caller = await requireOrgUser(deps, request, organizationId);
        if (!(await requireReadableCase(deps, caller, organizationId, caseId))) return reply.code(404).send({ error: "not_found" });
        await requirePermission(deps.store, caller, "aiGateway:invoke", caseResourceName(organizationId, caseId));
        const repo = deps.imagingStore.forTenant(caller.tenantContext);
        const studies = await repo.listStudies({ caseId });
        const options = [];
        for (const stored of studies) {
            const resource = `organization:${organizationId}/imagingStudy:${stored.study.id}`;
            if (!(await isPermissionAllowed(deps.store, caller, "imagingStudy:view", resource))) continue;
            const jobs = (await Promise.all(
                (await repo.listDerivedArtifactsForSource("deidentified-instance", undefined, stored.study.id)).map(async (artifact) => {
                    const match = /\/derived\/deidentified\/([^/]+)\//.exec(artifact.objectStorageKey);
                    return match ? repo.getDeidentificationJob(match[1]) : null;
                })
            )).filter((job): job is NonNullable<typeof job> => !!job && ["approved", "auto-approved"].includes(job.reviewStatus));
            for (const job of new Map(jobs.map((item) => [item.id, item])).values()) {
                options.push({ studyId: stored.study.id, modalities: stored.study.modalities, numberOfSeries: stored.study.numberOfSeries, numberOfInstances: stored.study.numberOfInstances, job });
            }
        }
        reply.send({ options });
    });

    async function resolveRequestForCase(deps: RouteDeps, caller: ResolvedPrincipal, organizationId: string, requestId: string) {
        const gatewayRepo = deps.aiGatewayStore.forTenant(caller.tenantContext);
        const requestEnvelope = await gatewayRepo.getRequest(requestId);
        if (!requestEnvelope) return null;
        const readable = await requireReadableCase(deps, caller, organizationId, requestEnvelope.patientCaseId);
        if (!readable) return null;
        return { gatewayRepo, requestEnvelope, caseRecord: readable.current };
    }

    fastify.get("/organizations/:organizationId/ai-requests/:requestId", { preHandler: deps.authPreHandler }, async (request, reply) => {
        const { organizationId, requestId } = organizationAiRequestParamsSchema.parse(request.params);
        const caller = await requireOrgUser(deps, request, organizationId);
        const resolved = await resolveRequestForCase(deps, caller, organizationId, requestId);
        if (!resolved) return reply.code(404).send({ error: "not_found" });
        await requirePermission(deps.store, caller, "aiGateway:viewAuditTrail", caseResourceName(organizationId, resolved.requestEnvelope.patientCaseId));
        const [inputs, transformations, outputs] = await Promise.all([
            resolved.gatewayRepo.listRequestInputs(requestId),
            resolved.gatewayRepo.listTransformations(requestId),
            resolved.gatewayRepo.listOutputsForRequest(requestId),
        ]);
        const outputDetails = await Promise.all(outputs.map(async (item) => {
            const storedCitations = await resolved.gatewayRepo.listCitationsForOutput(item.id);
            const citations = [];
            for (const citation of storedCitations) {
                if (citation.resourceType === "clinicalNote") {
                    if (resolved.caseRecord.patientCase.clinicalNotes.some((note) => note.id === citation.resourceId)) citations.push(citation);
                    continue;
                }
                if (citation.resourceType === "imagingStudy") {
                    const stored = await deps.imagingStore.forTenant(caller.tenantContext).getStudy(citation.resourceId);
                    if (!stored || stored.study.caseId !== resolved.requestEnvelope.patientCaseId) continue;
                    if (await isPermissionAllowed(deps.store, caller, "imagingStudy:view", `organization:${organizationId}/imagingStudy:${stored.study.id}`)) citations.push(citation);
                    continue;
                }
                // data-minimization.ts's synthetic per-field citation
                // (`"<category>:<caseId>"`) — no separate permission check
                // needed beyond the case-level access resolveRequestForCase
                // already required above (unlike imagingStudy, a case field
                // is not a separate authorization domain), just re-verified
                // existence: a known category, still belonging to this same
                // request's case. Same "re-checked only against the live
                // resource, not trusted from generation time" posture as
                // every other branch here.
                if (citation.resourceType === "patientCaseField") {
                    const [category, caseId] = [citation.resourceId.split(":")[0], citation.resourceId.slice(citation.resourceId.indexOf(":") + 1)];
                    if (caseId === resolved.requestEnvelope.patientCaseId && (SCALAR_CASE_FIELD_CATEGORIES as readonly string[]).includes(category)) citations.push(citation);
                }
            }
            return { output: item, citations, review: await resolved.gatewayRepo.getReviewForOutput(item.id) };
        }));
        reply.send({ request: resolved.requestEnvelope, inputs, transformations, outputs: outputDetails });
    });

    // --- Review (step 13) ----------------------------------------------------

    fastify.post("/organizations/:organizationId/ai-outputs/:outputId/review", { preHandler: deps.authPreHandler }, async (request, reply) => {
        const { organizationId, outputId } = organizationAiOutputParamsSchema.parse(request.params);
        const caller = await requireOrgUser(deps, request, organizationId);
        const gatewayRepo = deps.aiGatewayStore.forTenant(caller.tenantContext);
        const output = await gatewayRepo.getOutput(outputId);
        if (!output) return reply.code(404).send({ error: "not_found" });
        const resolved = await resolveRequestForCase(deps, caller, organizationId, output.requestId);
        if (!resolved) return reply.code(404).send({ error: "not_found" });
        await requirePermission(deps.store, caller, "aiGateway:review", caseResourceName(organizationId, resolved.requestEnvelope.patientCaseId));
        const body = reviewBodySchema.parse(request.body);
        try {
            const review = await buildGateway(deps, caller).recordReview({ outputId, reviewedByUserId: caller.id, decision: body.decision, correctedText: body.correctedText, escalationReason: body.escalationReason }, actorFrom(caller));
            reply.code(201).send(review);
        } catch (err) {
            reply.code(409).send({ error: "already_reviewed", message: err instanceof Error ? err.message : "This output already has a review." });
        }
    });

    // --- Consent (governance layer, not the IAM policy engine) ------------

    fastify.post("/organizations/:organizationId/cases/:caseId/ai-consents", { preHandler: deps.authPreHandler }, async (request, reply) => {
        const { organizationId, caseId } = organizationCaseParamsSchema.parse(request.params);
        const caller = await requireOrgUser(deps, request, organizationId);
        const readable = await requireReadableCase(deps, caller, organizationId, caseId);
        if (!readable) return reply.code(404).send({ error: "not_found" });
        await requirePermission(deps.store, caller, "aiGateway:manageConsent", caseResourceName(organizationId, caseId));
        const body = createConsentBodySchema.parse(request.body);
        const consent = await deps.aiGatewayStore.forTenant(caller.tenantContext).createConsent({ patientCaseId: caseId, purpose: body.purpose, dataCategories: body.dataCategories, grantedByUserId: caller.id, expiresAt: body.expiresAt }, actorFrom(caller));
        reply.code(201).send(consent);
    });

    fastify.get("/organizations/:organizationId/cases/:caseId/ai-consents", { preHandler: deps.authPreHandler }, async (request, reply) => {
        const { organizationId, caseId } = organizationCaseParamsSchema.parse(request.params);
        const caller = await requireOrgUser(deps, request, organizationId);
        const readable = await requireReadableCase(deps, caller, organizationId, caseId);
        if (!readable) return reply.code(404).send({ error: "not_found" });
        await requirePermission(deps.store, caller, "aiGateway:viewAuditTrail", caseResourceName(organizationId, caseId));
        const consents = await deps.aiGatewayStore.forTenant(caller.tenantContext).listConsentsForCase(caseId);
        reply.send({ consents });
    });

    fastify.post("/organizations/:organizationId/cases/:caseId/ai-consents/:consentId/revoke", { preHandler: deps.authPreHandler }, async (request, reply) => {
        const { organizationId, caseId, consentId } = organizationAiConsentParamsSchema.parse(request.params);
        const caller = await requireOrgUser(deps, request, organizationId);
        const readable = await requireReadableCase(deps, caller, organizationId, caseId);
        if (!readable) return reply.code(404).send({ error: "not_found" });
        const gatewayRepo = deps.aiGatewayStore.forTenant(caller.tenantContext);
        const existing = await gatewayRepo.getConsent(consentId);
        if (!existing || existing.patientCaseId !== caseId) return reply.code(404).send({ error: "not_found" });
        await requirePermission(deps.store, caller, "aiGateway:manageConsent", caseResourceName(organizationId, caseId));
        const body = revokeConsentBodySchema.parse(request.body);
        const revoked = await gatewayRepo.revokeConsent(consentId, caller.id, body.reason, actorFrom(caller));
        reply.send(revoked);
    });

    // --- Safety events -------------------------------------------------------

    fastify.get("/organizations/:organizationId/ai-safety-events", { preHandler: deps.authPreHandler }, async (request, reply) => {
        const { organizationId } = organizationParamsSchema.parse(request.params);
        const caller = await requireOrgUser(deps, request, organizationId);
        await requirePermission(deps.store, caller, "aiGateway:viewAuditTrail", globalCatalogResourceName(organizationId));
        const severity = z.enum(["info", "warning", "critical"]).optional().parse((request.query as Record<string, unknown> | undefined)?.severity);
        const events = await deps.aiGatewayStore.forTenant(caller.tenantContext).listSafetyEvents(severity ? { severity } : undefined);
        reply.send({ events });
    });

    // --- Global provider/model catalog (see this file's own doc comment on
    // the disclosed tenant-boundary caveat for these routes) ----------------

    fastify.get("/organizations/:organizationId/ai-providers", { preHandler: deps.authPreHandler }, async (request, reply) => {
        const { organizationId } = organizationParamsSchema.parse(request.params);
        const caller = await requireOrgUser(deps, request, organizationId);
        await requirePermission(deps.store, caller, "aiGateway:viewAuditTrail", globalCatalogResourceName(organizationId));
        reply.send({ providers: await deps.aiProviderRegistryStore.listProviders() });
    });

    fastify.post("/organizations/:organizationId/ai-providers", { preHandler: deps.authPreHandler }, async (request, reply) => {
        const { organizationId } = organizationParamsSchema.parse(request.params);
        const caller = await requireOrgUser(deps, request, organizationId);
        await requirePermission(deps.store, caller, "aiGateway:manageProviders", globalCatalogResourceName(organizationId));
        const body = createProviderBodySchema.parse(request.body);
        const provider = await deps.aiProviderRegistryStore.createProvider(body, actorFrom(caller));
        reply.code(201).send(provider);
    });

    fastify.post("/organizations/:organizationId/ai-providers/:providerId/kill-switch", { preHandler: deps.authPreHandler }, async (request, reply) => {
        const { organizationId, providerId } = organizationAiProviderParamsSchema.parse(request.params);
        const caller = await requireOrgUser(deps, request, organizationId);
        await requirePermission(deps.store, caller, "aiGateway:manageProviders", globalCatalogResourceName(organizationId));
        const body = killSwitchBodySchema.parse(request.body);
        const provider = await deps.aiProviderRegistryStore.setProviderKillSwitch(providerId, body.engaged, body.reason, actorFrom(caller));
        if (!provider) return reply.code(404).send({ error: "not_found" });
        reply.send(provider);
    });

    fastify.post("/organizations/:organizationId/ai-providers/:providerId/operational-status", { preHandler: deps.authPreHandler }, async (request, reply) => {
        const { organizationId, providerId } = organizationAiProviderParamsSchema.parse(request.params);
        const caller = await requireOrgUser(deps, request, organizationId);
        await requirePermission(deps.store, caller, "aiGateway:manageProviders", globalCatalogResourceName(organizationId));
        const body = operationalStatusBodySchema.parse(request.body);
        const provider = await deps.aiProviderRegistryStore.setProviderOperationalStatus(providerId, body.status, actorFrom(caller));
        if (!provider) return reply.code(404).send({ error: "not_found" });
        reply.send(provider);
    });

    fastify.get("/organizations/:organizationId/ai-providers/:providerId/models", { preHandler: deps.authPreHandler }, async (request, reply) => {
        const { organizationId, providerId } = organizationAiProviderParamsSchema.parse(request.params);
        const caller = await requireOrgUser(deps, request, organizationId);
        await requirePermission(deps.store, caller, "aiGateway:viewAuditTrail", globalCatalogResourceName(organizationId));
        reply.send({ models: await deps.aiProviderRegistryStore.listProviderModels({ providerId }) });
    });

    fastify.post("/organizations/:organizationId/ai-providers/:providerId/models", { preHandler: deps.authPreHandler }, async (request, reply) => {
        const { organizationId, providerId } = organizationAiProviderParamsSchema.parse(request.params);
        const caller = await requireOrgUser(deps, request, organizationId);
        await requirePermission(deps.store, caller, "aiGateway:manageProviders", globalCatalogResourceName(organizationId));
        const body = createProviderModelBodySchema.parse(request.body);
        const model = await deps.aiProviderRegistryStore.createProviderModel({ ...body, providerId }, actorFrom(caller));
        reply.code(201).send(model);
    });

    fastify.post("/organizations/:organizationId/ai-provider-models/:modelId/safety-status", { preHandler: deps.authPreHandler }, async (request, reply) => {
        const { organizationId, modelId } = organizationAiProviderModelParamsSchema.parse(request.params);
        const caller = await requireOrgUser(deps, request, organizationId);
        await requirePermission(deps.store, caller, "aiGateway:manageProviders", globalCatalogResourceName(organizationId));
        const body = safetyStatusBodySchema.parse(request.body);
        const model = await deps.aiProviderRegistryStore.setProviderModelSafetyStatus(modelId, body.status, actorFrom(caller));
        if (!model) return reply.code(404).send({ error: "not_found" });
        reply.send(model);
    });

    fastify.post("/organizations/:organizationId/ai-provider-models/:modelId/retire", { preHandler: deps.authPreHandler }, async (request, reply) => {
        const { organizationId, modelId } = organizationAiProviderModelParamsSchema.parse(request.params);
        const caller = await requireOrgUser(deps, request, organizationId);
        await requirePermission(deps.store, caller, "aiGateway:manageProviders", globalCatalogResourceName(organizationId));
        const model = await deps.aiProviderRegistryStore.retireProviderModel(modelId, actorFrom(caller));
        if (!model) return reply.code(404).send({ error: "not_found" });
        reply.send(model);
    });

    fastify.get("/organizations/:organizationId/ai-provider-models/:modelId/artifacts", { preHandler: deps.authPreHandler }, async (request, reply) => {
        const { organizationId, modelId } = organizationAiProviderModelParamsSchema.parse(request.params);
        const caller = await requireOrgUser(deps, request, organizationId);
        await requirePermission(deps.store, caller, "aiGateway:viewAuditTrail", globalCatalogResourceName(organizationId));
        reply.send({ artifacts: await deps.aiProviderRegistryStore.listModelArtifacts({ providerModelId: modelId }) });
    });

    // --- Online production quality monitoring (eval-harness/production-
    // monitor.ts) — the "online" half of the clinical AI evaluation
    // framework, complementary to the offline golden-dataset harness
    // (eval-harness/runner.ts, driven by its own CLI, not an HTTP route).
    // Aggregate rates only, gated the same as every other model-level
    // catalog read here — no patient-identifying data crosses this route.
    fastify.get("/organizations/:organizationId/ai-provider-models/:modelId/quality-monitor", { preHandler: deps.authPreHandler }, async (request, reply) => {
        const { organizationId, modelId } = organizationAiProviderModelParamsSchema.parse(request.params);
        const caller = await requireOrgUser(deps, request, organizationId);
        await requirePermission(deps.store, caller, "aiGateway:viewAuditTrail", globalCatalogResourceName(organizationId));
        const { since } = z.object({ since: z.string().datetime({ offset: true }).optional() }).parse(request.query);
        const repo = deps.aiGatewayStore.forTenant(caller.tenantContext);
        reply.send(await computeProductionQualitySnapshot(repo, modelId, since));
    });

    fastify.get("/organizations/:organizationId/ai-provider-models/:modelId/quality-drift", { preHandler: deps.authPreHandler }, async (request, reply) => {
        const { organizationId, modelId } = organizationAiProviderModelParamsSchema.parse(request.params);
        const caller = await requireOrgUser(deps, request, organizationId);
        await requirePermission(deps.store, caller, "aiGateway:viewAuditTrail", globalCatalogResourceName(organizationId));
        const { baselineSince, splitAt } = z.object({ baselineSince: z.string().datetime({ offset: true }).optional(), splitAt: z.string().datetime({ offset: true }) }).parse(request.query);
        const repo = deps.aiGatewayStore.forTenant(caller.tenantContext);
        reply.send(await detectProductionQualityDrift(repo, modelId, baselineSince, splitAt));
    });

    fastify.post("/organizations/:organizationId/ai-provider-models/:modelId/artifacts", { preHandler: deps.authPreHandler }, async (request, reply) => {
        const { organizationId, modelId } = organizationAiProviderModelParamsSchema.parse(request.params);
        const caller = await requireOrgUser(deps, request, organizationId);
        await requirePermission(deps.store, caller, "aiGateway:manageProviders", globalCatalogResourceName(organizationId));
        if (!await deps.aiProviderRegistryStore.getProviderModel(modelId)) return reply.code(404).send({ error: "not_found" });
        const body = createArtifactBodySchema.parse(request.body);
        const artifact = await deps.aiProviderRegistryStore.createModelArtifact({ ...body, providerModelId: modelId, status: "pending" }, actorFrom(caller));
        reply.code(201).send(artifact);
    });

    fastify.post("/organizations/:organizationId/ai-model-artifacts/:artifactId/status", { preHandler: deps.authPreHandler }, async (request, reply) => {
        const { organizationId, artifactId } = organizationAiModelArtifactParamsSchema.parse(request.params);
        const caller = await requireOrgUser(deps, request, organizationId);
        await requirePermission(deps.store, caller, "aiGateway:manageProviders", globalCatalogResourceName(organizationId));
        const body = artifactStatusBodySchema.parse(request.body);
        const existing = await deps.aiProviderRegistryStore.getModelArtifact(artifactId);
        if (!existing) return reply.code(404).send({ error: "not_found" });
        if (body.status === "verified" && !existing.licenseAccepted) return reply.code(409).send({ error: "license_not_accepted", message: "The artifact license must be accepted before verification." });
        const artifact = await deps.aiProviderRegistryStore.setModelArtifactStatus(artifactId, body.status, actorFrom(caller));
        reply.send(artifact);
    });

    fastify.get("/organizations/:organizationId/ai-model-artifacts/:artifactId/deployments", { preHandler: deps.authPreHandler }, async (request, reply) => {
        const { organizationId, artifactId } = organizationAiModelArtifactParamsSchema.parse(request.params);
        const caller = await requireOrgUser(deps, request, organizationId);
        await requirePermission(deps.store, caller, "aiGateway:viewAuditTrail", globalCatalogResourceName(organizationId));
        reply.send({ deployments: await deps.aiProviderRegistryStore.listInferenceDeployments({ artifactId }) });
    });

    fastify.post("/organizations/:organizationId/ai-model-artifacts/:artifactId/deployments", { preHandler: deps.authPreHandler }, async (request, reply) => {
        const { organizationId, artifactId } = organizationAiModelArtifactParamsSchema.parse(request.params);
        const caller = await requireOrgUser(deps, request, organizationId);
        await requirePermission(deps.store, caller, "aiGateway:manageProviders", globalCatalogResourceName(organizationId));
        if (!await deps.aiProviderRegistryStore.getModelArtifact(artifactId)) return reply.code(404).send({ error: "not_found" });
        const body = createDeploymentBodySchema.parse(request.body);
        const deployment = await deps.aiProviderRegistryStore.createInferenceDeployment({ ...body, artifactId, operationalStatus: "disabled" }, actorFrom(caller));
        reply.code(201).send(deployment);
    });

    fastify.post("/organizations/:organizationId/ai-inference-deployments/:deploymentId/operational-status", { preHandler: deps.authPreHandler }, async (request, reply) => {
        const { organizationId, deploymentId } = organizationAiInferenceDeploymentParamsSchema.parse(request.params);
        const caller = await requireOrgUser(deps, request, organizationId);
        await requirePermission(deps.store, caller, "aiGateway:manageProviders", globalCatalogResourceName(organizationId));
        const body = deploymentStatusBodySchema.parse(request.body);
        const existing = await deps.aiProviderRegistryStore.getInferenceDeployment(deploymentId);
        if (!existing) return reply.code(404).send({ error: "not_found" });
        if (body.status === "active" && !existing.lastVerifiedAt) return reply.code(409).send({ error: "verification_required", message: "Verify the deployment before activating it." });
        const deployment = await deps.aiProviderRegistryStore.setInferenceDeploymentStatus(deploymentId, body.status, actorFrom(caller));
        reply.send(deployment);
    });

    fastify.post("/organizations/:organizationId/ai-inference-deployments/:deploymentId/verify", { preHandler: deps.authPreHandler }, async (request, reply) => {
        const { organizationId, deploymentId } = organizationAiInferenceDeploymentParamsSchema.parse(request.params);
        const caller = await requireOrgUser(deps, request, organizationId);
        await requirePermission(deps.store, caller, "aiGateway:manageProviders", globalCatalogResourceName(organizationId));
        const deployment = await deps.aiProviderRegistryStore.getInferenceDeployment(deploymentId);
        const artifact = deployment ? await deps.aiProviderRegistryStore.getModelArtifact(deployment.artifactId) : null;
        const providerModel = artifact ? await deps.aiProviderRegistryStore.getProviderModel(artifact.providerModelId) : null;
        if (!deployment || !artifact || !providerModel) return reply.code(404).send({ error: "not_found" });
        let healthy = false;
        try { healthy = await clientForDeployment({ ...deployment, operationalStatus: "active" }, artifact, providerModel.modelVersion).healthCheck(); } catch { healthy = false; }
        const updated = await deps.aiProviderRegistryStore.recordInferenceDeploymentVerification(deploymentId, { healthy }, actorFrom(caller));
        reply.code(healthy ? 200 : 502).send({ healthy, deployment: updated });
    });

    // --- Per-tenant provider/model approval ---------------------------------

    fastify.get("/organizations/:organizationId/ai-provider-models/:modelId/tenant-settings", { preHandler: deps.authPreHandler }, async (request, reply) => {
        const { organizationId, modelId } = organizationAiProviderModelParamsSchema.parse(request.params);
        const caller = await requireOrgUser(deps, request, organizationId);
        await requirePermission(deps.store, caller, "aiGateway:viewAuditTrail", globalCatalogResourceName(organizationId));
        const settings = await deps.aiGatewayStore.forTenant(caller.tenantContext).getProviderTenantSettings(modelId);
        if (!settings) return reply.code(404).send({ error: "not_found" });
        reply.send(settings);
    });

    fastify.put("/organizations/:organizationId/ai-provider-models/:modelId/tenant-settings", { preHandler: deps.authPreHandler }, async (request, reply) => {
        const { organizationId, modelId } = organizationAiProviderModelParamsSchema.parse(request.params);
        const caller = await requireOrgUser(deps, request, organizationId);
        await requirePermission(deps.store, caller, "aiGateway:manageTenantSettings", globalCatalogResourceName(organizationId));
        const body = tenantSettingsBodySchema.parse(request.body);
        const settings = await deps.aiGatewayStore
            .forTenant(caller.tenantContext)
            .upsertProviderTenantSettings({ providerModelId: modelId, enabled: body.enabled, phiAllowed: body.phiAllowed, allowedRoles: body.allowedRoles, approvedByUserId: caller.id, notes: body.notes }, actorFrom(caller));
        reply.send(settings);
    });
}
