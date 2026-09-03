import { diagnosticReportSchema, imagingStudySchema } from "@modelforge/contracts";
import { describe, expect, it } from "vitest";
import { getField, parseHl7Message, unescapeHl7Text } from "./message.js";
import { buildOruR01 } from "./oru-builder.js";

const CONTEXT = { sendingApplication: "ModelForge", sendingFacility: "Example Health System", receivingApplication: "EHR", receivingFacility: "Example Health System", messageControlId: "MSG-TEST-001", now: new Date("2026-03-15T14:30:00Z") };

function study(overrides: Partial<Parameters<typeof imagingStudySchema.parse>[0]> = {}) {
    return imagingStudySchema.parse({
        id: "study-1",
        studyInstanceUid: "1.2.3.4",
        patientIdentifier: { value: "MRN-001", issuer: "TEST-HOSPITAL" },
        modalities: ["CT"],
        numberOfSeries: 1,
        numberOfInstances: 1,
        status: "available",
        sensitivity: "normal",
        ingestionStatus: "published",
        createdAt: "2026-03-15T00:00:00.000Z",
        updatedAt: "2026-03-15T00:00:00.000Z",
        ...overrides,
    });
}

function report(overrides: Partial<Parameters<typeof diagnosticReportSchema.parse>[0]> = {}) {
    return diagnosticReportSchema.parse({
        id: "report-1",
        studyId: "study-1",
        status: "final",
        conclusion: "No acute findings.",
        authorUserId: "user-1",
        authoredAt: "2026-03-15T10:00:00.000Z",
        signedByUserId: "user-1",
        signedAt: "2026-03-15T10:30:00.000Z",
        isCritical: false,
        createdAt: "2026-03-15T10:00:00.000Z",
        updatedAt: "2026-03-15T10:30:00.000Z",
        ...overrides,
    });
}

describe("buildOruR01", () => {
    it("produces a parseable ORU^R01 message with correct header fields", () => {
        const raw = buildOruR01(report(), study(), CONTEXT);
        const message = parseHl7Message(raw);
        const msh = message.segments[0];
        expect(getField(msh, 9)).toBe("ORU^R01");
        expect(getField(msh, 10)).toBe("MSG-TEST-001");
        expect(getField(msh, 11)).toBe("P");
        expect(getField(msh, 12)).toBe("2.5.1");
        expect(getField(msh, 3)).toBe("ModelForge");
        expect(getField(msh, 4)).toBe("Example Health System");
        expect(getField(msh, 7)).toBe("20260315143000");
    });

    it("PID-3 encodes the patient identifier as id^^^issuer", () => {
        const raw = buildOruR01(report(), study(), CONTEXT);
        const message = parseHl7Message(raw);
        const pid = message.segments.find((s) => s.id === "PID")!;
        expect(getField(pid, 3)).toBe("MRN-001^^^TEST-HOSPITAL");
    });

    it("never fabricates a patient name or birth date — same disclosed gap as the FHIR Patient mapper", () => {
        const raw = buildOruR01(report(), study(), CONTEXT);
        const message = parseHl7Message(raw);
        const pid = message.segments.find((s) => s.id === "PID")!;
        expect(getField(pid, 5)).toBe("");
        expect(getField(pid, 7)).toBe("");
    });

    it("OBR-4 carries a local, uncoded service identifier rather than a fabricated LOINC/CPT code", () => {
        const raw = buildOruR01(report(), study(), CONTEXT);
        const message = parseHl7Message(raw);
        const obr = message.segments.find((s) => s.id === "OBR")!;
        expect(getField(obr, 4)).toBe("DX-REPORT^Diagnostic imaging report");
    });

    it.each([
        ["preliminary", "P"],
        ["final", "F"],
        ["amended", "C"],
        ["corrected", "C"],
        ["cancelled", "X"],
    ] as const)("maps DiagnosticReport.status %s to HL7 v2 result status %s", (status, expected) => {
        const r = status === "amended" || status === "corrected"
            ? report({ status, previousVersionId: "report-0", amendmentReason: "correction" })
            : report({ status });
        const raw = buildOruR01(r, study(), CONTEXT);
        const message = parseHl7Message(raw);
        const obr = message.segments.find((s) => s.id === "OBR")!;
        expect(getField(obr, 25)).toBe(expected);
    });

    it("emits exactly one CONCLUSION OBX for a report with no conclusionCode and not critical", () => {
        const raw = buildOruR01(report(), study(), CONTEXT);
        const message = parseHl7Message(raw);
        const obxSegments = message.segments.filter((s) => s.id === "OBX");
        expect(obxSegments).toHaveLength(1);
        expect(unescapeHl7Text(getField(obxSegments[0], 5))).toBe("No acute findings.");
    });

    it("adds a second OBX for conclusionCode when present", () => {
        const raw = buildOruR01(report({ conclusionCode: "R91.8" }), study(), CONTEXT);
        const message = parseHl7Message(raw);
        const obxSegments = message.segments.filter((s) => s.id === "OBX");
        expect(obxSegments).toHaveLength(2);
        expect(getField(obxSegments[1], 5)).toBe("R91.8");
    });

    it("adds a critical-flag OBX when the report is marked critical, after any conclusionCode OBX", () => {
        const raw = buildOruR01(report({ conclusionCode: "R91.8", isCritical: true }), study(), CONTEXT);
        const message = parseHl7Message(raw);
        const obxSegments = message.segments.filter((s) => s.id === "OBX");
        expect(obxSegments).toHaveLength(3);
        expect(getField(obxSegments[2], 3)).toContain("CRITICAL-FLAG");
        expect(getField(obxSegments[2], 1)).toBe("3");
    });

    it("escapes delimiter characters in the conclusion text and recovers the exact original after parsing", () => {
        const tricky = "Impression: mild finding & concern (ratio 3|4, class^A~B)";
        const raw = buildOruR01(report({ conclusion: tricky }), study(), CONTEXT);
        // The raw message must still be well-formed HL7 (parseable at all,
        // i.e. the embedded "|" never created a spurious extra field).
        const message = parseHl7Message(raw);
        const obx = message.segments.find((s) => s.id === "OBX")!;
        expect(unescapeHl7Text(getField(obx, 5))).toBe(tricky);
    });

    it("generates a random, non-empty messageControlId when none is supplied", () => {
        const raw = buildOruR01(report(), study(), { ...CONTEXT, messageControlId: undefined });
        const message = parseHl7Message(raw);
        expect(getField(message.segments[0], 10).length).toBeGreaterThan(0);
    });
});
