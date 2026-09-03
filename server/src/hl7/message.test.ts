import { describe, expect, it } from "vitest";
import {
    buildHl7Message,
    buildSegment,
    DEFAULT_ENCODING_CHARACTERS,
    escapeHl7Text,
    getField,
    Hl7ParseError,
    parseHl7Message,
    parseHl7Timestamp,
    splitComponents,
    splitRepetitions,
    splitSubcomponents,
    unescapeHl7Text,
    type Hl7Message,
} from "./message.js";

const SAMPLE_ORU = [
    "MSH|^~\\&|LAB|HOSPITAL|EHR|HOSPITAL|20260101120000||ORU^R01|MSG00001|P|2.5.1",
    "PID|1||MRN12345||||",
    "OBR|1|||CBC^Complete Blood Count|||20260101110000",
    "OBX|1|TX|SUMMARY||No acute findings.||||||F",
].join("\r");

describe("parseHl7Message", () => {
    it("parses a well-formed ORU^R01 into segments with correctly split fields", () => {
        const message = parseHl7Message(SAMPLE_ORU);
        expect(message.segments.map((s) => s.id)).toEqual(["MSH", "PID", "OBR", "OBX"]);
        expect(message.encoding).toEqual(DEFAULT_ENCODING_CHARACTERS);
    });

    it("extracts MSH-2 encoding characters correctly, not hardcoded", () => {
        const message = parseHl7Message(SAMPLE_ORU);
        const msh = message.segments[0];
        expect(getField(msh, 1)).toBe("|");
        expect(getField(msh, 2)).toBe("^~\\&");
        expect(getField(msh, 9)).toBe("ORU^R01");
    });

    it("getField is 1-indexed and matches conventional HL7 field numbering (MSH-9 is the message type)", () => {
        const message = parseHl7Message(SAMPLE_ORU);
        const obx = message.segments[3];
        expect(getField(obx, 1)).toBe("1");
        expect(getField(obx, 2)).toBe("TX");
        expect(getField(obx, 3)).toBe("SUMMARY");
        expect(getField(obx, 11)).toBe("F");
    });

    it("returns '' rather than throwing for a field beyond what the segment actually has", () => {
        const message = parseHl7Message(SAMPLE_ORU);
        const pid = message.segments[1];
        expect(getField(pid, 50)).toBe("");
    });

    it("splitComponents decomposes a component-delimited field (OBR-4, code^text)", () => {
        const message = parseHl7Message(SAMPLE_ORU);
        const obr = message.segments[2];
        expect(splitComponents(getField(obr, 4), message.encoding)).toEqual(["CBC", "Complete Blood Count"]);
    });

    it("splitComponents/splitRepetitions/splitSubcomponents use DEFAULT_ENCODING_CHARACTERS when not passed explicitly", () => {
        expect(splitComponents("a^b^c")).toEqual(["a", "b", "c"]);
        expect(splitRepetitions("a~b")).toEqual(["a", "b"]);
        expect(splitSubcomponents("a&b")).toEqual(["a", "b"]);
    });

    it("tolerates LF and CRLF segment terminators, not only the spec's own CR", () => {
        const lfVersion = SAMPLE_ORU.replaceAll("\r", "\n");
        const crlfVersion = SAMPLE_ORU.replaceAll("\r", "\r\n");
        expect(parseHl7Message(lfVersion).segments.map((s) => s.id)).toEqual(["MSH", "PID", "OBR", "OBX"]);
        expect(parseHl7Message(crlfVersion).segments.map((s) => s.id)).toEqual(["MSH", "PID", "OBR", "OBX"]);
    });

    it("throws Hl7ParseError, not a generic error, for input that isn't a message at all", () => {
        expect(() => parseHl7Message("")).toThrow(Hl7ParseError);
        expect(() => parseHl7Message("PID|1||MRN\r")).toThrow(Hl7ParseError);
        expect(() => parseHl7Message("MSH|^~")).toThrow(Hl7ParseError);
    });
});

describe("buildHl7Message / buildSegment", () => {
    it("round-trips a hand-built message through build -> parse with the same field values", () => {
        const message: Hl7Message = {
            encoding: DEFAULT_ENCODING_CHARACTERS,
            segments: [
                buildSegment("MSH", { 1: "|", 2: "^~\\&", 3: "LAB", 9: "ORU^R01", 10: "MSG00001", 11: "P", 12: "2.5.1" }),
                buildSegment("PID", { 1: "1", 3: "MRN12345" }),
                buildSegment("OBX", { 1: "1", 2: "TX", 3: "SUMMARY", 5: "No acute findings.", 11: "F" }),
            ],
        };
        const raw = buildHl7Message(message);
        expect(raw.endsWith("\r")).toBe(true);
        const reparsed = parseHl7Message(raw);
        expect(reparsed.segments.map((s) => s.id)).toEqual(["MSH", "PID", "OBX"]);
        const msh = reparsed.segments[0];
        expect(getField(msh, 9)).toBe("ORU^R01");
        const obx = reparsed.segments[2];
        expect(getField(obx, 5)).toBe("No acute findings.");
    });

    it("buildSegment fills gaps between set fields with '' so later field positions stay correct", () => {
        const segment = buildSegment("OBX", { 1: "1", 5: "value-only-field-5" });
        expect(segment.fields).toEqual(["1", "", "", "", "value-only-field-5"]);
    });

    it("build -> parse -> build is stable (idempotent re-serialization)", () => {
        const once = buildHl7Message(parseHl7Message(SAMPLE_ORU));
        const twice = buildHl7Message(parseHl7Message(once));
        expect(twice).toBe(once);
    });
});

describe("escapeHl7Text / unescapeHl7Text", () => {
    it("escapes every one of the five delimiter characters so they never corrupt message structure", () => {
        const raw = "field|comp^sub&rep~esc\\end";
        const escaped = escapeHl7Text(raw);
        expect(escaped).not.toContain("|");
        // The unescaped `^`/`&`/`~` only ever appear as part of an escape
        // sequence's own literal "\S\"/"\T\"/"\R\" text, never as raw
        // delimiter characters — the round trip below is the real proof.
        expect(unescapeHl7Text(escaped)).toBe(raw);
    });

    it("a value with no special characters is returned unchanged by both directions", () => {
        expect(escapeHl7Text("No acute findings.")).toBe("No acute findings.");
        expect(unescapeHl7Text("No acute findings.")).toBe("No acute findings.");
    });

    it("leaves an unrecognized escape code untouched, verbatim, rather than guessing", () => {
        expect(unescapeHl7Text("text \\H\\highlighted\\N\\ text")).toBe("text \\H\\highlighted\\N\\ text");
    });

    it("escaping a value and embedding it as a field, then parsing the message back, recovers the exact original text", () => {
        const conclusionWithDelimiters = "Impression: mild finding & no other concern (ratio 3|4, class^A~B)";
        const message: Hl7Message = {
            encoding: DEFAULT_ENCODING_CHARACTERS,
            segments: [
                buildSegment("MSH", { 1: "|", 2: "^~\\&", 9: "ORU^R01" }),
                buildSegment("OBX", { 1: "1", 5: escapeHl7Text(conclusionWithDelimiters) }),
            ],
        };
        const reparsed = parseHl7Message(buildHl7Message(message));
        const obx = reparsed.segments[1];
        expect(unescapeHl7Text(getField(obx, 5))).toBe(conclusionWithDelimiters);
    });
});

describe("parseHl7Timestamp", () => {
    it("parses a full-precision timestamp (YYYYMMDDHHMMSS) as UTC when no timezone is given", () => {
        expect(parseHl7Timestamp("20260315143045")).toBe("2026-03-15T14:30:45.000Z");
    });

    it("parses a date-only value (YYYYMMDD) as midnight UTC — the minimum precision this function accepts", () => {
        expect(parseHl7Timestamp("20260315")).toBe("2026-03-15T00:00:00.000Z");
    });

    it("honors an explicit timezone offset instead of assuming UTC", () => {
        expect(parseHl7Timestamp("20260315143045+0500")).toBe("2026-03-15T09:30:45.000Z");
        expect(parseHl7Timestamp("20260315143045-0500")).toBe("2026-03-15T19:30:45.000Z");
    });

    it("tolerates a fractional-second component", () => {
        expect(parseHl7Timestamp("20260315143045.123")).toBe("2026-03-15T14:30:45.000Z");
    });

    it("returns undefined, never throws, for anything less precise than YYYYMMDD", () => {
        expect(parseHl7Timestamp("2026")).toBeUndefined();
        expect(parseHl7Timestamp("202603")).toBeUndefined();
        expect(parseHl7Timestamp("")).toBeUndefined();
    });

    it("returns undefined for garbage input rather than an Invalid Date", () => {
        expect(parseHl7Timestamp("not-a-timestamp")).toBeUndefined();
        expect(parseHl7Timestamp("99999999")).toBeUndefined();
    });
});
