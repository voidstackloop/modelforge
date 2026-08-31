import { describe, expect, it } from "vitest";
import { validatePolicyDocumentJson } from "./policy-document-schema";

const VALID = JSON.stringify({
    version: "2026-01-01",
    statements: [{ effect: "Allow", actions: ["iam:listUsers"], resources: ["organization:org-1"] }],
});

describe("validatePolicyDocumentJson", () => {
    it("accepts a well-formed document", () => {
        const result = validatePolicyDocumentJson(VALID);
        expect(result.valid).toBe(true);
        if (result.valid) expect(result.document.statements).toHaveLength(1);
    });

    it("rejects malformed JSON", () => {
        const result = validatePolicyDocumentJson("{not json");
        expect(result.valid).toBe(false);
        if (!result.valid) expect(result.errors[0]).toContain("Not valid JSON");
    });

    it("rejects a wrong version literal", () => {
        const result = validatePolicyDocumentJson(JSON.stringify({ version: "1.0", statements: [] }));
        expect(result.valid).toBe(false);
    });

    it("rejects an empty statements array", () => {
        const result = validatePolicyDocumentJson(JSON.stringify({ version: "2026-01-01", statements: [] }));
        expect(result.valid).toBe(false);
    });

    it("rejects a statement with no actions", () => {
        const result = validatePolicyDocumentJson(
            JSON.stringify({ version: "2026-01-01", statements: [{ effect: "Allow", actions: [], resources: ["organization:org-1"] }] })
        );
        expect(result.valid).toBe(false);
    });

    it("rejects an unknown top-level key (strict shape, same as the server)", () => {
        const result = validatePolicyDocumentJson(JSON.stringify({ version: "2026-01-01", statements: [], extra: true }));
        expect(result.valid).toBe(false);
    });

    it("rejects an invalid effect value", () => {
        const result = validatePolicyDocumentJson(
            JSON.stringify({ version: "2026-01-01", statements: [{ effect: "Maybe", actions: ["*"], resources: ["*"] }] })
        );
        expect(result.valid).toBe(false);
    });
});
