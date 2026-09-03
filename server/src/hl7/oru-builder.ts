import type { DiagnosticReport, ImagingStudy } from "@modelforge/contracts";
import { buildHl7Message, buildSegment, DEFAULT_ENCODING_CHARACTERS, escapeHl7Text, type Hl7Message } from "./message.js";

/**
 * Builds an HL7 v2.5.1 ORU^R01 (unsolicited observation result) message
 * from this system's own DiagnosticReport/ImagingStudy/PatientCase — the
 * outbound half of "HL7 v2 support," mirroring exactly what
 * server/src/fhir/mappers.ts's `toFhirDiagnosticReport` does for FHIR: a
 * pure, from-scratch mapping over data this codebase already has, not a
 * new persistence layer or a claim of conformance to any specific
 * receiving system's implementation guide (real HL7 v2 integrations are
 * always conformance-tested per trading partner — see
 * docs/HL7_V2_INTEGRATION.md).
 *
 * Segment structure: MSH (message header) / PID (patient identification,
 * built entirely from `ImagingStudy.patientIdentifier` — same disclosed
 * limitation as FHIR's own Patient mapping — no structured name or birth
 * date exists anywhere in this system's domain model, so PID-5/PID-7 are
 * left empty rather than fabricated, and there is no separate PatientCase
 * parameter here at all since nothing in this mapping reads one) / OBR
 * (the report itself) / one OBX per report field this maps (conclusion,
 * conclusion code, critical flag) — OBX-2 "TX" (text), the correct HL7 v2
 * value type for free-text narrative content, never a coded value this
 * system has no real terminology binding for.
 */

export interface OruMessageContext {
    sendingApplication: string;
    sendingFacility: string;
    receivingApplication: string;
    receivingFacility: string;
    /** Defaults to a freshly-generated UUID — pass an explicit one only for
     * deterministic tests. */
    messageControlId?: string;
    /** Defaults to "P" (production) — "T" (test)/"D" (debug) per HL7 v2's
     * own MSH-11 processing-id values, for a non-production environment
     * that still wants a realistic message shape. */
    processingId?: "P" | "T" | "D";
    /** Defaults to `new Date()` — overridable only for deterministic tests. */
    now?: Date;
}

function hl7Timestamp(date: Date): string {
    // HL7 v2's own TS data type, to-the-second precision (YYYYMMDDHHMMSS) —
    // this codebase has no sub-second-meaningful clinical event here to
    // justify finer precision, and to-the-second is the most common real-
    // world granularity for this field.
    const pad = (n: number, width = 2) => String(n).padStart(width, "0");
    return `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}`;
}

/** HL7 v2's OBR-25/OBX-11 "result status" — the closest standard code set
 * to this system's own DiagnosticReport.status; "final"/"corrected" map
 * cleanly, the rest fall back to the nearest honest equivalent rather than
 * a fabricated one-to-one that doesn't exist in the HL7 v2 table. */
const RESULT_STATUS: Record<DiagnosticReport["status"], string> = {
    preliminary: "P",
    final: "F",
    amended: "C", // "corrected", HL7 v2's own closest match to an amendment
    corrected: "C",
    cancelled: "X",
    "entered-in-error": "W", // "wrong patient" - table 0085 has no generic "entered in error"; nearest documented reason a result would be withdrawn
};

function randomMessageControlId(): string {
    return `MF${Date.now().toString(36).toUpperCase()}${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
}

export function buildOruR01(report: DiagnosticReport, study: ImagingStudy, context: OruMessageContext): string {
    const now = context.now ?? new Date();
    const encoding = DEFAULT_ENCODING_CHARACTERS;
    const esc = (value: string) => escapeHl7Text(value, encoding);

    const msh = buildSegment("MSH", {
        1: encoding.field,
        2: `${encoding.component}${encoding.repetition}${encoding.escape}${encoding.subcomponent}`,
        3: esc(context.sendingApplication),
        4: esc(context.sendingFacility),
        5: esc(context.receivingApplication),
        6: esc(context.receivingFacility),
        7: hl7Timestamp(now),
        9: "ORU^R01",
        10: context.messageControlId ?? randomMessageControlId(),
        11: context.processingId ?? "P",
        12: "2.5.1",
    });

    // PID-3 (patient identifier list): this system's ImagingStudy.patientIdentifier
    // is an {issuer, value} pair — HL7 v2's own PID-3 repeated-field shape
    // for exactly that: <id>^^^<issuer>. No name (PID-5) or birth date
    // (PID-7): same disclosed gap as fhir/mappers.ts's toFhirPatient — this
    // system's domain model has neither field anywhere to map from.
    const pid = buildSegment("PID", {
        1: "1",
        3: `${esc(study.patientIdentifier.value)}${encoding.component}${encoding.component}${encoding.component}${esc(study.patientIdentifier.issuer)}`,
    });

    // OBR-4 (universal service identifier): a local, un-coded text
    // identifier — "diagnostic imaging report," this codebase's own
    // fixed description — rather than a fabricated LOINC/CPT code this
    // system has no real terminology binding for (same reasoning
    // fhir/mappers.ts's toFhirDiagnosticReport documents for its own
    // `code.text`-only CodeableConcept).
    const obr = buildSegment("OBR", {
        1: "1",
        4: `DX-REPORT${encoding.component}Diagnostic imaging report`,
        7: hl7Timestamp(new Date(report.authoredAt)),
        22: hl7Timestamp(new Date(report.signedAt ?? report.authoredAt)),
        25: RESULT_STATUS[report.status],
    });

    // DiagnosticReport itself carries only conclusion/conclusionCode (the
    // structured evidence/uncertainty/followUp breakdown lives on AiOutput,
    // a different resource this builder doesn't map) — one OBX for the
    // conclusion, one more when conclusionCode is present, one more when
    // the report is flagged critical.
    const obxSegments = [
        buildSegment("OBX", { 1: "1", 2: "TX", 3: `CONCLUSION${encoding.component}Conclusion`, 5: esc(report.conclusion), 11: RESULT_STATUS[report.status] }),
        ...(report.conclusionCode
            ? [buildSegment("OBX", { 1: "2", 2: "TX", 3: `CONCLUSION-CODE${encoding.component}Conclusion code`, 5: esc(report.conclusionCode), 11: RESULT_STATUS[report.status] })]
            : []),
        ...(report.isCritical
            ? [buildSegment("OBX", { 1: String((report.conclusionCode ? 3 : 2)), 2: "TX", 3: `CRITICAL-FLAG${encoding.component}Critical result flag`, 5: "Y - critical result, requires acknowledgement", 11: "F" })]
            : []),
    ];

    const message: Hl7Message = { encoding, segments: [msh, pid, obr, ...obxSegments] };
    return buildHl7Message(message);
}
