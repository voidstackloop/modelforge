import { buildHl7Message, buildSegment, getField, type Hl7Message, type Hl7EncodingCharacters, DEFAULT_ENCODING_CHARACTERS } from "./message.js";

/**
 * HL7 v2's own general acknowledgment (ACK) message — every real HL7 v2
 * receiver (this codebase's mllp-server.ts included) is expected to send
 * one back for every message it receives, per the standard's own
 * "original mode acknowledgment" pattern: an MSH (mirroring the sender's
 * own encoding characters and swapping sending/receiving application-
 * facility) plus an MSA segment naming the acknowledgment code and the
 * original message's control id.
 */
export type Hl7AckCode = "AA" | "AE" | "AR"; // Application Accept / Error / Reject — HL7 v2 table 0008

export interface AckContext {
    sendingApplication: string;
    sendingFacility: string;
    /** Defaults to a freshly-generated control id — pass an explicit one
     * only for deterministic tests. */
    messageControlId?: string;
    now?: Date;
}

function hl7Timestamp(date: Date): string {
    const pad = (n: number, width = 2) => String(n).padStart(width, "0");
    return `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}`;
}

function randomMessageControlId(): string {
    return `MF${Date.now().toString(36).toUpperCase()}${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
}

/**
 * Builds an ACK in response to `original` — `code` "AA" (accepted), "AE"
 * (error — the message was understood but couldn't be processed, e.g. a
 * failed patient match), or "AR" (reject — the message itself is
 * malformed/unsupported). `details` becomes MSA-3 (a short human-readable
 * reason), never a stack trace or anything PHI-bearing — same "no
 * PHI-bearing failure detail" discipline as imaging/ingestion.ts's own
 * `failureCategory` (a closed category, never free text derived from
 * message content).
 */
export function buildAck(original: Hl7Message, code: Hl7AckCode, context: AckContext, details?: string): string {
    const originalMsh = original.segments.find((s) => s.id === "MSH");
    const encoding: Hl7EncodingCharacters = original.encoding ?? DEFAULT_ENCODING_CHARACTERS;
    const originalControlId = originalMsh ? getField(originalMsh, 10) : "";
    const now = context.now ?? new Date();

    const msh = buildSegment("MSH", {
        1: encoding.field,
        2: `${encoding.component}${encoding.repetition}${encoding.escape}${encoding.subcomponent}`,
        3: context.sendingApplication,
        4: context.sendingFacility,
        // Reply to whoever sent the original — MSH-3/4 of the inbound
        // message become MSH-5/6 of this ACK.
        5: originalMsh ? getField(originalMsh, 3) : "",
        6: originalMsh ? getField(originalMsh, 4) : "",
        7: hl7Timestamp(now),
        9: "ACK",
        10: context.messageControlId ?? randomMessageControlId(),
        11: "P",
        12: "2.5.1",
    });
    const msa = buildSegment("MSA", details ? { 1: code, 2: originalControlId, 3: details } : { 1: code, 2: originalControlId });

    return buildHl7Message({ encoding, segments: [msh, msa] });
}
