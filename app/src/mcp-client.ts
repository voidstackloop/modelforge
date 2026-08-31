import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { ToolDefinition } from "./providers/types";
import { precompileToolSchema, clearValidatorsForServer, validateArgs } from "./mcp-schema-validation";
import { getOAuthProvider, UnauthorizedError } from "./mcp-oauth";
import { logger } from "./logger";
import { mainResourceOrchestrator } from "./resource-orchestrator";
import {
    enforceManagedMcpToolCall,
    enforceManagedMcpDataEgress,
    filterManagedMcpTools,
    resolveManagedMcpPolicy,
    type ManagedMcpPolicy,
} from "./managed-mcp-policy";

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
    // A per-tool-name allowlist the user builds one tool at a time in
    // Settings — never a blanket "trust this server" flag. Only tools listed
    // here skip the per-call approval card; everything else (including any
    // tool this server adds later) still prompts every time. See
    // frontend/src/lib/tool-approval.ts for how this is consumed.
    trustProfile?: { autoApprovedTools: string[] };
    // "oauth2" delegates entirely to mcp-oauth.ts's OAuthClientProvider —
    // authorization-server discovery, client registration, and per-server
    // resource-indicator scoping all happen there rather than being
    // pre-filled here, since RFC 9728/8414 discovery means this app doesn't
    // need to know the authorization server URL up front.
    auth?: { type: "none" | "oauth2" };
    // A hard denylist enforced in code (filtered out of both the tool list
    // and callMcpTool itself, not just hidden in the UI) — for servers like
    // DICOM MCP whose upstream tool catalog includes operations this app
    // must never expose (move_series/move_study), regardless of what the
    // server claims to offer on any given connection.
    blockedTools?: string[];
    // Persistent, non-dismissible-per-session warning shown wherever this
    // server's tools appear (Settings, the tool-approval card) — for
    // integrations like DICOM MCP that the upstream project itself warns
    // are prototypes not intended for clinical use or live patient data.
    warningBanner?: string;
}

interface McpToolInfo {
    name: string;
    description?: string;
    inputSchema?: Record<string, unknown>;
    outputSchema?: Record<string, unknown>;
    annotations?: {
        title?: string;
        readOnlyHint?: boolean;
        destructiveHint?: boolean;
        idempotentHint?: boolean;
        openWorldHint?: boolean;
    };
}

interface Connection {
    config: McpServerConfig;
    client: Client;
    transport: Transport;
    tools: McpToolInfo[];
    // Populated for the HTTP transport, which exposes the version the SDK
    // negotiated during connect(); the stdio transport validates the same
    // negotiation internally (Client.connect() throws if the server's
    // returned protocolVersion isn't in SUPPORTED_PROTOCOL_VERSIONS) but
    // doesn't expose the agreed value back to the caller the way the HTTP
    // transport does.
    protocolVersion?: string;
    lastError?: string;
    // Item 1: "MCP/local tool processes — Usually none GPU / Low-medium CPU /
    // Bounded / Per-process limits." Only the stdio transport spawns a real
    // local child process; held for the connection's whole lifetime (not
    // per-tool-call — a request-scoped lease would add admission latency to
    // every tool call in an agent loop for no real benefit once the process
    // is already running) and released on disconnect. Absent for the http
    // transport, which spawns nothing local.
    resourceLeaseId?: string;
}

const connections = new Map<string, Connection>();
// The SDK's own default request timeout applies unless overridden per-call;
// this constant is kept only for the http transport's underlying fetch,
// which the SDK's StreamableHTTPClientTransport does not itself bound.
const REQUEST_TIMEOUT_MS = 30_000;
const CLIENT_INFO = { name: "ModelForge Medical", version: "1.0.0" };

// Blocked tools are removed here, before anything else ever sees them — not
// filtered later at the UI layer — so a blocked name never reaches
// getConnectedTools() (what the model is offered), the approval card, or
// callMcpTool's own dispatch. Logged rather than silently dropped: a server
// offering a name on the denylist (or on reconnect, a *new* one matching a
// move-shaped pattern) is exactly the "don't silently trust the server's
// self-reported tool list" case this exists for.
function filterBlockedTools(config: McpServerConfig, tools: McpToolInfo[]): McpToolInfo[] {
    const blocked = new Set(config.blockedTools ?? []);
    if (blocked.size === 0) return tools;
    const kept: McpToolInfo[] = [];
    for (const tool of tools) {
        if (blocked.has(tool.name)) {
            logger.warn(`MCP server "${config.name}" (${config.id}) offered blocked tool "${tool.name}" — excluded from the tool list.`);
        } else {
            kept.push(tool);
        }
    }
    return kept;
}

async function connectStdio(config: McpServerConfig, managedPolicy: ManagedMcpPolicy | null): Promise<Connection> {
    if (!config.command) throw new Error("This server has no command configured.");
    // Acquired (never queued: a slow-to-admit MCP connect would just look
    // like a hung "Connect" button) before spawning, so a burst of servers
    // being connected at once is bounded by ordinary CPU/RAM budget
    // contention rather than left unbounded.
    const lease = await mainResourceOrchestrator.acquire({
        workloadKind: "mcp-tool",
        priority: "user-interactive",
        requirements: { cpuThreads: 1, ramMB: 0, accelerator: "none" },
        queueIfUnavailable: false,
    });
    try {
        const transport = new StdioClientTransport({
            command: config.command,
            args: config.args ?? [],
            env: { ...(getDefaultInheritedEnv()), ...(config.env ?? {}) },
        });
        const client = new Client(CLIENT_INFO, { capabilities: {} });
        await client.connect(transport);
        const list = await client.listTools();
        const tools = filterManagedMcpTools(managedPolicy, filterBlockedTools(config, list.tools as McpToolInfo[]));
        for (const tool of tools) precompileToolSchema(config.id, tool.name, tool.inputSchema);
        return { config, client, transport, tools, resourceLeaseId: lease.leaseId };
    } catch (err) {
        mainResourceOrchestrator.release(lease.leaseId);
        throw err;
    }
}

// StdioClientTransport's own getDefaultEnvironment() already filters to a
// safe inherited set (PATH, HOME, etc.) — reproduced here as a thin call so
// a missing config.env doesn't silently spawn with an empty environment.
function getDefaultInheritedEnv(): Record<string, string> {
    const filtered: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
        if (value !== undefined) filtered[key] = value;
    }
    return filtered;
}

async function connectHttp(config: McpServerConfig, managedPolicy: ManagedMcpPolicy | null): Promise<Connection> {
    if (!config.url) throw new Error("This server has no URL configured.");
    const transport = new StreamableHTTPClientTransport(new URL(config.url), {
        requestInit: { headers: config.headers ?? {} },
        authProvider: getOAuthProvider(config),
    });
    const client = new Client(CLIENT_INFO, { capabilities: {} });
    try {
        await client.connect(transport, { timeout: REQUEST_TIMEOUT_MS });
    } catch (err) {
        if (err instanceof UnauthorizedError) {
            throw new Error('This server requires authorization — run "Sign in" for it in Settings first, then connect.');
        }
        throw err;
    }
    const list = await client.listTools();
    const tools = filterManagedMcpTools(managedPolicy, filterBlockedTools(config, list.tools as McpToolInfo[]));
    for (const tool of tools) precompileToolSchema(config.id, tool.name, tool.inputSchema);
    return {
        config,
        client,
        transport,
        tools,
        protocolVersion: transport.protocolVersion,
    };
}

export async function connectServer(config: McpServerConfig): Promise<{ tools: McpToolInfo[] }> {
    disconnectServer(config.id);
    let conn: Connection;
    try {
        // In managed mode the institutional registry is authoritative. Fetch
        // it before opening a socket or spawning a child process so an
        // unregistered endpoint never receives even a tools/list request.
        const managedPolicy = await resolveManagedMcpPolicy(config);
        conn = config.transport === "stdio"
            ? await connectStdio(config, managedPolicy)
            : await connectHttp(config, managedPolicy);
    } catch (err) {
        throw new Error(`Could not connect to MCP server "${config.name}": ${(err as Error).message}`);
    }
    connections.set(config.id, conn);
    return { tools: conn.tools };
}

export function disconnectServer(id: string): void {
    const conn = connections.get(id);
    if (!conn) return;
    conn.client.close().catch(() => {
        // Best-effort — the process/connection may already be gone.
    });
    if (conn.resourceLeaseId) mainResourceOrchestrator.release(conn.resourceLeaseId);
    connections.delete(id);
    clearValidatorsForServer(id);
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

interface RawContentBlock {
    type: string;
    text?: string;
    mimeType?: string;
    uri?: string;
    name?: string;
    resource?: { uri: string; mimeType?: string };
}

export interface McpResourceLink {
    uri: string;
    name?: string;
    mimeType?: string;
}

export interface McpStructuredToolResult {
    /** Flattened text — what today's chat loop expects (the same shape callMcpTool has always returned). */
    text: string;
    /** Preserved verbatim from the server's result, never read before this milestone. */
    structuredContent?: Record<string, unknown>;
    /** Any resource/resource_link content blocks, with their MIME type kept instead of collapsed to a placeholder string. */
    resourceLinks?: McpResourceLink[];
    isError: boolean;
    /** Which server/tool/when produced this — so a caller (audit logging, a
     * future UI) doesn't have to re-derive provenance the qualified tool
     * name already implies but doesn't timestamp. */
    provenance: { serverId: string; serverName: string; toolName: string; timestamp: string };
}

// MCP tool results are `{ content: [...], structuredContent?, isError? }`.
// Earlier versions of this client only understood `content[].type === "text"`
// and threw away everything else (structuredContent, MIME types, resource
// links) — this preserves all of it, while `text` stays exactly what the
// chat loop has always consumed so nothing downstream needs to change yet.
//
// This is also where "no autonomous interpretation of image pixels" (a
// requirement for the DICOM MCP integration, but enforced generically for
// any server) actually lives: an `image`/`audio` content block's raw `data`
// is deliberately never copied into `text` below — only its type and MIME
// type, as an inert placeholder string. Nothing in this file ever hands a
// model the bytes of an image a tool returned; see
// mcp-client.test.ts's "never forwards raw image content data" test.
function buildStructuredResult(
    serverId: string,
    serverName: string,
    toolName: string,
    result: unknown
): McpStructuredToolResult {
    const r = result as { content?: RawContentBlock[]; structuredContent?: Record<string, unknown>; isError?: boolean } | undefined;
    const content = Array.isArray(r?.content) ? r!.content : [];
    const textParts: string[] = [];
    const resourceLinks: McpResourceLink[] = [];
    for (const block of content) {
        if (block.type === "text") {
            textParts.push(block.text ?? "");
        } else if (block.type === "resource_link" && block.uri) {
            textParts.push(`[resource: ${block.name ?? block.uri}]`);
            resourceLinks.push({ uri: block.uri, name: block.name, mimeType: block.mimeType });
        } else if (block.type === "resource" && block.resource) {
            textParts.push(`[embedded resource: ${block.resource.uri}]`);
            resourceLinks.push({ uri: block.resource.uri, mimeType: block.resource.mimeType });
        } else if ((block.type === "image" || block.type === "audio") && block.mimeType) {
            textParts.push(`[${block.type} content, ${block.mimeType}]`);
        } else {
            textParts.push(`[${block.type} content]`);
        }
    }
    const flatText = content.length > 0 ? textParts.join("\n") : JSON.stringify(result ?? null, null, 2);
    return {
        text: r?.isError ? `Error: ${flatText}` : flatText,
        structuredContent: r?.structuredContent,
        resourceLinks: resourceLinks.length > 0 ? resourceLinks : undefined,
        isError: r?.isError ?? false,
        provenance: { serverId, serverName, toolName, timestamp: new Date().toISOString() },
    };
}

function splitQualifiedName(qualified: string): { serverId: string; toolName: string } {
    const rest = qualified.slice("mcp__".length);
    const separator = rest.indexOf("__");
    if (separator === -1) throw new Error(`Malformed MCP tool name: ${qualified}`);
    return { serverId: rest.slice(0, separator), toolName: rest.slice(separator + 2) };
}

function requireConnection(serverId: string): Connection {
    const conn = connections.get(serverId);
    if (!conn) throw new Error(`MCP server "${serverId}" is not connected.`);
    return conn;
}

export interface McpToolCallProgress {
    progress: number;
    total?: number;
    message?: string;
}

export interface McpToolCallOptions {
    /** Aborts the in-flight request — the SDK turns this into the spec's
     * `notifications/cancelled`, not just a client-side give-up. */
    signal?: AbortSignal;
    /** Requires the server to actually send progress notifications; most
     * won't for a fast call, so this may simply never fire. */
    onProgress?: (progress: McpToolCallProgress) => void;
}

/** Full structured result — used where structuredContent/resource links/
 * provenance matter (audit logging, future UI). `callMcpTool` below stays
 * the plain-string entry point the chat loop already uses. */
export async function callMcpToolStructured(
    qualified: string,
    args: Record<string, unknown>,
    options?: McpToolCallOptions
): Promise<McpStructuredToolResult> {
    const { serverId, toolName } = splitQualifiedName(qualified);
    const conn = requireConnection(serverId);

    // Re-resolve immediately before every call. This is intentionally not a
    // connect-time-only cache: disabling an entry or removing a tool from the
    // central allowlist must fail closed for an already-open connection.
    const managedPolicy = await resolveManagedMcpPolicy(conn.config);
    enforceManagedMcpToolCall(managedPolicy, toolName, args);

    // Defense in depth: filterBlockedTools() already keeps a blocked name out
    // of conn.tools (so it's never offered to the model or shown in the
    // approval card), but this call site is checked independently rather
    // than trusting "it's not in the list" alone — a caller that somehow
    // still produces a blocked qualified name must not reach the server.
    if (conn.config.blockedTools?.includes(toolName)) {
        throw new Error(`"${toolName}" is blocked on server "${conn.config.name}" and cannot be called.`);
    }

    const problems = validateArgs(serverId, toolName, args);
    if (problems.length > 0) {
        throw new Error(`Invalid arguments for "${toolName}": ${problems.join("; ")}`);
    }

    const result = await conn.client.callTool({ name: toolName, arguments: args }, undefined, {
        signal: options?.signal,
        onprogress: options?.onProgress
            ? (p) => options.onProgress!({ progress: p.progress, total: p.total, message: p.message })
            : undefined,
    });
    return buildStructuredResult(serverId, conn.config.name, toolName, result);
}

export async function callMcpTool(qualified: string, args: Record<string, unknown>, options?: McpToolCallOptions): Promise<string> {
    const structured = await callMcpToolStructured(qualified, args, options);
    return structured.text;
}

// --- Resources, resource templates, prompts (added alongside the tools/list
// + tools/call support that already existed) ---------------------------

export interface McpResourceInfo {
    uri: string;
    name: string;
    description?: string;
    mimeType?: string;
}

export interface McpResourceTemplateInfo {
    uriTemplate: string;
    name: string;
    description?: string;
    mimeType?: string;
}

export interface McpPromptInfo {
    name: string;
    description?: string;
    arguments?: { name: string; description?: string; required?: boolean }[];
}

export interface McpResourceContent {
    uri: string;
    mimeType?: string;
    text?: string;
    blob?: string;
}

export async function listResources(serverId: string): Promise<McpResourceInfo[]> {
    const conn = requireConnection(serverId);
    // Even metadata-only protocol operations re-check that this endpoint is
    // still active for the currently selected organization.
    await resolveManagedMcpPolicy(conn.config);
    const result = await conn.client.listResources();
    return result.resources as McpResourceInfo[];
}

export async function listResourceTemplates(serverId: string): Promise<McpResourceTemplateInfo[]> {
    const conn = requireConnection(serverId);
    await resolveManagedMcpPolicy(conn.config);
    const result = await conn.client.listResourceTemplates();
    return result.resourceTemplates as McpResourceTemplateInfo[];
}

export async function readResource(serverId: string, uri: string): Promise<McpResourceContent[]> {
    const conn = requireConnection(serverId);
    const managedPolicy = await resolveManagedMcpPolicy(conn.config);
    // Resource URIs can themselves contain case/patient identifiers, so they
    // are payload rather than harmless protocol metadata.
    enforceManagedMcpDataEgress(managedPolicy, "MCP resource read", true);
    const result = await conn.client.readResource({ uri });
    return result.contents as McpResourceContent[];
}

export async function listPrompts(serverId: string): Promise<McpPromptInfo[]> {
    const conn = requireConnection(serverId);
    await resolveManagedMcpPolicy(conn.config);
    const result = await conn.client.listPrompts();
    return result.prompts as McpPromptInfo[];
}

export async function getPrompt(
    serverId: string,
    name: string,
    args?: Record<string, string>
): Promise<{ description?: string; messages: { role: string; content: unknown }[] }> {
    const conn = requireConnection(serverId);
    const managedPolicy = await resolveManagedMcpPolicy(conn.config);
    // Selecting a prompt by name is protocol metadata. User-supplied prompt
    // arguments are data egress and are therefore blocked by metadata-only.
    enforceManagedMcpDataEgress(managedPolicy, "MCP prompt request", Object.keys(args ?? {}).length > 0);
    return conn.client.getPrompt({ name, arguments: args });
}

export interface McpServerToolSummary {
    name: string;
    description?: string;
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
}

export interface McpServerStatus {
    connected: boolean;
    toolCount: number;
    protocolVersion?: string;
    error?: string;
    /** Server-declared name/description/annotations for each tool — surfaced
     * to the user (Settings trust-profile picker, the tool-approval card) as
     * server-provided and unverified, never treated as trusted UI chrome. */
    tools: McpServerToolSummary[];
}

export function getServerStatuses(): Record<string, McpServerStatus> {
    const out: Record<string, McpServerStatus> = {};
    for (const [id, conn] of connections.entries()) {
        out[id] = {
            connected: true,
            toolCount: conn.tools.length,
            protocolVersion: conn.protocolVersion,
            error: conn.lastError,
            tools: conn.tools.map((t) => ({
                name: t.name,
                description: t.description,
                readOnlyHint: t.annotations?.readOnlyHint,
                destructiveHint: t.annotations?.destructiveHint,
            })),
        };
    }
    return out;
}
