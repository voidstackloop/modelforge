import { getField, Hl7ParseError, parseHl7Message, splitComponents, unescapeHl7Text } from "./message.js";

/**
 * Inbound ADT (admit/discharge/transfer) parsing — the second HL7 v2
 * message type this codebase understands, alongside oru-builder.ts/
 * inbound-parser.ts's ORU^R01. ADT is the standard way an EHR notifies
 * downstream systems of patient admit/register/transfer/update events
 * (A01/A04/A08/A28/... — HL7 v2 table 0003's full trigger-event list; this
 * parser accepts any of them uniformly rather than special-casing each,
 * since every trigger event shares the same PID-based identity payload
 * this codebase actually uses).
 *
 * Same scope discipline as inbound-parser.ts's parseOruR01: parsing only.
 * This never looks up, matches, or writes a PatientCase — see
 * docs/HL7_V2_INTEGRATION.md and hl7/ingestion.ts (the shared match/persist
 * pipeline both ORU and ADT feed into) for where that actually happens,
 * deliberately kept separate from parsing itself.
 */
export interface ParsedAdtMessage {
    messageControlId: string;
    /** The trigger event, e.g. "A01" (admit), "A08" (update) — read from
     * MSH-9.2, not validated against table 0003's closed list (an EHR
     * sending a trigger event this parser doesn't specifically know about
     * is still parsed the same way; only the message TYPE, MSH-9.1, must
     * be "ADT"). */
    triggerEvent: string;
    patientIdentifier?: { value: string; issuer: string };
}

export function parseAdtMessage(raw: string): ParsedAdtMessage {
    const message = parseHl7Message(raw);
    const msh = message.segments.find((s) => s.id === "MSH");
    if (!msh) throw new Hl7ParseError("Message has no MSH segment.");
    const messageTypeField = getField(msh, 9);
    const [messageType, triggerEvent = ""] = splitComponents(messageTypeField, message.encoding);
    if (messageType !== "ADT") throw new Hl7ParseError(`Expected an ADT message type, got "${messageTypeField || "(empty)"}".`);

    const pid = message.segments.find((s) => s.id === "PID");
    const pid3 = pid ? getField(pid, 3) : "";
    const pid3Components = pid3 ? splitComponents(pid3, message.encoding) : [];
    const value = pid3Components[0] ? unescapeHl7Text(pid3Components[0], message.encoding) : "";
    const issuer = pid3Components[3] ? unescapeHl7Text(pid3Components[3], message.encoding) : "";
    const patientIdentifier = value ? { value, issuer } : undefined;

    return { messageControlId: getField(msh, 10), triggerEvent, patientIdentifier };
}
