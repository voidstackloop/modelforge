import Ajv, { type ErrorObject, type ValidateFunction } from "ajv";

// Real JSON Schema validation for MCP tool arguments, replacing the old
// shallow top-level required/type check in mcp-client.ts. `strict: false`
// because MCP servers are free to include JSON-Schema-adjacent keywords
// (vendor extensions, draft variations) AJV's strict mode would otherwise
// reject outright — the goal here is validating shape, not policing the
// schema's own well-formedness.
const ajv = new Ajv({ allErrors: true, strict: false });

// Keyed `${serverId}::${toolName}` so a schema is compiled once per
// connection lifetime, not once per tool call, and so two different servers
// happening to expose a same-named tool never share a cached validator.
const validators = new Map<string, ValidateFunction | null>();

function cacheKey(serverId: string, toolName: string): string {
    return `${serverId}::${toolName}`;
}

/** Compiles and caches a tool's inputSchema. Call once per tool right after
 * connecting/reconnecting a server — a malformed schema (one AJV itself
 * can't compile) is recorded as "no validator" rather than thrown, so one
 * bad tool schema doesn't take down the whole connection; that tool's calls
 * simply go unvalidated, same as today's behavior for a tool with no
 * inputSchema at all. */
export function precompileToolSchema(serverId: string, toolName: string, inputSchema: Record<string, unknown> | undefined): void {
    const key = cacheKey(serverId, toolName);
    if (!inputSchema) {
        validators.set(key, null);
        return;
    }
    try {
        validators.set(key, ajv.compile(inputSchema));
    } catch {
        validators.set(key, null);
    }
}

export function clearValidatorsForServer(serverId: string): void {
    const prefix = `${serverId}::`;
    for (const key of [...validators.keys()]) {
        if (key.startsWith(prefix)) validators.delete(key);
    }
}

function formatError(err: ErrorObject): string {
    const path = err.instancePath ? err.instancePath.slice(1).replace(/\//g, ".") : null;
    if (err.keyword === "required") {
        const missing = (err.params as { missingProperty?: string }).missingProperty;
        return `missing required argument "${missing}"`;
    }
    const label = path ? `"${path}"` : "value";
    return `${label} ${err.message ?? "is invalid"}`.trim();
}

/** Validates tool-call arguments against the tool's declared JSON Schema
 * (compiled and cached by precompileToolSchema). Returns a human-readable
 * problem list, empty when the arguments are valid or no schema/validator
 * is known for this tool. */
export function validateArgs(serverId: string, toolName: string, args: Record<string, unknown>): string[] {
    const validator = validators.get(cacheKey(serverId, toolName));
    if (!validator) return [];
    const valid = validator(args);
    if (valid) return [];
    return (validator.errors ?? []).map(formatError);
}
