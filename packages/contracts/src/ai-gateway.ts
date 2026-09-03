import { z } from "zod";

/**
 * ClinicalAiGateway — the sole path by which any UI, model, plugin, or
 * provider may touch patient data on the way to or from an AI model. See
 * docs/CLINICAL_AI_GATEWAY.md for the full lifecycle, trust boundaries, and
 * disclosed limitations.
 *
 * Load-bearing invariants this schema layer encodes:
 *  - The provider/model **catalog** (`AiProvider`/`AiProviderModel`) is
 *    global, cross-tenant, and PHI-free by construction — it describes what
 *    a model *is*, never what any patient's data *is*. It lives outside
 *    every tenant schema (see migration 018's own top comment), the same
 *    "control-plane data lives in the public schema" pattern `organizations`
 *    itself already follows.
 *  - Everything patient-linked (`AiConsent`, `AiRequestEnvelope` and
 *    everything hanging off it) is tenant-scoped, mirroring
 *    ImagingStudy/PatientCase — never global, never cross-tenant-readable.
 *  - `AiRequestEnvelope` is the one and only object a provider adapter is
 *    ever handed — it carries already-minimized, already-scanned content,
 *    never a live handle back into patient-case JSON, DICOM storage, or any
 *    other store. See server/src/ai-gateway/gateway.ts.
 *  - Authorization ("can this user do this action") is the existing IAM
 *    policy engine (action-catalog.ts's new `aiGateway:*` actions) —
 *    nothing here duplicates that. What lives here is data-governance:
 *    consent, and per-tenant provider/model approval — "is this user
 *    allowed to click the button" is a different question from "may this
 *    patient's data go to this provider," and conflating them was a
 *    deliberate anti-goal.
 *  - Chain-of-thought is never modeled or stored here — `AiOutput` has a
 *    `summary`/`evidence`/`uncertainty`/`followUp` shape, not a
 *    `reasoning`/`thoughts` field. A provider adapter that returns
 *    reasoning traces must discard them before constructing this shape.
 */

const identifierSchema = z.string().min(1).max(200);
const timestampSchema = z.string().datetime({ offset: true });
const sha256HexSchema = z.string().regex(/^[a-f0-9]{64}$/, "must be a lowercase hex SHA-256 digest");

// --- Provider / model catalog (global, PHI-free) ---------------------------

export const aiProviderKindSchema = z.enum(["local", "on-premises", "tenant-managed", "cloud"]);
export const aiProviderOperationalStatusSchema = z.enum(["active", "degraded", "suspended", "retired"]);

export const aiProviderSchema = z
    .object({
        id: identifierSchema,
        name: z.string().min(1).max(200),
        kind: aiProviderKindSchema,
        // A global, immediate stop switch — independent of any per-model
        // status below. See "Support immediate provider or model shutdown
        // through an administrative kill switch."
        killSwitchEngaged: z.boolean(),
        killSwitchReason: z.string().max(2_000).optional(),
        operationalStatus: aiProviderOperationalStatusSchema,
        createdAt: timestampSchema,
        updatedAt: timestampSchema,
    })
    .strict();
export type AiProvider = z.infer<typeof aiProviderSchema>;

export const aiModelValidationStatusSchema = z.enum(["unvalidated", "shadow", "canary", "validated", "deprecated"]);
export const aiModelSafetyStatusSchema = z.enum(["nominal", "watch", "restricted", "disabled"]);

/**
 * One row per (provider, model, model version, API version) — a model
 * upgrade is a *new* row, never an in-place mutation of an old one, so a
 * past request's `providerModelId` always resolves to the exact
 * configuration that produced it (item: "reproducible enough to identify
 * the model version... even if exact output reproduction is impossible").
 */
export const aiProviderModelSchema = z
    .object({
        id: identifierSchema,
        providerId: identifierSchema,
        modelId: z.string().min(1).max(200),
        modelVersion: z.string().min(1).max(100),
        apiVersion: z.string().min(1).max(100).optional(),
        intendedUse: z.string().min(1).max(2_000),
        prohibitedUse: z.string().max(2_000).optional(),
        supportedDataTypes: z.array(z.enum(["text", "structured-data", "image", "dicom", "audio"])).min(1),
        maxContextTokens: z.number().int().positive(),
        hostingRegion: z.string().min(1).max(100),
        processingLocation: z.string().min(1).max(100),
        // Defaults enforced at the zod layer, not just by convention — a
        // provider row that omits these fields gets the safe values, never
        // an accidental permissive default. See "Default to denying PHI
        // access" / "Disable provider training and provider-side retention
        // by default."
        phiPermitted: z.boolean().default(false),
        retainsPrompts: z.boolean().default(false),
        retainsOutputs: z.boolean().default(false),
        trainingUseAllowed: z.boolean().default(false),
        zeroRetentionSupport: z.boolean().default(false),
        approvals: z
            .object({
                baaSigned: z.boolean().default(false),
                dpaSigned: z.boolean().default(false),
                contractualApproval: z.boolean().default(false),
                securityReviewApproval: z.boolean().default(false),
                notes: z.string().max(2_000).optional(),
            })
            .strict()
            .default({ baaSigned: false, dpaSigned: false, contractualApproval: false, securityReviewApproval: false }),
        encryptionInTransit: z.boolean().default(false),
        encryptionAtRest: z.boolean().default(false),
        validationStatus: aiModelValidationStatusSchema.default("unvalidated"),
        safetyStatus: aiModelSafetyStatusSchema.default("nominal"),
        approvedRoles: z.array(z.string().min(1).max(100)).default([]),
        rateLimitPerMinute: z.number().int().positive().optional(),
        costPerInputTokenUsd: z.number().nonnegative().optional(),
        costPerOutputTokenUsd: z.number().nonnegative().optional(),
        cpuThreads: z.number().int().positive().optional(),
        ramMB: z.number().int().nonnegative().optional(),
        vramMB: z.number().int().nonnegative().optional(),
        effectiveAt: timestampSchema,
        retiredAt: timestampSchema.optional(),
        createdAt: timestampSchema,
        updatedAt: timestampSchema,
    })
    .strict();
export type AiProviderModel = z.infer<typeof aiProviderModelSchema>;

// --- Verified inference artifacts and deployments (global, PHI-free) -----

export const inferenceRuntimeIdSchema = z.enum(["llamacpp", "vllm"]);
export type InferenceRuntimeId = z.infer<typeof inferenceRuntimeIdSchema>;

export const inferenceCapabilitiesSchema = z
    .object({
        chat: z.boolean().default(true),
        streaming: z.boolean().default(true),
        tools: z.boolean().default(false),
        structuredOutput: z.boolean().default(false),
        embeddings: z.boolean().default(false),
        tokenCounting: z.boolean().default(false),
    })
    .strict();
export type InferenceCapabilities = z.infer<typeof inferenceCapabilitiesSchema>;

export const aiModelArtifactSchema = z
    .object({
        id: identifierSchema,
        providerModelId: identifierSchema,
        runtime: inferenceRuntimeIdSchema,
        format: z.enum(["gguf", "safetensors"]),
        sourceUri: z.string().min(1).max(2_000),
        sourceRevision: z.string().min(1).max(200),
        fileName: z.string().min(1).max(500).optional(),
        sha256: sha256HexSchema,
        configurationHash: sha256HexSchema,
        licenseId: z.string().min(1).max(200),
        licenseAccepted: z.boolean(),
        capabilities: inferenceCapabilitiesSchema,
        chatTemplate: z.string().min(1).max(500).optional(),
        toolCallParser: z.string().min(1).max(100).optional(),
        trustRemoteCode: z.boolean().default(false),
        status: z.enum(["pending", "verified", "rejected", "retired"]),
        createdAt: timestampSchema,
        updatedAt: timestampSchema,
    })
    .strict()
    .superRefine((artifact, context) => {
        if (artifact.runtime === "llamacpp" && artifact.format !== "gguf") {
            context.addIssue({ code: "custom", path: ["format"], message: "llama.cpp artifacts must use GGUF" });
        }
        if (artifact.runtime === "vllm" && artifact.format !== "safetensors") {
            context.addIssue({ code: "custom", path: ["format"], message: "vLLM artifacts must use Safetensors" });
        }
        if (artifact.capabilities.tools && artifact.runtime === "vllm" && !artifact.toolCallParser) {
            context.addIssue({ code: "custom", path: ["toolCallParser"], message: "vLLM tool-capable artifacts require a verified tool-call parser" });
        }
    });
export type AiModelArtifact = z.infer<typeof aiModelArtifactSchema>;

export const aiInferenceDeploymentSchema = z
    .object({
        id: identifierSchema,
        artifactId: identifierSchema,
        name: z.string().min(1).max(200),
        endpointUrl: z.string().url().max(2_000),
        servedModelName: z.string().min(1).max(500),
        credentialRef: z.string().regex(/^(env:[A-Z][A-Z0-9_]*|file:\/[A-Za-z0-9._\/-]+)$/),
        tlsMode: z.enum(["required", "private-network"]),
        poolId: identifierSchema,
        maxConcurrency: z.number().int().positive().max(1_024),
        priority: z.number().int().min(0).max(10_000),
        operationalStatus: z.enum(["active", "degraded", "disabled"]),
        runtimeVersion: z.string().min(1).max(100).optional(),
        lastVerifiedAt: timestampSchema.optional(),
        createdAt: timestampSchema,
        updatedAt: timestampSchema,
    })
    .strict()
    .superRefine((deployment, context) => {
        if (deployment.tlsMode === "required" && !deployment.endpointUrl.startsWith("https://")) {
            context.addIssue({ code: "custom", path: ["endpointUrl"], message: "TLS-required deployments must use HTTPS" });
        }
        if (!/\/v1\/?$/.test(deployment.endpointUrl)) {
            context.addIssue({ code: "custom", path: ["endpointUrl"], message: "Inference endpoints must end with /v1" });
        }
    });
export type AiInferenceDeployment = z.infer<typeof aiInferenceDeploymentSchema>;

// --- Per-tenant provider/model approval (tenant-scoped) --------------------

/**
 * A model existing in the global catalog with `phiPermitted: true` does
 * NOT mean any tenant may send it PHI — this row is the tenant's own
 * explicit opt-in, and it can never widen what the catalog itself allows
 * (enforced in code, not just by convention: effective PHI permission is
 * `catalogModel.phiPermitted && tenantSettings.phiAllowed`).
 */
export const aiProviderTenantSettingsSchema = z
    .object({
        id: identifierSchema,
        providerModelId: identifierSchema,
        enabled: z.boolean().default(false),
        phiAllowed: z.boolean().default(false),
        allowedRoles: z.array(z.string().min(1).max(100)).default([]),
        approvedByUserId: identifierSchema,
        approvedAt: timestampSchema,
        notes: z.string().max(2_000).optional(),
    })
    .strict();
export type AiProviderTenantSettings = z.infer<typeof aiProviderTenantSettingsSchema>;

// --- Consent (tenant-scoped, patient-linked) -------------------------------

export const aiConsentStatusSchema = z.enum(["active", "revoked", "expired"]);
export const aiConsentPurposeSchema = z.enum(["treatment", "research", "teaching", "quality-improvement"]);

export const aiConsentSchema = z
    .object({
        id: identifierSchema,
        patientCaseId: identifierSchema,
        version: z.number().int().positive(),
        purpose: aiConsentPurposeSchema,
        dataCategories: z.array(z.string().min(1).max(100)).min(1),
        status: aiConsentStatusSchema,
        grantedByUserId: identifierSchema,
        grantedAt: timestampSchema,
        expiresAt: timestampSchema.optional(),
        revokedByUserId: identifierSchema.optional(),
        revokedAt: timestampSchema.optional(),
        revokedReason: z.string().max(2_000).optional(),
    })
    .strict()
    .refine((v) => v.status !== "revoked" || (v.revokedByUserId !== undefined && v.revokedAt !== undefined), {
        message: "a revoked consent must carry revokedByUserId and revokedAt",
        path: ["revokedAt"],
    });
export type AiConsent = z.infer<typeof aiConsentSchema>;

// --- Request envelope (tenant-scoped) ---------------------------------------

export const aiRequestStatusSchema = z.enum([
    "draft", "pending-authorization", "scanning", "queued", "running",
    "awaiting-review", "accepted", "rejected", "corrected", "escalated",
    "failed", "cancelled", "expired",
]);

export const aiPurposeOfUseSchema = z.enum([
    "diagnostic-support", "summarization", "medication-review", "documentation-assist",
    "research", "teaching", "quality-improvement",
]);

/** What a preview/authorization step both check against — the exact shape
 * shown to the user before they confirm (item: "pre-flight sharing UI"). */
export const aiDataScopeSchema = z
    .object({
        dataCategories: z.array(z.string().min(1).max(100)).min(1),
        resourceRefs: z.array(z.object({ resourceType: z.string().min(1).max(100), resourceId: identifierSchema })).max(500),
        dateRangeStart: timestampSchema.optional(),
        dateRangeEnd: timestampSchema.optional(),
        includesIdentifiers: z.boolean(),
    })
    .strict();
export type AiDataScope = z.infer<typeof aiDataScopeSchema>;

export const aiRequestEnvelopeSchema = z
    .object({
        id: identifierSchema,
        patientCaseId: identifierSchema,
        requestedByUserId: identifierSchema,
        providerModelId: identifierSchema,
        purposeOfUse: aiPurposeOfUseSchema,
        consentId: identifierSchema,
        // The exact policy/consent version consulted for THIS request,
        // frozen at creation time — a later policy edit or consent change
        // must never retroactively change what an already-decided request
        // is understood to have been authorized under.
        policySnapshotHash: sha256HexSchema,
        dataScope: aiDataScopeSchema,
        deidentificationApplied: z.boolean(),
        status: aiRequestStatusSchema,
        rejectionReason: z.string().max(2_000).optional(),
        createdAt: timestampSchema,
        // Time-limited envelope — item: "time-limited AI request envelope."
        expiresAt: timestampSchema,
        completedAt: timestampSchema.optional(),
    })
    .strict();
export type AiRequestEnvelope = z.infer<typeof aiRequestEnvelopeSchema>;

export const aiRequestInputSchema = z
    .object({
        id: identifierSchema,
        requestId: identifierSchema,
        resourceType: z.string().min(1).max(100),
        resourceId: identifierSchema,
        resourceVersionHash: sha256HexSchema.optional(),
        includedInPrompt: z.boolean(),
    })
    .strict();
export type AiRequestInput = z.infer<typeof aiRequestInputSchema>;

export const aiTransformationKindSchema = z.enum(["minimization", "redaction", "deidentification", "pseudonymization", "content-scan"]);

export const aiDataTransformationSchema = z
    .object({
        id: identifierSchema,
        requestId: identifierSchema,
        kind: aiTransformationKindSchema,
        appliedAt: timestampSchema,
        // Metadata about the transformation only — counts, categories
        // touched — never a second copy of the transformed content itself.
        details: z.record(z.string(), z.unknown()).optional(),
    })
    .strict();
export type AiDataTransformation = z.infer<typeof aiDataTransformationSchema>;

// --- Output (tenant-scoped) --------------------------------------------------

/**
 * Evidence, conclusion, uncertainty, and follow-up are separate fields, not
 * one blob of prose — item: "Separate evidence, generated conclusions,
 * uncertainty, and recommended follow-up." `summary` is the only free-text
 * "what the model concluded" field; there is deliberately no `reasoning`/
 * `chainOfThought` field anywhere in this schema.
 */
export const aiOutputSchema = z
    .object({
        id: identifierSchema,
        requestId: identifierSchema,
        providerModelId: identifierSchema,
        modelVersion: z.string().min(1).max(100),
        generatedAt: timestampSchema,
        summary: z.string().min(1).max(20_000),
        // The gateway's own system-prompt version (server/src/ai-gateway/
        // prompt-registry.ts), NOT the provider's modelVersion above — two
        // independent axes of "what produced this output." Required, not
        // optional: every output has always been generated from some
        // prompt text, this just makes which one an explicit, queryable
        // fact instead of an unrecorded implementation detail.
        promptVersion: z.string().min(1).max(100),
        evidence: z.array(z.string().max(2_000)).default([]),
        uncertainty: z.string().max(4_000).optional(),
        followUp: z.array(z.string().max(2_000)).default([]),
        abstained: z.boolean().default(false),
        abstainReason: z.string().max(2_000).optional(),
        confidence: z.number().min(0).max(1).optional(),
        outputHash: sha256HexSchema,
        // Never true by construction of this pipeline — a review record is
        // a separate resource (AiReview, below) created only by explicit
        // clinician action. Present here only as a read-optimization flag
        // the store keeps in sync, so a route never has to join to know
        // whether an output is still an unsigned draft.
        reviewStatus: z.enum(["unreviewed", "accepted", "rejected", "corrected", "escalated"]).default("unreviewed"),
    })
    .strict();
export type AiOutput = z.infer<typeof aiOutputSchema>;

export const aiCitationSchema = z
    .object({
        id: identifierSchema,
        outputId: identifierSchema,
        resourceType: z.string().min(1).max(100),
        resourceId: identifierSchema,
        resourceVersionHash: sha256HexSchema.optional(),
        // A pointer into the source (page/line/frame), never a re-copied
        // excerpt — a citation is re-verified against the live authorized
        // resource at read time (item: "reject citations the requesting
        // user cannot access"), not trusted from what was true when the
        // output was generated.
        locator: z.string().max(500).optional(),
    })
    .strict();
export type AiCitation = z.infer<typeof aiCitationSchema>;

// --- Human review / sign-off (tenant-scoped) --------------------------------

export const aiReviewDecisionSchema = z.enum(["accepted", "rejected", "corrected", "escalated"]);

export const aiReviewSchema = z
    .object({
        id: identifierSchema,
        outputId: identifierSchema,
        reviewedByUserId: identifierSchema,
        decision: aiReviewDecisionSchema,
        correctedText: z.string().max(20_000).optional(),
        escalationReason: z.string().max(2_000).optional(),
        reviewedAt: timestampSchema,
    })
    .strict()
    .refine((v) => v.decision !== "corrected" || v.correctedText !== undefined, { message: "a corrected review must include correctedText", path: ["correctedText"] })
    .refine((v) => v.decision !== "escalated" || v.escalationReason !== undefined, { message: "an escalated review must include escalationReason", path: ["escalationReason"] });
export type AiReview = z.infer<typeof aiReviewSchema>;

// --- Safety events (tenant-scoped) ------------------------------------------

export const aiSafetyEventKindSchema = z.enum([
    "prompt-injection-detected", "secret-detected", "unsupported-content-detected",
    "dlp-block", "abstained", "provider-failure", "consent-violation-blocked",
    "quota-exceeded", "kill-switch-blocked",
]);
export const aiSafetyEventSeveritySchema = z.enum(["info", "warning", "critical"]);

export const aiSafetyEventSchema = z
    .object({
        id: identifierSchema,
        requestId: identifierSchema.optional(),
        kind: aiSafetyEventKindSchema,
        severity: aiSafetyEventSeveritySchema,
        details: z.string().max(2_000).optional(),
        createdAt: timestampSchema,
    })
    .strict();
export type AiSafetyEvent = z.infer<typeof aiSafetyEventSchema>;

// --- Change feed (tenant-scoped, metadata-only) -----------------------------

export const aiGatewayChangeResourceSchema = z.enum(["request", "output", "review", "consent"]);

export const aiGatewayChangeSchema = z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("upsert"), resourceType: aiGatewayChangeResourceSchema, resourceId: identifierSchema, sequence: z.number().int().nonnegative(), occurredAt: timestampSchema }).strict(),
    z.object({ kind: z.literal("delete"), resourceType: aiGatewayChangeResourceSchema, resourceId: identifierSchema, sequence: z.number().int().nonnegative(), occurredAt: timestampSchema }).strict(),
]);
export type AiGatewayChange = z.infer<typeof aiGatewayChangeSchema>;

export const aiGatewayChangeFeedSchema = z.object({ changes: z.array(aiGatewayChangeSchema), cursor: z.string() }).strict();
export type AiGatewayChangeFeed = z.infer<typeof aiGatewayChangeFeedSchema>;
