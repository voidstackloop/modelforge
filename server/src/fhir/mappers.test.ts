import { diagnosticReportSchema, documentReferenceSchema, imagingStudySchema } from "@modelforge/contracts";
import { describe, expect, it } from "vitest";
import type { ImagingSeriesRecord } from "../store/imaging-store.js";
import { patientCaseFixture } from "../test/patient-case-fixture.js";
import { fhirBundle, fhirNotFound, mapSexToFhirGender, toFhirDiagnosticReport, toFhirDocumentReference, toFhirImagingStudy, toFhirPatient } from "./mappers.js";

const SHA256_HEX = "a".repeat(64);

describe("fhir mappers", () => {
    describe("mapSexToFhirGender", () => {
        it.each([
            ["male", "male"],
            ["Male", "male"],
            ["m", "male"],
            ["female", "female"],
            ["F", "female"],
            [undefined, "unknown"],
            ["", "unknown"],
            ["nonbinary", "other"],
        ] as const)("maps %s to %s", (input, expected) => {
            expect(mapSexToFhirGender(input)).toBe(expected);
        });
    });

    it("toFhirPatient carries identifier, gender, and a reported-age extension, but never fabricates name/birthDate", () => {
        const patientCase = patientCaseFixture("case-1", { demographics: { value: { age: "42", sex: "female" }, includeInContext: false } });
        const patient = toFhirPatient(patientCase, "MRN-001");
        expect(patient).toEqual({
            resourceType: "Patient",
            id: "MRN-001",
            meta: { lastUpdated: patientCase.updatedAt },
            active: true,
            identifier: [{ system: "urn:modelforge:patientId", value: "MRN-001" }],
            gender: "female",
            extension: [{ url: "urn:modelforge:extension:reportedAge", valueString: "42" }],
        });
        expect(patient).not.toHaveProperty("name");
        expect(patient).not.toHaveProperty("birthDate");
    });

    it("toFhirPatient omits the extension entirely when no age was recorded", () => {
        const patientCase = patientCaseFixture("case-2");
        const patient = toFhirPatient(patientCase, "MRN-002");
        expect(patient.extension).toBeUndefined();
    });

    it("toFhirDiagnosticReport maps status/conclusion and references the source ImagingStudy and Patient", () => {
        const study = imagingStudySchema.parse({
            id: "study-1",
            studyInstanceUid: "1.2.3.4",
            patientIdentifier: { value: "MRN-001", issuer: "TEST-HOSPITAL" },
            modalities: ["CT"],
            numberOfSeries: 1,
            numberOfInstances: 1,
            status: "available",
            sensitivity: "normal",
            ingestionStatus: "published",
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
        });
        const report = diagnosticReportSchema.parse({
            id: "report-1",
            studyId: "study-1",
            status: "final",
            conclusion: "No acute findings.",
            authorUserId: "user-1",
            authoredAt: "2026-01-02T00:00:00.000Z",
            signedByUserId: "user-1",
            signedAt: "2026-01-02T01:00:00.000Z",
            isCritical: false,
            createdAt: "2026-01-02T00:00:00.000Z",
            updatedAt: "2026-01-02T01:00:00.000Z",
        });
        const fhirReport = toFhirDiagnosticReport(report, study);
        expect(fhirReport.status).toBe("final");
        expect(fhirReport.conclusion).toBe("No acute findings.");
        expect(fhirReport.subject).toEqual({ reference: "Patient/MRN-001" });
        expect(fhirReport.imagingStudy).toEqual([{ reference: "ImagingStudy/study-1" }]);
        expect(fhirReport.issued).toBe("2026-01-02T01:00:00.000Z");
    });

    it("toFhirImagingStudy maps modalities to DICOM codings and embeds series", () => {
        const study = imagingStudySchema.parse({
            id: "study-2",
            studyInstanceUid: "1.2.3.5",
            patientIdentifier: { value: "MRN-002", issuer: "TEST-HOSPITAL" },
            modalities: ["MR"],
            description: "Brain MRI",
            studyDate: "2026-02-01",
            numberOfSeries: 1,
            numberOfInstances: 3,
            status: "available",
            sensitivity: "normal",
            ingestionStatus: "published",
            createdAt: "2026-02-01T00:00:00.000Z",
            updatedAt: "2026-02-01T00:00:00.000Z",
        });
        const series: ImagingSeriesRecord[] = [
            { id: "series-1", studyId: "study-2", seriesInstanceUid: "1.2.3.5.1", seriesNumber: "1", modality: "MR", numberOfInstances: 3, createdAt: study.createdAt, updatedAt: study.updatedAt },
        ];
        const fhirStudy = toFhirImagingStudy(study, series);
        expect(fhirStudy.status).toBe("available");
        expect(fhirStudy.modality).toEqual([{ system: "urn:oid:1.2.840.10008.2.16.4", code: "MR" }]);
        expect(fhirStudy.series).toEqual([{ uid: "1.2.3.5.1", number: 1, modality: { system: "urn:oid:1.2.840.10008.2.16.4", code: "MR" }, description: undefined, numberOfInstances: 3 }]);
        expect(fhirStudy.started).toBe("2026-02-01T00:00:00Z");
    });

    it("toFhirDocumentReference is always status current, since this system tracks no other document lifecycle state", () => {
        const doc = documentReferenceSchema.parse({
            id: "doc-1",
            title: "Referral letter",
            contentType: "application/pdf",
            sizeBytes: 1024,
            checksumSha256: SHA256_HEX,
            authorUserId: "user-1",
            createdAt: "2026-01-01T00:00:00.000Z",
        });
        const fhirDoc = toFhirDocumentReference(doc);
        expect(fhirDoc.status).toBe("current");
        expect(fhirDoc.content).toEqual([{ attachment: { contentType: "application/pdf", size: 1024, hash: SHA256_HEX, title: "Referral letter" } }]);
    });

    it("fhirNotFound and fhirBundle produce spec-shaped envelopes", () => {
        expect(fhirNotFound("Patient", "abc")).toEqual({
            resourceType: "OperationOutcome",
            issue: [{ severity: "error", code: "not-found", diagnostics: "Patient/abc was not found or is not accessible." }],
        });
        expect(fhirBundle([{ resourceType: "DocumentReference" }])).toEqual({
            resourceType: "Bundle",
            type: "searchset",
            total: 1,
            entry: [{ resource: { resourceType: "DocumentReference" } }],
        });
    });
});
