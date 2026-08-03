import { describe, it, expect, beforeEach } from "vitest";
import { precompileToolSchema, clearValidatorsForServer, validateArgs } from "./mcp-schema-validation";

describe("mcp-schema-validation", () => {
    beforeEach(() => clearValidatorsForServer("srv"));

    it("passes when no inputSchema is known", () => {
        precompileToolSchema("srv", "tool", undefined);
        expect(validateArgs("srv", "tool", { anything: 1 })).toEqual([]);
    });

    it("flags a missing required argument", () => {
        precompileToolSchema("srv", "tool", { type: "object", required: ["path"], properties: { path: { type: "string" } } });
        expect(validateArgs("srv", "tool", {})).toEqual(['missing required argument "path"']);
    });

    it("passes when all required arguments are present", () => {
        precompileToolSchema("srv", "tool", { type: "object", required: ["path"], properties: { path: { type: "string" } } });
        expect(validateArgs("srv", "tool", { path: "a.txt" })).toEqual([]);
    });

    it("flags a wrong-typed argument", () => {
        precompileToolSchema("srv", "tool", { type: "object", properties: { count: { type: "number" } } });
        expect(validateArgs("srv", "tool", { count: "five" })).toHaveLength(1);
    });

    // These are exactly the shapes the old shallow top-level checker (removed
    // in this milestone) could not validate at all — the reason for switching
    // to AJV in the first place.
    it("validates enum values", () => {
        precompileToolSchema("srv", "tool", { type: "object", properties: { level: { enum: ["low", "medium", "high"] } } });
        expect(validateArgs("srv", "tool", { level: "extreme" })).toHaveLength(1);
        expect(validateArgs("srv", "tool", { level: "high" })).toEqual([]);
    });

    it("validates pattern constraints", () => {
        precompileToolSchema("srv", "tool", { type: "object", properties: { id: { type: "string", pattern: "^[A-Z]{3}-\\d+$" } } });
        expect(validateArgs("srv", "tool", { id: "not-valid" })).toHaveLength(1);
        expect(validateArgs("srv", "tool", { id: "ABC-123" })).toEqual([]);
    });

    it("validates oneOf branches", () => {
        precompileToolSchema("srv", "tool", {
            type: "object",
            properties: { value: { oneOf: [{ type: "string" }, { type: "number" }] } },
        });
        // AJV reports one error per failed oneOf branch plus the oneOf itself
        // when allErrors is on — assert non-empty rather than an exact count.
        expect(validateArgs("srv", "tool", { value: true }).length).toBeGreaterThan(0);
        expect(validateArgs("srv", "tool", { value: "ok" })).toEqual([]);
        expect(validateArgs("srv", "tool", { value: 5 })).toEqual([]);
    });

    it("validates nested object/array item schemas", () => {
        precompileToolSchema("srv", "tool", {
            type: "object",
            properties: {
                items: { type: "array", items: { type: "object", required: ["name"], properties: { name: { type: "string" } } } },
            },
        });
        expect(validateArgs("srv", "tool", { items: [{ name: "a" }, {}] })).toHaveLength(1);
        expect(validateArgs("srv", "tool", { items: [{ name: "a" }] })).toEqual([]);
    });

    it("treats an uncompilable schema as unvalidated rather than throwing", () => {
        // A schema with a self-referential/invalid structure AJV can't compile.
        precompileToolSchema("srv", "tool", { type: "object", properties: { x: { $ref: "#/does/not/exist" } } });
        expect(() => validateArgs("srv", "tool", { x: 1 })).not.toThrow();
    });

    it("clearValidatorsForServer removes only that server's cached validators", () => {
        precompileToolSchema("srv", "tool", { type: "object", required: ["a"] });
        precompileToolSchema("other", "tool", { type: "object", required: ["b"] });
        clearValidatorsForServer("srv");
        expect(validateArgs("srv", "tool", {})).toEqual([]); // no validator cached anymore
        expect(validateArgs("other", "tool", {})).toEqual(['missing required argument "b"']);
        clearValidatorsForServer("other");
    });
});
