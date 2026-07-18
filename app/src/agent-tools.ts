import * as fs from "node:fs";
import * as path from "node:path";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import type { ToolDefinition } from "./providers/types";

const execAsync = promisify(exec);

export const AGENT_TOOLS: ToolDefinition[] = [
    {
        name: "read_file",
        description: "Read the contents of a text file within the workspace.",
        parameters: {
            type: "object",
            properties: {
                path: { type: "string", description: "File path, relative to the workspace root." },
            },
            required: ["path"],
        },
    },
    {
        name: "write_file",
        description: "Create a file or overwrite it with the given content. Creates parent directories as needed.",
        parameters: {
            type: "object",
            properties: {
                path: { type: "string", description: "File path, relative to the workspace root." },
                content: { type: "string", description: "The full content to write to the file." },
            },
            required: ["path", "content"],
        },
    },
    {
        name: "list_dir",
        description: "List files and subdirectories at a path within the workspace.",
        parameters: {
            type: "object",
            properties: {
                path: { type: "string", description: 'Directory path, relative to the workspace root. Use "." for the root.' },
            },
            required: [],
        },
    },
    {
        name: "search_files",
        description: "Search for a text string across files in the workspace and return matching lines.",
        parameters: {
            type: "object",
            properties: {
                query: { type: "string", description: "The text to search for (plain substring match, case-sensitive)." },
                path: { type: "string", description: 'Subdirectory to scope the search to, relative to the workspace root. Defaults to "."' },
            },
            required: ["query"],
        },
    },
    {
        name: "run_command",
        description:
            "Execute a shell command in the workspace (or a subdirectory of it) and return its stdout/stderr/exit code. Use for builds, tests, git, npm, etc.",
        parameters: {
            type: "object",
            properties: {
                command: { type: "string", description: "The shell command to run." },
                cwd: { type: "string", description: 'Working directory for the command, relative to the workspace root. Defaults to "."' },
            },
            required: ["command"],
        },
    },
];

const MAX_READ_CHARS = 100_000;
const MAX_SEARCH_RESULTS = 50;
const MAX_LIST_ENTRIES = 500;
const MAX_COMMAND_OUTPUT_CHARS = 50_000;
const COMMAND_TIMEOUT_MS = 60_000;
const IGNORED_DIRS = new Set(["node_modules", ".git", "dist", "build", "out", "release", "__pycache__"]);

// Every tool call is confined to the chosen workspace directory — this
// resolves the (possibly relative, possibly attacker-crafted via a prompt
// injection in file content the model read) path and throws if it would
// escape that directory via ../ or an absolute path elsewhere on disk.
function resolveSafePath(workspaceRoot: string, relativePath: string): string {
    const root = path.resolve(workspaceRoot);
    const resolved = path.resolve(root, relativePath || ".");
    if (resolved !== root && !resolved.startsWith(root + path.sep)) {
        throw new Error(`Path "${relativePath}" is outside the workspace directory.`);
    }
    return resolved;
}

export function readFile(workspaceRoot: string, relativePath: string): string {
    const target = resolveSafePath(workspaceRoot, relativePath);
    const stat = fs.statSync(target);
    if (stat.isDirectory()) throw new Error(`"${relativePath}" is a directory, not a file.`);
    const content = fs.readFileSync(target, "utf-8");
    return content.length > MAX_READ_CHARS
        ? `${content.slice(0, MAX_READ_CHARS)}\n\n[truncated — file is ${content.length} characters]`
        : content;
}

export function writeFile(workspaceRoot: string, relativePath: string, content: string): { bytesWritten: number } {
    const target = resolveSafePath(workspaceRoot, relativePath);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
    return { bytesWritten: Buffer.byteLength(content) };
}

export function listDir(workspaceRoot: string, relativePath: string): string[] {
    const target = resolveSafePath(workspaceRoot, relativePath || ".");
    const entries = fs.readdirSync(target, { withFileTypes: true });
    return entries.slice(0, MAX_LIST_ENTRIES).map((e) => (e.isDirectory() ? `${e.name}/` : e.name));
}

export interface SearchMatch {
    file: string;
    line: number;
    text: string;
}

export function searchFiles(workspaceRoot: string, query: string, relativePath = "."): SearchMatch[] {
    const startDir = resolveSafePath(workspaceRoot, relativePath);
    const results: SearchMatch[] = [];

    function walk(dir: string): void {
        if (results.length >= MAX_SEARCH_RESULTS) return;
        let entries: fs.Dirent[];
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
            return;
        }
        for (const entry of entries) {
            if (results.length >= MAX_SEARCH_RESULTS) return;
            if (entry.name.startsWith(".") || IGNORED_DIRS.has(entry.name)) continue;
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                walk(full);
                continue;
            }
            if (!entry.isFile()) continue;
            let text: string;
            try {
                text = fs.readFileSync(full, "utf-8");
            } catch {
                continue; // binary or unreadable — skip
            }
            const lines = text.split("\n");
            for (let i = 0; i < lines.length && results.length < MAX_SEARCH_RESULTS; i++) {
                if (lines[i].includes(query)) {
                    results.push({
                        file: path.relative(workspaceRoot, full).split(path.sep).join("/"),
                        line: i + 1,
                        text: lines[i].trim().slice(0, 200),
                    });
                }
            }
        }
    }

    walk(startDir);
    return results;
}

function truncateOutput(text: string): string {
    return text.length > MAX_COMMAND_OUTPUT_CHARS
        ? `${text.slice(0, MAX_COMMAND_OUTPUT_CHARS)}\n[truncated]`
        : text;
}

function formatCommandResult(stdout: string, stderr: string, exitCode: number | null): string {
    const parts = [`Exit code: ${exitCode}`];
    if (stdout) parts.push(`--- stdout ---\n${truncateOutput(stdout)}`);
    if (stderr) parts.push(`--- stderr ---\n${truncateOutput(stderr)}`);
    return parts.join("\n\n");
}

export async function runCommand(workspaceRoot: string, command: string, relativeCwd = "."): Promise<string> {
    const cwd = resolveSafePath(workspaceRoot, relativeCwd);
    try {
        const { stdout, stderr } = await execAsync(command, {
            cwd,
            timeout: COMMAND_TIMEOUT_MS,
            maxBuffer: 10 * 1024 * 1024,
        });
        return formatCommandResult(stdout, stderr, 0);
    } catch (err) {
        const e = err as { stdout?: string; stderr?: string; code?: number; killed?: boolean; message: string };
        if (e.killed) {
            return `Command timed out after ${COMMAND_TIMEOUT_MS / 1000}s.\n\n${formatCommandResult(e.stdout ?? "", e.stderr ?? "", e.code ?? null)}`;
        }
        return formatCommandResult(e.stdout ?? "", e.stderr ?? e.message, e.code ?? null);
    }
}

export async function executeTool(workspaceRoot: string, name: string, args: Record<string, unknown>): Promise<unknown> {
    switch (name) {
        case "read_file":
            return readFile(workspaceRoot, String(args.path ?? ""));
        case "write_file":
            return writeFile(workspaceRoot, String(args.path ?? ""), String(args.content ?? ""));
        case "list_dir":
            return listDir(workspaceRoot, String(args.path ?? "."));
        case "search_files":
            return searchFiles(workspaceRoot, String(args.query ?? ""), args.path ? String(args.path) : ".");
        case "run_command":
            return runCommand(workspaceRoot, String(args.command ?? ""), args.cwd ? String(args.cwd) : ".");
        default:
            throw new Error(`Unknown tool: ${name}`);
    }
}
