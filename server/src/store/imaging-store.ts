import type {
    DeidentificationJob,
    DerivedArtifact,
    DiagnosticReport,
    DocumentReference,
    ImagingAnnotation,
    ImagingChange,
    ImagingChangeFeed,
    ImagingIngestionJob,
    ImagingPatientIdentifier,
    ImagingResourceAttributes,
    ImagingShareGrant,
    ImagingStudy,
    ProvenanceRecord,
    ViewerSession,
} from "@modelforge/contracts";
import type { TenantContext } from "../tenant-context.js";
import type { AuditActor } from "./audit-store.js";

/**
 * Clinical imaging repository — one consolidated interface across every
 * imaging sub-resource (study/series/instance/report/annotation/
 * provenance/derived-artifact/share-grant/ingestion-job/viewer-session/
 * de-identification-job/document-reference), the same "one interface per
 * domain" shape as store/iam-store.ts, not a dozen tiny stores — this
 * domain has more sub-resource types than IAM does, and splitting it
 * further would multiply the deps.ts/app.ts/index.ts wiring for no real
 * isolation benefit (every sub-resource already lives in one tenant schema
 * together).
 *
 * Tenant-bound via `forTenant(context)`, mirroring case-store.ts's
 * TenantCaseRepository exactly — imaging is clinical, tenant-scoped data,
 * not shared control-plane metadata like IAM.
 *
 * `objectStorageKey` (the actual pixel-data location) is NEVER part of any
 * @modelforge/contracts imaging type — see imaging.ts's own top doc
 * comment. `StoredImagingInstance` below is this store's own internal
 * representation carrying that key; routes/imaging code only ever hands it
 * to ImagingObjectStore (server/src/imaging/object-store.ts), never to a
 * client response.
 */

export interface InternalImagingInstance {
    id: string;
    seriesId: string;
    sopInstanceUid: string;
    sopClassUid: string;
    instanceNumber?: string;
    transferSyntaxUid: string;
    rows?: number;
    columns?: number;
    numberOfFrames?: number;
    checksumSha256: string;
    objectStorageKey: string;
    sizeBytes: number;
    hasThumbnail: boolean;
    createdAt: string;
}

export interface ImagingSeriesRecord {
    id: string;
    studyId: string;
    seriesInstanceUid: string;
    seriesNumber?: string;
    modality: string;
    bodyPartExamined?: string;
    description?: string;
    numberOfInstances: number;
    createdAt: string;
    updatedAt: string;
}

export interface StoredImagingStudy {
    study: ImagingStudy;
    resource: ImagingResourceAttributes;
}

export interface StoredImagingChange {
    change: ImagingChange;
}

export interface CreateStudyInput {
    studyInstanceUid: string;
    patientIdentifier: ImagingPatientIdentifier;
    caseId?: string;
    accessionNumber?: string;
    modalities: string[];
    description?: string;
    bodyPart?: string;
    studyDate?: string;
    studyTime?: string;
    institutionName?: string;
    referringPhysician?: string;
    ownerUserId: string;
    workspaceId?: string;
    departmentId?: string;
    assignedUserIds?: string[];
    sensitivity?: "normal" | "restricted";
}

/** Internal representation carrying objectStorageKey — mirrors
 * InternalImagingInstance's own reasoning: the public DerivedArtifact
 * contract type never carries it (imaging.ts's own doc comment), so any
 * route handler that needs to actually retrieve the bytes (only
 * routes/imaging-dicomweb.ts's thumbnail endpoint today) uses this
 * instead. */
export interface InternalDerivedArtifact extends DerivedArtifact {
    objectStorageKey: string;
}

export interface CreateDerivedArtifactInput {
    kind: DerivedArtifact["kind"];
    sourceInstanceId?: string;
    sourceStudyId?: string;
    objectStorageKey: string;
    checksumSha256: string;
    sizeBytes: number;
    provenance: Omit<ProvenanceRecord, "id">;
}

export interface TenantImagingRepository {
    readonly context: TenantContext;

    // --- Studies ---
    createStudy(input: CreateStudyInput, actor: AuditActor): Promise<StoredImagingStudy>;
    getStudy(id: string): Promise<StoredImagingStudy | null>;
    findStudyByUid(studyInstanceUid: string): Promise<StoredImagingStudy | null>;
    /** Exact `(issuer, value)` match only — see docs/IMAGING.md's patient-
     * matching section. Multiple results (or a match against more than one
     * distinct caseId) is the caller's signal to hold for manual review. */
    findStudiesByPatientIdentifier(patientIdentifier: ImagingPatientIdentifier): Promise<StoredImagingStudy[]>;
    listStudies(filter?: { caseId?: string; ingestionStatus?: ImagingStudy["ingestionStatus"] }): Promise<StoredImagingStudy[]>;
    updateStudy(
        id: string,
        partial: Partial<
            Pick<
                ImagingStudy,
                "caseId" | "status" | "sensitivity" | "ingestionStatus" | "numberOfSeries" | "numberOfInstances" | "workspaceId" | "departmentId" | "assignedUserIds"
            >
        >,
        actor: AuditActor
    ): Promise<StoredImagingStudy | null>;

    // --- Series / Instances ---
    createSeries(studyId: string, input: Omit<ImagingSeriesRecord, "id" | "studyId" | "createdAt" | "updatedAt" | "numberOfInstances">, actor: AuditActor): Promise<ImagingSeriesRecord>;
    listSeriesForStudy(studyId: string): Promise<ImagingSeriesRecord[]>;
    getSeries(id: string): Promise<ImagingSeriesRecord | null>;
    createInstance(seriesId: string, input: Omit<InternalImagingInstance, "id" | "seriesId" | "createdAt">, actor: AuditActor): Promise<InternalImagingInstance>;
    listInstancesForSeries(seriesId: string): Promise<InternalImagingInstance[]>;
    getInstance(id: string): Promise<InternalImagingInstance | null>;
    findInstanceByUid(sopInstanceUid: string): Promise<InternalImagingInstance | null>;
    markInstanceThumbnailed(id: string): Promise<void>;

    // --- Diagnostic reports ---
    /** Creates a new report row. When `previousVersionId` is set (amend/
     * correct), the prior row is left untouched (immutable) — this method
     * never mutates an existing row. */
    createReport(input: Omit<DiagnosticReport, "id" | "createdAt" | "updatedAt">, actor: AuditActor): Promise<DiagnosticReport>;
    getReport(id: string): Promise<DiagnosticReport | null>;
    /** The current report for a study: the newest row with no successor
     * referencing it as previousVersionId, excluding cancelled/
     * entered-in-error. Null if none. */
    getCurrentReport(studyId: string): Promise<DiagnosticReport | null>;
    listReportHistory(studyId: string): Promise<DiagnosticReport[]>;
    signReport(id: string, signedByUserId: string, actor: AuditActor): Promise<DiagnosticReport | null>;
    acknowledgeCriticalReport(id: string, acknowledgedByUserId: string, actor: AuditActor): Promise<DiagnosticReport | null>;

    // --- Annotations ---
    createAnnotation(input: Omit<ImagingAnnotation, "id" | "createdAt" | "updatedAt" | "version">, actor: AuditActor): Promise<ImagingAnnotation>;
    listAnnotationsForStudy(studyId: string): Promise<ImagingAnnotation[]>;

    // --- Provenance ---
    recordProvenance(input: Omit<ProvenanceRecord, "id">): Promise<ProvenanceRecord>;
    listProvenanceForTarget(targetType: ProvenanceRecord["targetType"], targetId: string): Promise<ProvenanceRecord[]>;

    // --- Derived artifacts ---
    createDerivedArtifact(input: CreateDerivedArtifactInput): Promise<InternalDerivedArtifact>;
    getDerivedArtifact(id: string): Promise<InternalDerivedArtifact | null>;
    listDerivedArtifactsForSource(kind: DerivedArtifact["kind"], sourceInstanceId?: string, sourceStudyId?: string): Promise<InternalDerivedArtifact[]>;

    // --- Share grants ---
    createShareGrant(input: Omit<ImagingShareGrant, "id" | "createdAt" | "status" | "revokedAt" | "revokedByUserId"> & { externalTokenHash?: string; externalVerificationCodeHash?: string }, actor: AuditActor): Promise<ImagingShareGrant>;
    getShareGrant(id: string): Promise<ImagingShareGrant | null>;
    listShareGrantsForStudy(studyId: string): Promise<ImagingShareGrant[]>;
    revokeShareGrant(id: string, revokedByUserId: string, actor: AuditActor): Promise<ImagingShareGrant | null>;
    /** External-portal access: resolves an active, non-expired grant by
     * its link-token hash. Verification-code check happens in the caller
     * (routes/imaging-share.ts), against the returned grant's stored
     * externalVerificationCodeHash. */
    findActiveExternalShareByTokenHash(tokenHash: string): Promise<{ grant: ImagingShareGrant; externalVerificationCodeHash: string } | null>;

    // --- Ingestion jobs ---
    createIngestionJob(input: Omit<ImagingIngestionJob, "id" | "createdAt" | "updatedAt">, createdByUserId: string, actor: AuditActor): Promise<ImagingIngestionJob>;
    getIngestionJob(id: string): Promise<ImagingIngestionJob | null>;
    listIngestionJobs(filter?: { status?: ImagingIngestionJob["status"] }): Promise<ImagingIngestionJob[]>;
    updateIngestionJob(id: string, partial: Partial<Pick<ImagingIngestionJob, "status" | "studyId" | "failureCategory" | "checksumSha256">>, actor: AuditActor): Promise<ImagingIngestionJob | null>;

    // --- Viewer sessions ---
    createViewerSession(
        input: { userId?: string; studyId: string; seriesIds?: string[]; instanceIds?: string[]; grantedActions: ViewerSession["grantedActions"]; shareGrantId?: string; tokenHash: string; expiresAt: string },
        actor: AuditActor
    ): Promise<ViewerSession>;
    findActiveViewerSessionByTokenHash(tokenHash: string): Promise<ViewerSession | null>;
    revokeViewerSession(id: string, actor: AuditActor): Promise<void>;
    /** Item 11: "Revocation must terminate new viewer sessions
     * immediately." Called by revokeShareGrant's caller in the same
     * logical operation. */
    revokeViewerSessionsForShareGrant(shareGrantId: string, actor: AuditActor): Promise<number>;

    // --- De-identification ---
    createDeidentificationJob(input: Omit<DeidentificationJob, "id" | "createdAt" | "updatedAt">): Promise<DeidentificationJob>;
    getDeidentificationJob(id: string): Promise<DeidentificationJob | null>;
    updateDeidentificationJob(
        id: string,
        partial: Partial<Pick<DeidentificationJob, "reviewStatus" | "reviewedByUserId" | "reviewedAt" | "resultArtifactId" | "burnedInTextSuspected" | "recognizableFeaturesFlagged">>
    ): Promise<DeidentificationJob | null>;

    // --- Document references ---
    createDocumentReference(input: Omit<DocumentReference, "id" | "createdAt"> & { objectStorageKey: string }): Promise<DocumentReference>;
    listDocumentReferencesForStudy(studyId: string): Promise<DocumentReference[]>;

    // --- Change feed (study/report/shareGrant only — never pixel data,
    // never series/instance/annotation/provenance rows) ---
    readChanges(cursor: string | null): Promise<{ changes: StoredImagingChange[]; cursor: string }>;
}

export interface ImagingStore {
    forTenant(context: TenantContext): TenantImagingRepository;
}

export function publicImagingFeed(changes: StoredImagingChange[], cursor: string): ImagingChangeFeed {
    return { changes: changes.map((c) => c.change), cursor };
}
