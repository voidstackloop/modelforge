import * as path from "node:path";
import { describe, it, expect, afterEach } from "vitest";
import * as mcpClient from "./mcp-client";

// Real JSON-Schema (AJV) validation of tool arguments is unit-tested against
// the validator module directly in mcp-schema-validation.test.ts. What's
// tested here is that callMcpTool actually wires into it end to end.

const STUB_SERVER_PATH = path.join(__dirname, "test", "fixtures", "stub-mcp-server.cjs");

function stubConfig(id: string): mcpClient.McpServerConfig {
    return { id, name: "Stub server", transport: "stdio", enabled: true, command: "node", args: [STUB_SERVER_PATH] };
}

// These exercise the real official-SDK-backed stdio transport end to end
// against a real (tiny, in-repo) MCP server — not a hand-mocked transport —
// so a regression in the SDK swap itself would actually be caught.
describe("mcp-client (stdio, official SDK transport)", () => {
    afterEach(() => mcpClient.disconnectAll());

    it("connects, negotiates the protocol version, and lists tools", async () => {
        const { tools } = await mcpClient.connectServer(stubConfig("stub-1"));
        expect(tools.map((t) => t.name).sort()).toEqual(["echo", "image_tool", "move_series", "slow_task", "strict_args"]);
        const statuses = mcpClient.getServerStatuses();
        expect(statuses["stub-1"].connected).toBe(true);
        expect(statuses["stub-1"].toolCount).toBe(5);
    });

    it("exposes connected tools qualified by server id, prefixed for the model", async () => {
        await mcpClient.connectServer(stubConfig("stub-2"));
        const defs = mcpClient.getConnectedTools();
        const echo = defs.find((d) => d.name === "mcp__stub-2__echo");
        expect(echo).toBeDefined();
        expect(echo!.description).toContain("[MCP: Stub server]");
        expect(mcpClient.isMcpTool(echo!.name)).toBe(true);
    });

    it("calls a tool through the real transport and returns its text content", async () => {
        await mcpClient.connectServer(stubConfig("stub-3"));
        const result = await mcpClient.callMcpTool("mcp__stub-3__echo", { text: "hi" });
        expect(result).toContain("ECHO: hi");
    });

    it("rejects a call to an unconnected server", async () => {
        await expect(mcpClient.callMcpTool("mcp__nope__echo", {})).rejects.toThrow(/not connected/);
    });

    it("rejects arguments that violate the tool's real JSON Schema (not just a shallow check)", async () => {
        await mcpClient.connectServer(stubConfig("stub-strict"));
        // strict_args requires a positive integer — a negative number passes
        // the old shallow "is it a number" check but fails AJV's `minimum`.
        await expect(mcpClient.callMcpTool("mcp__stub-strict__strict_args", { count: -5 })).rejects.toThrow(/Invalid arguments/);
        const ok = await mcpClient.callMcpTool("mcp__stub-strict__strict_args", { count: 3 });
        expect(ok).toContain("count was 3");
    });

    it("disconnects cleanly and removes the server from status", async () => {
        await mcpClient.connectServer(stubConfig("stub-4"));
        mcpClient.disconnectServer("stub-4");
        expect(mcpClient.getServerStatuses()["stub-4"]).toBeUndefined();
    });

    it("reconnecting the same server id replaces the old connection", async () => {
        await mcpClient.connectServer(stubConfig("stub-5"));
        const { tools } = await mcpClient.connectServer(stubConfig("stub-5"));
        expect(tools.length).toBe(5);
        expect(mcpClient.getServerStatuses()["stub-5"].connected).toBe(true);
    });

    it("delivers progress notifications from a long-running tool call", async () => {
        await mcpClient.connectServer(stubConfig("stub-progress"));
        const updates: { progress: number; total?: number }[] = [];
        const result = await mcpClient.callMcpToolStructured(
            "mcp__stub-progress__slow_task",
            {},
            { onProgress: (p) => updates.push({ progress: p.progress, total: p.total }) }
        );
        expect(result.text).toBe("slow task done");
        expect(updates.length).toBeGreaterThanOrEqual(2);
        expect(updates[0]).toEqual({ progress: 1, total: 2 });
    });

    it("aborting the signal cancels an in-flight call instead of waiting it out", async () => {
        await mcpClient.connectServer(stubConfig("stub-cancel"));
        const controller = new AbortController();
        const promise = mcpClient.callMcpTool("mcp__stub-cancel__slow_task", {}, { signal: controller.signal });
        setTimeout(() => controller.abort(), 50);
        await expect(promise).rejects.toThrow();
    });

    it("callMcpToolStructured preserves structuredContent instead of dropping it", async () => {
        await mcpClient.connectServer(stubConfig("stub-6"));
        const result = await mcpClient.callMcpToolStructured("mcp__stub-6__echo", { text: "hi" });
        expect(result.text).toContain("ECHO: hi");
        expect(result.structuredContent).toEqual({ echoed: "HI" });
        expect(result.provenance).toMatchObject({ serverId: "stub-6", serverName: "Stub server", toolName: "echo" });
        expect(result.isError).toBe(false);
    });

    it("lists and reads resources", async () => {
        await mcpClient.connectServer(stubConfig("stub-7"));
        const resources = await mcpClient.listResources("stub-7");
        expect(resources.map((r) => r.uri)).toContain("greeting://hello");
        const contents = await mcpClient.readResource("stub-7", "greeting://hello");
        expect(contents[0].text).toBe("hello resource");
        expect(contents[0].mimeType).toBe("text/plain");
    });

    it("lists resource templates (empty when the server declares none)", async () => {
        await mcpClient.connectServer(stubConfig("stub-8"));
        const templates = await mcpClient.listResourceTemplates("stub-8");
        expect(templates).toEqual([]);
    });

    it("lists and gets prompts", async () => {
        await mcpClient.connectServer(stubConfig("stub-9"));
        const prompts = await mcpClient.listPrompts("stub-9");
        expect(prompts.map((p) => p.name)).toContain("test-prompt");
        const prompt = await mcpClient.getPrompt("stub-9", "test-prompt");
        expect(prompt.messages).toHaveLength(1);
    });

    it("resource/prompt calls against an unconnected server throw the same not-connected error", async () => {
        await expect(mcpClient.listResources("nope")).rejects.toThrow(/not connected/);
        await expect(mcpClient.listPrompts("nope")).rejects.toThrow(/not connected/);
    });

    it("never forwards raw image content data into the model-facing text output", async () => {
        // Stands in for a DICOM-style tool that returns imaging content
        // alongside text — the "no autonomous interpretation of image
        // pixels" requirement is enforced structurally here: an image
        // content block is only ever summarized as a placeholder
        // (type + mimeType), never its base64 `data`.
        await mcpClient.connectServer(stubConfig("stub-image"));
        const result = await mcpClient.callMcpToolStructured("mcp__stub-image__image_tool", {});
        expect(result.text).toContain("here is a chest X-ray");
        expect(result.text).toContain("[image content, image/png]");
        expect(result.text).not.toContain("QkFTRTY0X1BJWEVMX0RBVEFfU0hPVUxEX05FVkVSX0xFQUs=");
    });

    describe("blockedTools (DICOM MCP's move_series/move_study denylist mechanism)", () => {
        function blockedConfig(id: string): mcpClient.McpServerConfig {
            return { ...stubConfig(id), blockedTools: ["move_series"] };
        }

        it("filters a blocked tool out of the connect-time tool list", async () => {
            const { tools } = await mcpClient.connectServer(blockedConfig("stub-blocked-1"));
            expect(tools.map((t) => t.name)).not.toContain("move_series");
        });

        it("never exposes a blocked tool to the model, even though the server offers it", async () => {
            await mcpClient.connectServer(blockedConfig("stub-blocked-2"));
            const defs = mcpClient.getConnectedTools();
            expect(defs.some((d) => d.name === "mcp__stub-blocked-2__move_series")).toBe(false);
            // The rest of the server's real tools are unaffected.
            expect(defs.some((d) => d.name === "mcp__stub-blocked-2__echo")).toBe(true);
        });

        it("rejects a direct call to a blocked tool as defense in depth, not just hiding it from the list", async () => {
            await mcpClient.connectServer(blockedConfig("stub-blocked-3"));
            await expect(mcpClient.callMcpTool("mcp__stub-blocked-3__move_series", {})).rejects.toThrow(/blocked/);
        });

        it("does not filter anything for a server with no blockedTools configured", async () => {
            await mcpClient.connectServer(stubConfig("stub-unblocked"));
            const defs = mcpClient.getConnectedTools();
            expect(defs.some((d) => d.name === "mcp__stub-unblocked__move_series")).toBe(true);
        });
    });
}, 20_000);
