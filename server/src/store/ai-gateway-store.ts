import type {
    AiCitation,
    AiConsent,
    AiDataScope,
    AiDataTransformation,
    AiGatewayChange,
    AiGatewayChangeFeed,
    AiOutput,
    AiProviderTenantSettings,
    AiRequestEnvelope,
    AiRequestInput,
    AiReview,
    AiSafetyEvent,
} from "@modelforge/contracts";
import type { TenantContext } from "../tenant-context.js";
import type { AuditActor } from "./audit-store.js";

/**
 * ClinicalAiGateway's tenant-scoped repository — one consolidated interface,
 * the same "one interface per domain" shape as store/imaging-store.ts, not
 * a dozen tiny stores (this domain has more sub-resource types than IAM
 * does, and splitting further would multiply deps.ts/app.ts/index.ts wiring
 * for no real isolation benefit — every sub-resource already lives in one
 * tenant schema together).
 *
 * Tenant-bound via `forTenant(context)`, mirroring case-store.ts's
 * TenantCaseRepository / imaging-store.ts's TenantImagingRepository exactly.
 *
 * The global provider/model catalog (ai-provider-registry-store.ts) is
 * deliberately NOT part of this interface — it is cross-tenant, PHI-free
 * control-plane data. Everything here is patient-linked and tenant-scoped.
 */

export interface CreateAiConsentInput {
    patientCaseId: string;
    purpose: AiConsent["purpose"];
    dataCategories: string[];
    grantedByUserId: string;
    expiresAt?: string;
}

export interface CreateAiRequestInput {
    patientCaseId: string;
    requestedByUserId: string;
    providerModelId: string;
    purposeOfUse: AiRequestEnvelope["purposeOfUse"];
    consentId: string;
    policySnapshotHash: string;
    dataScope: AiDataScope;
    deidentificationApplied?: boolean;
    expiresAt: string;
}

export interface CreateAiOutputInput {
    requestId: string;
    providerModelId: string;
    modelVersion: string;
    promptVersion: string;
    summary: string;
    evidence: string[];
    uncertainty?: string;
    followUp: string[];
    abstained: boolean;
    abstainReason?: string;
    confidence?: number;
    outputHash: string;
    citations: Array<{ resourceType: string; resourceId: string; resourceVersionHash?: string; locator?: string }>;
}

export interface TenantAiGatewayRepository {
    readonly context: TenantContext;

    // --- Per-tenant provider approval ---
    upsertProviderTenantSettings(
        input: Omit<AiProviderTenantSettings, "id" | "approvedAt">,
        actor: AuditActor
    ): Promise<AiProviderTenantSettings>;
    getProviderTenantSettings(providerModelId: string): Promise<AiProviderTenantSettings | null>;
    listProviderTenantSettings(): Promise<AiProviderTenantSettings[]>;

    // --- Consent ---
    createConsent(input: CreateAiConsentInput, actor: AuditActor): Promise<AiConsent>;
    getConsent(id: string): Promise<AiConsent | null>;
    /** The current (highest-version, non-superseded) consent for a case and
     * purpose — what an authorization check actually consults. */
    getActiveConsent(patientCaseId: string, purpose: AiConsent["purpose"]): Promise<AiConsent | null>;
    listConsentsForCase(patientCaseId: string): Promise<AiConsent[]>;
    /** Revocation must be immediately visible to getActiveConsent — "must
     * prevent new AI requests immediately." */
    revokeConsent(id: string, revokedByUserId: string, reason: string, actor: AuditActor): Promise<AiConsent | null>;
    /** Called opportunistically (e.g. before each authorization check) to
     * flip any consent whose expiresAt has passed to status "expired" —
     * never trust a cached "active" read past expiry. */
    expireStaleConsents(now: string): Promise<number>;

    // --- Request envelopes ---
    createRequest(input: CreateAiRequestInput, actor: AuditActor): Promise<AiRequestEnvelope>;
    getRequest(id: string): Promise<AiRequestEnvelope | null>;
    listRequestsForCase(patientCaseId: string): Promise<AiRequestEnvelope[]>;
    updateRequestStatus(
        id: string,
        status: AiRequestEnvelope["status"],
        extra: { rejectionReason?: string; completedAt?: string } | undefined,
        actor: AuditActor
    ): Promise<AiRequestEnvelope | null>;

    addRequestInputs(requestId: string, inputs: Array<Omit<AiRequestInput, "id" | "requestId">>): Promise<AiRequestInput[]>;
    listRequestInputs(requestId: string): Promise<AiRequestInput[]>;

    recordTransformation(input: Omit<AiDataTransformation, "id" | "appliedAt">): Promise<AiDataTransformation>;
    listTransformations(requestId: string): Promise<AiDataTransformation[]>;

    // --- Outputs, citations, review ---
    createOutput(input: CreateAiOutputInput, actor: AuditActor): Promise<{ output: AiOutput; citations: AiCitation[] }>;
    getOutput(id: string): Promise<AiOutput | null>;
    listOutputsForRequest(requestId: string): Promise<AiOutput[]>;
    /** Every output for one provider model across the whole tenant
     * (not scoped to a single case/request) — backs
     * eval-harness/production-monitor.ts's online quality snapshot.
     * `since`, when given, excludes outputs generated at or before that
     * ISO timestamp (an open lower bound, matching `readChanges`'s own
     * cursor convention elsewhere in this codebase). Ordered oldest-first,
     * same as listOutputsForRequest. */
    listOutputsForProviderModel(providerModelId: string, since?: string): Promise<AiOutput[]>;
    listCitationsForOutput(outputId: string): Promise<AiCitation[]>;

    /** Immutable — a review is a new row, never an edit of a prior one; an
     * output that already has a review is re-reviewed by creating another
     * row referencing the same output only if the store allows more than
     * one (this schema enforces UNIQUE(output_id): the FIRST review is
     * final, matching "never silently alter... a previous AI output" —
     * amendment is a new AiOutput + new AiRequest, not a mutated review). */
    createReview(input: Omit<AiReview, "id" | "reviewedAt">, actor: AuditActor): Promise<AiReview>;
    getReviewForOutput(outputId: string): Promise<AiReview | null>;

    recordSafetyEvent(input: Omit<AiSafetyEvent, "id" | "createdAt">, actor: AuditActor): Promise<AiSafetyEvent>;
    listSafetyEvents(filter?: { requestId?: string; severity?: AiSafetyEvent["severity"] }): Promise<AiSafetyEvent[]>;

    // --- Change feed (request/output/review/consent only — never prompt
    // or output text beyond what AiOutput.summary already is; the feed
    // carries the same resource rows a direct read would, metadata-first) ---
    readChanges(cursor: string | null): Promise<{ changes: Array<{ change: AiGatewayChange }>; cursor: string }>;
}

export interface AiGatewayStore {
    forTenant(context: TenantContext): TenantAiGatewayRepository;
}

export function publicAiGatewayFeed(changes: Array<{ change: AiGatewayChange }>, cursor: string): AiGatewayChangeFeed {
    return { changes: changes.map((c) => c.change), cursor };
}
