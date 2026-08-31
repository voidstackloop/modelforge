import { describe, expect, it } from "vitest";
import type { McpServerConfig } from "./mcp-client";
import {
    canonicalMcpEndpoint,
    enforceManagedMcpDataEgress,
    enforceManagedMcpToolCall,
    filterManagedMcpTools,
    selectManagedMcpPolicy,
} from "./managed-mcp-policy";

const organizationId = "11111111-1111-4111-8111-111111111111";
const entryId = "22222222-2222-4222-8222-222222222222";

function httpConfig(overrides: Partial<McpServerConfig> = {}): McpServerConfig {
    return {
        id: "clinical-tools",
        name: "Clinical tools",
        transport: "http",
        enabled: true,
        url: "https://mcp.example.test/api/",
        ...overrides,
    };
}

function entry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        id: entryId,
        organizationId,
        name: "Clinical tools",
        transport: "http",
        endpoint: "https://mcp.example.test/api",
        allowedTools: ["lookup"],
        dataEgressPolicy: "unrestricted",
        status: "active",
        ...overrides,
    };
}

describe("managed MCP policy", () => {
    it("normalizes HTTP endpoints but binds stdio arguments into endpoint identity", () => {
        expect(canonicalMcpEndpoint(httpConfig())).toBe("https://mcp.example.test/api");
        expect(canonicalMcpEndpoint({
            id: "vault", name: "Vault", transport: "stdio", enabled: true,
            command: "node", args: ["server.js", "C:\\Clinical Vault"],
        })).toBe('["node","server.js","C:\\\\Clinical Vault"]');
    });

    it("selects the single active entry for the exact endpoint", () => {
        expect(selectManagedMcpPolicy(httpConfig(), organizationId, [entry()])).toEqual({
            entryId,
            organizationId,
            allowedTools: ["lookup"],
            dataEgressPolicy: "unrestricted",
        });
    });

    it("fails closed for missing, disabled, cross-tenant, ambiguous, or malformed entries", () => {
        expect(() => selectManagedMcpPolicy(httpConfig(), organizationId, [])).toThrow(/not an active entry/);
        expect(() => selectManagedMcpPolicy(httpConfig(), organizationId, [entry({ status: "disabled" })])).toThrow(/not an active entry/);
        expect(() => selectManagedMcpPolicy(httpConfig(), organizationId, [entry({ organizationId: "33333333-3333-4333-8333-333333333333" })])).toThrow(/not an active entry/);
        expect(() => selectManagedMcpPolicy(httpConfig(), organizationId, [entry(), entry({ id: "44444444-4444-4444-8444-444444444444" })])).toThrow(/multiple/);
        expect(() => selectManagedMcpPolicy(httpConfig(), organizationId, [{ nope: true }])).toThrow(/invalid response/);
    });

    it("filters the advertised tool list and enforces the allowlist again at call time", () => {
        const policy = selectManagedMcpPolicy(httpConfig(), organizationId, [entry()]);
        expect(filterManagedMcpTools(policy, [{ name: "lookup" }, { name: "delete" }])).toEqual([{ name: "lookup" }]);
        expect(() => enforceManagedMcpToolCall(policy, "lookup", { query: "x" })).not.toThrow();
        expect(() => enforceManagedMcpToolCall(policy, "delete", {})).toThrow(/not allowed/);
    });

    it("blocks all calls for none and only argument-bearing calls for metadata-only", () => {
        const none = selectManagedMcpPolicy(httpConfig(), organizationId, [entry({ allowedTools: "*", dataEgressPolicy: "none" })]);
        expect(() => enforceManagedMcpToolCall(none, "lookup", {})).toThrow(/may not receive data/);

        const metadata = selectManagedMcpPolicy(httpConfig(), organizationId, [entry({ allowedTools: "*", dataEgressPolicy: "metadata-only" })]);
        expect(() => enforceManagedMcpToolCall(metadata, "status", {})).not.toThrow();
        expect(() => enforceManagedMcpToolCall(metadata, "lookup", { patient: "secret" })).toThrow(/metadata-only/);
        expect(() => enforceManagedMcpDataEgress(metadata, "MCP resource read", true)).toThrow(/payload/);
        expect(() => enforceManagedMcpDataEgress(metadata, "MCP prompt request", false)).not.toThrow();
    });

    it("leaves standalone local mode unchanged", () => {
        expect(filterManagedMcpTools(null, [{ name: "anything" }])).toEqual([{ name: "anything" }]);
        expect(() => enforceManagedMcpToolCall(null, "anything", { payload: "local" })).not.toThrow();
    });
});
