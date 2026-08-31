import { z } from "zod";

/**
 * Clinical imaging — a dedicated domain (X-ray/MRI/CT/ultrasound and other
 * DICOM-derived diagnostic imaging), not a generic file-attachment system.
 * See docs/IMAGING.md for the full architecture, trust boundaries, and
 * disclosed limitations.
 *
 * Load-bearing invariants this schema layer encodes:
 *  - Original DICOM pixel data never appears here. `ImagingInstance` (below)
 *    carries only metadata — checksum, transfer syntax, sizes — never the
 *    pixel bytes themselves. Retrieval happens via WADO-RS through
 *    server/src/routes/imaging-dicomweb.ts, never through the change feed
 *    or any JSON API that includes this schema.
 *  - `StudyInstanceUID`/`SeriesInstanceUID`/`SOPInstanceUID` are DICOM
 *    identifiers, not tenant boundaries: every resource here also carries
 *    `organizationId`, and every lookup in the server layer is scoped by
 *    the pair, never the DICOM UID alone (two different tenants can
 *    legitimately have studies sharing the same UID — a real, adversarial-
 *    tested scenario, see server/src/routes/imaging-dicomweb.test.ts).
 *  - Reports are a separate, versioned, linked resource from the imaging
 *    study they describe — never embedded fields on the study.
 */

const identifierSchema = z.string().min(1).max(200);
const timestampSchema = z.string().datetime({ offset: true });
const dicomUidSchema = z.string().regex(/^[0-9.]{1,64}$/, "must be a valid DICOM UID (digits and dots only, max 64 chars)");
const sha256HexSchema = z.string().regex(/^[a-f0-9]{64}$/, "must be a lowercase hex SHA-256 digest");

// --- Patient identity (DICOM PatientID + IssuerOfPatientID) ---
//
// Deliberately NOT the same as PatientCase.patientId (packages/contracts's
// existing bare optional string) — DICOM patient matching needs the
// (issuer, value) pair to be safe (an MRN "12345" from Hospital A and
// "12345" from Hospital B are different patients). See docs/IMAGING.md's
// "Patient matching" section for the resolution algorithm and its
// deliberate ambiguous-match-requires-review behavior.
export const imagingPatientIdentifierSchema = z
    .object({
        value: z.string().min(1).max(200),
        issuer: z.string().min(1).max(200),
    })
    .strict();
export type ImagingPatientIdentifier = z.infer<typeof imagingPatientIdentifierSchema>;

export const imagingSensitivitySchema = z.enum(["normal", "restricted"]);
export const imagingIngestionStatusSchema = z.enum([
    "quarantined",
    "validating",
    "parsing",
    "matching",
    "review-required",
    "thumbnailing",
    "publishing",
    "published",
    "failed",
    "rejected",
]);
export const imagingStudyStatusSchema = z.enum(["registered", "available", "cancelled", "entered-in-error"]);

// --- ImagingStudy / ImagingSeries / ImagingInstance ---
// Loosely modeled on FHIR ImagingStudy (item 1's own requirement) — not a
// full FHIR resource server, just the shape, since this codebase has no
// FHIR server elsewhere to be consistent with.

export const imagingStudySchema = z
    .object({
        id: identifierSchema,
        studyInstanceUid: dicomUidSchema,
        patientIdentifier: imagingPatientIdentifierSchema,
        /** Set once patient matching resolves to a specific case — absent
         * while `ingestionStatus` is anything before "published" and match
         * confidence isn't yet certain. */
        caseId: identifierSchema.optional(),
        accessionNumber: z.string().max(200).optional(),
        modalities: z.array(z.string().min(1).max(20)).min(1).max(50),
        description: z.string().max(2_000).optional(),
        bodyPart: z.string().max(200).optional(),
        studyDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        studyTime: z.string().max(20).optional(),
        institutionName: z.string().max(500).optional(),
        referringPhysician: z.string().max(500).optional(),
        numberOfSeries: z.number().int().nonnegative(),
        numberOfInstances: z.number().int().nonnegative(),
        status: imagingStudyStatusSchema,
        sensitivity: imagingSensitivitySchema,
        ingestionStatus: imagingIngestionStatusSchema,
        /** Workspace/department scoping — mirrors CaseResourceAttributes,
         * used the same way for resource-level authorization. */
        workspaceId: identifierSchema.optional(),
        departmentId: identifierSchema.optional(),
        assignedUserIds: z.array(identifierSchema).max(1_000).optional(),
        createdAt: timestampSchema,
        updatedAt: timestampSchema,
        version: z.string().regex(/^\d+$/).optional(),
    })
    .strict()
    .refine((v) => v.updatedAt >= v.createdAt, { message: "updatedAt must not precede createdAt", path: ["updatedAt"] });
export type ImagingStudy = z.infer<typeof imagingStudySchema>;

export const imagingSeriesSchema = z
    .object({
        id: identifierSchema,
        studyId: identifierSchema,
        seriesInstanceUid: dicomUidSchema,
        seriesNumber: z.string().max(20).optional(),
        modality: z.string().min(1).max(20),
        bodyPartExamined: z.string().max(200).optional(),
        description: z.string().max(2_000).optional(),
        numberOfInstances: z.number().int().nonnegative(),
        createdAt: timestampSchema,
        updatedAt: timestampSchema,
    })
    .strict();
export type ImagingSeries = z.infer<typeof imagingSeriesSchema>;

/** Metadata only — see this file's own top doc comment. `objectStorageKey`
 * is intentionally NOT part of this type: it is a server-internal storage
 * detail, never serialized to a client (see ImagingObjectStore). */
export const imagingInstanceSchema = z
    .object({
        id: identifierSchema,
        seriesId: identifierSchema,
        sopInstanceUid: dicomUidSchema,
        sopClassUid: dicomUidSchema,
        instanceNumber: z.string().max(20).optional(),
        transferSyntaxUid: dicomUidSchema,
        rows: z.number().int().positive().optional(),
        columns: z.number().int().positive().optional(),
        numberOfFrames: z.number().int().positive().optional(),
        checksumSha256: sha256HexSchema,
        sizeBytes: z.number().int().nonnegative(),
        hasThumbnail: z.boolean(),
        createdAt: timestampSchema,
    })
    .strict();
export type ImagingInstance = z.infer<typeof imagingInstanceSchema>;

export const imagingResourceAttributesSchema = z
    .object({
        organizationId: identifierSchema,
        studyId: identifierSchema,
        patientIdentifier: imagingPatientIdentifierSchema,
        caseId: identifierSchema.optional(),
        ownerUserId: identifierSchema,
        workspaceId: identifierSchema.optional(),
        departmentId: identifierSchema.optional(),
        assignedUserIds: z.array(identifierSchema),
        sensitivity: imagingSensitivitySchema,
    })
    .strict();
export type ImagingResourceAttributes = z.infer<typeof imagingResourceAttributesSchema>;

// --- DiagnosticReport (FHIR-inspired) and amendments ---
//
// Immutable-row versioning, same pattern as PolicyVersion
// (server/src/domain/types.ts): an amendment/correction is a NEW row with
// `previousVersionId` set, never an in-place edit. The "current" report for
// a study is whichever row has status in (preliminary, final, amended,
// corrected) and no successor referencing it.

export const diagnosticReportStatusSchema = z.enum(["preliminary", "final", "amended", "corrected", "cancelled", "entered-in-error"]);

export const diagnosticReportSchema = z
    .object({
        id: identifierSchema,
        studyId: identifierSchema,
        status: diagnosticReportStatusSchema,
        conclusion: z.string().max(100_000),
        conclusionCode: z.string().max(200).optional(),
        authorUserId: identifierSchema,
        authoredAt: timestampSchema,
        signedByUserId: identifierSchema.optional(),
        signedAt: timestampSchema.optional(),
        /** Set only for amended/corrected reports — the row this one
         * supersedes. Never mutated once set. */
        previousVersionId: identifierSchema.optional(),
        amendmentReason: z.string().max(5_000).optional(),
        isCritical: z.boolean(),
        criticalAcknowledgedByUserId: identifierSchema.optional(),
        criticalAcknowledgedAt: timestampSchema.optional(),
        createdAt: timestampSchema,
        updatedAt: timestampSchema,
    })
    .strict()
    .refine((v) => (v.status === "amended" || v.status === "corrected") === (v.previousVersionId !== undefined), {
        message: "previousVersionId is required for (and only for) amended/corrected reports",
        path: ["previousVersionId"],
    })
    .refine((v) => (v.signedByUserId !== undefined) === (v.signedAt !== undefined), {
        message: "signedByUserId and signedAt must be set together",
        path: ["signedAt"],
    })
    .refine((v) => (v.criticalAcknowledgedByUserId !== undefined) === (v.criticalAcknowledgedAt !== undefined), {
        message: "criticalAcknowledgedByUserId and criticalAcknowledgedAt must be set together",
        path: ["criticalAcknowledgedAt"],
    });
export type DiagnosticReport = z.infer<typeof diagnosticReportSchema>;

// --- Annotations ---

export const imagingAnnotationKindSchema = z.enum(["measurement", "note", "region"]);
export const imagingAnnotationProvenanceSchema = z.enum(["human", "ai-generated"]);

export const imagingAnnotationSchema = z
    .object({
        id: identifierSchema,
        studyId: identifierSchema,
        seriesId: identifierSchema.optional(),
        instanceId: identifierSchema.optional(),
        frameNumber: z.number().int().positive().optional(),
        kind: imagingAnnotationKindSchema,
        /** Structured, renderer-specific shape data (points, ROI, measured
         * value+unit) — deliberately z.unknown(): this server never
         * interprets annotation geometry itself, only stores/authorizes/
         * audits it. The viewer integration owns the actual shape. */
        data: z.unknown(),
        text: z.string().max(20_000).optional(),
        authorUserId: identifierSchema,
        provenance: imagingAnnotationProvenanceSchema,
        createdAt: timestampSchema,
        updatedAt: timestampSchema,
        version: z.string().regex(/^\d+$/).optional(),
    })
    .strict();
export type ImagingAnnotation = z.infer<typeof imagingAnnotationSchema>;

// --- Provenance (derived artifacts: thumbnails, de-identified copies, AI outputs) ---

export const provenanceTargetTypeSchema = z.enum(["instance", "study", "report", "derivedArtifact"]);
export const provenanceActionSchema = z.enum(["ingested", "thumbnail-generated", "deidentified", "annotated", "ai-generated", "exported"]);

export const provenanceRecordSchema = z
    .object({
        id: identifierSchema,
        targetType: provenanceTargetTypeSchema,
        targetId: identifierSchema,
        action: provenanceActionSchema,
        performedBy: z.string().min(1).max(500), // a userId, or "system:<job-name>" for automated actions
        performedAt: timestampSchema,
        sourceRefs: z.array(identifierSchema).max(1_000),
        details: z.record(z.string(), z.unknown()).optional(),
    })
    .strict();
export type ProvenanceRecord = z.infer<typeof provenanceRecordSchema>;

export const derivedArtifactKindSchema = z.enum(["thumbnail", "deidentified-instance", "annotation-overlay", "ai-output"]);

export const derivedArtifactSchema = z
    .object({
        id: identifierSchema,
        kind: derivedArtifactKindSchema,
        sourceInstanceId: identifierSchema.optional(),
        sourceStudyId: identifierSchema.optional(),
        checksumSha256: sha256HexSchema,
        sizeBytes: z.number().int().nonnegative(),
        provenanceId: identifierSchema,
        createdAt: timestampSchema,
    })
    .strict();
export type DerivedArtifact = z.infer<typeof derivedArtifactSchema>;

// --- Sharing ---

export const imagingShareModeSchema = z.enum(["internal", "cross-organization", "external-portal"]);
export const imagingShareScopeSchema = z.enum(["study", "series", "instance", "report"]);
export const imagingShareStatusSchema = z.enum(["active", "revoked", "expired"]);

export const imagingShareGrantSchema = z
    .object({
        id: identifierSchema,
        mode: imagingShareModeSchema,
        scope: imagingShareScopeSchema,
        studyId: identifierSchema,
        seriesId: identifierSchema.optional(),
        instanceId: identifierSchema.optional(),
        reportId: identifierSchema.optional(),
        // Exactly one recipient identity, matching `mode`.
        recipientUserId: identifierSchema.optional(),
        recipientOrganizationId: identifierSchema.optional(),
        recipientEmail: z.string().email().optional(),
        recipientName: z.string().max(500).optional(),
        purposeOfUse: z.string().min(1).max(500),
        message: z.string().max(5_000).optional(),
        expiresAt: timestampSchema,
        allowDownload: z.boolean(),
        issuedByUserId: identifierSchema,
        consentBasis: z.string().min(1).max(500),
        status: imagingShareStatusSchema,
        revokedByUserId: identifierSchema.optional(),
        revokedAt: timestampSchema.optional(),
        createdAt: timestampSchema,
    })
    .strict()
    .refine((v) => v.mode !== "internal" || v.recipientUserId !== undefined, { message: "internal shares require recipientUserId", path: ["recipientUserId"] })
    .refine((v) => v.mode !== "cross-organization" || (v.recipientUserId !== undefined && v.recipientOrganizationId !== undefined), {
        message: "cross-organization shares require recipientUserId and recipientOrganizationId",
        path: ["recipientOrganizationId"],
    })
    .refine((v) => v.mode !== "external-portal" || v.recipientEmail !== undefined, { message: "external-portal shares require recipientEmail", path: ["recipientEmail"] })
    .refine((v) => v.mode !== "external-portal" || v.allowDownload === false, {
        message: "external-portal shares must not allow download by default (item 11)",
        path: ["allowDownload"],
    })
    .refine((v) => (v.status === "revoked") === (v.revokedAt !== undefined), { message: "revokedAt is required for (and only for) revoked status", path: ["revokedAt"] });
export type ImagingShareGrant = z.infer<typeof imagingShareGrantSchema>;

// --- Ingestion ---

export const ingestionFailureCategorySchema = z.enum([
    "invalid-file-type",
    "file-too-large",
    "malformed-dicom",
    "unsupported-transfer-syntax",
    "missing-required-identifiers",
    "ambiguous-patient-match",
    "storage-error",
    "internal-error",
]);

export const imagingIngestionJobSchema = z
    .object({
        id: identifierSchema,
        uploadId: identifierSchema,
        /** Sanitized for display — never a raw client-supplied path. */
        fileName: z.string().max(1_000),
        sizeBytes: z.number().int().nonnegative(),
        checksumSha256: sha256HexSchema.optional(),
        status: imagingIngestionStatusSchema,
        studyId: identifierSchema.optional(),
        /** PHI-safe by construction: a closed category, never free text
         * derived from file content (item 5's "record failures without
         * exposing PHI"). */
        failureCategory: ingestionFailureCategorySchema.optional(),
        createdAt: timestampSchema,
        updatedAt: timestampSchema,
    })
    .strict();
export type ImagingIngestionJob = z.infer<typeof imagingIngestionJobSchema>;

// --- Viewer sessions ---

export const viewerSessionScopeSchema = z
    .object({
        studyId: identifierSchema,
        seriesIds: z.array(identifierSchema).optional(),
        instanceIds: z.array(identifierSchema).optional(),
    })
    .strict();

export const viewerSessionGrantedActionSchema = z.enum(["view", "measure", "download"]);

/** The server-issued response — never includes the raw token in a form a
 * client could persist insecurely; the token itself is a separate,
 * write-once field in the create response, not part of this stored/listed
 * shape (mirrors ScimToken/Invitation's own tokenHash-never-round-tripped
 * pattern). */
export const viewerSessionSchema = z
    .object({
        id: identifierSchema,
        scope: viewerSessionScopeSchema,
        grantedActions: z.array(viewerSessionGrantedActionSchema).min(1),
        shareGrantId: identifierSchema.optional(),
        issuedAt: timestampSchema,
        expiresAt: timestampSchema,
        revoked: z.boolean(),
    })
    .strict();
export type ViewerSession = z.infer<typeof viewerSessionSchema>;

// --- Change feed (metadata + reports + share grants + tombstones — NEVER
// pixel data, per this file's own top doc comment) ---

export const imagingChangeResourceTypeSchema = z.enum(["study", "report", "shareGrant"]);

export const imagingChangeSchema = z.discriminatedUnion("kind", [
    z
        .object({
            sequence: z.string().regex(/^\d+$/),
            kind: z.literal("upsert"),
            resourceType: imagingChangeResourceTypeSchema,
            resourceId: identifierSchema,
            studyId: identifierSchema,
            changedAt: timestampSchema,
            study: imagingStudySchema.optional(),
            report: diagnosticReportSchema.optional(),
            shareGrant: imagingShareGrantSchema.optional(),
        })
        .strict(),
    z
        .object({
            sequence: z.string().regex(/^\d+$/),
            kind: z.literal("delete"),
            resourceType: imagingChangeResourceTypeSchema,
            resourceId: identifierSchema,
            studyId: identifierSchema,
            changedAt: timestampSchema,
        })
        .strict(),
]);
export type ImagingChange = z.infer<typeof imagingChangeSchema>;

export const imagingChangeFeedSchema = z.object({ changes: z.array(imagingChangeSchema), cursor: z.string().regex(/^\d+$/) }).strict();
export type ImagingChangeFeed = z.infer<typeof imagingChangeFeedSchema>;

// --- De-identification ---

export const deidentificationProfileSchema = z.enum(["basic", "clean-pixel-data", "retain-longitudinal-full-dates", "retain-safe-private"]);
export const deidentificationReviewStatusSchema = z.enum(["pending-review", "approved", "rejected", "auto-approved"]);

export const deidentificationJobSchema = z
    .object({
        id: identifierSchema,
        sourceStudyId: identifierSchema,
        profile: deidentificationProfileSchema,
        purpose: z.enum(["research", "teaching", "external-export"]),
        /** True if OCR-based burned-in-text detection found probable text
         * in pixel data — always forces reviewStatus to pending-review
         * regardless of profile (item 13's "mandatory human review when
         * automated de-identification is uncertain"). */
        burnedInTextSuspected: z.boolean(),
        recognizableFeaturesFlagged: z.boolean(),
        reviewStatus: deidentificationReviewStatusSchema,
        reviewedByUserId: identifierSchema.optional(),
        reviewedAt: timestampSchema.optional(),
        resultArtifactId: identifierSchema.optional(),
        requestedByUserId: identifierSchema,
        createdAt: timestampSchema,
        updatedAt: timestampSchema,
    })
    .strict();
export type DeidentificationJob = z.infer<typeof deidentificationJobSchema>;

// --- Non-DICOM documents (FHIR DocumentReference-inspired) ---

export const documentReferenceSchema = z
    .object({
        id: identifierSchema,
        studyId: identifierSchema.optional(),
        caseId: identifierSchema.optional(),
        title: z.string().min(1).max(2_000),
        contentType: z.string().min(1).max(200),
        sizeBytes: z.number().int().nonnegative(),
        checksumSha256: sha256HexSchema,
        authorUserId: identifierSchema,
        createdAt: timestampSchema,
    })
    .strict();
export type DocumentReference = z.infer<typeof documentReferenceSchema>;
