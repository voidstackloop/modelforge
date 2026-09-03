import { describe, expect, it } from "vitest";
import { buildAck } from "./ack-builder.js";
import { getField, parseHl7Message } from "./message.js";

const ORIGINAL = parseHl7Message(["MSH|^~\\&|LAB|HOSPITAL|EHR|HOSPITAL|20260315120000||ORU^R01|MSG00001|P|2.5.1", "PID|1||MRN-001"].join("\r"));

describe("buildAck", () => {
    it("builds a parseable ACK naming the original message's control id in MSA-2", () => {
        const raw = buildAck(ORIGINAL, "AA", { sendingApplication: "ModelForge", sendingFacility: "Example Health System", messageControlId: "ACK001", now: new Date("2026-03-15T12:00:05Z") });
        const ack = parseHl7Message(raw);
        expect(ack.segments.map((s) => s.id)).toEqual(["MSH", "MSA"]);
        const msh = ack.segments[0];
        expect(getField(msh, 9)).toBe("ACK");
        expect(getField(msh, 10)).toBe("ACK001");
        const msa = ack.segments[1];
        expect(getField(msa, 1)).toBe("AA");
        expect(getField(msa, 2)).toBe("MSG00001");
    });

    it("swaps sending/receiving application-facility relative to the original message", () => {
        const raw = buildAck(ORIGINAL, "AA", { sendingApplication: "ModelForge", sendingFacility: "Example Health System" });
        const msh = parseHl7Message(raw).segments[0];
        expect(getField(msh, 3)).toBe("ModelForge");
        expect(getField(msh, 4)).toBe("Example Health System");
        // The ACK is addressed back to whoever sent the original.
        expect(getField(msh, 5)).toBe("LAB");
        expect(getField(msh, 6)).toBe("HOSPITAL");
    });

    it("includes MSA-3 details only when supplied", () => {
        const withDetails = parseHl7Message(buildAck(ORIGINAL, "AE", { sendingApplication: "ModelForge", sendingFacility: "Example" }, "no matching patient"));
        expect(getField(withDetails.segments[1], 3)).toBe("no matching patient");

        const withoutDetails = parseHl7Message(buildAck(ORIGINAL, "AA", { sendingApplication: "ModelForge", sendingFacility: "Example" }));
        expect(getField(withoutDetails.segments[1], 3)).toBe("");
    });

    it("generates a random, non-empty messageControlId when none is supplied", () => {
        const raw = buildAck(ORIGINAL, "AA", { sendingApplication: "ModelForge", sendingFacility: "Example" });
        expect(getField(parseHl7Message(raw).segments[0], 10).length).toBeGreaterThan(0);
    });

    it("handles an original message with no MSH gracefully (AR — reject — is exactly this case)", () => {
        const malformed = { segments: [], encoding: { field: "|", component: "^", repetition: "~", escape: "\\", subcomponent: "&" } };
        const raw = buildAck(malformed, "AR", { sendingApplication: "ModelForge", sendingFacility: "Example" }, "malformed message");
        const ack = parseHl7Message(raw);
        expect(getField(ack.segments[1], 1)).toBe("AR");
        expect(getField(ack.segments[1], 2)).toBe("");
    });
});
