import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { ToolDefinition } from "./providers/types";

export interface McpServerConfig {
    id: string;
    name: string;
    transport: "stdio" | "http";
    enabled: boolean;
    // stdio
    command?: string;
    args?: string[];
    env?: Record<string, string>;
    // http (MCP "Streamable HTTP" transport)
    url?: string;
    headers?: Record<string, string>;
}

interface McpToolInfo {
    name: string;
    description?: string;
    inputSchema?: Record<string, unknown>;
}

interface PendingRequest {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
}

interface Connection {
    config: McpServerConfig;
    tools: McpToolInfo[];
    process?: ChildProcessWithoutNullStreams;
    buffer: string;
    nextId: number;
    pending: Map<number, PendingRequest>;
    httpSessionId?: string;
    lastError?: string;
}

const connections = new Map<string, Connection>();
const REQUEST_TIMEOUT_MS = 30_000;
const CLIENT_INFO = { name: "Modelforge", version: "1.0.0" };
const PROTOCOL_VERSION = "2024-11-05";

function sendStdioRequest(conn: Connection, method: string, params?: unknown): Promise<unknown> {
    if (!conn.process || conn.process.exitCode !== null) {
        return Promise.reject(new Error("MCP server process is not running."));
    }
    const id = conn.nextId++;
    const message = { jsonrpc: "2.0", id, method, params: params ?? {} };
    return new Promise((resolve, reject) => {
        conn.pending.set(id, { resolve, reject });
        conn.process!.stdin.write(`${JSON.stringify(message)}\n`);
        setTimeout(() => {
            if (conn.pending.has(id)) {
                conn.pending.delete(id);
                reject(new Error(`MCP request "${method}" timed out after ${REQUEST_TIMEOUT_MS / 1000}s.`));
            }
        }, REQUEST_TIMEOUT_MS);
    });
}

function sendStdioNotification(conn: Connection, method: string, params?: unknown): void {
    conn.process?.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params: params ?? {} })}\n`);
}

// The stdio transport frames messages as newline-delimited JSON-RPC objects.
// Servers sometimes also print plain-text banners/logs to stdout before
// speaking the protocol — lines that don't parse as JSON are just ignored
// rather than treated as a fatal error.
function handleStdioData(conn: Connection, chunk: Buffer): void {
    conn.buffer += chunk.toString("utf-8");
    let newlineIndex = conn.buffer.indexOf("\n");
    while (newlineIndex !== -1) {
        const line = conn.buffer.slice(0, newlineIndex).trim();
        conn.buffer = conn.buffer.slice(newlineIndex + 1);
        newlineIndex = conn.buffer.indexOf("\n");
        if (!line) continue;
        let message: { id?: number; result?: unknown; error?: { message?: string } };
        try {
            message = JSON.parse(line);
        } catch {
            continue;
        }
        if (typeof message.id === "number" && conn.pending.has(message.id)) {
            const { resolve, reject } = conn.pending.get(message.id)!;
            conn.pending.delete(message.id);
            if (message.error) reject(new Error(message.error.message ?? "MCP server returned an error."));
            else resolve(message.result);
        }
    }
}

async function connectStdio(config: McpServerConfig): Promise<Connection> {
    if (!config.command) throw new Error("This server has no command configured.");
    const proc = spawn(config.command, config.args ?? [], {
        env: { ...process.env, ...(config.env ?? {}) },
        stdio: ["pipe", "pipe", "pipe"],
        shell: process.platform === "win32",
    });
    const conn: Connection = { config, tools: [], process: proc, buffer: "", nextId: 1, pending: new Map() };
    proc.stdout.on("data", (chunk: Buffer) => handleStdioData(conn, chunk));
    proc.on("exit", () => {
        for (const { reject } of conn.pending.values()) reject(new Error("MCP server process exited."));
        conn.pending.clear();
    });
    proc.on("error", (err) => {
        conn.lastError = err.message;
    });

    try {
        await sendStdioRequest(conn, "initialize", {
            protocolVersion: PROTOCOL_VERSION,
            capabilities: {},
            clientInfo: CLIENT_INFO,
        });
        sendStdioNotification(conn, "notifications/initialized");
        const list = (await sendStdioRequest(conn, "tools/list")) as { tools?: McpToolInfo[] };
        conn.tools = list.tools ?? [];
        return conn;
    } catch (err) {
        proc.kill();
        throw err;
    }
}

async function httpRequest(
    config: McpServerConfig,
    method: string,
    params: unknown,
    sessionId: string | undefined
): Promise<{ result: unknown; sessionId?: string }> {
    if (!config.url) throw new Error("This server has no URL configured.");
    let res: Response;
    try {
        res = await fetch(config.url, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Accept: "application/json, text/event-stream",
                ...(sessionId ? { "Mcp-Session-Id": sessionId } : {}),
                ...(config.headers ?? {}),
            },
            body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: params ?? {} }),
        });
    } catch (err) {
        throw new Error(`Could not reach MCP server: ${(err as Error).message}`);
    }
    if (!res.ok) throw new Error(`MCP server responded with HTTP ${res.status} ${res.statusText}`);
    const newSessionId = res.headers.get("mcp-session-id") ?? sessionId;
    const contentType = res.headers.get("content-type") ?? "";
    const text = await res.text();
    let json: { result?: unknown; error?: { message?: string } };
    if (contentType.includes("text/event-stream")) {
        const dataLine = text
            .split("\n")
            .filter((line) => line.startsWith("data:"))
            .pop();
        if (!dataLine) throw new Error("MCP server sent an empty event stream response.");
        json = JSON.parse(dataLine.slice(5).trim());
    } else {
        json = JSON.parse(text);
    }
    if (json.error) throw new Error(json.error.message ?? "MCP server returned an error.");
    return { result: json.result, sessionId: newSessionId };
}

async function connectHttp(config: McpServerConfig): Promise<Connection> {
    const conn: Connection = { config, tools: [], buffer: "", nextId: 1, pending: new Map() };
    const init = await httpRequest(
        config,
        "initialize",
        { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: CLIENT_INFO },
        undefined
    );
    conn.httpSessionId = init.sessionId;
    const list = await httpRequest(config, "tools/list", {}, conn.httpSessionId);
    conn.tools = (list.result as { tools?: McpToolInfo[] } | undefined)?.tools ?? [];
    return conn;
}

export async function connectServer(config: McpServerConfig): Promise<{ tools: McpToolInfo[] }> {
    disconnectServer(config.id);
    const conn = config.transport === "stdio" ? await connectStdio(config) : await connectHttp(config);
    connections.set(config.id, conn);
    return { tools: conn.tools };
}

export function disconnectServer(id: string): void {
    const conn = connections.get(id);
    if (!conn) return;
    conn.process?.kill();
    connections.delete(id);
}

export function disconnectAll(): void {
    for (const id of [...connections.keys()]) disconnectServer(id);
}

// Prefixed and namespaced so a tool name collision between two MCP servers
// (or between an MCP server and a built-in agent tool) can't happen.
function qualifiedName(serverId: string, toolName: string): string {
    return `mcp__${serverId}__${toolName}`;
}

export function isMcpTool(name: string): boolean {
    return name.startsWith("mcp__");
}

export function getConnectedTools(): ToolDefinition[] {
    const result: ToolDefinition[] = [];
    for (const conn of connections.values()) {
        for (const tool of conn.tools) {
            result.push({
                name: qualifiedName(conn.config.id, tool.name),
                description: `[MCP: ${conn.config.name}] ${tool.description ?? tool.name}`,
                parameters: (tool.inputSchema as unknown as ToolDefinition["parameters"]) ?? {
                    type: "object",
                    properties: {},
                },
            });
        }
    }
    return result;
}

// MCP tool results are `{ content: [{ type: "text", text }, ...], isError? }`
// rather than a plain string/JSON value — flatten that into text the chat
// loop can drop straight into a "tool" message.
function formatToolResult(result: unknown): string {
    const r = result as { content?: { type: string; text?: string }[]; isError?: boolean } | undefined;
    if (!r || !Array.isArray(r.content)) return JSON.stringify(result ?? null, null, 2);
    const text = r.content
        .map((block) => (block.type === "text" ? block.text ?? "" : `[${block.type} content]`))
        .join("\n");
    return r.isError ? `Error: ${text}` : text;
}

export async function callMcpTool(qualified: string, args: Record<string, unknown>): Promise<string> {
    const rest = qualified.slice("mcp__".length);
    const separator = rest.indexOf("__");
    if (separator === -1) throw new Error(`Malformed MCP tool name: ${qualified}`);
    const serverId = rest.slice(0, separator);
    const toolName = rest.slice(separator + 2);
    const conn = connections.get(serverId);
    if (!conn) throw new Error(`MCP server "${serverId}" is not connected.`);

    if (conn.config.transport === "stdio") {
        const result = await sendStdioRequest(conn, "tools/call", { name: toolName, arguments: args });
        return formatToolResult(result);
    }
    const { result, sessionId } = await httpRequest(
        conn.config,
        "tools/call",
        { name: toolName, arguments: args },
        conn.httpSessionId
    );
    conn.httpSessionId = sessionId;
    return formatToolResult(result);
}

export interface McpServerStatus {
    connected: boolean;
    toolCount: number;
    error?: string;
}

export function getServerStatuses(): Record<string, McpServerStatus> {
    const out: Record<string, McpServerStatus> = {};
    for (const [id, conn] of connections.entries()) {
        out[id] = { connected: true, toolCount: conn.tools.length, error: conn.lastError };
    }
    return out;
}
