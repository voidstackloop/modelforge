import { describe, expect, it } from "vitest";
import { formatAllowedTools, parseAllowedTools, validateMcpEndpoint } from "./mcp-registry-form";

describe("MCP registry form helpers", () => {
    it("parses wildcard or a deduplicated comma/newline tool list", () => {
        expect(parseAllowedTools(" * ")).toBe("*");
        expect(parseAllowedTools("search, read\nsearch")).toEqual(["search", "read"]);
        expect(() => parseAllowedTools(" \n ")).toThrow(/at least one/);
        expect(formatAllowedTools(["search", "read"])).toBe("search\nread");
    });

    it("validates HTTP URLs and exact stdio invocation arrays", () => {
        expect(validateMcpEndpoint("http", "https://mcp.example.test/api")).toBeUndefined();
        expect(validateMcpEndpoint("http", "file:///tmp/mcp")).toMatch(/http/);
        expect(validateMcpEndpoint("stdio", '["node","server.js","/vault"]')).toBeUndefined();
        expect(validateMcpEndpoint("stdio", "node server.js")).toMatch(/valid JSON/);
        expect(validateMcpEndpoint("stdio", "[]")).toMatch(/JSON array/);
    });
});
