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
            "Execute a shell command in the workspace (or a subdirectory of it) and return its stdout/stderr/exit code. Use for builds, tests, git, npm, etc. Commands that could affect the system outside the workspace (deleting elsewhere, shutting down the machine, privilege escalation, etc.) are rejected.",
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

interface WriteBackup {
    relativePath: string;
    // null means the file didn't exist before this write — rollback deletes it.
    previousContent: string | null;
}

// Undo history is kept in memory only, per workspace, capped so a long agent
// session doesn't grow this unboundedly. It's intentionally session-scoped
// (not written to disk) — Rollback is a quick "oops" safety net for the
// current run, not a durable version history.
const MAX_BACKUPS_PER_WORKSPACE = 20;
const writeBackups = new Map<string, WriteBackup[]>();

function normalizeWorkspaceKey(workspaceRoot: string): string {
    return path.resolve(workspaceRoot);
}

function recordBackup(workspaceRoot: string, relativePath: string, previousContent: string | null): void {
    const key = normalizeWorkspaceKey(workspaceRoot);
    const stack = writeBackups.get(key) ?? [];
    stack.push({ relativePath, previousContent });
    while (stack.length > MAX_BACKUPS_PER_WORKSPACE) stack.shift();
    writeBackups.set(key, stack);
}

export function writeFile(workspaceRoot: string, relativePath: string, content: string): { bytesWritten: number } {
    const target = resolveSafePath(workspaceRoot, relativePath);
    let previousContent: string | null = null;
    try {
        previousContent = fs.readFileSync(target, "utf-8");
    } catch {
        previousContent = null; // file doesn't exist yet — this write creates it
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
    recordBackup(workspaceRoot, relativePath, previousContent);
    return { bytesWritten: Buffer.byteLength(content) };
}

export interface RollbackResult {
    path: string;
    restoredContent: boolean; // true = previous content restored, false = newly-created file was deleted
}

export function rollbackLastWrite(workspaceRoot: string): RollbackResult | null {
    const key = normalizeWorkspaceKey(workspaceRoot);
    const stack = writeBackups.get(key);
    const backup = stack?.pop();
    if (!backup) return null;
    const target = resolveSafePath(workspaceRoot, backup.relativePath);
    if (backup.previousContent === null) {
        fs.rmSync(target, { force: true });
        return { path: backup.relativePath, restoredContent: false };
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, backup.previousContent);
    return { path: backup.relativePath, restoredContent: true };
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

// Defense in depth for `run_command`: the workspace-root sandboxing above
// only constrains our own read_file/write_file/list_dir/search_files
// implementations, which build and validate paths themselves. A shell
// command is opaque text — it can reference any path on disk (`rm -rf ~`,
// `del C:\Windows`) regardless of the `cwd` we launch it in, so `cwd`
// alone is not a real sandbox against a destructive command. This can't
// catch everything a shell is capable of, but it blocks the common,
// catastrophic patterns outright — even if the user already clicked
// "Allow" without noticing what the command actually does.
const DANGEROUS_COMMAND_PATTERNS: RegExp[] = [
    /\brm\s+(-\w*r\w*f\w*|-\w*f\w*r\w*)\s+(\/|~|\*|\$HOME|\.\.)/i, // rm -rf /, ~, *, ..
    /\bdel\s+\/[sf]\s.*[a-z]:\\/i, // del /s /q C:\...
    /\brd\s+\/s\s+\/q\s+[a-z]:\\/i, // rd /s /q C:\...
    /\bformat\s+[a-z]:/i,
    /\bdiskpart\b/i,
    /\bmkfs(\.\w+)?\b/i,
    /\bdd\s+if=.*\bof=\/dev\//i,
    /\b(shutdown|reboot)\b/i,
    /\bRestart-Computer\b/i,
    /\bStop-Computer\b/i,
    /:\(\)\s*\{\s*:\|\s*:&\s*\}\s*;\s*:/, // classic fork bomb
    /\breg(\.exe)?\s+delete\b/i,
    /\bregedit\b/i,
    /\bsudo\b/i,
    /\brunas\b/i,
    /\bchmod\s+-R\s+777\s+\//i,
    /\bcurl\b[^|]*\|\s*(sh|bash|zsh)\b/i, // curl ... | sh
    /\b(iwr|Invoke-WebRequest)\b[^|]*\|\s*(iex|Invoke-Expression)\b/i,
];

export function findDangerousCommandReason(command: string): string | null {
    const match = DANGEROUS_COMMAND_PATTERNS.find((pattern) => pattern.test(command));
    return match
        ? "This command was blocked because it matches a pattern that could affect your whole system rather than just the workspace folder (e.g. deleting outside it, a system shutdown, or a privilege-escalation attempt)."
        : null;
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
    const dangerReason = findDangerousCommandReason(command);
    if (dangerReason) throw new Error(dangerReason);

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

export interface ProjectScripts {
    test?: string;
    lint?: string;
    format?: string;
}

// Backs the Test/Lint/Format quick-action buttons — only npm-style
// package.json scripts are recognized, which covers the JS/TS projects this
// app's Agent mode is primarily used against.
export function detectProjectScripts(workspaceRoot: string): ProjectScripts {
    const pkgPath = resolveSafePath(workspaceRoot, "package.json");
    let scripts: Record<string, string> = {};
    try {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8")) as { scripts?: Record<string, string> };
        scripts = pkg.scripts ?? {};
    } catch {
        return {};
    }
    return {
        test: scripts.test ? "npm test" : undefined,
        lint: scripts.lint ? "npm run lint" : undefined,
        format: scripts.format ? "npm run format" : undefined,
    };
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
