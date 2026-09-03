import { randomUUID } from "node:crypto";
import type {
    AiCitation,
    AiConsent,
    AiDataTransformation,
    AiGatewayChange,
    AiOutput,
    AiProviderTenantSettings,
    AiRequestEnvelope,
    AiRequestInput,
    AiReview,
    AiSafetyEvent,
} from "@modelforge/contracts";
import type { TenantContext } from "../tenant-context.js";
import { type AuditActor, type AuditStore, InMemoryAuditStore } from "./audit-store.js";
import type {
    AiGatewayStore,
    CreateAiConsentInput,
    CreateAiOutputInput,
    CreateAiRequestInput,
    TenantAiGatewayRepository,
} from "./ai-gateway-store.js";

interface OrgState {
    providerTenantSettings: Map<string, AiProviderTenantSettings>; // keyed by providerModelId
    consents: Map<string, AiConsent>;
    requests: Map<string, AiRequestEnvelope>;
    requestInputs: Map<string, AiRequestInput[]>; // keyed by requestId
    transformations: Map<string, AiDataTransformation[]>; // keyed by requestId
    outputs: Map<string, AiOutput>;
    outputsByRequest: Map<string, string[]>; // requestId -> outputId[]
    citations: Map<string, AiCitation[]>; // keyed by outputId
    reviews: Map<string, AiReview>; // keyed by outputId
    safetyEvents: AiSafetyEvent[];
    changes: Array<{ change: AiGatewayChange }>;
    nextSequence: bigint;
}

function emptyOrgState(): OrgState {
    return {
        providerTenantSettings: new Map(), consents: new Map(), requests: new Map(),
        requestInputs: new Map(), transformations: new Map(), outputs: new Map(),
        outputsByRequest: new Map(), citations: new Map(), reviews: new Map(),
        safetyEvents: [], changes: [], nextSequence: 1n,
    };
}

/** In-memory ClinicalAiGateway tenant repository — the default when
 * DATABASE_URL is unset, and what every non-Postgres-gated test exercises.
 * See ai-gateway-store.ts's own doc comment for the consolidated-interface
 * design rationale. */
export class InMemoryAiGatewayStore implements AiGatewayStore {
    private readonly orgs = new Map<string, OrgState>();

    constructor(private readonly auditStore: AuditStore = new InMemoryAuditStore()) {}

    private stateFor(organizationId: string): OrgState {
        let state = this.orgs.get(organizationId);
        if (!state) {
            state = emptyOrgState();
            this.orgs.set(organizationId, state);
        }
        return state;
    }

    forTenant(context: TenantContext): TenantAiGatewayRepository {
        const state = this.stateFor(context.organizationId);
        const auditStore = this.auditStore;
        const organizationId = context.organizationId;

        function recordChange(kind: "upsert" | "delete", resourceType: AiGatewayChange["resourceType"], resourceId: string): void {
            const sequence = state.nextSequence;
            state.nextSequence += 1n;
            state.changes.push({ change: { kind, resourceType, resourceId, sequence: Number(sequence), occurredAt: new Date().toISOString() } });
        }

        return {
            context,

            async upsertProviderTenantSettings(input, actor) {
                const existing = state.providerTenantSettings.get(input.providerModelId);
                const settings: AiProviderTenantSettings = { id: existing?.id ?? randomUUID(), approvedAt: new Date().toISOString(), ...input };
                state.providerTenantSettings.set(input.providerModelId, settings);
                await auditStore.record({ organizationId, actorUserId: actor.userId, actorExternalSubject: actor.externalSubject, action: "aiProviderTenantSettings.upsert", targetType: "aiProviderTenantSettings", targetId: settings.id, details: { providerModelId: input.providerModelId, enabled: input.enabled, phiAllowed: input.phiAllowed } });
                return settings;
            },
            async getProviderTenantSettings(providerModelId) {
                return state.providerTenantSettings.get(providerModelId) ?? null;
            },
            async listProviderTenantSettings() {
                return [...state.providerTenantSettings.values()];
            },

            async createConsent(input: CreateAiConsentInput, actor) {
                const existingForCase = [...state.consents.values()].filter((c) => c.patientCaseId === input.patientCaseId);
                const version = existingForCase.reduce((max, c) => Math.max(max, c.version), 0) + 1;
                const id = randomUUID();
                const consent: AiConsent = {
                    id, patientCaseId: input.patientCaseId, version, purpose: input.purpose,
                    dataCategories: input.dataCategories, status: "active",
                    grantedByUserId: input.grantedByUserId, grantedAt: new Date().toISOString(),
                    expiresAt: input.expiresAt,
                };
                state.consents.set(id, consent);
                recordChange("upsert", "consent", id);
                await auditStore.record({ organizationId, actorUserId: actor.userId, actorExternalSubject: actor.externalSubject, action: "aiConsent.create", targetType: "aiConsent", targetId: id, details: { patientCaseId: input.patientCaseId, purpose: input.purpose, version } });
                return consent;
            },
            async getConsent(id) {
                return state.consents.get(id) ?? null;
            },
            async getActiveConsent(patientCaseId, purpose) {
                const now = new Date().toISOString();
                const candidates = [...state.consents.values()]
                    .filter((c) => c.patientCaseId === patientCaseId && c.purpose === purpose && c.status === "active" && (!c.expiresAt || c.expiresAt > now))
                    .sort((a, b) => b.version - a.version);
                return candidates[0] ?? null;
            },
            async listConsentsForCase(patientCaseId) {
                return [...state.consents.values()].filter((c) => c.patientCaseId === patientCaseId).sort((a, b) => b.version - a.version);
            },
            async revokeConsent(id, revokedByUserId, reason, actor) {
                const existing = state.consents.get(id);
                if (!existing || existing.status === "revoked") return existing ?? null;
                const updated: AiConsent = { ...existing, status: "revoked", revokedByUserId, revokedAt: new Date().toISOString(), revokedReason: reason };
                state.consents.set(id, updated);
                recordChange("upsert", "consent", id);
                await auditStore.record({ organizationId, actorUserId: actor.userId, actorExternalSubject: actor.externalSubject, action: "aiConsent.revoke", targetType: "aiConsent", targetId: id, details: { reason } });
                return updated;
            },
            async expireStaleConsents(now) {
                let count = 0;
                for (const [id, consent] of state.consents) {
                    if (consent.status === "active" && consent.expiresAt && consent.expiresAt <= now) {
                        state.consents.set(id, { ...consent, status: "expired" });
                        recordChange("upsert", "consent", id);
                        count++;
                    }
                }
                return count;
            },

            async createRequest(input: CreateAiRequestInput, actor) {
                const id = randomUUID();
                const request: AiRequestEnvelope = {
                    id, patientCaseId: input.patientCaseId, requestedByUserId: input.requestedByUserId,
                    providerModelId: input.providerModelId, purposeOfUse: input.purposeOfUse, consentId: input.consentId,
                    policySnapshotHash: input.policySnapshotHash, dataScope: input.dataScope,
                    deidentificationApplied: input.deidentificationApplied ?? false, status: "draft",
                    createdAt: new Date().toISOString(), expiresAt: input.expiresAt,
                };
                state.requests.set(id, request);
                recordChange("upsert", "request", id);
                await auditStore.record({ organizationId, actorUserId: actor.userId, actorExternalSubject: actor.externalSubject, action: "aiRequest.create", targetType: "aiRequest", targetId: id, details: { patientCaseId: input.patientCaseId, providerModelId: input.providerModelId, purposeOfUse: input.purposeOfUse } });
                return request;
            },
            async getRequest(id) {
                return state.requests.get(id) ?? null;
            },
            async listRequestsForCase(patientCaseId) {
                return [...state.requests.values()].filter((r) => r.patientCaseId === patientCaseId).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
            },
            async updateRequestStatus(id, status, extra, actor) {
                const existing = state.requests.get(id);
                if (!existing) return null;
                const updated: AiRequestEnvelope = { ...existing, status, rejectionReason: extra?.rejectionReason ?? existing.rejectionReason, completedAt: extra?.completedAt ?? existing.completedAt };
                state.requests.set(id, updated);
                recordChange("upsert", "request", id);
                await auditStore.record({ organizationId, actorUserId: actor.userId, actorExternalSubject: actor.externalSubject, action: "aiRequest.statusChange", targetType: "aiRequest", targetId: id, details: { status } });
                return updated;
            },

            async addRequestInputs(requestId, inputs) {
                const created = inputs.map((input) => ({ id: randomUUID(), requestId, ...input }));
                const existing = state.requestInputs.get(requestId) ?? [];
                state.requestInputs.set(requestId, [...existing, ...created]);
                return created;
            },
            async listRequestInputs(requestId) {
                return state.requestInputs.get(requestId) ?? [];
            },

            async recordTransformation(input) {
                const transformation: AiDataTransformation = { id: randomUUID(), appliedAt: new Date().toISOString(), ...input };
                const existing = state.transformations.get(input.requestId) ?? [];
                state.transformations.set(input.requestId, [...existing, transformation]);
                return transformation;
            },
            async listTransformations(requestId) {
                return state.transformations.get(requestId) ?? [];
            },

            async createOutput(input: CreateAiOutputInput, actor) {
                const id = randomUUID();
                const output: AiOutput = {
                    id, requestId: input.requestId, providerModelId: input.providerModelId, modelVersion: input.modelVersion, promptVersion: input.promptVersion,
                    generatedAt: new Date().toISOString(), summary: input.summary, evidence: input.evidence,
                    uncertainty: input.uncertainty, followUp: input.followUp, abstained: input.abstained,
                    abstainReason: input.abstainReason, confidence: input.confidence, outputHash: input.outputHash,
                    reviewStatus: "unreviewed",
                };
                state.outputs.set(id, output);
                const forRequest = state.outputsByRequest.get(input.requestId) ?? [];
                state.outputsByRequest.set(input.requestId, [...forRequest, id]);
                const citations = input.citations.map((c) => ({ id: randomUUID(), outputId: id, ...c }));
                state.citations.set(id, citations);
                recordChange("upsert", "output", id);
                await auditStore.record({ organizationId, actorUserId: actor.userId, actorExternalSubject: actor.externalSubject, action: "aiOutput.create", targetType: "aiOutput", targetId: id, details: { requestId: input.requestId, abstained: input.abstained, citationCount: citations.length } });
                return { output, citations };
            },
            async getOutput(id) {
                return state.outputs.get(id) ?? null;
            },
            async listOutputsForRequest(requestId) {
                const ids = state.outputsByRequest.get(requestId) ?? [];
                return ids.map((id) => state.outputs.get(id)).filter((o): o is AiOutput => o !== undefined);
            },
            async listOutputsForProviderModel(providerModelId, since) {
                return [...state.outputs.values()]
                    .filter((o) => o.providerModelId === providerModelId && (!since || o.generatedAt > since))
                    .sort((a, b) => a.generatedAt.localeCompare(b.generatedAt) || a.id.localeCompare(b.id));
            },
            async listCitationsForOutput(outputId) {
                return state.citations.get(outputId) ?? [];
            },

            async createReview(input, actor) {
                if (state.reviews.has(input.outputId)) {
                    throw new Error(`Output ${input.outputId} already has a review — reviews are immutable; create a new output/request to amend.`);
                }
                const review: AiReview = { id: randomUUID(), reviewedAt: new Date().toISOString(), ...input };
                state.reviews.set(input.outputId, review);
                const output = state.outputs.get(input.outputId);
                if (output) state.outputs.set(input.outputId, { ...output, reviewStatus: input.decision });
                recordChange("upsert", "review", review.id);
                await auditStore.record({ organizationId, actorUserId: actor.userId, actorExternalSubject: actor.externalSubject, action: "aiReview.create", targetType: "aiReview", targetId: review.id, details: { outputId: input.outputId, decision: input.decision } });
                return review;
            },
            async getReviewForOutput(outputId) {
                return state.reviews.get(outputId) ?? null;
            },

            async recordSafetyEvent(input, actor) {
                const event: AiSafetyEvent = { id: randomUUID(), createdAt: new Date().toISOString(), ...input };
                state.safetyEvents.push(event);
                await auditStore.record({ organizationId, actorUserId: actor.userId, actorExternalSubject: actor.externalSubject, action: "aiSafetyEvent.record", targetType: "aiSafetyEvent", targetId: event.id, details: { kind: input.kind, severity: input.severity, requestId: input.requestId } });
                return event;
            },
            async listSafetyEvents(filter) {
                return state.safetyEvents.filter((e) => (!filter?.requestId || e.requestId === filter.requestId) && (!filter?.severity || e.severity === filter.severity));
            },

            async readChanges(cursor) {
                const since = cursor ? BigInt(cursor) : 0n;
                const changes = state.changes.filter((c) => BigInt(c.change.sequence) > since);
                const nextCursor = (state.nextSequence - 1n).toString();
                return { changes, cursor: nextCursor };
            },
        };
    }
}
