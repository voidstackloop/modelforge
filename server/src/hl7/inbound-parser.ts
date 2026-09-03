import { randomUUID } from "node:crypto";
import { labResultSchema, type LabResult } from "@modelforge/contracts";
import { getField, Hl7ParseError, parseHl7Message, parseHl7Timestamp, splitComponents, unescapeHl7Text } from "./message.js";

/**
 * Inbound HL7 v2 parsing — the receiving-side counterpart to
 * oru-builder.ts's outbound generation, for the one message type this
 * codebase currently understands (ORU^R01, "unsolicited observation
 * result" — the common shape a lab system sends result data in).
 *
 * Deliberately, and by design, this ONLY parses and returns structured
 * data — it never looks up, matches, or writes to a PatientCase. Turning a
 * parsed message into a stored, patient-matched lab result is a separate,
 * NOT-yet-built step that would need the same kind of deliberate ambiguous-
 * match-requires-review workflow imaging ingestion already has for DICOM
 * patient matching (see docs/IMAGING.md) — building that same rigor for
 * HL7 inbound intake, without the review workflow, would be a real safety
 * regression, so it was left undone rather than done carelessly. See
 * docs/HL7_V2_INTEGRATION.md.
 */

export interface ParsedInboundObservation extends LabResult {
    /** `id` is synthetic (randomUUID) — HL7 v2's OBX segment has no
     * concept of a persistent, stable identifier across a system boundary
     * the way this codebase's own LabResult.id does. A caller that
     * eventually persists this must not treat it as a dedup key across
     * repeated deliveries of the same message. */
    id: string;
}

export interface ParsedOruMessage {
    messageControlId: string;
    /** Undefined when the message has no PID segment, or PID-3 is empty —
     * a message with no recognizable patient identifier is not itself a
     * parse error (some ORU messages are genuinely unsolicited/QC results
     * with no patient), but a caller intending to act on this must handle
     * that case, not assume it's always present. */
    patientIdentifier?: { value: string; issuer: string };
    observations: ParsedInboundObservation[];
}

/**
 * Parses an inbound ORU^R01 message into `{messageControlId,
 * patientIdentifier?, observations}`. Throws `Hl7ParseError` for anything
 * that isn't a well-formed HL7 v2 message at all (see message.ts's own
 * parseHl7Message), or whose MSH-9 message type isn't ORU-shaped — never
 * for a message that parses fine but is merely missing optional content
 * (a missing PID, an OBX with no OBX-6 units, etc.), which this function
 * represents as absent fields, not an error.
 */
export function parseOruR01(raw: string): ParsedOruMessage {
    const message = parseHl7Message(raw);
    const msh = message.segments.find((s) => s.id === "MSH");
    if (!msh) throw new Hl7ParseError("Message has no MSH segment.");
    const messageType = getField(msh, 9);
    if (!messageType.startsWith("ORU")) throw new Hl7ParseError(`Expected an ORU message type, got "${messageType || "(empty)"}".`);

    const pid = message.segments.find((s) => s.id === "PID");
    const pid3 = pid ? getField(pid, 3) : "";
    const pid3Components = pid3 ? splitComponents(pid3, message.encoding) : [];
    const patientIdentifierValue = pid3Components[0] ? unescapeHl7Text(pid3Components[0], message.encoding) : "";
    // PID-3 component 4 (assigning authority) is the conventional
    // "^^^issuer" position this codebase's own oru-builder.ts writes to
    // (`<id>^^^<issuer>`) — read back symmetrically.
    const patientIdentifierIssuer = pid3Components[3] ? unescapeHl7Text(pid3Components[3], message.encoding) : "";
    const patientIdentifier = patientIdentifierValue ? { value: patientIdentifierValue, issuer: patientIdentifierIssuer } : undefined;

    const observations = message.segments
        .filter((s) => s.id === "OBX")
        .map((obx) => {
            const idComponents = splitComponents(getField(obx, 3), message.encoding);
            // Prefer the human-readable text component (OBX-3.2) over the
            // raw code (OBX-3.1) when both are present, matching how a
            // clinician would actually want to see this; fall back to
            // whichever one exists.
            const name = unescapeHl7Text(idComponents[1] || idComponents[0] || "", message.encoding) || "Unknown observation";
            return labResultSchema.parse({
                id: randomUUID(),
                name,
                value: unescapeHl7Text(getField(obx, 5), message.encoding),
                unit: getField(obx, 6) || undefined,
                referenceRange: getField(obx, 7) || undefined,
                observedAt: parseHl7Timestamp(getField(obx, 14)),
            } satisfies ParsedInboundObservation);
        });

    return { messageControlId: getField(msh, 10), patientIdentifier, observations };
}
