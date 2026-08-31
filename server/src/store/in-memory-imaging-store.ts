import { randomUUID } from "node:crypto";
import type {
    DeidentificationJob,
    DerivedArtifact,
    DiagnosticReport,
    DocumentReference,
    ImagingAnnotation,
    ImagingChange,
    ImagingIngestionJob,
    ImagingPatientIdentifier,
    ImagingResourceAttributes,
    ImagingShareGrant,
    ImagingStudy,
    ProvenanceRecord,
    ViewerSession,
} from "@modelforge/contracts";
import type { TenantContext } from "../tenant-context.js";
import { type AuditActor, type AuditStore, InMemoryAuditStore } from "./audit-store.js";
import type {
    CreateDerivedArtifactInput,
    CreateStudyInput,
    ImagingSeriesRecord,
    ImagingStore,
    InternalDerivedArtifact,
    InternalImagingInstance,
    StoredImagingChange,
    StoredImagingStudy,
    TenantImagingRepository,
} from "./imaging-store.js";

interface OrgState {
    studies: Map<string, StoredImagingStudy>;
    series: Map<string, ImagingSeriesRecord>;
    instances: Map<string, InternalImagingInstance>;
    reports: Map<string, DiagnosticReport>;
    annotations: Map<string, ImagingAnnotation>;
    provenance: Map<string, ProvenanceRecord>;
    derivedArtifacts: Map<string, InternalDerivedArtifact>;
    shareGrants: Map<string, ImagingShareGrant & { externalTokenHash?: string; externalVerificationCodeHash?: string }>;
    ingestionJobs: Map<string, ImagingIngestionJob>;
    viewerSessions: Map<string, ViewerSession & { tokenHash: string }>;
    deidentificationJobs: Map<string, DeidentificationJob>;
    documentReferences: Map<string, DocumentReference & { objectStorageKey: string }>;
    changes: StoredImagingChange[];
    nextSequence: bigint;
}

function emptyOrgState(): OrgState {
    return {
        studies: new Map(), series: new Map(), instances: new Map(), reports: new Map(),
        annotations: new Map(), provenance: new Map(), derivedArtifacts: new Map(),
        shareGrants: new Map(), ingestionJobs: new Map(), viewerSessions: new Map(),
        deidentificationJobs: new Map(), documentReferences: new Map(),
        changes: [], nextSequence: 1n,
    };
}

const identifierKey = (id: ImagingPatientIdentifier): string => `${id.issuer.toLowerCase()}:${id.value.toLowerCase()}`;

/**
 * In-memory clinical imaging store — the default when DATABASE_URL is
 * unset (local/personal mode), and what every non-Postgres-gated test in
 * this package exercises. See imaging-store.ts's own doc comment for the
 * "one consolidated store" design rationale.
 */
export class InMemoryImagingStore implements ImagingStore {
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

    forTenant(context: TenantContext): TenantImagingRepository {
        const state = this.stateFor(context.organizationId);
        const auditStore = this.auditStore;
        const organizationId = context.organizationId;

        function recordChange(kind: "upsert" | "delete", resourceType: "study" | "report" | "shareGrant", resourceId: string, studyId: string, payload?: { study?: ImagingStudy; report?: DiagnosticReport; shareGrant?: ImagingShareGrant }): void {
            const sequence = state.nextSequence;
            state.nextSequence += 1n;
            const changedAt = new Date().toISOString();
            const change: ImagingChange =
                kind === "upsert"
                    ? { sequence: sequence.toString(), kind: "upsert", resourceType, resourceId, studyId, changedAt, ...payload }
                    : { sequence: sequence.toString(), kind: "delete", resourceType, resourceId, studyId, changedAt };
            state.changes.push({ change });
        }

        return {
            context,

            async createStudy(input: CreateStudyInput, actor: AuditActor): Promise<StoredImagingStudy> {
                const id = randomUUID();
                const now = new Date().toISOString();
                const study: ImagingStudy = {
                    id,
                    studyInstanceUid: input.studyInstanceUid,
                    patientIdentifier: input.patientIdentifier,
                    caseId: input.caseId,
                    accessionNumber: input.accessionNumber,
                    modalities: input.modalities,
                    description: input.description,
                    bodyPart: input.bodyPart,
                    studyDate: input.studyDate,
                    studyTime: input.studyTime,
                    institutionName: input.institutionName,
                    referringPhysician: input.referringPhysician,
                    numberOfSeries: 0,
                    numberOfInstances: 0,
                    status: "registered",
                    sensitivity: input.sensitivity ?? "normal",
                    ingestionStatus: "quarantined",
                    workspaceId: input.workspaceId,
                    departmentId: input.departmentId,
                    assignedUserIds: input.assignedUserIds ?? [],
                    createdAt: now,
                    updatedAt: now,
                    version: "1",
                };
                const resource: ImagingResourceAttributes = {
                    organizationId,
                    studyId: id,
                    patientIdentifier: input.patientIdentifier,
                    caseId: input.caseId,
                    ownerUserId: input.ownerUserId,
                    workspaceId: input.workspaceId,
                    departmentId: input.departmentId,
                    assignedUserIds: input.assignedUserIds ?? [],
                    sensitivity: input.sensitivity ?? "normal",
                };
                const stored: StoredImagingStudy = { study, resource };
                state.studies.set(id, stored);
                recordChange("upsert", "study", id, id, { study });
                await auditStore.record({ organizationId, actorUserId: actor.userId, actorExternalSubject: actor.externalSubject, action: "imagingStudy.create", targetType: "imagingStudy", targetId: id, details: { studyInstanceUid: input.studyInstanceUid } });
                return stored;
            },

            async getStudy(id) {
                return state.studies.get(id) ?? null;
            },

            async findStudyByUid(studyInstanceUid) {
                for (const s of state.studies.values()) if (s.study.studyInstanceUid === studyInstanceUid) return s;
                return null;
            },

            async findStudiesByPatientIdentifier(patientIdentifier) {
                const key = identifierKey(patientIdentifier);
                return [...state.studies.values()].filter((s) => identifierKey(s.study.patientIdentifier) === key);
            },

            async listStudies(filter) {
                let all = [...state.studies.values()];
                if (filter?.caseId !== undefined) all = all.filter((s) => s.study.caseId === filter.caseId);
                if (filter?.ingestionStatus !== undefined) all = all.filter((s) => s.study.ingestionStatus === filter.ingestionStatus);
                return all.sort((a, b) => (a.study.createdAt < b.study.createdAt ? 1 : -1));
            },

            async updateStudy(id, partial, actor) {
                const existing = state.studies.get(id);
                if (!existing) return null;
                const updatedStudy: ImagingStudy = {
                    ...existing.study,
                    ...partial,
                    updatedAt: new Date().toISOString(),
                    version: String(BigInt(existing.study.version ?? "1") + 1n),
                };
                const updatedResource: ImagingResourceAttributes = {
                    ...existing.resource,
                    caseId: partial.caseId ?? existing.resource.caseId,
                    sensitivity: partial.sensitivity ?? existing.resource.sensitivity,
                    workspaceId: partial.workspaceId ?? existing.resource.workspaceId,
                    departmentId: partial.departmentId ?? existing.resource.departmentId,
                    assignedUserIds: partial.assignedUserIds ?? existing.resource.assignedUserIds,
                };
                const stored: StoredImagingStudy = { study: updatedStudy, resource: updatedResource };
                state.studies.set(id, stored);
                recordChange("upsert", "study", id, id, { study: updatedStudy });
                await auditStore.record({ organizationId, actorUserId: actor.userId, actorExternalSubject: actor.externalSubject, action: "imagingStudy.update", targetType: "imagingStudy", targetId: id, details: { fields: Object.keys(partial) } });
                return stored;
            },

            async createSeries(studyId, input, actor) {
                const id = randomUUID();
                const now = new Date().toISOString();
                const series: ImagingSeriesRecord = { id, studyId, numberOfInstances: 0, createdAt: now, updatedAt: now, ...input };
                state.series.set(id, series);
                const study = state.studies.get(studyId);
                if (study) {
                    const updated = { ...study.study, numberOfSeries: study.study.numberOfSeries + 1, updatedAt: now };
                    state.studies.set(studyId, { ...study, study: updated });
                }
                await auditStore.record({ organizationId, actorUserId: actor.userId, actorExternalSubject: actor.externalSubject, action: "imagingSeries.create", targetType: "imagingSeries", targetId: id, details: {} });
                return series;
            },

            async listSeriesForStudy(studyId) {
                return [...state.series.values()].filter((s) => s.studyId === studyId);
            },

            async getSeries(id) {
                return state.series.get(id) ?? null;
            },

            async createInstance(seriesId, input, actor) {
                const id = randomUUID();
                const instance: InternalImagingInstance = { id, seriesId, createdAt: new Date().toISOString(), ...input };
                state.instances.set(id, instance);
                const series = state.series.get(seriesId);
                if (series) {
                    series.numberOfInstances += 1;
                    series.updatedAt = new Date().toISOString();
                    const study = state.studies.get(series.studyId);
                    if (study) {
                        const updated = { ...study.study, numberOfInstances: study.study.numberOfInstances + 1, updatedAt: new Date().toISOString() };
                        state.studies.set(series.studyId, { ...study, study: updated });
                    }
                }
                await auditStore.record({ organizationId, actorUserId: actor.userId, actorExternalSubject: actor.externalSubject, action: "imagingInstance.create", targetType: "imagingInstance", targetId: id, details: {} });
                return instance;
            },

            async listInstancesForSeries(seriesId) {
                return [...state.instances.values()].filter((i) => i.seriesId === seriesId);
            },

            async getInstance(id) {
                return state.instances.get(id) ?? null;
            },

            async findInstanceByUid(sopInstanceUid) {
                for (const i of state.instances.values()) if (i.sopInstanceUid === sopInstanceUid) return i;
                return null;
            },

            async markInstanceThumbnailed(id) {
                const instance = state.instances.get(id);
                if (instance) instance.hasThumbnail = true;
            },

            async createReport(input, actor) {
                const id = randomUUID();
                const now = new Date().toISOString();
                const report: DiagnosticReport = { id, createdAt: now, updatedAt: now, ...input };
                state.reports.set(id, report);
                recordChange("upsert", "report", id, input.studyId, { report });
                await auditStore.record({ organizationId, actorUserId: actor.userId, actorExternalSubject: actor.externalSubject, action: input.previousVersionId ? "diagnosticReport.amend" : "diagnosticReport.create", targetType: "diagnosticReport", targetId: id, details: { studyId: input.studyId, status: input.status } });
                return report;
            },

            async getReport(id) {
                return state.reports.get(id) ?? null;
            },

            async getCurrentReport(studyId) {
                const superseded = new Set<string>();
                for (const r of state.reports.values()) if (r.previousVersionId) superseded.add(r.previousVersionId);
                const candidates = [...state.reports.values()].filter(
                    (r) => r.studyId === studyId && !superseded.has(r.id) && r.status !== "cancelled" && r.status !== "entered-in-error"
                );
                candidates.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
                return candidates[0] ?? null;
            },

            async listReportHistory(studyId) {
                return [...state.reports.values()].filter((r) => r.studyId === studyId).sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
            },

            async signReport(id, signedByUserId, actor) {
                const existing = state.reports.get(id);
                if (!existing) return null;
                const updated: DiagnosticReport = { ...existing, signedByUserId, signedAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
                state.reports.set(id, updated);
                recordChange("upsert", "report", id, existing.studyId, { report: updated });
                await auditStore.record({ organizationId, actorUserId: actor.userId, actorExternalSubject: actor.externalSubject, action: "diagnosticReport.sign", targetType: "diagnosticReport", targetId: id, details: {} });
                return updated;
            },

            async acknowledgeCriticalReport(id, acknowledgedByUserId, actor) {
                const existing = state.reports.get(id);
                if (!existing) return null;
                const updated: DiagnosticReport = { ...existing, criticalAcknowledgedByUserId: acknowledgedByUserId, criticalAcknowledgedAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
                state.reports.set(id, updated);
                recordChange("upsert", "report", id, existing.studyId, { report: updated });
                await auditStore.record({ organizationId, actorUserId: actor.userId, actorExternalSubject: actor.externalSubject, action: "diagnosticReport.acknowledgeCritical", targetType: "diagnosticReport", targetId: id, details: {} });
                return updated;
            },

            async createAnnotation(input, actor) {
                const id = randomUUID();
                const now = new Date().toISOString();
                const annotation: ImagingAnnotation = { id, createdAt: now, updatedAt: now, version: "1", ...input };
                state.annotations.set(id, annotation);
                await auditStore.record({ organizationId, actorUserId: actor.userId, actorExternalSubject: actor.externalSubject, action: "imagingAnnotation.create", targetType: "imagingAnnotation", targetId: id, details: { studyId: input.studyId, kind: input.kind } });
                return annotation;
            },

            async listAnnotationsForStudy(studyId) {
                return [...state.annotations.values()].filter((a) => a.studyId === studyId);
            },

            async recordProvenance(input) {
                const id = randomUUID();
                const record: ProvenanceRecord = { id, ...input };
                state.provenance.set(id, record);
                return record;
            },

            async listProvenanceForTarget(targetType, targetId) {
                return [...state.provenance.values()].filter((p) => p.targetType === targetType && p.targetId === targetId);
            },

            async createDerivedArtifact(input: CreateDerivedArtifactInput) {
                const provenanceId = randomUUID();
                const provenance: ProvenanceRecord = { id: provenanceId, ...input.provenance };
                state.provenance.set(provenanceId, provenance);
                const id = randomUUID();
                const artifact: InternalDerivedArtifact = {
                    id, kind: input.kind, sourceInstanceId: input.sourceInstanceId, sourceStudyId: input.sourceStudyId,
                    checksumSha256: input.checksumSha256, sizeBytes: input.sizeBytes, provenanceId, createdAt: new Date().toISOString(),
                    objectStorageKey: input.objectStorageKey,
                };
                state.derivedArtifacts.set(id, artifact);
                return artifact;
            },

            async getDerivedArtifact(id) {
                return state.derivedArtifacts.get(id) ?? null;
            },

            async listDerivedArtifactsForSource(kind, sourceInstanceId, sourceStudyId) {
                return [...state.derivedArtifacts.values()].filter(
                    (a) => a.kind === kind && (sourceInstanceId === undefined || a.sourceInstanceId === sourceInstanceId) && (sourceStudyId === undefined || a.sourceStudyId === sourceStudyId)
                );
            },

            async createShareGrant(input, actor) {
                const id = randomUUID();
                const grant: ImagingShareGrant & { externalTokenHash?: string; externalVerificationCodeHash?: string } = {
                    id, status: "active", createdAt: new Date().toISOString(), ...input,
                };
                state.shareGrants.set(id, grant);
                const { externalTokenHash: _t, externalVerificationCodeHash: _v, ...publicGrant } = grant;
                recordChange("upsert", "shareGrant", id, input.studyId, { shareGrant: publicGrant });
                await auditStore.record({ organizationId, actorUserId: actor.userId, actorExternalSubject: actor.externalSubject, action: "imagingShareGrant.create", targetType: "imagingShareGrant", targetId: id, details: { mode: input.mode, scope: input.scope, studyId: input.studyId } });
                return publicGrant;
            },

            async getShareGrant(id) {
                const grant = state.shareGrants.get(id);
                if (!grant) return null;
                const { externalTokenHash: _t, externalVerificationCodeHash: _v, ...publicGrant } = grant;
                return publicGrant;
            },

            async listShareGrantsForStudy(studyId) {
                return [...state.shareGrants.values()]
                    .filter((g) => g.studyId === studyId)
                    .map(({ externalTokenHash: _t, externalVerificationCodeHash: _v, ...g }) => g)
                    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
            },

            async revokeShareGrant(id, revokedByUserId, actor) {
                const existing = state.shareGrants.get(id);
                if (!existing || existing.status !== "active") return null;
                const updated = { ...existing, status: "revoked" as const, revokedByUserId, revokedAt: new Date().toISOString() };
                state.shareGrants.set(id, updated);
                const { externalTokenHash: _t, externalVerificationCodeHash: _v, ...publicGrant } = updated;
                recordChange("upsert", "shareGrant", id, existing.studyId, { shareGrant: publicGrant });
                await auditStore.record({ organizationId, actorUserId: actor.userId, actorExternalSubject: actor.externalSubject, action: "imagingShareGrant.revoke", targetType: "imagingShareGrant", targetId: id, details: {} });
                return publicGrant;
            },

            async findActiveExternalShareByTokenHash(tokenHash) {
                for (const g of state.shareGrants.values()) {
                    if (g.externalTokenHash === tokenHash && g.status === "active") {
                        const { externalTokenHash: _t, externalVerificationCodeHash, ...publicGrant } = g;
                        return { grant: publicGrant, externalVerificationCodeHash: externalVerificationCodeHash ?? "" };
                    }
                }
                return null;
            },

            async createIngestionJob(input, createdByUserId, actor) {
                const id = randomUUID();
                const now = new Date().toISOString();
                const job: ImagingIngestionJob = { id, createdAt: now, updatedAt: now, ...input };
                state.ingestionJobs.set(id, job);
                void createdByUserId; // recorded via actor; kept as an explicit param for callers' own bookkeeping/tests
                await auditStore.record({ organizationId, actorUserId: actor.userId, actorExternalSubject: actor.externalSubject, action: "imagingIngestionJob.create", targetType: "imagingIngestionJob", targetId: id, details: { status: input.status } });
                return job;
            },

            async getIngestionJob(id) {
                return state.ingestionJobs.get(id) ?? null;
            },

            async listIngestionJobs(filter) {
                let all = [...state.ingestionJobs.values()];
                if (filter?.status !== undefined) all = all.filter((j) => j.status === filter.status);
                return all.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
            },

            async updateIngestionJob(id, partial, actor) {
                const existing = state.ingestionJobs.get(id);
                if (!existing) return null;
                const updated: ImagingIngestionJob = { ...existing, ...partial, updatedAt: new Date().toISOString() };
                state.ingestionJobs.set(id, updated);
                await auditStore.record({ organizationId, actorUserId: actor.userId, actorExternalSubject: actor.externalSubject, action: "imagingIngestionJob.update", targetType: "imagingIngestionJob", targetId: id, details: { status: updated.status, failureCategory: updated.failureCategory } });
                return updated;
            },

            async createViewerSession(input, actor) {
                const id = randomUUID();
                const session: ViewerSession & { tokenHash: string } = {
                    id, scope: { studyId: input.studyId, seriesIds: input.seriesIds, instanceIds: input.instanceIds },
                    grantedActions: input.grantedActions, shareGrantId: input.shareGrantId,
                    issuedAt: new Date().toISOString(), expiresAt: input.expiresAt, revoked: false, tokenHash: input.tokenHash,
                };
                state.viewerSessions.set(id, session);
                await auditStore.record({ organizationId, actorUserId: actor.userId, actorExternalSubject: actor.externalSubject, action: "imagingViewerSession.create", targetType: "imagingViewerSession", targetId: id, details: { studyId: input.studyId, grantedActions: input.grantedActions } });
                const { tokenHash: _h, ...publicSession } = session;
                return publicSession;
            },

            async findActiveViewerSessionByTokenHash(tokenHash) {
                const now = new Date().toISOString();
                for (const s of state.viewerSessions.values()) {
                    if (s.tokenHash === tokenHash && !s.revoked && s.expiresAt > now) {
                        const { tokenHash: _h, ...publicSession } = s;
                        return publicSession;
                    }
                }
                return null;
            },

            async revokeViewerSession(id, actor) {
                const existing = state.viewerSessions.get(id);
                if (!existing || existing.revoked) return;
                existing.revoked = true;
                await auditStore.record({ organizationId, actorUserId: actor.userId, actorExternalSubject: actor.externalSubject, action: "imagingViewerSession.revoke", targetType: "imagingViewerSession", targetId: id, details: {} });
            },

            async revokeViewerSessionsForShareGrant(shareGrantId, actor) {
                let count = 0;
                for (const s of state.viewerSessions.values()) {
                    if (s.shareGrantId === shareGrantId && !s.revoked) {
                        s.revoked = true;
                        count += 1;
                    }
                }
                if (count > 0) {
                    await auditStore.record({ organizationId, actorUserId: actor.userId, actorExternalSubject: actor.externalSubject, action: "imagingViewerSession.revokeForShareGrant", targetType: "imagingShareGrant", targetId: shareGrantId, details: { count } });
                }
                return count;
            },

            async createDeidentificationJob(input) {
                const id = randomUUID();
                const now = new Date().toISOString();
                const job: DeidentificationJob = { id, createdAt: now, updatedAt: now, ...input };
                state.deidentificationJobs.set(id, job);
                return job;
            },

            async getDeidentificationJob(id) {
                return state.deidentificationJobs.get(id) ?? null;
            },

            async updateDeidentificationJob(id, partial) {
                const existing = state.deidentificationJobs.get(id);
                if (!existing) return null;
                const updated: DeidentificationJob = { ...existing, ...partial, updatedAt: new Date().toISOString() };
                state.deidentificationJobs.set(id, updated);
                return updated;
            },

            async createDocumentReference(input) {
                const id = randomUUID();
                const doc: DocumentReference & { objectStorageKey: string } = { id, createdAt: new Date().toISOString(), ...input };
                state.documentReferences.set(id, doc);
                const { objectStorageKey: _k, ...publicDoc } = doc;
                return publicDoc;
            },

            async listDocumentReferencesForStudy(studyId) {
                return [...state.documentReferences.values()]
                    .filter((d) => d.studyId === studyId)
                    .map(({ objectStorageKey: _k, ...d }) => d);
            },

            async readChanges(cursor) {
                const after = cursor !== null && /^\d+$/.test(cursor) ? BigInt(cursor) : 0n;
                const matching = state.changes.filter((c) => BigInt(c.change.sequence) > after);
                const newCursor = matching.length > 0 ? matching[matching.length - 1].change.sequence : (cursor ?? "0");
                return { changes: matching, cursor: newCursor };
            },
        };
    }
}
