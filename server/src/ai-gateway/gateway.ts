import { createHash } from "node:crypto";
import type {
    AiCitation,
    AiConsent,
    AiDataScope,
    AiOutput,
    AiProvider,
    AiProviderModel,
    AiRequestEnvelope,
    AiReview,
    PatientCase,
} from "@modelforge/contracts";
import type { AuditActor } from "../store/audit-store.js";
import type { TenantCaseRepository } from "../store/case-store.js";
import type { TenantAiGatewayRepository } from "../store/ai-gateway-store.js";
import type { AiProviderRegistryStore } from "../store/ai-provider-registry-store.js";
import { evaluateGatewayAuthorization, type GatewayAuthorizationDenialReason } from "./policy.js";
import { scanForUnsafeContent, type ContentScanFinding } from "./content-scanner.js";
import { minimizeForTask } from "./data-minimization.js";
import { AiAdmissionError, type AiAdmissionDecisionStatus, type AiAdmissionPriority, type AiInferenceAdmission } from "./admission.js";
import type { AiProviderClient } from "./provider-client.js";
import { validateModelResponse } from "./response-validation.js";

/**
 * ClinicalAiGateway — the sole path by which patient data reaches an AI
 * model and a model's output reaches a clinician. This class implements the
 * full 15-step lifecycle from docs/CLINICAL_AI_GATEWAY.md end to end:
 *
 *  1. select scope        -> the caller's own SubmitAiRequestInput
 *  2. preview              -> previewRequest() (read-only, no side effects)
 *  3-4. authorize/validate -> policy.ts's evaluateGatewayAuthorization,
 *                             fed real consent/provider/model/tenant rows
 *  5. minimize             -> data-minimization.ts's minimizeForTask
 *  6. redact/de-identify   -> folded into step 5 (minimizeForTask redacts
 *                             every section it builds before this class ever
 *                             sees the text — see that module's own comment)
 *  7. scan                 -> content-scanner.ts's scanForUnsafeContent
 *  8. create envelope      -> gatewayRepo.createRequest (time-limited via
 *                             `expiresAt`, tenant-bound via gatewayRepo's own
 *                             TenantContext)
 *  9. schedule             -> admission.ts's AiInferenceAdmission
 * 10. validate/normalize   -> response-validation.ts's validateModelResponse
 * 11. safety/DLP checks    -> folded into step 10 (validateModelResponse
 *                             re-scans the OUTPUT) plus recordSafetyEvent
 * 12. present as draft     -> gatewayRepo.createOutput (AiOutput.reviewStatus
 *                             defaults to "unreviewed" — never auto-accepted)
 * 13. record clinician decision -> recordReview() (a separate call, since a
 *                             clinician reviews a draft after it exists, not
 *                             synchronously with generation)
 * 14. provenance/audit     -> every store call above takes an AuditActor and
 *                             writes its own audit row; recordTransformation
 *                             captures step 5-7 metadata against the request
 * 15. delete transient data -> see runMaintenanceSweep()'s own doc comment;
 *                             there is no separate "transient prompt buffer"
 *                             to delete because this pipeline never persists
 *                             raw prompt/output text anywhere outside the
 *                             structured AiOutput fields it is supposed to
 *                             end up in (item: "never store raw prompts or
 *                             outputs in ordinary logs")
 *
 * Disclosed gaps in this pass (not faked, not silently skipped):
 *  - No idempotency-key deduplication or automatic retry/backoff on provider
 *    failure yet — a caller that times out and resubmits will create a
 *    second, independent AiRequestEnvelope. Adding real dedup needs an
 *    `idempotencyKey` column on `ai_requests` (migration 018 does not have
 *    one); tracked as a follow-up, not implemented here to avoid a schema
 *    change late in this pass.
 *  - No streaming — see provider-client.ts's own disclosure.
 *  - Citation re-authorization at *read* time ("reject citations the
 *    requesting user cannot access") is a route-layer responsibility against
 *    the live case/imaging authorization state, not something this class
 *    does at generation time — not yet implemented since no HTTP routes
 *    exist yet in this pass.
 *  - No imaging/DICOM-scoped requests yet — this class only ever pulls
 *    `PatientCase` scalar/note fields through data-minimization.ts; wiring
 *    `TenantImagingRepository`/`deidentifyStudy()` into a request's data
 *    scope is a separate, not-yet-done step.
 *  - No tenant-safe RAG/retrieval integration — there is no vector index in
 *    this codebase to retrieve from yet (confirmed absent during the
 *    architecture survey for this phase).
 */

const SYSTEM_PROMPT = `You are a clinical decision-support assistant. You are NOT a diagnostic device and your output is never a final medical decision. Every response you produce will be shown to a licensed clinician as an unsigned draft for their review — it must never be presented to a patient directly, and it never modifies, signs, or submits any medical record on its own.

Respond using EXACTLY this structure, with no other section headers:
SUMMARY: <one concise, clinically useful conclusion, or "N/A" if abstaining>
EVIDENCE:
- <one bullet per specific supporting fact, referencing only the clinical data provided below>
UNCERTAINTY: <what is uncertain or missing, if anything>
FOLLOWUP:
- <one bullet per recommended next step for the clinician to consider>
ABSTAIN: <present ONLY if the provided data is insufficient, contradictory, or outside your scope — explain why you cannot safely draw a conclusion>

Never include your reasoning process, chain-of-thought, or private deliberation — only the concise sections above. Never invent facts not present in the clinical data provided. If the data is insufficient, contradictory, or you are not confident, use the ABSTAIN section rather than guessing.`;

/** Default admission-queue priority per clinical purpose of use — item:
 * "priority for active clinician workflows... preemption of background
 * jobs." A caller may override via `SubmitAiRequestInput.admissionPriority`
 * (e.g. an imaging-scoped request explicitly using the "imaging-inference"
 * queue once that integration exists); this is only the sensible default. */
const DEFAULT_ADMISSION_PRIORITY: Record<string, AiAdmissionPriority> = {
    "diagnostic-support": "interactive",
    "medication-review": "interactive",
    "documentation-assist": "interactive",
    summarization: "background-summary",
    research: "background-summary",
    teaching: "background-summary",
    "quality-improvement": "background-summary",
};

const CONSENT_PURPOSE_FOR: Record<string, AiConsent["purpose"]> = {
    "diagnostic-support": "treatment",
    "medication-review": "treatment",
    "documentation-assist": "treatment",
    summarization: "treatment",
    research: "research",
    teaching: "teaching",
    "quality-improvement": "quality-improvement",
};

const IMAGING_ALLOWED_PURPOSES = new Set<AiRequestEnvelope["purposeOfUse"]>(["diagnostic-support", "teaching"]);

/** The case's own coarse, pre-existing consent scope (packages/contracts's
 * caseConsentSchema) — the cheap first gate `policy.ts` calls
 * `caseHasAiConsentScope`. A fully "local" provider (the model never leaves
 * this deployment's own infrastructure) only needs the general
 * "ai-assistance" scope; every other provider kind additionally needs the
 * case's own explicit "remote-model-use" scope, since data is leaving the
 * local environment regardless of what any AiConsent record separately
 * says. */
function caseHasRequiredConsentScope(patientCase: PatientCase, providerKind: AiProvider["kind"]): boolean {
    const hasActiveScope = (scope: string): boolean => patientCase.consentRecords.some((record) => record.scope === scope && record.revokedAt === undefined);
    if (!hasActiveScope("ai-assistance")) return false;
    if (providerKind !== "local" && !hasActiveScope("remote-model-use")) return false;
    return true;
}

export interface SubmitAiRequestInput {
    patientCaseId: string;
    requestedByUserId: string;
    callerRoles: string[];
    providerModelId: string;
    purposeOfUse: AiRequestEnvelope["purposeOfUse"];
    /** The user's own explicit selection from the pre-flight sharing UI —
     * see data-minimization.ts's own doc comment on why this can only ever
     * narrow, never widen, what the purpose's task allowlist permits. */
    requestedCategories: string[];
    /** Already-authorized, already-de-identified imaging manifests. The
     * route resolves these from reviewed jobs and deliberately supplies no
     * DICOM bytes, patient identifiers, object keys, or access tokens. */
    imagingSelections?: Array<{
        studyId: string;
        deidentificationJobId: string;
        artifactIds: string[];
        safeSummary: string;
    }>;
    admissionPriority?: AiAdmissionPriority;
    maxTokens?: number;
}

export interface RequestPreview {
    patientCaseId: string;
    purposeOfUse: string;
    dataCategories: string[];
    resourceCount: number;
    /** See submitRequest's own comment on why this is a conservative
     * "any free-text clinical content selected at all" signal, never a
     * claim that redaction already stripped every identifier. */
    includesIdentifiers: boolean;
    provider: { id: string; name: string; kind: AiProvider["kind"] } | null;
    model: { id: string; modelId: string; modelVersion: string; hostingRegion: string; processingLocation: string } | null;
}

export type GatewaySubmitResult =
    | { outcome: "case-not-found" }
    | { outcome: "authorization-denied"; reason: GatewayAuthorizationDenialReason; message: string }
    | { outcome: "content-blocked"; findings: ContentScanFinding[] }
    | { outcome: "admission-rejected"; status: AiAdmissionDecisionStatus; reasons: string[] }
    | { outcome: "provider-failed"; message: string }
    | { outcome: "completed"; request: AiRequestEnvelope; output: AiOutput; citations: AiCitation[] };

export interface ClinicalAiGatewayDeps {
    caseRepo: TenantCaseRepository;
    gatewayRepo: TenantAiGatewayRepository;
    registry: AiProviderRegistryStore;
    admission: AiInferenceAdmission;
    resolveProviderClient: (provider: AiProvider, providerModel: AiProviderModel) => AiProviderClient | Promise<AiProviderClient>;
    now?: () => Date;
    /** Defaults to 15 minutes — item: "create a tenant-bound, time-limited
     * AI request envelope." */
    requestTtlMs?: number;
}

export class ClinicalAiGateway {
    private readonly now: () => Date;
    private readonly requestTtlMs: number;

    constructor(private readonly deps: ClinicalAiGatewayDeps) {
        this.now = deps.now ?? (() => new Date());
        this.requestTtlMs = deps.requestTtlMs ?? 15 * 60 * 1_000;
    }

    /** Lifecycle steps 1-2: read-only, no consent/policy/admission side
     * effects at all — exactly what a pre-flight sharing-confirmation UI
     * calls before the user clicks "share." */
    async previewRequest(input: SubmitAiRequestInput): Promise<RequestPreview | null> {
        const caseRecord = await this.deps.caseRepo.getOne(input.patientCaseId);
        if (!caseRecord) return null;

        const providerModel = await this.deps.registry.getProviderModel(input.providerModelId);
        const provider = providerModel ? await this.deps.registry.getProvider(providerModel.providerId) : null;
        const minimized = minimizeForTask(caseRecord.patientCase, input.purposeOfUse, input.requestedCategories);
        const imaging = input.requestedCategories.includes("imagingStudies") && IMAGING_ALLOWED_PURPOSES.has(input.purposeOfUse) ? input.imagingSelections ?? [] : [];

        return {
            patientCaseId: input.patientCaseId,
            purposeOfUse: input.purposeOfUse,
            dataCategories: [...new Set([...minimized.includedCategories, ...(imaging.length ? ["imagingStudies"] : [])])],
            resourceCount: minimized.resourceRefs.length + imaging.length,
            includesIdentifiers: minimized.sections.length > 0,
            provider: provider ? { id: provider.id, name: provider.name, kind: provider.kind } : null,
            model: providerModel
                ? { id: providerModel.id, modelId: providerModel.modelId, modelVersion: providerModel.modelVersion, hostingRegion: providerModel.hostingRegion, processingLocation: providerModel.processingLocation }
                : null,
        };
    }

    /** Lifecycle steps 3-14: the real, side-effecting request lifecycle.
     * Every early return corresponds to one governance or safety gate
     * failing closed — none of them proceed to invoke a provider. */
    async submitRequest(input: SubmitAiRequestInput, actor: AuditActor): Promise<GatewaySubmitResult> {
        const caseRecord = await this.deps.caseRepo.getOne(input.patientCaseId);
        if (!caseRecord) return { outcome: "case-not-found" };
        const patientCase = caseRecord.patientCase;

        const providerModel = await this.deps.registry.getProviderModel(input.providerModelId);
        const provider = providerModel ? await this.deps.registry.getProvider(providerModel.providerId) : null;

        // Steps 5-6: minimize to exactly what this purpose of use allows,
        // redacting identifiers as part of the same pass.
        const minimized = minimizeForTask(patientCase, input.purposeOfUse, input.requestedCategories);
        const imaging = input.requestedCategories.includes("imagingStudies") && IMAGING_ALLOWED_PURPOSES.has(input.purposeOfUse) ? input.imagingSelections ?? [] : [];
        if (imaging.length > 0) {
            for (const selected of imaging) minimized.sections.push({ category: "imagingStudies", text: selected.safeSummary });
            minimized.includedCategories = [...new Set([...minimized.includedCategories, "imagingStudies"])];
            minimized.resourceRefs.push(...imaging.map((selected) => ({ resourceType: "imagingStudy", resourceId: selected.studyId })));
        }
        // Conservative by design: pattern-based redaction is best-effort
        // (redaction.ts's own disclosure) and free-text clinical narrative
        // can carry identifiers no pattern recognizes. Rather than let a
        // redaction pass silently downgrade a request to "de-identified,"
        // any request that selected data at all is treated as carrying
        // identifiers — item: "never imply automated de-identification
        // guarantees anonymity." An empty selection is the only case
        // honestly reported as not including identifiers.
        const includesIdentifiers = minimized.sections.length > 0;
        const dataScope: AiDataScope = { dataCategories: minimized.includedCategories, resourceRefs: minimized.resourceRefs, includesIdentifiers };

        // Steps 3-4: authorize against real consent/provider/model/tenant
        // state. Opportunistically expire stale consents first so a
        // just-passed expiry is honored on this very check, not on some
        // later background sweep — item: "revocation must prevent new AI
        // requests immediately."
        await this.deps.gatewayRepo.expireStaleConsents(this.now().toISOString());
        const consentPurpose = CONSENT_PURPOSE_FOR[input.purposeOfUse] ?? "treatment";
        const consent = await this.deps.gatewayRepo.getActiveConsent(input.patientCaseId, consentPurpose);
        const tenantSettings = providerModel ? await this.deps.gatewayRepo.getProviderTenantSettings(providerModel.id) : null;
        const caseConsentOk = provider ? caseHasRequiredConsentScope(patientCase, provider.kind) : false;

        const authz = evaluateGatewayAuthorization({
            purposeOfUse: input.purposeOfUse,
            consentPurpose,
            dataCategories: dataScope.dataCategories,
            includesIdentifiers,
            callerRoles: input.callerRoles,
            caseHasAiConsentScope: caseConsentOk,
            consent,
            provider,
            providerModel,
            tenantSettings,
        });
        if (!authz.allowed) {
            await this.deps.gatewayRepo.recordSafetyEvent({ kind: "consent-violation-blocked", severity: "warning", details: `${authz.reason}: ${authz.message}`.slice(0, 2_000) }, actor);
            return { outcome: "authorization-denied", reason: authz.reason, message: authz.message };
        }

        // Step 7: scan the minimized, redacted content before it ever
        // leaves this process.
        const combinedText = minimized.sections.map((section) => section.text).join("\n\n");
        const scan = scanForUnsafeContent(combinedText);
        if (!scan.safe) {
            const primaryKind = scan.findings[0].kind;
            await this.deps.gatewayRepo.recordSafetyEvent(
                {
                    kind: primaryKind === "secret" ? "secret-detected" : primaryKind === "prompt-injection" ? "prompt-injection-detected" : "unsupported-content-detected",
                    severity: "critical",
                    details: scan.findings.map((f) => f.pattern).join(", ").slice(0, 2_000),
                },
                actor
            );
            return { outcome: "content-blocked", findings: scan.findings };
        }

        // Step 8: create the tenant-bound, time-limited request envelope.
        const expiresAt = new Date(this.now().getTime() + this.requestTtlMs).toISOString();
        const policySnapshotHash = createHash("sha256")
            .update(
                JSON.stringify({
                    consentId: authz.consent.id,
                    consentVersion: authz.consent.version,
                    providerId: authz.provider.id,
                    providerModelId: authz.providerModel.id,
                    providerModelVersion: authz.providerModel.modelVersion,
                    tenantSettingsId: authz.tenantSettings.id,
                    effectivePhiPermitted: authz.effectivePhiPermitted,
                })
            )
            .digest("hex");

        const request = await this.deps.gatewayRepo.createRequest(
            {
                patientCaseId: input.patientCaseId,
                requestedByUserId: input.requestedByUserId,
                providerModelId: authz.providerModel.id,
                purposeOfUse: input.purposeOfUse,
                consentId: authz.consent.id,
                policySnapshotHash,
                dataScope,
                deidentificationApplied: imaging.length > 0,
                expiresAt,
            },
            actor
        );

        if (dataScope.resourceRefs.length > 0) {
            await this.deps.gatewayRepo.addRequestInputs(
                request.id,
                dataScope.resourceRefs.map((ref) => ({ resourceType: ref.resourceType, resourceId: ref.resourceId, includedInPrompt: true }))
            );
        }
        await this.deps.gatewayRepo.recordTransformation({ requestId: request.id, kind: "minimization", details: { includedCategories: dataScope.dataCategories } });
        await this.deps.gatewayRepo.recordTransformation({ requestId: request.id, kind: "redaction", details: {} });
        if (imaging.length > 0) {
            await this.deps.gatewayRepo.recordTransformation({ requestId: request.id, kind: "deidentification", details: { studyCount: imaging.length, artifactCount: imaging.reduce((count, item) => count + item.artifactIds.length, 0), jobIds: imaging.map((item) => item.deidentificationJobId) } });
        }
        await this.deps.gatewayRepo.recordTransformation({ requestId: request.id, kind: "content-scan", details: { safe: true } });
        await this.deps.gatewayRepo.updateRequestStatus(request.id, "queued", undefined, actor);

        // Step 9: schedule the actual inference call under tenant-aware
        // admission control.
        const priority = input.admissionPriority ?? DEFAULT_ADMISSION_PRIORITY[input.purposeOfUse] ?? "background-summary";
        let invocation;
        try {
            invocation = await this.deps.admission.withLease(
                {
                    requestId: request.id,
                    organizationId: this.deps.gatewayRepo.context.organizationId,
                    priority,
                    requirements: { cpuThreads: authz.providerModel.cpuThreads, ramMB: authz.providerModel.ramMB, vramMB: authz.providerModel.vramMB },
                },
                async () => {
                    await this.deps.gatewayRepo.updateRequestStatus(request.id, "running", undefined, actor);
                    const client = await this.deps.resolveProviderClient(authz.provider, authz.providerModel);
                    return client.invoke({ systemPrompt: SYSTEM_PROMPT, sections: minimized.sections, purposeOfUse: input.purposeOfUse, maxTokens: input.maxTokens });
                }
            );
        } catch (err) {
            if (err instanceof AiAdmissionError) {
                await this.deps.gatewayRepo.updateRequestStatus(request.id, "failed", { rejectionReason: err.message.slice(0, 2_000) }, actor);
                return { outcome: "admission-rejected", status: err.status, reasons: err.reasons };
            }
            const message = err instanceof Error ? err.message : "Unknown provider error";
            await this.deps.gatewayRepo.updateRequestStatus(request.id, "failed", { rejectionReason: message.slice(0, 2_000) }, actor);
            await this.deps.gatewayRepo.recordSafetyEvent({ requestId: request.id, kind: "provider-failure", severity: "critical", details: message.slice(0, 2_000) }, actor);
            return { outcome: "provider-failed", message };
        }

        // Steps 10-11: parse/validate the response and re-run the same
        // content scan against the OUTPUT — response-validation.ts folds
        // both together and never lets flagged content pass through.
        const validated = validateModelResponse(invocation.rawText);
        if (validated.outputFlagged) {
            await this.deps.gatewayRepo.recordSafetyEvent({ requestId: request.id, kind: "dlp-block", severity: "critical", details: validated.outputFlagReasons.join(", ").slice(0, 2_000) }, actor);
        }
        if (validated.abstained) {
            await this.deps.gatewayRepo.recordSafetyEvent({ requestId: request.id, kind: "abstained", severity: "info", details: validated.abstainReason?.slice(0, 2_000) }, actor);
        }

        // Step 12: persist as an unsigned draft — AiOutput.reviewStatus
        // defaults to "unreviewed" at the schema layer; nothing here ever
        // marks it accepted/signed.
        const { output, citations } = await this.deps.gatewayRepo.createOutput(
            {
                requestId: request.id,
                providerModelId: authz.providerModel.id,
                modelVersion: invocation.modelVersion,
                summary: validated.summary,
                evidence: validated.evidence,
                uncertainty: validated.uncertainty,
                followUp: validated.followUp,
                abstained: validated.abstained,
                abstainReason: validated.abstainReason,
                outputHash: validated.outputHash,
                citations: dataScope.resourceRefs.map((ref) => ({ resourceType: ref.resourceType, resourceId: ref.resourceId })),
            },
            actor
        );

        const completedRequest = await this.deps.gatewayRepo.updateRequestStatus(request.id, "awaiting-review", { completedAt: this.now().toISOString() }, actor);

        return { outcome: "completed", request: completedRequest ?? request, output, citations };
    }

    /** Lifecycle step 13: a clinician's accept/reject/correct/escalate
     * decision on a draft output — always a NEW row (createReview throws on
     * a duplicate; see ai-gateway-store.ts's own doc comment), never an
     * edit of a previous decision or of the AiOutput itself. */
    async recordReview(
        input: { outputId: string; reviewedByUserId: string; decision: AiReview["decision"]; correctedText?: string; escalationReason?: string },
        actor: AuditActor
    ): Promise<AiReview> {
        const review = await this.deps.gatewayRepo.createReview(
            { outputId: input.outputId, reviewedByUserId: input.reviewedByUserId, decision: input.decision, correctedText: input.correctedText, escalationReason: input.escalationReason },
            actor
        );

        const output = await this.deps.gatewayRepo.getOutput(input.outputId);
        if (output) {
            const statusForDecision: Record<AiReview["decision"], AiRequestEnvelope["status"]> = {
                accepted: "accepted",
                rejected: "rejected",
                corrected: "corrected",
                escalated: "escalated",
            };
            await this.deps.gatewayRepo.updateRequestStatus(output.requestId, statusForDecision[input.decision], undefined, actor);
        }
        return review;
    }

    /**
     * Lifecycle step 15, and the crash-safety net for step 9. There is no
     * separate "transient data" buffer to purge — this class never persists
     * raw prompt or output text anywhere except the structured `AiOutput`
     * fields that are supposed to hold it, so "delete transient data per
     * retention policy" is satisfied by construction, not by a cleanup job.
     * What this DOES do: propagate consent expiry into `getActiveConsent`
     * immediately (so a lapsed consent can never authorize a new request),
     * and reclaim any admission lease whose caller crashed mid-inference
     * without releasing it. Intended to run on a periodic timer wired in
     * server/src/index.ts; not self-scheduling.
     */
    async runMaintenanceSweep(): Promise<{ expiredConsents: number; reclaimedLeaseIds: string[] }> {
        const expiredConsents = await this.deps.gatewayRepo.expireStaleConsents(this.now().toISOString());
        const reclaimedLeaseIds = this.deps.admission.sweepExpired();
        return { expiredConsents, reclaimedLeaseIds };
    }
}
