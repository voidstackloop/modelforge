import type {
    DiagnosticReport,
    DocumentReference,
    FhirBundle,
    FhirDiagnosticReport,
    FhirDocumentReference,
    FhirImagingStudy,
    FhirOperationOutcome,
    FhirPatient,
    ImagingStudy,
    PatientCase,
} from "@modelforge/contracts";
import { fhirBundleSchema, fhirDiagnosticReportSchema, fhirDocumentReferenceSchema, fhirImagingStudySchema, fhirOperationOutcomeSchema, fhirPatientSchema } from "@modelforge/contracts";
import type { ImagingSeriesRecord } from "../store/imaging-store.js";

/**
 * Pure PatientCase/ImagingStudy/DiagnosticReport/DocumentReference -> FHIR R4
 * JSON mappers. No I/O, no authorization — routes/fhir.ts owns both of
 * those; this module only ever transforms already-authorized, already-
 * fetched domain objects. See @modelforge/contracts's fhir.ts for the
 * schemas and this file's overall scope statement.
 *
 * Every `toFhir*` function ends with `.parse(...)` against the matching
 * schema — deliberately, so a future field added to a FHIR schema without a
 * matching mapper update fails loudly in tests (a missing required field)
 * rather than silently shipping an incomplete resource.
 */

const DICOM_MODALITY_SYSTEM = "urn:oid:1.2.840.10008.2.16.4" as const; // DICOM Ontology (DCM) CID 29 code system

type FhirAdministrativeGender = "male" | "female" | "other" | "unknown";

/**
 * Best-effort mapping from this system's free-text `demographics.sex` case
 * field onto FHIR's coded `Patient.gender` (administrative gender, not a
 * clinical assertion). A value this doesn't recognize maps to "unknown"
 * rather than being guessed at or omitted-as-error — FHIR's own definition
 * of "unknown" is exactly "The gender is not known" ,which a free-text field
 * this system never validated at entry time genuinely can be.
 */
export function mapSexToFhirGender(sex: string | undefined): FhirAdministrativeGender {
    if (!sex) return "unknown";
    const normalized = sex.trim().toLowerCase();
    if (["male", "m"].includes(normalized)) return "male";
    if (["female", "f"].includes(normalized)) return "female";
    if (normalized.length === 0) return "unknown";
    return "other";
}

export function toFhirPatient(patientCase: PatientCase, resourcePatientId: string): FhirPatient {
    const age = patientCase.demographics.value.age;
    return fhirPatientSchema.parse({
        resourceType: "Patient",
        id: resourcePatientId,
        meta: { lastUpdated: patientCase.updatedAt },
        active: true,
        identifier: [{ system: "urn:modelforge:patientId", value: resourcePatientId }],
        gender: mapSexToFhirGender(patientCase.demographics.value.sex),
        extension: age ? [{ url: "urn:modelforge:extension:reportedAge", valueString: age }] : undefined,
    } satisfies FhirPatient);
}

const DIAGNOSTIC_REPORT_CODE_TEXT = "Diagnostic imaging report";

export function toFhirDiagnosticReport(report: DiagnosticReport, study: ImagingStudy): FhirDiagnosticReport {
    return fhirDiagnosticReportSchema.parse({
        resourceType: "DiagnosticReport",
        id: report.id,
        meta: { lastUpdated: report.updatedAt },
        status: report.status,
        code: { text: DIAGNOSTIC_REPORT_CODE_TEXT },
        subject: { reference: `Patient/${study.patientIdentifier.value}` },
        issued: report.signedAt ?? report.authoredAt,
        effectiveDateTime: report.authoredAt,
        conclusion: report.conclusion,
        conclusionCode: report.conclusionCode ? [{ text: report.conclusionCode }] : undefined,
        imagingStudy: [{ reference: `ImagingStudy/${study.id}` }],
    } satisfies FhirDiagnosticReport);
}

export function toFhirImagingStudy(study: ImagingStudy, series: ImagingSeriesRecord[]): FhirImagingStudy {
    return fhirImagingStudySchema.parse({
        resourceType: "ImagingStudy",
        id: study.id,
        meta: { lastUpdated: study.updatedAt },
        status: study.status,
        identifier: [{ system: "urn:dicom:uid", value: `urn:oid:${study.studyInstanceUid}` }],
        modality: study.modalities.map((code) => ({ system: DICOM_MODALITY_SYSTEM, code })),
        subject: { reference: `Patient/${study.patientIdentifier.value}` },
        started: study.studyDate ? `${study.studyDate}T${(study.studyTime ?? "00:00:00").padEnd(8, "0").slice(0, 8)}Z` : undefined,
        numberOfSeries: study.numberOfSeries,
        numberOfInstances: study.numberOfInstances,
        description: study.description,
        series: series.map((s) => ({
            uid: s.seriesInstanceUid,
            number: s.seriesNumber ? Number(s.seriesNumber) : undefined,
            modality: { system: DICOM_MODALITY_SYSTEM, code: s.modality },
            description: s.description,
            numberOfInstances: s.numberOfInstances,
        })),
    } satisfies FhirImagingStudy);
}

/**
 * Always `status: "current"` — see @modelforge/contracts's fhir.ts doc
 * comment on fhirDocumentReferenceStatusSchema for why this system has no
 * superseded/entered-in-error lifecycle to map from.
 */
export function toFhirDocumentReference(doc: DocumentReference): FhirDocumentReference {
    return fhirDocumentReferenceSchema.parse({
        resourceType: "DocumentReference",
        id: doc.id,
        status: "current",
        date: doc.createdAt,
        content: [{ attachment: { contentType: doc.contentType, size: doc.sizeBytes, hash: doc.checksumSha256, title: doc.title } }],
    } satisfies FhirDocumentReference);
}

export function fhirNotFound(resourceType: string, id: string): FhirOperationOutcome {
    return fhirOperationOutcomeSchema.parse({
        resourceType: "OperationOutcome",
        issue: [{ severity: "error", code: "not-found", diagnostics: `${resourceType}/${id} was not found or is not accessible.` }],
    } satisfies FhirOperationOutcome);
}

export function fhirBundle(resources: unknown[]): FhirBundle {
    return fhirBundleSchema.parse({
        resourceType: "Bundle",
        type: "searchset",
        total: resources.length,
        entry: resources.map((resource) => ({ resource })),
    } satisfies FhirBundle);
}
