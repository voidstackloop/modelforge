import type { McpTransport } from "@/lib/api/types";

export function parseAllowedTools(value: string): "*" | string[] {
    const trimmed = value.trim();
    if (trimmed === "*") return "*";
    const tools = [...new Set(trimmed.split(/[\n,]+/).map((tool) => tool.trim()).filter(Boolean))];
    if (tools.length === 0) throw new Error('Enter "*" or at least one tool name.');
    return tools;
}

export function formatAllowedTools(value: "*" | string[]): string {
    return value === "*" ? "*" : value.join("\n");
}

export function validateMcpEndpoint(transport: McpTransport, endpoint: string): string | undefined {
    if (!endpoint.trim()) return "Endpoint is required.";
    if (transport === "http") {
        try {
            const url = new URL(endpoint);
            if (url.protocol !== "http:" && url.protocol !== "https:") return "HTTP MCP endpoints must use http:// or https://.";
        } catch {
            return "Enter a valid HTTP MCP URL.";
        }
        return undefined;
    }
    try {
        const invocation = JSON.parse(endpoint) as unknown;
        if (!Array.isArray(invocation) || invocation.length === 0 || invocation.some((part) => typeof part !== "string" || part.length === 0)) {
            return "Stdio endpoints must be a JSON array containing the command followed by its exact arguments.";
        }
    } catch {
        return "Stdio endpoints must be valid JSON, for example [\"node\",\"server.js\"].";
    }
    return undefined;
}
