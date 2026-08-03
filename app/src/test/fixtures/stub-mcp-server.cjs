#!/usr/bin/env node
// A minimal real MCP server (stdio transport) used only by mcp-client.test.ts.
// Built with the same official SDK the client now uses, so tests exercise a
// real wire protocol round-trip instead of a hand-mocked transport.
const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
const { StdioServerTransport } = require("@modelcontextprotocol/sdk/server/stdio.js");
const { z } = require("zod");

const server = new McpServer({ name: "stub-test-server", version: "1.0.0" });

server.registerTool(
    "echo",
    {
        description: "Echoes the given text back, uppercased",
        inputSchema: { text: z.string() },
        annotations: { readOnlyHint: true },
    },
    async ({ text }) => ({
        content: [{ type: "text", text: `ECHO: ${text}` }],
        structuredContent: { echoed: text.toUpperCase() },
    })
);

server.registerTool(
    "strict_args",
    {
        description: "Only accepts a positive integer count (used to test AJV validation)",
        inputSchema: { count: z.number().int().positive() },
    },
    async ({ count }) => ({ content: [{ type: "text", text: `count was ${count}` }] })
);

server.registerTool(
    "slow_task",
    { description: "Reports progress twice, then finishes (or aborts early if cancelled)" },
    async (extra) => {
        const progressToken = extra._meta?.progressToken;
        for (let i = 1; i <= 2; i++) {
            if (extra.signal.aborted) {
                return { content: [{ type: "text", text: "cancelled mid-task" }], isError: true };
            }
            if (progressToken !== undefined) {
                await extra.sendNotification({
                    method: "notifications/progress",
                    params: { progressToken, progress: i, total: 2, message: `step ${i}` },
                });
            }
            await new Promise((resolve) => setTimeout(resolve, 150));
        }
        return { content: [{ type: "text", text: "slow task done" }] };
    }
);

server.registerTool(
    "image_tool",
    { description: "Returns an image content block — used to test that raw pixel data never reaches the model-facing text output." },
    async () => ({
        content: [
            { type: "text", text: "here is a chest X-ray" },
            { type: "image", data: "QkFTRTY0X1BJWEVMX0RBVEFfU0hPVUxEX05FVkVSX0xFQUs=", mimeType: "image/png" },
        ],
    })
);

server.registerTool(
    "move_series",
    { description: "A tool blocklisted by real callers via McpServerConfig.blockedTools — used to test that filtering." },
    async () => ({ content: [{ type: "text", text: "moved (should never actually be reachable)" }] })
);

server.registerResource(
    "greeting",
    "greeting://hello",
    { description: "A test resource", mimeType: "text/plain" },
    async (uri) => ({ contents: [{ uri: uri.href, text: "hello resource", mimeType: "text/plain" }] })
);

server.registerPrompt(
    "test-prompt",
    { description: "A test prompt" },
    async () => ({
        messages: [{ role: "user", content: { type: "text", text: "test prompt content" } }],
    })
);

const transport = new StdioServerTransport();
server.connect(transport);
