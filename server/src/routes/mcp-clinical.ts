import type { CaseResourceAttributes } from "@modelforge/contracts";
import { aiPurposeOfUseSchema, mcpApprovalChallengeSchema, mcpDestinationClassSchema } from "@modelforge/contracts";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { McpApprovalIssuerUnavailableError } from "../mcp-approval-issuer.js";
import { actorFrom } from "../store/audit-store.js";
import type { RouteDeps } from "./deps.js";
import { isPermissionAllowed, requireOrgUser, requirePermission, type ResolvedPrincipal } from "./guards.js";
import { organizationMcpApprovalParamsSchema, organizationParamsSchema } from "./params.js";

const grantBodySchema = z.object({
    registryEntryId: z.string().uuid(),
    caseId: z.string().min(1).max(512),
    purpose: aiPurposeOfUseSchema,
    toolNames: z.array(z.string().min(1).max(512)).min(1).max(100),
    requestedFields: z.array(z.string().min(1).max(100)).min(1).max(100),
    destination: mcpDestinationClassSchema.default("managed_model_forge"),
    ttlSeconds: z.number().int().min(30).max(300).default(300),
}).strict();

const prepareBodySchema = z.object({
    registryEntryId: z.string().uuid(),
    toolName: z.string().min(1).max(512),
    arguments: z.record(z.string(), z.unknown()),
    contextGrantId: z.string().min(1).max(512).optional(),
    caseId: z.string().min(1).max(512).optional(),
}).strict();

const introspectBodySchema = z.object({ grantId: z.string().min(1).max(512) }).strict();
const reviewBodySchema = z.object({
    organizationId: z.string().uuid(),
    caseId: z.string().min(1).max(512),
    reviewerSubjectId: z.string().min(1).max(512),
    reviewedOperationId: z.string().uuid(),
    decision: z.enum(["approved", "rejected", "needs_revision"]),
    rationale: z.string().trim().min(1).max(2_000),
}).strict();

const PURPOSE_TO_CONSENT = {
    "diagnostic-support": "treatment",
    "medication-review": "treatment",
    "documentation-assist": "treatment",
    summarization: "treatment",
    research: "research",
    teaching: "teaching",
    "quality-improvement": "quality-improvement",
} as const;
const DERIVED_FIELDS = new Set(["assistantResponse", "items", "rationale"]);

function clientId(request: FastifyRequest): string {
    const azp = request.auth?.claims.azp;
    const client = request.auth?.claims.client_id;
    if (typeof azp === "string" && azp.length > 0) return azp;
    if (typeof client === "string" && client.length > 0) return client;
    throw Object.assign(new Error("The verified token is missing azp/client_id."), { statusCode: 401 });
}

function caseResourceName(organizationId: string, caseId: string): string {
    return `organization:${organizationId}/patientCase:${caseId}`;
}

function caseConditions(resource: CaseResourceAttributes, caller: ResolvedPrincipal): Record<string, string> {
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

function endpointAllowed(value: string): boolean {
    try {
        const url = new URL(value);
        return url.protocol === "https:" || (url.protocol === "http:" && ["127.0.0.1", "localhost", "::1"].includes(url.hostname));
    } catch { return false; }
}

async function requestApprovalChallenge(endpoint: string, authorization: string, body: z.infer<typeof prepareBodySchema>) {
    if (!endpointAllowed(endpoint)) throw Object.assign(new Error("The registry approval challenge endpoint is not trusted."), { statusCode: 503 });
    const response = await fetch(endpoint, {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(5_000),
        headers: { authorization, "content-type": "application/json" },
        body: JSON.stringify({ toolName: body.toolName, arguments: body.arguments, contextGrantId: body.contextGrantId }),
    });
    if (!response.ok) throw Object.assign(new Error(`Clinical MCP approval challenge failed with HTTP ${response.status}.`), { statusCode: response.status >= 500 ? 503 : 409 });
    return mcpApprovalChallengeSchema.parse(await response.json());
}

export function registerMcpClinicalRoutes(fastify: FastifyInstance, deps: RouteDeps): void {
    fastify.post("/organizations/:organizationId/mcp-context-grants", { preHandler: deps.authPreHandler }, async (request, reply) => {
        const { organizationId } = organizationParamsSchema.parse(request.params);
        const body = grantBodySchema.parse(request.body);
        const caller = await requireOrgUser(deps, request, organizationId);
        const current = await deps.caseStore.forTenant(caller.tenantContext).getOne(body.caseId);
        if (!current || !(await isPermissionAllowed(deps.store, caller, "patientCase:view", caseResourceName(organizationId, body.caseId), caseConditions(current.resource, caller)))) return reply.code(404).send({ error: "not_found" });
        await requirePermission(deps.store, caller, "mcpClinical:use", caseResourceName(organizationId, body.caseId), caseConditions(current.resource, caller));

        const registry = await deps.mcpRegistryStore.getById(organizationId, body.registryEntryId);
        if (!registry || registry.status !== "active" || registry.integrationProfile !== "modelforge-clinical") return reply.code(404).send({ error: "not_found" });
        if (!registry.oauthClientId || registry.oauthClientId !== clientId(request)) return reply.code(403).send({ error: "oauth_client_not_allowed" });
        if (registry.allowedTools !== "*" && body.toolNames.some((tool) => !registry.allowedTools.includes(tool))) return reply.code(403).send({ error: "tool_not_allowed" });
        if (body.destination !== "managed_model_forge") return reply.code(403).send({ error: "destination_not_allowed" });
        if (registry.dataEgressPolicy !== "unrestricted" && body.requestedFields.length > 0) return reply.code(403).send({ error: "data_egress_denied" });

        const hasCaseConsent = current.patientCase.consentRecords.some((record) => record.scope === "ai-assistance" && record.revokedAt === undefined);
        const hasRemoteConsent = current.patientCase.consentRecords.some((record) => record.scope === "remote-model-use" && record.revokedAt === undefined);
        if (!hasCaseConsent || !hasRemoteConsent) return reply.code(403).send({ error: "case_consent_required" });
        const gatewayRepo = deps.aiGatewayStore.forTenant(caller.tenantContext);
        await gatewayRepo.expireStaleConsents(new Date().toISOString());
        const consent = await gatewayRepo.getActiveConsent(body.caseId, PURPOSE_TO_CONSENT[body.purpose]);
        const consentFields = new Set(consent?.dataCategories ?? []);
        if (!consent || body.requestedFields.some((field) => !consentFields.has(field) && !DERIVED_FIELDS.has(field))) return reply.code(403).send({ error: "consent_scope_insufficient" });

        const grant = await deps.mcpClinicalStore.createGrant({ organizationId, subjectId: request.auth!.subject, clientId: clientId(request), caseId: body.caseId, allowedTools: body.toolNames, allowedFields: body.requestedFields, purpose: body.purpose, destination: body.destination, expiresAtEpochSeconds: Math.floor(Date.now() / 1000) + body.ttlSeconds }, actorFrom(caller));
        reply.code(201).send(grant);
    });

    fastify.post("/organizations/:organizationId/mcp-approvals/prepare", { preHandler: deps.authPreHandler }, async (request, reply) => {
        const { organizationId } = organizationParamsSchema.parse(request.params);
        const body = prepareBodySchema.parse(request.body);
        const caller = await requireOrgUser(deps, request, organizationId);
        await requirePermission(deps.store, caller, "mcpClinical:approve", body.caseId ? caseResourceName(organizationId, body.caseId) : `organization:${organizationId}`);
        const registry = await deps.mcpRegistryStore.getById(organizationId, body.registryEntryId);
        if (!registry || registry.status !== "active" || registry.integrationProfile !== "modelforge-clinical" || !registry.approvalChallengeEndpoint) return reply.code(404).send({ error: "not_found" });
        if (!registry.oauthClientId || registry.oauthClientId !== clientId(request)) return reply.code(403).send({ error: "oauth_client_not_allowed" });
        if (registry.allowedTools !== "*" && !registry.allowedTools.includes(body.toolName)) return reply.code(403).send({ error: "tool_not_allowed" });
        const challenge = await requestApprovalChallenge(registry.approvalChallengeEndpoint, request.headers.authorization!, body);
        const expiresAt = new Date(Math.min(challenge.expiresAtEpochSeconds, Math.floor(Date.now() / 1000) + 300) * 1_000).toISOString();
        const approval = await deps.mcpClinicalStore.createApprovalRequest({ organizationId, registryEntryId: body.registryEntryId, subjectId: request.auth!.subject, clientId: clientId(request), toolName: body.toolName, operationDigest: challenge.operationDigest, caseId: body.caseId, expiresAt }, actorFrom(caller));
        reply.code(201).send({ approvalRequest: approval, challenge });
    });

    fastify.post("/organizations/:organizationId/mcp-approvals/:approvalRequestId/confirm", { preHandler: deps.authPreHandler }, async (request, reply) => {
        const { organizationId, approvalRequestId } = organizationMcpApprovalParamsSchema.parse(request.params);
        const caller = await requireOrgUser(deps, request, organizationId);
        const pending = await deps.mcpClinicalStore.getApprovalRequest(organizationId, approvalRequestId);
        if (!pending) return reply.code(404).send({ error: "not_found" });
        await requirePermission(deps.store, caller, "mcpClinical:approve", pending.caseId ? caseResourceName(organizationId, pending.caseId) : `organization:${organizationId}`);
        const confirmed = await deps.mcpClinicalStore.confirmApprovalRequest(organizationId, approvalRequestId, request.auth!.subject, clientId(request), actorFrom(caller));
        if (!confirmed) return reply.code(409).send({ error: "approval_not_pending" });
        try { return reply.send({ approvalRequest: confirmed, approvalTicket: await deps.mcpApprovalTicketIssuer.issue(confirmed) }); }
        catch (error) {
            if (error instanceof McpApprovalIssuerUnavailableError) return reply.code(503).send({ error: "approval_issuer_unavailable" });
            throw error;
        }
    });

    fastify.post("/internal/mcp/context-grants/introspect", { preHandler: deps.authPreHandler }, async (request, reply) => {
        const { grantId } = introspectBodySchema.parse(request.body);
        const organizationId = grantId.slice(0, 36);
        const caller = await requireOrgUser(deps, request, organizationId);
        if (caller.principalType !== "service") return reply.code(403).send({ error: "service_principal_required" });
        await requirePermission(deps.store, caller, "mcpClinical:introspect", `organization:${organizationId}`);
        const grant = await deps.mcpClinicalStore.introspectGrant(grantId);
        if (!grant) return reply.code(404).send({ error: "not_found" });
        reply.send(grant);
    });

    fastify.post("/internal/mcp/reviews", { preHandler: deps.authPreHandler }, async (request, reply) => {
        const body = reviewBodySchema.parse(request.body);
        const caller = await requireOrgUser(deps, request, body.organizationId);
        if (caller.principalType !== "service") return reply.code(403).send({ error: "service_principal_required" });
        await requirePermission(deps.store, caller, "mcpClinical:recordReview", caseResourceName(body.organizationId, body.caseId));
        reply.code(201).send(await deps.mcpClinicalStore.recordReview(body, actorFrom(caller)));
    });
}
