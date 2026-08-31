import { z } from "zod";
import type { McpServerConfig } from "./mcp-client";
import { authorizedRequest } from "./shared-backend-client";
import { getSharedBackendConfig } from "./shared-backend-config-store";

const registryEntrySchema = z.object({
    id: z.string().uuid(),
    organizationId: z.string().uuid(),
    name: z.string().min(1),
    transport: z.enum(["stdio", "http"]),
    endpoint: z.string().min(1),
    allowedTools: z.union([z.literal("*"), z.array(z.string().min(1))]),
    dataEgressPolicy: z.enum(["none", "metadata-only", "unrestricted"]),
    status: z.enum(["active", "disabled"]),
}).passthrough();

type RegistryEntry = z.infer<typeof registryEntrySchema>;

export interface ManagedMcpPolicy {
    entryId: string;
    organizationId: string;
    allowedTools: "*" | string[];
    dataEgressPolicy: "none" | "metadata-only" | "unrestricted";
}

export class ManagedMcpPolicyError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "ManagedMcpPolicyError";
    }
}

function normalizeHttpEndpoint(value: string): string | null {
    try {
        const url = new URL(value);
        url.hash = "";
        if (url.pathname !== "/") url.pathname = url.pathname.replace(/\/+$/, "");
        return url.toString();
    } catch {
        return null;
    }
}

/**
 * Canonical endpoint identity used to bind a local MCP configuration to an
 * institutional registry entry. HTTP uses a normalized URL. Stdio uses a
 * JSON array so command arguments are part of the identity; approving only
 * an executable path while allowing arbitrary arguments would let a local
 * configuration silently select a different vault, script, or target.
 */
export function canonicalMcpEndpoint(config: McpServerConfig): string {
    if (config.transport === "http") {
        if (!config.url) throw new ManagedMcpPolicyError(`MCP server "${config.name}" has no URL configured.`);
        const normalized = normalizeHttpEndpoint(config.url);
        if (!normalized) throw new ManagedMcpPolicyError(`MCP server "${config.name}" has an invalid URL.`);
        return normalized;
    }
    if (!config.command) throw new ManagedMcpPolicyError(`MCP server "${config.name}" has no command configured.`);
    return JSON.stringify([config.command, ...(config.args ?? [])]);
}

function entryMatches(config: McpServerConfig, entry: RegistryEntry): boolean {
    if (entry.transport !== config.transport || entry.status !== "active") return false;
    if (config.transport === "http") {
        return normalizeHttpEndpoint(entry.endpoint) === canonicalMcpEndpoint(config);
    }
    return entry.endpoint === canonicalMcpEndpoint(config);
}

export function selectManagedMcpPolicy(
    config: McpServerConfig,
    organizationId: string,
    entries: unknown
): ManagedMcpPolicy {
    const parsed = z.array(registryEntrySchema).safeParse(entries);
    if (!parsed.success) throw new ManagedMcpPolicyError("The institutional MCP registry returned an invalid response.");
    const matches = parsed.data.filter((entry) => entry.organizationId === organizationId && entryMatches(config, entry));
    if (matches.length === 0) {
        throw new ManagedMcpPolicyError(
            `MCP server "${config.name}" is not an active entry in the selected organization's registry.`
        );
    }
    if (matches.length > 1) {
        throw new ManagedMcpPolicyError(
            `MCP server "${config.name}" matches multiple institutional registry entries; an administrator must remove the ambiguity.`
        );
    }
    const entry = matches[0];
    return {
        entryId: entry.id,
        organizationId: entry.organizationId,
        allowedTools: entry.allowedTools,
        dataEgressPolicy: entry.dataEgressPolicy,
    };
}

/** Null means standalone/local mode. Once an organization is selected, any
 * registry/network/auth failure is an error and therefore fails closed. */
export async function resolveManagedMcpPolicy(config: McpServerConfig): Promise<ManagedMcpPolicy | null> {
    const organizationId = getSharedBackendConfig()?.organizationId;
    if (!organizationId) return null;
    const response = await authorizedRequest(
        `/organizations/${encodeURIComponent(organizationId)}/mcp-registry?status=active`
    );
    if (!response.ok) {
        throw new ManagedMcpPolicyError(`Could not verify institutional MCP policy: HTTP ${response.status}.`);
    }
    return selectManagedMcpPolicy(config, organizationId, await response.json());
}

export function filterManagedMcpTools<T extends { name: string }>(policy: ManagedMcpPolicy | null, tools: T[]): T[] {
    if (!policy || policy.allowedTools === "*") return tools;
    const allowed = new Set(policy.allowedTools);
    return tools.filter((tool) => allowed.has(tool.name));
}

export function enforceManagedMcpToolCall(
    policy: ManagedMcpPolicy | null,
    toolName: string,
    args: Record<string, unknown>
): void {
    if (!policy) return;
    if (policy.allowedTools !== "*" && !policy.allowedTools.includes(toolName)) {
        throw new ManagedMcpPolicyError(`MCP tool "${toolName}" is not allowed by institutional policy.`);
    }
    enforceManagedMcpDataEgress(policy, `MCP tool "${toolName}"`, Object.keys(args).length > 0);
}

export function enforceManagedMcpDataEgress(
    policy: ManagedMcpPolicy | null,
    operation: string,
    hasPayload: boolean
): void {
    if (!policy) return;
    if (policy.dataEgressPolicy === "none") {
        throw new ManagedMcpPolicyError(`Institutional policy forbids ${operation}; this MCP server may not receive data.`);
    }
    // The registry has no field-level data-classification vocabulary yet.
    // Treating arbitrary values as "metadata" would be an unsafe guess, so
    // metadata-only allows only an empty arguments object. This is strict but
    // auditable and can be relaxed later when typed egress contracts exist.
    if (policy.dataEgressPolicy === "metadata-only" && hasPayload) {
        throw new ManagedMcpPolicyError(
            `Institutional policy permits metadata-only MCP access; ${operation} contains a payload and was blocked.`
        );
    }
}
