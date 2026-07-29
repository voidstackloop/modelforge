import { describe, it, expect } from "vitest";
import { validateAgainstInputSchema } from "./mcp-client";

describe("validateAgainstInputSchema", () => {
    it("passes when no inputSchema is known", () => {
        expect(validateAgainstInputSchema(undefined, { anything: 1 })).toEqual([]);
    });

    it("flags a missing required argument", () => {
        const schema = { required: ["path"], properties: { path: { type: "string" } } };
        expect(validateAgainstInputSchema(schema, {})).toEqual(['missing required argument "path"']);
    });

    it("passes when all required arguments are present", () => {
        const schema = { required: ["path"], properties: { path: { type: "string" } } };
        expect(validateAgainstInputSchema(schema, { path: "a.txt" })).toEqual([]);
    });

    it("flags a wrong-typed argument", () => {
        const schema = { properties: { count: { type: "number" } } };
        expect(validateAgainstInputSchema(schema, { count: "five" })).toEqual(['"count" should be number, got string']);
    });

    it("treats JSON Schema's integer as the JS number type", () => {
        const schema = { properties: { limit: { type: "integer" } } };
        expect(validateAgainstInputSchema(schema, { limit: 5 })).toEqual([]);
    });

    it("does not flag arguments the schema doesn't describe", () => {
        const schema = { properties: { path: { type: "string" } } };
        expect(validateAgainstInputSchema(schema, { path: "a.txt", extra: true })).toEqual([]);
    });

    it("reports multiple problems at once", () => {
        const schema = { required: ["a", "b"], properties: { c: { type: "string" } } };
        expect(validateAgainstInputSchema(schema, { c: 1 })).toEqual([
            'missing required argument "a"',
            'missing required argument "b"',
            '"c" should be string, got number',
        ]);
    });
});
