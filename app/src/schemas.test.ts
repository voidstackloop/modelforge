import { describe, it, expect } from "vitest";
import {
    agentToolArgsSchemas,
    appSettingsSchema,
    formatZodError,
    mcpServerConfigSchema,
    mcpToolArgsSchema,
    parseOrThrow,
    secretsFileSchema,
    secretsSetInputSchema,
} from "./schemas";

// These schemas are exactly what main.ts's IPC handlers run malformed
// renderer input through before it reaches store/tool code (settings:save,
// secrets:set, mcp:connect, tools:execute) or before a JSON file loaded from
// disk is trusted (json-store.ts's readJsonWithSchema). Testing them directly
// is testing the actual guard, not a stand-in for it.

describe("parseOrThrow", () => {
    it("returns the parsed value for valid input", () => {
        expect(parseOrThrow(secretsSetInputSchema, { key: "openai_api_key", value: "sk-1" }, "secrets")).toEqual({
            key: "openai_api_key",
            value: "sk-1",
        });
    });

    it("throws a single readable error naming every offending field", () => {
        expect(() => parseOrThrow(secretsSetInputSchema, { key: 5, value: 9 }, "secrets:set arguments")).toThrow(
            /Invalid secrets:set arguments: key: .*; value: /
        );
    });
});

describe("formatZodError", () => {
    it("joins issues with their dotted path", () => {
        const result = mcpServerConfigSchema.safeParse({ id: "x", name: "x", transport: "carrier-pigeon", enabled: true });
        expect(result.success).toBe(false);
        if (!result.success) {
            expect(formatZodError(result.error)).toMatch(/^transport: /);
        }
    });
});

describe("secretsSetInputSchema", () => {
    it("accepts a value-less request (delete)", () => {
        expect(secretsSetInputSchema.safeParse({ key: "figma_token" }).success).toBe(true);
    });

    it("rejects a missing key", () => {
        expect(secretsSetInputSchema.safeParse({ value: "x" }).success).toBe(false);
    });

    it("rejects an empty-string key", () => {
        expect(secretsSetInputSchema.safeParse({ key: "" }).success).toBe(false);
    });

    it("rejects a non-string value", () => {
        expect(secretsSetInputSchema.safeParse({ key: "k", value: 123 }).success).toBe(false);
    });
});

describe("secretsFileSchema", () => {
    it("accepts a flat string map", () => {
        expect(secretsFileSchema.safeParse({ openai_api_key: "enc-blob" }).success).toBe(true);
    });

    it("rejects a value that isn't a string (e.g. a hand-edited nested object)", () => {
        expect(secretsFileSchema.safeParse({ openai_api_key: { nested: true } }).success).toBe(false);
    });

    it("rejects a top-level array", () => {
        expect(secretsFileSchema.safeParse(["not", "a", "map"]).success).toBe(false);
    });
});

describe("mcpServerConfigSchema", () => {
    it("accepts a well-formed stdio server", () => {
        expect(
            mcpServerConfigSchema.safeParse({ id: "s1", name: "Server", transport: "stdio", enabled: true, command: "npx", args: ["-y", "pkg"] })
                .success
        ).toBe(true);
    });

    it("accepts a well-formed http server", () => {
        expect(
            mcpServerConfigSchema.safeParse({ id: "s2", name: "Server", transport: "http", enabled: false, url: "https://example.com/mcp" }).success
        ).toBe(true);
    });

    it("rejects an invalid transport value", () => {
        expect(mcpServerConfigSchema.safeParse({ id: "s3", name: "n", transport: "websocket", enabled: true }).success).toBe(false);
    });

    it("rejects a missing enabled flag", () => {
        expect(mcpServerConfigSchema.safeParse({ id: "s4", name: "n", transport: "stdio" }).success).toBe(false);
    });

    it("rejects args that aren't all strings", () => {
        expect(mcpServerConfigSchema.safeParse({ id: "s5", name: "n", transport: "stdio", enabled: true, args: ["ok", 42] }).success).toBe(
            false
        );
    });
});

describe("appSettingsSchema", () => {
    it("accepts an empty patch", () => {
        expect(appSettingsSchema.safeParse({}).success).toBe(true);
    });

    it("accepts a normal partial save", () => {
        expect(appSettingsSchema.safeParse({ temperature: 0.5, theme: "dark", onboardingComplete: true }).success).toBe(true);
    });

    it("passes through fields it doesn't recognize (forward compatibility)", () => {
        const result = appSettingsSchema.safeParse({ temperature: 0.5, someFutureField: "value" });
        expect(result.success).toBe(true);
        if (result.success) expect((result.data as Record<string, unknown>).someFutureField).toBe("value");
    });

    it("rejects a numeric field sent as a string", () => {
        expect(appSettingsSchema.safeParse({ temperature: "hot" }).success).toBe(false);
    });

    it("rejects an invalid enum value", () => {
        expect(appSettingsSchema.safeParse({ theme: "solarized" }).success).toBe(false);
    });

    it("rejects a malformed nested mcpServers entry", () => {
        expect(appSettingsSchema.safeParse({ mcpServers: [{ id: "x", name: "n" /* missing transport/enabled */ }] }).success).toBe(false);
    });

    it("rejects a malformed nested customProviders entry (modelIds not an array)", () => {
        expect(
            appSettingsSchema.safeParse({ customProviders: [{ id: "c1", name: "Custom", baseUrl: "https://x", modelIds: "not-an-array" }] })
                .success
        ).toBe(false);
    });
});

describe("agentToolArgsSchemas (tools:execute)", () => {
    it("covers every dispatchable built-in tool", () => {
        // Mirrors agent-tools.ts's executeTool() switch minus set_plan/
        // request_checkpoint, which the frontend intercepts before an IPC
        // call is ever made and so never reach executeTool.
        const dispatchedTools = [
            "read_file", "write_file", "replace_in_file", "find_files", "file_info", "make_directory",
            "move_path", "delete_path", "list_dir", "search_files", "run_command", "run_code",
            "start_background_command", "get_background_output", "stop_background_command", "list_background_commands",
            "create_terminal", "write_to_terminal", "read_terminal_output", "close_terminal",
            "git_status", "git_diff", "git_log", "git_commit", "web_search",
            "github_list_repositories", "github_repository_tree", "github_read_file",
            "fetch_url", "http_request", "capture_page_screenshot", "find_symbol_references",
            "apply_patch", "read_notes", "write_notes",
        ];
        for (const tool of dispatchedTools) {
            expect(agentToolArgsSchemas, `missing schema for "${tool}"`).toHaveProperty(tool);
        }
    });

    it("accepts the shape read_file is actually called with", () => {
        expect(agentToolArgsSchemas.read_file.safeParse({ path: "a.ts" }).success).toBe(true);
        expect(agentToolArgsSchemas.read_file.safeParse({ path: "a.ts", start_line: 1, end_line: 10 }).success).toBe(true);
    });

    it("rejects read_file with no path", () => {
        expect(agentToolArgsSchemas.read_file.safeParse({}).success).toBe(false);
    });

    it("rejects read_file with a numeric path", () => {
        expect(agentToolArgsSchemas.read_file.safeParse({ path: 42 }).success).toBe(false);
    });

    it("rejects write_file missing content", () => {
        expect(agentToolArgsSchemas.write_file.safeParse({ path: "a.ts" }).success).toBe(false);
    });

    it("rejects move_path missing destination", () => {
        expect(agentToolArgsSchemas.move_path.safeParse({ source: "a" }).success).toBe(false);
    });

    it("rejects run_command with a non-string command", () => {
        expect(agentToolArgsSchemas.run_command.safeParse({ command: ["rm", "-rf", "/"] }).success).toBe(false);
    });

    it("accepts run_command's optional fields when present and well-typed", () => {
        expect(agentToolArgsSchemas.run_command.safeParse({ command: "ls", cwd: ".", network: false }).success).toBe(true);
    });

    it("rejects run_code with an unsupported language", () => {
        expect(agentToolArgsSchemas.run_code.safeParse({ language: "ruby", code: "puts 1" }).success).toBe(false);
    });

    it("rejects http_request with an unsupported method", () => {
        expect(agentToolArgsSchemas.http_request.safeParse({ url: "https://x", method: "TRACE" }).success).toBe(false);
    });

    it("rejects http_request whose headers aren't a flat string map", () => {
        expect(agentToolArgsSchemas.http_request.safeParse({ url: "https://x", headers: { a: 1 } }).success).toBe(false);
    });

    it("accepts tools with no required arguments called with an empty object", () => {
        expect(agentToolArgsSchemas.git_status.safeParse({}).success).toBe(true);
        expect(agentToolArgsSchemas.list_dir.safeParse({}).success).toBe(true);
    });
});

describe("mcpToolArgsSchema (MCP-provided tools)", () => {
    it("accepts a plain object of arbitrary shape", () => {
        expect(mcpToolArgsSchema.safeParse({ anything: "goes", nested: { ok: true } }).success).toBe(true);
        expect(mcpToolArgsSchema.safeParse({}).success).toBe(true);
    });

    it("rejects a non-object payload", () => {
        expect(mcpToolArgsSchema.safeParse("just a string").success).toBe(false);
        expect(mcpToolArgsSchema.safeParse(["array", "not", "object"]).success).toBe(false);
        expect(mcpToolArgsSchema.safeParse(null).success).toBe(false);
    });
});
