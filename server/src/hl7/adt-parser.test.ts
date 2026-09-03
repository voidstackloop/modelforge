import { describe, expect, it } from "vitest";
import { parseAdtMessage } from "./adt-parser.js";
import { Hl7ParseError } from "./message.js";

const SAMPLE_ADT_A01 = [
    "MSH|^~\\&|EHR|HOSPITAL|MODELFORGE|MODELFORGE|20260315120000||ADT^A01|MSG00001|P|2.5.1",
    "PID|1||MRN-001^^^TEST-HOSPITAL||",
    "PV1|1|I",
].join("\r");

describe("parseAdtMessage", () => {
    it("parses message control id, trigger event, and patient identifier", () => {
        const parsed = parseAdtMessage(SAMPLE_ADT_A01);
        expect(parsed.messageControlId).toBe("MSG00001");
        expect(parsed.triggerEvent).toBe("A01");
        expect(parsed.patientIdentifier).toEqual({ value: "MRN-001", issuer: "TEST-HOSPITAL" });
    });

    it("accepts any ADT trigger event uniformly, not just A01", () => {
        expect(parseAdtMessage(SAMPLE_ADT_A01.replace("ADT^A01", "ADT^A08")).triggerEvent).toBe("A08");
        expect(parseAdtMessage(SAMPLE_ADT_A01.replace("ADT^A01", "ADT^A28")).triggerEvent).toBe("A28");
    });

    it("returns undefined patientIdentifier for a message with no PID segment, rather than throwing", () => {
        const noPid = SAMPLE_ADT_A01.split("\r").filter((line) => !line.startsWith("PID")).join("\r");
        expect(parseAdtMessage(noPid).patientIdentifier).toBeUndefined();
    });

    it("rejects a non-ADT message type with Hl7ParseError, never silently parsing it as one", () => {
        const oru = SAMPLE_ADT_A01.replace("ADT^A01", "ORU^R01");
        expect(() => parseAdtMessage(oru)).toThrow(Hl7ParseError);
        expect(() => parseAdtMessage(oru)).toThrow(/Expected an ADT message type/);
    });
});
