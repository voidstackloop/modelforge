/**
 * A minimal, from-scratch HL7 v2.x (ER7/"pipe-and-hat") message parser and
 * builder. Scope, deliberately: this is protocol-level plumbing — parsing
 * and constructing well-formed HL7 v2 messages — not an interface engine.
 * It has no MLLP (the TCP framing real HL7 v2 transport uses), no
 * persistence, and no inbound HTTP listener; see docs/HL7_V2_INTEGRATION.md
 * for the full scope statement and how a real deployment would wire actual
 * network transport on top of this. server/src/hl7/oru-builder.ts is the
 * one concrete message type this codebase currently builds (ORU^R01,
 * mapping this system's own DiagnosticReport/ImagingStudy/PatientCase).
 *
 * HL7 v2's own field-composition rules (per its own spec, not a rule this
 * code invented): a message is CR ("\r", 0x0D)-terminated segments; each
 * segment is a segment-id followed by fields separated by the field
 * separator (declared in MSH-1, always `|` in practice — HL7 v2 itself
 * defines no other legal value, but this parser still reads it from the
 * message rather than hardcoding it, matching the spec's own model);
 * MSH-2 declares the four "encoding characters" (component `^`, repetition
 * `~`, escape `\`, subcomponent `&`, in that fixed order) used inside every
 * OTHER segment's fields. This parser stops at the FIELD level by default
 * (a segment's fields as raw, still-delimited strings) — `splitComponents`/
 * `splitRepetitions`/`splitSubcomponents` below decompose a field further
 * only where a caller actually needs to (most fields, especially simple
 * ones like a timestamp or a status code, are used whole).
 */

export interface Hl7EncodingCharacters {
    field: string; // MSH-1, e.g. "|"
    component: string; // MSH-2 char 1, e.g. "^"
    repetition: string; // MSH-2 char 2, e.g. "~"
    escape: string; // MSH-2 char 3, e.g. "\"
    subcomponent: string; // MSH-2 char 4, e.g. "&"
}

export const DEFAULT_ENCODING_CHARACTERS: Hl7EncodingCharacters = { field: "|", component: "^", repetition: "~", escape: "\\", subcomponent: "&" };

export interface Hl7Segment {
    /** The segment id (e.g. "MSH", "PID", "OBX") — NOT included in `fields`. */
    id: string;
    /** Raw, still-delimited field strings, 1-indexed in the conventional
     * HL7 sense via `getField` below (fields[0] here is field 1, since the
     * segment id itself is field 0 in the spec's own numbering but is
     * already split out as `id`) — EXCEPT for MSH, where field 1 (the
     * field separator itself) is never a normal delimited value and field
     * 2 (encoding characters) is stored as a plain literal string; both
     * are still present in `fields` at their spec-numbered positions so
     * `getField(seg, 1)`/`getField(seg, 2)` work uniformly across every
     * segment type, MSH included. */
    fields: string[];
}

export interface Hl7Message {
    segments: Hl7Segment[];
    encoding: Hl7EncodingCharacters;
}

export class Hl7ParseError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "Hl7ParseError";
    }
}

/** 1-indexed field access, matching HL7's own field-numbering convention
 * (MSH-9, PID-3, etc.) — `getField(segment, 9)` for MSH-9, not
 * `segment.fields[9]`. Returns "" (never undefined/throws) for a field
 * beyond what the segment actually has — a short/truncated segment is
 * common and every value here is optional by construction, not a parse
 * error. */
export function getField(segment: Hl7Segment, oneIndexedField: number): string {
    return segment.fields[oneIndexedField - 1] ?? "";
}

export function splitComponents(field: string, encoding: Hl7EncodingCharacters = DEFAULT_ENCODING_CHARACTERS): string[] {
    return field.split(encoding.component);
}

export function splitRepetitions(field: string, encoding: Hl7EncodingCharacters = DEFAULT_ENCODING_CHARACTERS): string[] {
    return field.split(encoding.repetition);
}

export function splitSubcomponents(component: string, encoding: Hl7EncodingCharacters = DEFAULT_ENCODING_CHARACTERS): string[] {
    return component.split(encoding.subcomponent);
}

/**
 * Escapes a value that will become ONE field/component/subcomponent so any
 * of the message's own delimiter characters appearing literally in real
 * data (e.g. a conclusion string that happens to contain "&", or a name
 * with a "^") do not corrupt the message's structure — HL7 v2's own
 * escape-sequence mechanism (`\F\`, `\S\`, `\T\`, `\R\`, `\E\` for
 * field/component/subcomponent/repetition/escape respectively), applied in
 * a single left-to-right pass so an already-escaped backslash is never
 * re-escaped.
 */
export function escapeHl7Text(value: string, encoding: Hl7EncodingCharacters = DEFAULT_ENCODING_CHARACTERS): string {
    let result = "";
    for (const char of value) {
        if (char === encoding.escape) result += `${encoding.escape}E${encoding.escape}`;
        else if (char === encoding.field) result += `${encoding.escape}F${encoding.escape}`;
        else if (char === encoding.component) result += `${encoding.escape}S${encoding.escape}`;
        else if (char === encoding.subcomponent) result += `${encoding.escape}T${encoding.escape}`;
        else if (char === encoding.repetition) result += `${encoding.escape}R${encoding.escape}`;
        else result += char;
    }
    return result;
}

const UNESCAPE_MAP: Record<string, keyof Hl7EncodingCharacters> = { E: "escape", F: "field", S: "component", T: "subcomponent", R: "repetition" };

/** Inverse of escapeHl7Text — decodes `\F\`/`\S\`/`\T\`/`\R\`/`\E\` escape
 * sequences back to literal delimiter characters. An unrecognized escape
 * code (anything HL7 v2 also reserves for locally-defined or highlighting
 * escapes, e.g. `\H\`/`\N\`/`\Zxxx\`) is left untouched, verbatim — this
 * function only ever decodes the five delimiter escapes it itself
 * produces, never guesses at ones it doesn't know. */
export function unescapeHl7Text(value: string, encoding: Hl7EncodingCharacters = DEFAULT_ENCODING_CHARACTERS): string {
    const esc = encoding.escape;
    if (!value.includes(esc)) return value;
    let result = "";
    let i = 0;
    while (i < value.length) {
        if (value[i] === esc) {
            const close = value.indexOf(esc, i + 1);
            const code = close > i ? value.slice(i + 1, close) : "";
            const key = UNESCAPE_MAP[code];
            if (close > i && key) {
                result += encoding[key];
                i = close + 1;
                continue;
            }
        }
        result += value[i];
        i++;
    }
    return result;
}

/**
 * Parses a raw HL7 v2 message. Segments split on CR (`\r`) primarily, per
 * spec — but a bare `\n` or `\r\n` (common from systems/tools that don't
 * preserve the exact wire terminator, e.g. a message pasted from a text
 * editor) is tolerated too, since rejecting an otherwise well-formed
 * message over terminator style would be pedantry with no safety benefit
 * here (this parser is never fed anything but this codebase's own
 * already-built messages and, in the future, whatever a real MLLP
 * transport layer hands it — see this file's own top doc comment on why
 * that transport doesn't exist yet).
 */
export function parseHl7Message(raw: string): Hl7Message {
    const lines = raw.split(/\r\n|\r|\n/).filter((line) => line.length > 0);
    if (lines.length === 0) throw new Hl7ParseError("Empty message.");
    const mshLine = lines[0];
    if (!mshLine.startsWith("MSH")) throw new Hl7ParseError("Message must start with an MSH segment.");
    if (mshLine.length < 8) throw new Hl7ParseError("MSH segment too short to contain a field separator and encoding characters.");

    const fieldSep = mshLine[3];
    const encodingCharsField = mshLine.slice(4, 8);
    if (encodingCharsField.length !== 4) throw new Hl7ParseError("MSH-2 (encoding characters) must be exactly 4 characters.");
    const encoding: Hl7EncodingCharacters = { field: fieldSep, component: encodingCharsField[0], repetition: encodingCharsField[1], escape: encodingCharsField[2], subcomponent: encodingCharsField[3] };

    const segments: Hl7Segment[] = lines.map((line) => {
        const id = line.slice(0, 3);
        if (id === "MSH") {
            // MSH-1 is the field separator itself (never split out of the
            // raw text the way other segments' field 1 is). Index 8 is the
            // single separator character between MSH-2 and MSH-3 — sliced
            // past (not included) so the rest splits on fieldSep exactly
            // like every other segment's fields, starting at MSH-3.
            const rest = line.slice(9);
            const restFields = rest.length > 0 || line.length > 8 ? rest.split(fieldSep) : [];
            return { id, fields: [fieldSep, encodingCharsField, ...restFields] };
        }
        // Plain startsWith/slice, not a dynamically-built RegExp — fieldSep
        // is taken from the message itself (MSH-1), so constructing a
        // RegExp from it is both a ReDoS smell and a correctness risk (a
        // fieldSep that happens to be a regex metacharacter would silently
        // match something other than its literal self).
        const afterId = line.slice(3);
        const body = afterId.startsWith(fieldSep) ? afterId.slice(fieldSep.length) : afterId;
        return { id, fields: body.length > 0 || line.length > 3 ? body.split(fieldSep) : [] };
    });

    return { segments, encoding };
}

/** Serializes a Hl7Message back to CR-terminated wire format — the inverse
 * of parseHl7Message for a message this codebase itself constructed (see
 * MSH's own special-cased fields[0]/fields[1] handling, mirroring the
 * parser's own). Every segment ends with the terminator; the whole message
 * does too, matching how real HL7 v2 senders terminate the final segment
 * the same as every other one. */
export function buildHl7Message(message: Hl7Message): string {
    return message.segments
        .map((segment) => {
            if (segment.id === "MSH") {
                const fieldSep = segment.fields[0] ?? message.encoding.field;
                const encodingChars = segment.fields[1] ?? `${message.encoding.component}${message.encoding.repetition}${message.encoding.escape}${message.encoding.subcomponent}`;
                const rest = segment.fields.slice(2);
                return `MSH${fieldSep}${encodingChars}${rest.length > 0 ? fieldSep + rest.join(fieldSep) : ""}`;
            }
            return `${segment.id}${segment.fields.length > 0 ? message.encoding.field + segment.fields.join(message.encoding.field) : ""}`;
        })
        .join("\r") + "\r";
}

/** Builds one non-MSH segment from 1-indexed field values (a sparse
 * `{fieldNumber: value}` map, since most segments only set a handful of
 * fields out of dozens the spec defines) — the construction-side
 * counterpart to `getField`. Gaps are filled with "" so a later field's
 * position is always correct even when earlier ones are unset. */
export function buildSegment(id: string, oneIndexedFields: Record<number, string>): Hl7Segment {
    const maxField = Math.max(0, ...Object.keys(oneIndexedFields).map(Number));
    const fields: string[] = [];
    for (let i = 1; i <= maxField; i++) fields.push(oneIndexedFields[i] ?? "");
    return { id, fields };
}

const TS_PATTERN = /^(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?(?:\.\d+)?([+-]\d{4})?$/;

/**
 * Parses an HL7 v2 TS (timestamp) field value — `YYYYMMDDHHMMSS`, or any
 * shorter prefix per the standard's own "trailing components may be
 * omitted" rule, optionally followed by a fractional-second and/or a
 * `+HHMM`/`-HHMM` timezone offset — into an ISO 8601 string. Requires at
 * least `YYYYMMDD` (year+month+day); anything less precise is treated as
 * unusably imprecise for this codebase's purposes and returns undefined,
 * never throws. When no timezone offset is present, UTC is assumed — a
 * real, disclosed ambiguity: HL7 v2 itself has no required-timezone rule,
 * and this parser has no way to know a sending system's local convention
 * when the message itself doesn't say.
 */
export function parseHl7Timestamp(value: string): string | undefined {
    const match = TS_PATTERN.exec(value);
    if (!match || !match[2] || !match[3]) return undefined;
    const [, year, month, day, hour = "00", minute = "00", second = "00", tz] = match;
    const offset = tz ? `${tz.slice(0, 3)}:${tz.slice(3)}` : "Z";
    const iso = `${year}-${month}-${day}T${hour}:${minute}:${second}${offset}`;
    const date = new Date(iso);
    return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}
