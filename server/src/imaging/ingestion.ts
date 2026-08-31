import type { ImagingIngestionJob, ImagingPatientIdentifier } from "@modelforge/contracts";
import type { AuditActor } from "../store/audit-store.js";
import type { TenantImagingRepository } from "../store/imaging-store.js";
import type { DicomwebAdapter } from "./dicomweb-adapter.js";
import { sha256Hex, type ImagingObjectStore } from "./object-store.js";
import { parseAndValidateDicom, dicomDateToIso, MalformedDicomError, UnsupportedTransferSyntaxError, MissingRequiredIdentifiersError, DicomBoundsExceededError } from "./dicom-parse.js";
import { generateThumbnail } from "./thumbnail.js";

// The ingestion pipeline (item 5). Stages, in order:
//  1. Quarantine: the job is created in "quarantined" status with the raw
//     bytes held only in memory/caller scope, never linked to a study yet.
//  2. Validate: type/size (caller-enforced before this is even called,
//     see MAX_UPLOAD_SIZE_BYTES), DICOM structure, transfer syntax,
//     required identifiers, and bounds (dicom-parse.ts).
//  3. Match: resolve (PatientID, IssuerOfPatientID) against existing
//     studies for this tenant, exact match only; more than one distinct
//     patient/case candidate is "ambiguous," held for manual review,
//     never auto-resolved. See docs/IMAGING.md.
//  4. Publish: create/update the ImagingStudy + Series + Instance rows and
//     store the immutable original via the DicomwebAdapter, only after
//     every prior step succeeded. A failure at any earlier stage leaves
//     no study/series/instance row at all, not a partial one.
//  5. Thumbnail: kicked off by the caller (routes/imaging-ingestion.ts)
//     as a separate, lower-priority, cancellable background step through
//     the resource orchestrator, deliberately not inline in this
//     function, per item 5's "generate thumbnails asynchronously" and
//     item 19's "prioritize interactive viewing over thumbnails."
//
// Every failure path records a job status plus a closed-vocabulary
// IngestionFailureCategory (packages/contracts/src/imaging.ts), never a
// message containing file content, parsed tag values, or any other
// PHI-shaped text. That is what item 5's "record failures without
// exposing PHI" means concretely: the type of failure is logged, never
// the content that caused it.

export const MAX_UPLOAD_SIZE_BYTES = 512 * 1024 * 1024; // 512MB, generous for a single DICOM instance, bounded against a resource-exhaustion upload

export interface IngestOneInstanceInput {
    fileName: string;
    fileBytes: Buffer;
    uploadId: string;
    ownerUserId: string;
    /** Set only when the caller (an authenticated clinician uploading
     * through the case's own imaging tab) already knows which case this
     * should attach to. Used as a hint, never blindly trusted: patient
     * identifier matching still runs and can still land on
     * "review-required" if the DICOM file's own PatientID does not
     * correspond to that case at all. */
    expectedCaseId?: string;
    workspaceId?: string;
    departmentId?: string;
}

export interface IngestOneInstanceResult {
    job: ImagingIngestionJob;
    studyId?: string;
    /** Set only on a successful publish (new or byte-identical re-send) —
     * routes/imaging-ingestion.ts uses this to schedule thumbnail
     * generation without re-parsing the file it already has in hand. */
    instanceId?: string;
    requiresReview: boolean;
}

/** Ingests exactly one DICOM instance (a real upload is typically many
 * instances across one or more series/studies; routes/imaging-ingestion.ts
 * calls this once per file). Never throws for an expected validation
 * failure; those are represented as a "failed"/"review-required" job with
 * a failureCategory. Only truly unexpected errors (a store/object-store
 * failure) propagate. */
export async function ingestOneInstance(
    deps: {
        repo: TenantImagingRepository;
        objectStore: ImagingObjectStore;
        dicomweb: DicomwebAdapter;
        organizationId: string;
    },
    input: IngestOneInstanceInput,
    actor: AuditActor
): Promise<IngestOneInstanceResult> {
    const uploadChecksum = sha256Hex(input.fileBytes);

    if (input.fileBytes.length > MAX_UPLOAD_SIZE_BYTES) {
        const job = await deps.repo.createIngestionJob(
            { uploadId: input.uploadId, fileName: sanitizeFileName(input.fileName), sizeBytes: input.fileBytes.length, status: "rejected", failureCategory: "file-too-large" },
            input.ownerUserId,
            actor
        );
        return { job, requiresReview: false };
    }

    const job0 = await deps.repo.createIngestionJob(
        { uploadId: input.uploadId, fileName: sanitizeFileName(input.fileName), sizeBytes: input.fileBytes.length, checksumSha256: uploadChecksum, status: "quarantined" },
        input.ownerUserId,
        actor
    );

    let parsed: ReturnType<typeof parseAndValidateDicom>;
    try {
        await deps.repo.updateIngestionJob(job0.id, { status: "validating" }, actor);
        parsed = parseAndValidateDicom(input.fileBytes);
    } catch (err) {
        const failureCategory = classifyParseFailure(err);
        const job = await deps.repo.updateIngestionJob(job0.id, { status: "failed", failureCategory }, actor);
        return { job: job!, requiresReview: false };
    }

    await deps.repo.updateIngestionJob(job0.id, { status: "matching" }, actor);
    const { metadata } = parsed;
    const patientIdentifier = { value: metadata.patientId, issuer: metadata.issuerOfPatientId };

    // Patient matching: exact (issuer, value) match against EXISTING
    // studies' own patientIdentifier. See docs/IMAGING.md for why this is
    // deliberately not fuzzy/demographic matching.
    const existingByPatient = await deps.repo.findStudiesByPatientIdentifier(patientIdentifier);
    const distinctCaseIds = new Set(existingByPatient.map((s) => s.study.caseId).filter((id): id is string => id !== undefined));
    const ambiguous = distinctCaseIds.size > 1 || (input.expectedCaseId !== undefined && distinctCaseIds.size === 1 && !distinctCaseIds.has(input.expectedCaseId));
    if (ambiguous) {
        // Persist the bytes so a later human resolution
        // (resolveAmbiguousIngestionJob) has something to publish — every
        // other failure/success path either already has a real instance
        // object key or has nothing worth keeping, but "review-required" is
        // the one state a person is expected to act on afterward. Deleted
        // by resolveAmbiguousIngestionJob once it runs either decision.
        await deps.objectStore.put(ambiguousMatchQuarantineKey(deps.organizationId, job0.id), input.fileBytes, "application/dicom");
        const job = await deps.repo.updateIngestionJob(job0.id, { status: "review-required", failureCategory: "ambiguous-patient-match" }, actor);
        return { job: job!, requiresReview: true };
    }
    const resolvedCaseId = input.expectedCaseId ?? [...distinctCaseIds][0];

    return publishInstance(
        deps,
        job0,
        metadata,
        patientIdentifier,
        uploadChecksum,
        input.fileBytes,
        { uploadId: input.uploadId, ownerUserId: input.ownerUserId, resolvedCaseId, workspaceId: input.workspaceId, departmentId: input.departmentId },
        actor
    );
}

/** Shared by ingestOneInstance's normal (unambiguous) path and
 * resolveAmbiguousIngestionJob's "attach" decision — find-or-create the
 * study/series by UID, enforce original-instance immutability, store the
 * bytes, and publish. Never called until a caseId is already resolved
 * (either automatically, or by a human review decision). */
async function publishInstance(
    deps: { repo: TenantImagingRepository; objectStore: ImagingObjectStore; dicomweb: DicomwebAdapter; organizationId: string },
    job0: ImagingIngestionJob,
    metadata: ReturnType<typeof parseAndValidateDicom>["metadata"],
    patientIdentifier: ImagingPatientIdentifier,
    uploadChecksum: string,
    fileBytes: Buffer,
    ctx: { uploadId: string; ownerUserId: string; resolvedCaseId?: string; workspaceId?: string; departmentId?: string },
    actor: AuditActor
): Promise<IngestOneInstanceResult> {
    // Find-or-create the study/series by DICOM UID, tenant-scoped.
    // Re-ingesting an instance for a study already known to this tenant
    // (e.g. a PACS re-send) attaches to the existing study/series rather
    // than duplicating them.
    const existingStudy = await deps.repo.findStudyByUid(metadata.studyInstanceUid);
    const studyId = existingStudy
        ? existingStudy.study.id
        : (
              await deps.repo.createStudy(
                  {
                      studyInstanceUid: metadata.studyInstanceUid,
                      patientIdentifier,
                      caseId: ctx.resolvedCaseId,
                      accessionNumber: metadata.accessionNumber,
                      modalities: [metadata.modality],
                      description: metadata.studyDescription,
                      bodyPart: metadata.bodyPartExamined,
                      studyDate: dicomDateToIso(metadata.studyDate),
                      studyTime: metadata.studyTime,
                      institutionName: metadata.institutionName,
                      referringPhysician: metadata.referringPhysicianName,
                      ownerUserId: ctx.ownerUserId,
                      workspaceId: ctx.workspaceId,
                      departmentId: ctx.departmentId,
                  },
                  actor
              )
          ).study.id;

    let series = (await deps.repo.listSeriesForStudy(studyId)).find((s) => s.seriesInstanceUid === metadata.seriesInstanceUid);
    if (!series) {
        series = await deps.repo.createSeries(studyId, { seriesInstanceUid: metadata.seriesInstanceUid, seriesNumber: metadata.seriesNumber, modality: metadata.modality, bodyPartExamined: metadata.bodyPartExamined }, actor);
    }

    const existingInstance = await deps.repo.findInstanceByUid(metadata.sopInstanceUid);
    if (existingInstance) {
        // Byte-identical re-send is a harmless no-op; a different payload
        // under the same SOPInstanceUID is a real anomaly (immutability
        // violation attempt) and is rejected, never silently overwritten.
        // "Keep original DICOM objects immutable" applies to re-ingestion
        // too, not just to in-place edits.
        if (existingInstance.checksumSha256 !== uploadChecksum) {
            const job = await deps.repo.updateIngestionJob(job0.id, { status: "rejected", failureCategory: "missing-required-identifiers" }, actor);
            return { job: job!, studyId, requiresReview: false };
        }
        const job = await deps.repo.updateIngestionJob(job0.id, { status: "published", studyId }, actor);
        return { job: job!, studyId, instanceId: existingInstance.id, requiresReview: false };
    }

    await deps.repo.updateIngestionJob(job0.id, { status: "publishing" }, actor);
    const stored = await deps.dicomweb.storeInstance({
        studyId,
        seriesId: series.id,
        instanceBytes: fileBytes,
        sopInstanceUid: metadata.sopInstanceUid,
        sopClassUid: metadata.sopClassUid,
        transferSyntaxUid: metadata.transferSyntaxUid,
    });
    const instance = await deps.repo.createInstance(
        series.id,
        {
            sopInstanceUid: metadata.sopInstanceUid,
            sopClassUid: metadata.sopClassUid,
            instanceNumber: metadata.instanceNumber,
            transferSyntaxUid: metadata.transferSyntaxUid,
            rows: metadata.rows,
            columns: metadata.columns,
            numberOfFrames: metadata.numberOfFrames,
            checksumSha256: stored.checksumSha256,
            objectStorageKey: stored.objectStorageKey,
            sizeBytes: stored.sizeBytes,
            hasThumbnail: false,
        },
        actor
    );
    await deps.repo.recordProvenance({ targetType: "instance", targetId: metadata.sopInstanceUid, action: "ingested", performedBy: `system:ingestion:${job0.id}`, performedAt: new Date().toISOString(), sourceRefs: [ctx.uploadId] });

    if (!existingStudy) {
        await deps.repo.updateStudy(studyId, { ingestionStatus: "published", status: "available" }, actor);
    }
    const job = await deps.repo.updateIngestionJob(job0.id, { status: "published", studyId }, actor);
    return { job: job!, studyId, instanceId: instance.id, requiresReview: false };
}

const ambiguousMatchQuarantineKey = (organizationId: string, jobId: string): string => `${organizationId}/ingestion-quarantine/${jobId}.dcm`;

export interface ResolveAmbiguousJobInput {
    jobId: string;
    /** "attach" requires caseId — the human's own determination of which
     * case this study actually belongs to. "reject" discards the held
     * bytes without ever creating a study. */
    decision: "attach" | "reject";
    caseId?: string;
    /** The reviewer resolving the job — becomes the new study's
     * ownerUserId on "attach" (the original uploader's id was never part
     * of ImagingIngestionJob's own public shape, by the same PHI-shaped-
     * metadata-minimization reasoning as the rest of this file). */
    resolvingUserId: string;
}

export class JobNotResolvableError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "JobNotResolvableError";
    }
}

/** Completes or discards a job that ingestOneInstance held as
 * "review-required" / "ambiguous-patient-match" — see that branch's own
 * comment for why the bytes are only quarantined (not published) at that
 * point. Never re-runs the ambiguity check: a human explicitly overriding
 * automatic matching is the entire point of this path. */
export async function resolveAmbiguousIngestionJob(
    deps: { repo: TenantImagingRepository; objectStore: ImagingObjectStore; dicomweb: DicomwebAdapter; organizationId: string },
    input: ResolveAmbiguousJobInput,
    actor: AuditActor
): Promise<IngestOneInstanceResult> {
    const job0 = await deps.repo.getIngestionJob(input.jobId);
    if (!job0) throw new JobNotResolvableError("No such ingestion job.");
    if (job0.status !== "review-required" || job0.failureCategory !== "ambiguous-patient-match") {
        throw new JobNotResolvableError("This job is not awaiting ambiguous-match resolution.");
    }
    const quarantineKey = ambiguousMatchQuarantineKey(deps.organizationId, job0.id);
    const fileBytes = await deps.objectStore.get(quarantineKey);

    if (input.decision === "reject") {
        await deps.objectStore.delete(quarantineKey);
        const job = await deps.repo.updateIngestionJob(job0.id, { status: "rejected" }, actor);
        return { job: job!, requiresReview: false };
    }

    if (!input.caseId) throw new JobNotResolvableError("caseId is required to attach this job to a case.");
    // Re-validates rather than trusting the quarantine copy blindly — cheap,
    // and it re-derives `metadata` without threading it through the job
    // record (which never carries parsed DICOM tag values, by design).
    const parsed = parseAndValidateDicom(fileBytes);
    const patientIdentifier = { value: parsed.metadata.patientId, issuer: parsed.metadata.issuerOfPatientId };
    const result = await publishInstance(
        deps,
        job0,
        parsed.metadata,
        patientIdentifier,
        sha256Hex(fileBytes),
        fileBytes,
        { uploadId: job0.uploadId, ownerUserId: input.resolvingUserId, resolvedCaseId: input.caseId },
        actor
    );
    await deps.objectStore.delete(quarantineKey);
    return result;
}

/** Generates and stores a thumbnail for one instance. Run separately from
 * ingestOneInstance (see this module's own doc comment on why), always
 * through the resource orchestrator at background-compute priority. */
export async function generateAndStoreThumbnail(
    deps: { repo: TenantImagingRepository; objectStore: ImagingObjectStore; organizationId: string },
    instanceId: string,
    instanceBytes: Buffer
): Promise<{ generated: boolean }> {
    const instance = await deps.repo.getInstance(instanceId);
    if (!instance) return { generated: false };
    let parsed;
    try {
        parsed = parseAndValidateDicom(instanceBytes);
    } catch {
        return { generated: false };
    }
    const thumbnail = generateThumbnail(parsed.dataSet, parsed.metadata.transferSyntaxUid);
    if (!thumbnail) return { generated: false };

    const key = `${deps.organizationId}/thumbnails/${instanceId}.png`;
    const stored = await deps.objectStore.put(key, thumbnail, "image/png");
    const provenance = await deps.repo.recordProvenance({ targetType: "instance", targetId: instanceId, action: "thumbnail-generated", performedBy: "system:thumbnail-job", performedAt: new Date().toISOString(), sourceRefs: [instanceId] });
    await deps.repo.createDerivedArtifact({
        kind: "thumbnail",
        sourceInstanceId: instanceId,
        objectStorageKey: key,
        checksumSha256: stored.checksumSha256,
        sizeBytes: stored.sizeBytes,
        provenance: {
            targetType: provenance.targetType,
            targetId: provenance.targetId,
            action: provenance.action,
            performedBy: provenance.performedBy,
            performedAt: provenance.performedAt,
            sourceRefs: provenance.sourceRefs,
            details: provenance.details,
        },
    });
    await deps.repo.markInstanceThumbnailed(instanceId);
    return { generated: true };
}

const PATH_SEPARATOR_PATTERN = new RegExp("[" + "/" + "\\\\" + "]", "g");

function sanitizeFileName(name: string): string {
    // Display-safe only, never used as a filesystem path (object storage
    // keys are always server-generated from UIDs, never from this value).
    // Strips path separators only; built via RegExp() rather than a
    // literal to sidestep an editor/tool encoding issue seen while
    // authoring this file with a literal character-class regex here.
    return name.replace(PATH_SEPARATOR_PATTERN, "").slice(0, 500);
}

function classifyParseFailure(err: unknown): "malformed-dicom" | "unsupported-transfer-syntax" | "missing-required-identifiers" | "internal-error" {
    if (err instanceof MalformedDicomError) return "malformed-dicom";
    if (err instanceof UnsupportedTransferSyntaxError) return "unsupported-transfer-syntax";
    if (err instanceof MissingRequiredIdentifiersError) return "missing-required-identifiers";
    if (err instanceof DicomBoundsExceededError) return "malformed-dicom";
    return "internal-error";
}
