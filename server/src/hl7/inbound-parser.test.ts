import { diagnosticReportSchema, imagingStudySchema } from "@modelforge/contracts";
import { describe, expect, it } from "vitest";
import { Hl7ParseError } from "./message.js";
import { parseOruR01 } from "./inbound-parser.js";
import { buildOruR01 } from "./oru-builder.js";

const SAMPLE_ORU = [
    "MSH|^~\\&|LAB|HOSPITAL|EHR|HOSPITAL|20260315120000||ORU^R01|MSG00001|P|2.5.1",
    "PID|1||MRN-001^^^TEST-HOSPITAL||",
    "OBR|1|||CBC^Complete Blood Count|||20260315110000",
    "OBX|1|NM|2345-7^Glucose^LN||95|mg/dL|70-99|N|||F|||20260315113000",
    "OBX|2|NM|718-7^Hemoglobin^LN||14.2|g/dL|13.5-17.5|N|||F|||20260315113000",
].join("\r");

describe("parseOruR01", () => {
    it("parses message control id, patient identifier, and every OBX as an observation", () => {
        const parsed = parseOruR01(SAMPLE_ORU);
        expect(parsed.messageControlId).toBe("MSG00001");
        expect(parsed.patientIdentifier).toEqual({ value: "MRN-001", issuer: "TEST-HOSPITAL" });
        expect(parsed.observations).toHaveLength(2);
    });

    it("prefers the human-readable text component of OBX-3 over the raw code", () => {
        const parsed = parseOruR01(SAMPLE_ORU);
        expect(parsed.observations[0].name).toBe("Glucose");
        expect(parsed.observations[1].name).toBe("Hemoglobin");
    });

    it("extracts value/unit/referenceRange from the correct OBX fields", () => {
        const parsed = parseOruR01(SAMPLE_ORU);
        expect(parsed.observations[0]).toMatchObject({ value: "95", unit: "mg/dL", referenceRange: "70-99" });
    });

    it("parses OBX-14 into an ISO observedAt timestamp", () => {
        const parsed = parseOruR01(SAMPLE_ORU);
        expect(parsed.observations[0].observedAt).toBe("2026-03-15T11:30:00.000Z");
    });

    it("every observation gets a fresh synthetic id — never the same id across two parses of the same message", () => {
        const first = parseOruR01(SAMPLE_ORU);
        const second = parseOruR01(SAMPLE_ORU);
        expect(first.observations[0].id).not.toBe(second.observations[0].id);
    });

    it("returns undefined patientIdentifier for a message with no PID segment, rather than throwing", () => {
        const noPid = SAMPLE_ORU.split("\r").filter((line) => !line.startsWith("PID")).join("\r");
        expect(parseOruR01(noPid).patientIdentifier).toBeUndefined();
    });

    it("returns an empty observations array for a message with no OBX segments", () => {
        const noObx = SAMPLE_ORU.split("\r").filter((line) => !line.startsWith("OBX")).join("\r");
        expect(parseOruR01(noObx).observations).toEqual([]);
    });

    it("rejects a non-ORU message type with Hl7ParseError, never silently parsing it as one", () => {
        const adt = SAMPLE_ORU.replace("ORU^R01", "ADT^A01");
        expect(() => parseOruR01(adt)).toThrow(Hl7ParseError);
        expect(() => parseOruR01(adt)).toThrow(/Expected an ORU message type/);
    });

    it("round-trips through buildOruR01: parsing what this codebase itself built recovers the same patient identifier and conclusion", () => {
        const report = diagnosticReportSchema.parse({
            id: "report-1", studyId: "study-1", status: "final", conclusion: "No acute findings.",
            authorUserId: "user-1", authoredAt: "2026-03-15T10:00:00.000Z", isCritical: false,
            createdAt: "2026-03-15T10:00:00.000Z", updatedAt: "2026-03-15T10:00:00.000Z",
        });
        const study = imagingStudySchema.parse({
            id: "study-1", studyInstanceUid: "1.2.3.4", patientIdentifier: { value: "MRN-999", issuer: "ROUND-TRIP-HOSPITAL" },
            modalities: ["CT"], numberOfSeries: 1, numberOfInstances: 1, status: "available", sensitivity: "normal",
            ingestionStatus: "published", createdAt: "2026-03-15T00:00:00.000Z", updatedAt: "2026-03-15T00:00:00.000Z",
        });
        const raw = buildOruR01(report, study, { sendingApplication: "ModelForge", sendingFacility: "Example", receivingApplication: "EHR", receivingFacility: "Example" });
        const parsed = parseOruR01(raw);
        expect(parsed.patientIdentifier).toEqual({ value: "MRN-999", issuer: "ROUND-TRIP-HOSPITAL" });
        expect(parsed.observations[0].value).toBe("No acute findings.");
    });
});
