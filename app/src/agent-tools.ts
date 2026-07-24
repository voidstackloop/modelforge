import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { exec, spawn, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import type { ToolDefinition } from "./providers/types";
import { getAccountToken } from "./accounts";
import { capturePageScreenshot } from "./browser-capture";
import { killProcessTree } from "./process-tree";
import { applySandbox } from "./command-sandbox";
import { monitorProcess } from "./resource-monitor";
import * as settingsStore from "./settings-store";

const execAsync = promisify(exec);

export const AGENT_TOOLS: ToolDefinition[] = [
    {
        name: "read_file",
        description: "Read the contents of a text file within the workspace.",
        parameters: {
            type: "object",
            properties: {
                path: { type: "string", description: "File path, relative to the workspace root." },
                start_line: { type: "number", description: "Optional 1-based first line to read." },
                end_line: { type: "number", description: "Optional 1-based last line to read (inclusive)." },
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
        name: "replace_in_file",
        description: "Replace one exact block of text in a file. Safer and more token-efficient than rewriting the whole file; fails if the text is missing or ambiguous.",
        parameters: {
            type: "object",
            properties: {
                path: { type: "string", description: "File path, relative to the workspace root." },
                old_text: { type: "string", description: "Exact text currently in the file." },
                new_text: { type: "string", description: "Replacement text." },
                replace_all: { type: "boolean", description: "Replace every occurrence instead of requiring exactly one." },
            },
            required: ["path", "old_text", "new_text"],
        },
    },
    {
        name: "find_files",
        description: "Find files by a glob-style pattern such as **/*.ts or src/*.tsx. Skips generated and dependency directories.",
        parameters: {
            type: "object",
            properties: {
                pattern: { type: "string", description: "Glob-style path pattern relative to the search directory." },
                path: { type: "string", description: 'Search directory relative to the workspace root. Defaults to ".".' },
            },
            required: ["pattern"],
        },
    },
    {
        name: "file_info",
        description: "Get a file or directory's type, size, and modification time.",
        parameters: {
            type: "object",
            properties: { path: { type: "string", description: "Path relative to the workspace root." } },
            required: ["path"],
        },
    },
    {
        name: "make_directory",
        description: "Create a directory and any missing parent directories within the workspace.",
        parameters: {
            type: "object",
            properties: { path: { type: "string", description: "Directory path relative to the workspace root." } },
            required: ["path"],
        },
    },
    {
        name: "move_path",
        description: "Move or rename a file or directory within the workspace. Refuses to overwrite an existing destination.",
        parameters: {
            type: "object",
            properties: {
                source: { type: "string", description: "Existing source path relative to the workspace root." },
                destination: { type: "string", description: "New destination path relative to the workspace root." },
            },
            required: ["source", "destination"],
        },
    },
    {
        name: "delete_path",
        description: "Delete a file or an empty directory within the workspace. Set recursive=true only when explicitly asked to delete a non-empty directory.",
        parameters: {
            type: "object",
            properties: {
                path: { type: "string", description: "Path relative to the workspace root." },
                recursive: { type: "boolean", description: "Allow deleting a non-empty directory tree." },
            },
            required: ["path"],
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
            "Execute a shell command in the workspace (or a subdirectory of it) and return its stdout/stderr/exit code. Use for builds, tests, git, npm, etc. Commands that could affect the system outside the workspace (deleting elsewhere, shutting down the machine, privilege escalation, etc.) are rejected. Runs inside an OS-level sandbox confined to the workspace where the platform supports it (Linux with bubblewrap installed, macOS always) — on Windows this containment isn't available and only the command-text checks above apply.",
        parameters: {
            type: "object",
            properties: {
                command: { type: "string", description: "The shell command to run." },
                cwd: { type: "string", description: 'Working directory for the command, relative to the workspace root. Defaults to "."' },
                network: { type: "boolean", description: "Whether this command needs network access (e.g. npm install, curl). Defaults to false — most commands don't need it." },
            },
            required: ["command"],
        },
    },
    {
        name: "run_code",
        description:
            "Run a Python or JavaScript code snippet in the workspace and return its stdout/stderr/exit code. A convenience over run_command for multi-line code (no shell-quoting to worry about) — subject to the same sandboxing (where available) and safety checks as run_command.",
        parameters: {
            type: "object",
            properties: {
                language: { type: "string", enum: ["python", "javascript"], description: "Which interpreter to run the code with." },
                code: { type: "string", description: "The full source code to execute." },
                cwd: { type: "string", description: 'Working directory, relative to the workspace root. Defaults to "."' },
                network: { type: "boolean", description: "Whether this code needs network access. Defaults to false." },
            },
            required: ["language", "code"],
        },
    },
    {
        name: "start_background_command",
        description:
            "Start a long-running command (dev server, build watcher, long test run) in the background and return immediately with a task id. Use get_background_output to check on it later and stop_background_command when done — unlike run_command, this doesn't block or time out. Subject to the same safety checks and sandboxing as run_command.",
        parameters: {
            type: "object",
            properties: {
                command: { type: "string", description: "The shell command to run." },
                cwd: { type: "string", description: 'Working directory, relative to the workspace root. Defaults to "."' },
                name: { type: "string", description: "Short human-readable label for this task (e.g. \"dev server\")." },
                network: { type: "boolean", description: "Whether this command needs network access (e.g. a dev server that fetches data). Defaults to false." },
            },
            required: ["command"],
        },
    },
    {
        name: "get_background_output",
        description: "Get the current status and recent output of a background command started with start_background_command.",
        parameters: {
            type: "object",
            properties: {
                task_id: { type: "string", description: "The task id returned by start_background_command." },
            },
            required: ["task_id"],
        },
    },
    {
        name: "stop_background_command",
        description: "Stop a running background command by its task id.",
        parameters: {
            type: "object",
            properties: {
                task_id: { type: "string", description: "The task id returned by start_background_command." },
            },
            required: ["task_id"],
        },
    },
    {
        name: "list_background_commands",
        description: "List all background commands from this session with their status.",
        parameters: { type: "object", properties: {}, required: [] },
    },
    {
        name: "git_status",
        description: "Show the working tree status (git status) for the workspace.",
        parameters: { type: "object", properties: {}, required: [] },
    },
    {
        name: "git_diff",
        description: "Show unstaged (or, if staged=true, staged) changes in the workspace as a unified diff.",
        parameters: {
            type: "object",
            properties: {
                staged: { type: "boolean", description: "Show staged changes (git diff --staged) instead of unstaged." },
                path: { type: "string", description: "Limit the diff to this file or directory, relative to the workspace root." },
            },
            required: [],
        },
    },
    {
        name: "git_log",
        description: "Show recent commit history for the workspace.",
        parameters: {
            type: "object",
            properties: {
                count: { type: "number", description: "How many commits to show. Defaults to 10." },
            },
            required: [],
        },
    },
    {
        name: "git_commit",
        description: "Stage all changes and create a commit in the workspace. Requires explicit approval, like write_file.",
        parameters: {
            type: "object",
            properties: {
                message: { type: "string", description: "The commit message." },
            },
            required: ["message"],
        },
    },
    {
        name: "web_search",
        description: "Search the web for a query and return the top results (title, URL, snippet). Use this to find information not available locally.",
        parameters: {
            type: "object",
            properties: {
                query: { type: "string", description: "The search query." },
            },
            required: ["query"],
        },
    },
    {
        name: "github_list_repositories",
        description: "List repositories accessible to the linked GitHub account. Use this to choose a repository for analysis.",
        parameters: {
            type: "object",
            properties: {
                visibility: { type: "string", enum: ["all", "public", "private"], description: "Repository visibility filter. Defaults to all." },
                limit: { type: "number", description: "Maximum repositories to return, from 1 to 100. Defaults to 30." },
            },
            required: [],
        },
    },
    {
        name: "github_repository_tree",
        description: "List the complete file tree of a GitHub repository so its structure can be analyzed before reading selected files.",
        parameters: {
            type: "object",
            properties: {
                repository: { type: "string", description: "Repository in owner/name form." },
                ref: { type: "string", description: "Branch, tag, or commit. Defaults to the repository's default branch." },
            },
            required: ["repository"],
        },
    },
    {
        name: "github_read_file",
        description: "Read a UTF-8 text file from a repository accessible to the linked GitHub account.",
        parameters: {
            type: "object",
            properties: {
                repository: { type: "string", description: "Repository in owner/name form." },
                path: { type: "string", description: "File path inside the repository." },
                ref: { type: "string", description: "Branch, tag, or commit. Defaults to the default branch." },
            },
            required: ["repository", "path"],
        },
    },
    {
        name: "fetch_url",
        description: "Fetch a web page by URL and return its readable text content (HTML tags stripped). Use after web_search to read a specific result, or for any URL the user provides.",
        parameters: {
            type: "object",
            properties: {
                url: { type: "string", description: "The full URL to fetch, including https://." },
            },
            required: ["url"],
        },
    },
    {
        name: "http_request",
        description:
            "Make an HTTP request to any URL with a chosen method, headers, and body, and return the response status and body. Use this for calling REST APIs — fetch_url is for reading web pages, this is for actual API calls (GET/POST/PUT/PATCH/DELETE). Requires explicit approval, like write_file, since it can have side effects on external systems.",
        parameters: {
            type: "object",
            properties: {
                url: { type: "string", description: "The full URL to request, including https://." },
                method: { type: "string", enum: ["GET", "POST", "PUT", "PATCH", "DELETE"], description: "Defaults to GET." },
                headers: { type: "object", properties: {}, description: "Request headers as a flat object of string values." },
                body: { type: "string", description: "Raw request body, e.g. a JSON string. Omit for GET/DELETE." },
            },
            required: ["url"],
        },
    },
    {
        name: "capture_page_screenshot",
        description:
            "Load a URL in a hidden browser window and return a screenshot of the rendered page as an image. Use this to visually inspect a web page or a local dev server (e.g. http://localhost:3000) — fetch_url only gives you the HTML/text, not what it actually looks like.",
        parameters: {
            type: "object",
            properties: {
                url: { type: "string", description: "The full URL to load, including http:// or https://." },
                width: { type: "number", description: "Viewport width in pixels. Defaults to 1280." },
                height: { type: "number", description: "Viewport height in pixels. Defaults to 800." },
            },
            required: ["url"],
        },
    },
    {
        name: "find_symbol_references",
        description:
            "Find where a function, class, variable, or other identifier is defined and referenced across the workspace. Faster and more targeted than search_files for navigating code — use this before editing something to see everywhere it's used.",
        parameters: {
            type: "object",
            properties: {
                symbol: { type: "string", description: "The identifier to search for (e.g. a function or class name)." },
                path: { type: "string", description: 'Subdirectory to scope the search to, relative to the workspace root. Defaults to "."' },
            },
            required: ["symbol"],
        },
    },
    {
        name: "apply_patch",
        description:
            "Apply a unified diff (the format produced by `git diff` / `diff -u`) across one or more files in a single call, instead of one replace_in_file call per file. Use this for multi-file refactors or when you already have a precise diff in mind. Requires explicit approval, like write_file.",
        parameters: {
            type: "object",
            properties: {
                patch: { type: "string", description: "The unified diff text, with --- /+++ file headers and @@ hunks." },
            },
            required: ["patch"],
        },
    },
    {
        name: "read_notes",
        description: "Read the agent's persistent notes for this workspace — a scratchpad for tracking long-running context, decisions, or progress across turns and sessions. Empty if nothing has been written yet.",
        parameters: { type: "object", properties: {}, required: [] },
    },
    {
        name: "write_notes",
        description: "Overwrite the agent's persistent notes for this workspace with the given content. Use this to record progress, decisions, or context worth remembering later in a long task — write the full notes each time, not just an addition.",
        parameters: {
            type: "object",
            properties: {
                content: { type: "string", description: "The full notes content to save, replacing whatever was there before." },
            },
            required: ["content"],
        },
    },
    {
        name: "set_plan",
        description:
            "Declare or update a step-by-step plan for the current task, shown to the user as a checklist. Call this once at the start of any multi-step task, then call it again (with the full updated list) whenever a step is completed or the plan changes. Always pass the complete list, not just changes.",
        parameters: {
            type: "object",
            properties: {
                steps: {
                    type: "array",
                    items: {
                        type: "object",
                        properties: {
                            text: { type: "string", description: "Short description of this step." },
                            done: { type: "boolean", description: "Whether this step is already complete." },
                        },
                        required: ["text", "done"],
                    },
                    description: "The full, ordered list of steps.",
                },
            },
            required: ["steps"],
        },
    },
    {
        name: "request_checkpoint",
        description:
            "Pause and ask the user to confirm before continuing — use this after finishing a meaningful chunk of work or before starting something risky/irreversible, so the user can review progress rather than only finding out at the very end.",
        parameters: {
            type: "object",
            properties: {
                summary: { type: "string", description: "What's been done so far, in a sentence or two." },
                question: { type: "string", description: "What you'd like to confirm before continuing (optional)." },
            },
            required: ["summary"],
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
    const isWithin = (parent: string, child: string): boolean => {
        const relative = path.relative(parent, child);
        return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
    };
    if (!isWithin(root, resolved)) {
        throw new Error(`Path "${relativePath}" is outside the workspace directory.`);
    }

    // Lexical checks alone are bypassable through a symlink inside the
    // workspace that points elsewhere. Resolve the target, or its nearest
    // existing parent for new files, and verify the real path too.
    const realRoot = fs.realpathSync(root);
    let existing = resolved;
    while (!fs.existsSync(existing)) {
        const parent = path.dirname(existing);
        if (parent === existing) break;
        existing = parent;
    }
    const realExisting = fs.realpathSync(existing);
    if (!isWithin(realRoot, realExisting)) {
        throw new Error(`Path "${relativePath}" resolves outside the workspace directory through a symbolic link.`);
    }
    return resolved;
}

export function readFile(workspaceRoot: string, relativePath: string, startLine?: number, endLine?: number): string {
    const target = resolveSafePath(workspaceRoot, relativePath);
    const stat = fs.statSync(target);
    if (stat.isDirectory()) throw new Error(`"${relativePath}" is a directory, not a file.`);
    const content = fs.readFileSync(target, "utf-8");
    if (startLine !== undefined || endLine !== undefined) {
        const start = Math.max(1, Math.floor(startLine ?? 1));
        const end = Math.max(start, Math.floor(endLine ?? start + 499));
        if (end - start > 2_000) throw new Error("A ranged read is limited to 2,001 lines at a time.");
        const lines = content.split(/\r?\n/);
        if (start > lines.length) throw new Error(`start_line ${start} is beyond the file's ${lines.length} lines.`);
        return lines.slice(start - 1, Math.min(end, lines.length)).join("\n");
    }
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

export function replaceInFile(
    workspaceRoot: string,
    relativePath: string,
    oldText: string,
    newText: string,
    replaceAll = false
): { replacements: number; bytesWritten: number } {
    if (!oldText) throw new Error("old_text must not be empty.");
    const target = resolveSafePath(workspaceRoot, relativePath);
    const content = fs.readFileSync(target, "utf-8");
    const occurrences = content.split(oldText).length - 1;
    if (occurrences === 0) throw new Error("old_text was not found in the file.");
    if (!replaceAll && occurrences !== 1) {
        throw new Error(`old_text matched ${occurrences} times; provide a unique block or set replace_all=true.`);
    }
    const updated = replaceAll ? content.split(oldText).join(newText) : content.replace(oldText, newText);
    recordBackup(workspaceRoot, relativePath, content);
    fs.writeFileSync(target, updated);
    return { replacements: replaceAll ? occurrences : 1, bytesWritten: Buffer.byteLength(updated) };
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

function globToRegExp(pattern: string): RegExp {
    const normalized = pattern.replace(/\\/g, "/");
    let source = "^";
    for (let i = 0; i < normalized.length; i++) {
        const char = normalized[i];
        if (char === "*" && normalized[i + 1] === "*") {
            i++;
            if (normalized[i + 1] === "/") {
                i++;
                source += "(?:.*/)?";
            } else {
                source += ".*";
            }
        } else if (char === "*") source += "[^/]*";
        else if (char === "?") source += "[^/]";
        else source += char.replace(/[\\^$.[\]|()+{}]/g, "\\$&");
    }
    return new RegExp(`${source}$`, "i");
}

export function findFiles(workspaceRoot: string, pattern: string, relativePath = "."): string[] {
    if (!pattern.trim()) throw new Error("pattern must not be empty.");
    const startDir = resolveSafePath(workspaceRoot, relativePath);
    const matcher = globToRegExp(pattern);
    const results: string[] = [];
    function walk(dir: string): void {
        if (results.length >= MAX_LIST_ENTRIES) return;
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            if (entry.name.startsWith(".") || IGNORED_DIRS.has(entry.name)) continue;
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) walk(full);
            else if (entry.isFile()) {
                const relative = path.relative(startDir, full).split(path.sep).join("/");
                if (matcher.test(relative)) results.push(path.relative(workspaceRoot, full).split(path.sep).join("/"));
            }
        }
    }
    walk(startDir);
    return results.sort();
}

export function fileInfo(workspaceRoot: string, relativePath: string): {
    path: string; type: "file" | "directory" | "other"; sizeBytes: number; modifiedAt: string;
} {
    const target = resolveSafePath(workspaceRoot, relativePath);
    const stat = fs.statSync(target);
    return {
        path: relativePath,
        type: stat.isFile() ? "file" : stat.isDirectory() ? "directory" : "other",
        sizeBytes: stat.size,
        modifiedAt: stat.mtime.toISOString(),
    };
}

export function makeDirectory(workspaceRoot: string, relativePath: string): { created: boolean } {
    const target = resolveSafePath(workspaceRoot, relativePath);
    const existed = fs.existsSync(target);
    fs.mkdirSync(target, { recursive: true });
    return { created: !existed };
}

export function movePath(workspaceRoot: string, sourcePath: string, destinationPath: string): { moved: boolean } {
    const root = path.resolve(workspaceRoot);
    const source = resolveSafePath(workspaceRoot, sourcePath);
    const destination = resolveSafePath(workspaceRoot, destinationPath);
    if (source === root || destination === root) throw new Error("The workspace root cannot be moved or replaced.");
    if (!fs.existsSync(source)) throw new Error(`Source path "${sourcePath}" does not exist.`);
    if (fs.existsSync(destination)) throw new Error(`Destination path "${destinationPath}" already exists.`);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.renameSync(source, destination);
    return { moved: true };
}

export function deletePath(workspaceRoot: string, relativePath: string, recursive = false): { deleted: boolean } {
    const root = path.resolve(workspaceRoot);
    const target = resolveSafePath(workspaceRoot, relativePath);
    if (target === root) throw new Error("The workspace root cannot be deleted.");
    if (!fs.existsSync(target)) return { deleted: false };
    const stat = fs.statSync(target);
    if (stat.isDirectory()) fs.rmSync(target, { recursive, force: false });
    else fs.unlinkSync(target);
    return { deleted: true };
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

// Escapes a symbol name for safe use inside a RegExp — a symbol containing
// regex metacharacters (e.g. from a typo'd argument) shouldn't throw or,
// worse, behave like an unintended pattern.
function escapeRegExp(text: string): string {
    return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Word-boundary matching over the same directory walk as searchFiles, but
// scoped to whole identifiers — "count" won't also match "recount" or
// "counter", which a plain substring search (searchFiles) would.
export function findSymbolReferences(workspaceRoot: string, symbol: string, relativePath = "."): SearchMatch[] {
    const startDir = resolveSafePath(workspaceRoot, relativePath);
    const pattern = new RegExp(`\\b${escapeRegExp(symbol)}\\b`);
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
                if (pattern.test(lines[i])) {
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

export async function runCommand(
    workspaceRoot: string,
    command: string,
    relativeCwd = ".",
    network = false
): Promise<string> {
    const dangerReason = findDangerousCommandReason(command);
    if (dangerReason) throw new Error(dangerReason);

    const cwd = resolveSafePath(workspaceRoot, relativeCwd);
    const wrappedCommand = applySandbox(command, { workspaceRoot, allowNetwork: network });
    const settings = settingsStore.getSettings();
    let stopMonitor = () => {};
    try {
        const execPromise = execAsync(wrappedCommand, {
            cwd,
            timeout: COMMAND_TIMEOUT_MS,
            maxBuffer: 10 * 1024 * 1024,
        });
        // execPromise.child is a documented feature of promisify(exec) — the
        // returned promise carries the underlying ChildProcess, which is the
        // only way to get its pid for resource-monitor.ts to watch.
        if (execPromise.child.pid) {
            stopMonitor = monitorProcess(
                execPromise.child.pid,
                { maxMemoryMB: settings.sandboxMaxMemoryMB, maxCpuPercent: settings.sandboxMaxCpuPercent },
                () => execPromise.child.kill()
            );
        }
        const { stdout, stderr } = await execPromise;
        return formatCommandResult(stdout, stderr, 0);
    } catch (err) {
        const e = err as { stdout?: string; stderr?: string; code?: number; killed?: boolean; message: string };
        if (e.killed) {
            return `Command timed out after ${COMMAND_TIMEOUT_MS / 1000}s.\n\n${formatCommandResult(e.stdout ?? "", e.stderr ?? "", e.code ?? null)}`;
        }
        return formatCommandResult(e.stdout ?? "", e.stderr ?? e.message, e.code ?? null);
    } finally {
        stopMonitor();
    }
}

// run_code is a thin convenience wrapper over run_command for multi-line
// snippets (avoids shell-quoting hell for real code) — it carries the exact
// same risk and is checked against the exact same blocklist as run_command,
// applied to the source text too since dangerous *content* (not just the
// invocation) could otherwise slip past a check that only looks at the
// command line.
export async function runCode(
    workspaceRoot: string,
    language: "python" | "javascript",
    code: string,
    relativeCwd = ".",
    network = false
): Promise<string> {
    const dangerReason = findDangerousCommandReason(code);
    if (dangerReason) throw new Error(dangerReason);

    const ext = language === "python" ? "py" : "js";
    const tmpFile = path.join(os.tmpdir(), `modelforge-code-${randomUUID()}.${ext}`);
    fs.writeFileSync(tmpFile, code);
    try {
        const interpreter = language === "python" ? "python3" : "node";
        return await runCommand(workspaceRoot, `${interpreter} "${tmpFile}"`, relativeCwd, network);
    } finally {
        fs.rmSync(tmpFile, { force: true });
    }
}

interface BackgroundTask {
    id: string;
    name: string;
    command: string;
    process: ChildProcess;
    // Absolute path — lets killBackgroundCommandsForWorkspace() target only
    // the tasks that belong to a workspace being switched away from, rather
    // than every background task the process has ever started.
    workspaceRoot: string;
    // Rolling tail of combined stdout+stderr — capped so a chatty dev server
    // can't grow memory unboundedly over a long session.
    output: string;
    exitCode: number | null;
    startedAt: number;
}

const MAX_BACKGROUND_TASKS = 5;
const MAX_BACKGROUND_OUTPUT_CHARS = 100_000;
const BACKGROUND_OUTPUT_TAIL_CHARS = 20_000;
const backgroundTasks = new Map<string, BackgroundTask>();

export function startBackgroundCommand(
    workspaceRoot: string,
    command: string,
    relativeCwd = ".",
    name?: string,
    network = false
): { taskId: string; name: string } {
    const dangerReason = findDangerousCommandReason(command);
    if (dangerReason) throw new Error(dangerReason);
    const runningCount = [...backgroundTasks.values()].filter((t) => t.exitCode === null).length;
    if (runningCount >= MAX_BACKGROUND_TASKS) {
        throw new Error(`Already running ${MAX_BACKGROUND_TASKS} background commands — stop one first.`);
    }

    const cwd = resolveSafePath(workspaceRoot, relativeCwd);
    const wrappedCommand = applySandbox(command, { workspaceRoot, allowNetwork: network });
    // detached so the shell becomes its own process group leader — lets
    // killProcessTree() below signal the whole group (shell + whatever it
    // spawned, e.g. `npm run dev` spawning `node`) instead of just the shell
    // itself, which is all a plain .kill() would reach. No effect on Windows,
    // where killProcessTree uses `taskkill /t` instead.
    const child = spawn(wrappedCommand, {
        cwd,
        shell: true,
        stdio: ["ignore", "pipe", "pipe"],
        detached: process.platform !== "win32",
    });
    const id = randomUUID().slice(0, 8);
    const task: BackgroundTask = {
        id,
        name: name?.trim() || command.slice(0, 40),
        command,
        process: child,
        workspaceRoot: path.resolve(workspaceRoot),
        output: "",
        exitCode: null,
        startedAt: Date.now(),
    };
    const append = (chunk: Buffer) => {
        task.output += chunk.toString();
        if (task.output.length > MAX_BACKGROUND_OUTPUT_CHARS) {
            task.output = task.output.slice(-MAX_BACKGROUND_OUTPUT_CHARS);
        }
    };
    child.stdout?.on("data", append);
    child.stderr?.on("data", append);
    child.on("error", (err) => {
        task.output += `\n[failed to start: ${err.message}]`;
        task.exitCode = -1;
    });
    const settings = settingsStore.getSettings();
    const stopMonitor = child.pid
        ? monitorProcess(
              child.pid,
              { maxMemoryMB: settings.sandboxMaxMemoryMB, maxCpuPercent: settings.sandboxMaxCpuPercent },
              (reason) => append(Buffer.from(`\n[background task stopped: ${reason}]`))
          )
        : () => {};
    child.on("exit", (code) => {
        stopMonitor();
        task.exitCode = code ?? -1;
    });
    backgroundTasks.set(id, task);
    return { taskId: id, name: task.name };
}

export function getBackgroundOutput(taskId: string): string {
    const task = backgroundTasks.get(taskId);
    if (!task) throw new Error(`No background task with id "${taskId}".`);
    const status =
        task.exitCode === null
            ? `running (${Math.round((Date.now() - task.startedAt) / 1000)}s)`
            : `exited with code ${task.exitCode}`;
    const tail =
        task.output.length > BACKGROUND_OUTPUT_TAIL_CHARS
            ? `[...earlier output trimmed]\n${task.output.slice(-BACKGROUND_OUTPUT_TAIL_CHARS)}`
            : task.output;
    return `Task ${task.id} (${task.name}): ${status}\n--- output ---\n${tail || "(no output yet)"}`;
}

export function stopBackgroundCommand(taskId: string): string {
    const task = backgroundTasks.get(taskId);
    if (!task) throw new Error(`No background task with id "${taskId}".`);
    if (task.exitCode !== null) return `Task ${task.id} had already exited with code ${task.exitCode}.`;
    if (task.process.pid) killProcessTree(task.process.pid);
    return `Task ${task.id} (${task.name}) stopped.`;
}

export function listBackgroundCommands(): { id: string; name: string; command: string; status: string }[] {
    return [...backgroundTasks.values()].map((t) => ({
        id: t.id,
        name: t.name,
        command: t.command,
        status: t.exitCode === null ? "running" : `exited (${t.exitCode})`,
    }));
}

export function killAllBackgroundCommands(): void {
    for (const task of backgroundTasks.values()) {
        if (task.exitCode === null && task.process.pid) killProcessTree(task.process.pid);
    }
    backgroundTasks.clear();
}

// Only tears down tasks belonging to the workspace being switched away from
// — background commands are otherwise never cleaned up until app quit
// (killAllBackgroundCommands, called from window-all-closed/before-quit),
// so switching to a different workspace mid-session used to leave the old
// one's tasks running indefinitely, silently eating into MAX_BACKGROUND_TASKS.
export function killBackgroundCommandsForWorkspace(workspaceRoot: string): number {
    const root = path.resolve(workspaceRoot);
    let killed = 0;
    for (const [id, task] of backgroundTasks) {
        if (task.workspaceRoot !== root) continue;
        if (task.exitCode === null && task.process.pid) killProcessTree(task.process.pid);
        backgroundTasks.delete(id);
        killed++;
    }
    return killed;
}

function gitCommand(workspaceRoot: string, args: string): Promise<string> {
    return runCommand(workspaceRoot, `git ${args}`, ".");
}

export function gitStatus(workspaceRoot: string): Promise<string> {
    return gitCommand(workspaceRoot, "status");
}

export function gitDiff(workspaceRoot: string, staged = false, relativePath?: string): Promise<string> {
    const target = relativePath ? ` -- "${relativePath}"` : "";
    return gitCommand(workspaceRoot, `diff${staged ? " --staged" : ""}${target}`);
}

export function gitLog(workspaceRoot: string, count = 10): Promise<string> {
    return gitCommand(workspaceRoot, `log -n ${Math.max(1, Math.min(count, 100))} --oneline`);
}

export async function gitCommit(workspaceRoot: string, message: string): Promise<string> {
    await gitCommand(workspaceRoot, "add -A");
    return gitCommand(workspaceRoot, `commit -m ${JSON.stringify(message)}`);
}

const WEB_FETCH_TIMEOUT_MS = 15_000;
const MAX_FETCH_CHARS = 30_000;
const MAX_SEARCH_RESULTS_WEB = 5;

// Crude HTML-to-text: drop non-content tags outright, then strip remaining
// markup and collapse whitespace. Not a real HTML parser — good enough for
// giving a model readable page text without pulling in a DOM library in the
// main process.
function htmlToText(html: string): string {
    return html
        .replace(/<script[\s\S]*?<\/script>/gi, " ")
        .replace(/<style[\s\S]*?<\/style>/gi, " ")
        .replace(/<!--[\s\S]*?-->/g, " ")
        .replace(/<[^>]+>/g, " ")
        .replace(/&nbsp;/g, " ")
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/[ \t]+/g, " ")
        .replace(/\n\s*\n+/g, "\n\n")
        .trim();
}

export async function fetchUrl(url: string): Promise<string> {
    let parsed: URL;
    try {
        parsed = new URL(url);
    } catch {
        throw new Error(`"${url}" is not a valid URL.`);
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        throw new Error("Only http:// and https:// URLs can be fetched.");
    }

    const res = await fetch(parsed, {
        signal: AbortSignal.timeout(WEB_FETCH_TIMEOUT_MS),
        headers: { "User-Agent": "Mozilla/5.0 (compatible; Modelforge/1.0)" },
    });
    if (!res.ok) throw new Error(`Failed to fetch ${url}: HTTP ${res.status}`);
    const contentType = res.headers.get("content-type") ?? "";
    const raw = await res.text();
    const text = contentType.includes("html") ? htmlToText(raw) : raw;
    return text.length > MAX_FETCH_CHARS
        ? `${text.slice(0, MAX_FETCH_CHARS)}\n\n[truncated — page is ${text.length} characters]`
        : text;
}

const MAX_HTTP_BODY_CHARS = 20_000;

export async function httpRequest(
    url: string,
    method = "GET",
    headers?: Record<string, string>,
    body?: string
): Promise<string> {
    let parsed: URL;
    try {
        parsed = new URL(url);
    } catch {
        throw new Error(`"${url}" is not a valid URL.`);
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        throw new Error("Only http:// and https:// URLs can be requested.");
    }

    const res = await fetch(parsed, {
        method,
        headers,
        body: method !== "GET" && method !== "DELETE" ? body : undefined,
        signal: AbortSignal.timeout(WEB_FETCH_TIMEOUT_MS),
    });
    const text = await res.text();
    const truncated =
        text.length > MAX_HTTP_BODY_CHARS
            ? `${text.slice(0, MAX_HTTP_BODY_CHARS)}\n[truncated — body is ${text.length} characters]`
            : text;
    return `HTTP ${res.status} ${res.statusText}\n--- body ---\n${truncated || "(empty body)"}`;
}

// --- apply_patch: a minimal unified-diff parser/applier -------------------
// Supports the subset git diff / `diff -u` actually produce: multiple
// --- /+++ file header pairs, one or more @@ hunks each, context/add/remove
// lines, and /dev/null on either side for creates/deletes. No fuzzy
// matching — a hunk whose context doesn't match the file's current content
// throws rather than guessing, since silently misapplying a patch is worse
// than failing loudly.

interface PatchHunkLine {
    type: "context" | "add" | "remove";
    text: string;
}

interface PatchHunk {
    oldStart: number;
    lines: PatchHunkLine[];
}

interface FilePatch {
    oldPath: string | null;
    newPath: string | null;
    hunks: PatchHunk[];
}

function stripDiffPathPrefix(p: string): string {
    return p.replace(/^[ab]\//, "");
}

function parseUnifiedDiff(patchText: string): FilePatch[] {
    // A trailing "\n" (the normal case for patch text) produces one extra
    // empty element from split() that's just a string-terminator artifact,
    // not an actual blank line in the diff — without dropping it, it gets
    // parsed as a spurious empty context line at the end of the last hunk.
    const lines = patchText.replace(/\n$/, "").split("\n");
    const files: FilePatch[] = [];
    let i = 0;
    while (i < lines.length) {
        if (!lines[i].startsWith("--- ")) {
            i++;
            continue;
        }
        const oldHeader = lines[i].slice(4).trim();
        i++;
        if (i >= lines.length || !lines[i].startsWith("+++ ")) {
            throw new Error(`Malformed patch: expected a "+++ " line after "--- ${oldHeader}".`);
        }
        const newHeader = lines[i].slice(4).trim();
        i++;
        const oldPath = oldHeader === "/dev/null" ? null : stripDiffPathPrefix(oldHeader.split("\t")[0]);
        const newPath = newHeader === "/dev/null" ? null : stripDiffPathPrefix(newHeader.split("\t")[0]);

        const hunks: PatchHunk[] = [];
        while (i < lines.length && lines[i].startsWith("@@")) {
            const match = lines[i].match(/^@@ -(\d+)(?:,\d+)? \+\d+(?:,\d+)? @@/);
            if (!match) throw new Error(`Malformed hunk header: "${lines[i]}"`);
            const oldStart = Number(match[1]);
            i++;
            const hunkLines: PatchHunkLine[] = [];
            while (i < lines.length && !lines[i].startsWith("@@") && !lines[i].startsWith("--- ")) {
                const line = lines[i];
                if (line.startsWith("+")) hunkLines.push({ type: "add", text: line.slice(1) });
                else if (line.startsWith("-")) hunkLines.push({ type: "remove", text: line.slice(1) });
                else if (line.startsWith(" ")) hunkLines.push({ type: "context", text: line.slice(1) });
                else if (line.startsWith("\\")) {
                    // "\ No newline at end of file" — not a content line.
                } else if (line === "") {
                    hunkLines.push({ type: "context", text: "" });
                } else {
                    break;
                }
                i++;
            }
            hunks.push({ oldStart, lines: hunkLines });
        }
        files.push({ oldPath, newPath, hunks });
    }
    return files;
}

function applyHunksToContent(content: string, hunks: PatchHunk[], filePath: string): string {
    const originalLines = content.length > 0 ? content.split("\n") : [];
    const result: string[] = [];
    let cursor = 0;

    for (const hunk of hunks) {
        // "@@ -0,0 ..." is the convention for a hunk against an empty/new
        // file — oldStart is 0 there, not a real 1-based line number.
        const startIdx = Math.max(0, hunk.oldStart - 1);
        if (startIdx < cursor || startIdx > originalLines.length) {
            throw new Error(`Hunk in "${filePath}" doesn't align with the file's current content (expected to start at line ${hunk.oldStart}).`);
        }
        result.push(...originalLines.slice(cursor, startIdx));
        let oldCursor = startIdx;
        for (const line of hunk.lines) {
            if (line.type === "add") {
                result.push(line.text);
                continue;
            }
            const actual = originalLines[oldCursor];
            if (actual !== line.text) {
                throw new Error(
                    `Context mismatch in "${filePath}" at line ${oldCursor + 1}: expected ${JSON.stringify(line.text)}, found ${JSON.stringify(actual ?? "<end of file>")}.`
                );
            }
            if (line.type === "context") result.push(line.text);
            oldCursor++;
        }
        cursor = oldCursor;
    }
    result.push(...originalLines.slice(cursor));
    return result.join("\n");
}

export function applyPatch(workspaceRoot: string, patchText: string): { filesChanged: string[] } {
    const files = parseUnifiedDiff(patchText);
    if (files.length === 0) throw new Error("No valid file patches found in the given diff.");

    const filesChanged: string[] = [];
    for (const file of files) {
        if (file.newPath === null) {
            if (!file.oldPath) throw new Error("Patch deletes a file but its path (/dev/null on both sides) is missing.");
            deletePath(workspaceRoot, file.oldPath, false);
            filesChanged.push(file.oldPath);
            continue;
        }
        const isNewFile = file.oldPath === null;
        const existingContent = isNewFile ? "" : readFile(workspaceRoot, file.newPath);
        const newContent = applyHunksToContent(existingContent, file.hunks, file.newPath);
        writeFile(workspaceRoot, file.newPath, newContent);
        filesChanged.push(file.newPath);
    }
    return { filesChanged };
}

export interface WebSearchResult {
    title: string;
    url: string;
    snippet: string;
}

// Uses DuckDuckGo's keyless HTML endpoint (no API key/signup needed, unlike
// most search APIs) and regex-scrapes the result markup — brittle if DDG
// changes its HTML, but keeps this tool usable out of the box with zero
// configuration, consistent with the rest of Agent mode's tools.
export async function webSearch(query: string): Promise<WebSearchResult[]> {
    const res = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, {
        signal: AbortSignal.timeout(WEB_FETCH_TIMEOUT_MS),
        headers: { "User-Agent": "Mozilla/5.0 (compatible; Modelforge/1.0)" },
    });
    if (!res.ok) throw new Error(`Web search failed: HTTP ${res.status}`);
    const html = await res.text();

    const results: WebSearchResult[] = [];
    const linkPattern = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
    const snippetPattern = /<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi;
    const links = [...html.matchAll(linkPattern)];
    const snippets = [...html.matchAll(snippetPattern)];

    for (let i = 0; i < links.length && results.length < MAX_SEARCH_RESULTS_WEB; i++) {
        const href = links[i][1];
        // DuckDuckGo's HTML endpoint wraps result URLs in a redirect
        // (/l/?uddg=<encoded target>) rather than linking straight to them.
        const uddgMatch = href.match(/[?&]uddg=([^&]+)/);
        const url = uddgMatch ? decodeURIComponent(uddgMatch[1]) : href;
        results.push({
            title: htmlToText(links[i][2]),
            url,
            snippet: htmlToText(snippets[i]?.[1] ?? ""),
        });
    }
    return results;
}

function notesPath(): string {
    return ".agent-notes.md";
}

export function readNotes(workspaceRoot: string): string {
    try {
        return readFile(workspaceRoot, notesPath());
    } catch {
        return "";
    }
}

export function writeNotes(workspaceRoot: string, content: string): { bytesWritten: number } {
    return writeFile(workspaceRoot, notesPath(), content);
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

function requireGitHubToken(): string {
    const token = getAccountToken("github");
    if (!token) throw new Error("Link a GitHub account in Settings → Integrations before using GitHub repository tools.");
    return token;
}

function normalizeGitHubRepository(repository: string): string {
    const value = repository.trim();
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value)) {
        throw new Error('repository must use the "owner/name" format.');
    }
    return value;
}

async function githubApi<T>(endpoint: string): Promise<T> {
    const response = await fetch(`https://api.github.com${endpoint}`, {
        headers: {
            Authorization: `Bearer ${requireGitHubToken()}`,
            Accept: "application/vnd.github+json",
            "X-GitHub-Api-Version": "2026-03-10",
            "User-Agent": "Modelforge",
        },
    });
    if (response.status === 401) throw new Error("The linked GitHub token is invalid or expired. Reconnect it in Settings.");
    if (response.status === 404) throw new Error("The repository, ref, or file was not found, or the linked account cannot access it.");
    if (!response.ok) throw new Error(`GitHub API error (HTTP ${response.status}).`);
    return await response.json() as T;
}

export async function githubListRepositories(visibility = "all", limit = 30): Promise<unknown[]> {
    const safeVisibility = ["all", "public", "private"].includes(visibility) ? visibility : "all";
    const safeLimit = Math.max(1, Math.min(Math.floor(limit), 100));
    const repos = await githubApi<Array<Record<string, unknown>>>(
        `/user/repos?visibility=${safeVisibility}&affiliation=owner,collaborator,organization_member&sort=updated&per_page=${safeLimit}`
    );
    return repos.map((repo) => ({
        fullName: repo.full_name,
        private: repo.private,
        description: repo.description,
        defaultBranch: repo.default_branch,
        language: repo.language,
        updatedAt: repo.updated_at,
        url: repo.html_url,
    }));
}

export async function githubRepositoryTree(repository: string, ref?: string): Promise<{ ref: string; truncated: boolean; files: unknown[] }> {
    const repo = normalizeGitHubRepository(repository);
    let resolvedRef = ref?.trim();
    if (!resolvedRef) {
        const metadata = await githubApi<{ default_branch: string }>(`/repos/${repo}`);
        resolvedRef = metadata.default_branch;
    }
    const tree = await githubApi<{ truncated: boolean; tree: Array<{ path: string; type: string; size?: number; sha: string }> }>(
        `/repos/${repo}/git/trees/${encodeURIComponent(resolvedRef)}?recursive=1`
    );
    return {
        ref: resolvedRef,
        truncated: tree.truncated,
        files: tree.tree.filter((item) => item.type === "blob").slice(0, 2_000).map((item) => ({ path: item.path, sizeBytes: item.size ?? null, sha: item.sha })),
    };
}

export async function githubReadFile(repository: string, filePath: string, ref?: string): Promise<string> {
    const repo = normalizeGitHubRepository(repository);
    const cleanPath = filePath.replace(/^\/+/, "");
    if (!cleanPath || cleanPath.split("/").some((segment) => segment === ".." || segment === "." || !segment)) {
        throw new Error("Invalid repository file path.");
    }
    const encodedPath = cleanPath.split("/").map(encodeURIComponent).join("/");
    const query = ref?.trim() ? `?ref=${encodeURIComponent(ref.trim())}` : "";
    const file = await githubApi<{ type: string; size: number; encoding?: string; content?: string }>(`/repos/${repo}/contents/${encodedPath}${query}`);
    if (file.type !== "file" || file.encoding !== "base64" || !file.content) throw new Error("The requested GitHub path is not a readable file.");
    if (file.size > MAX_READ_CHARS * 4) throw new Error(`The GitHub file is too large to analyze directly (${file.size} bytes).`);
    const content = Buffer.from(file.content.replace(/\s/g, ""), "base64").toString("utf-8");
    return content.length > MAX_READ_CHARS ? `${content.slice(0, MAX_READ_CHARS)}\n\n[truncated]` : content;
}

// Tools that reach the network — gated by settings.networkToolsEnabled as a
// baseline that's 100% enforceable on every platform (refusing to run the
// tool at all, rather than trying to block network access after the fact,
// which is what command-sandbox.ts's per-call `network` argument does for
// run_command/run_code/start_background_command instead).
const NETWORK_TOOLS = new Set([
    "web_search",
    "fetch_url",
    "http_request",
    "capture_page_screenshot",
    "github_list_repositories",
    "github_repository_tree",
    "github_read_file",
]);

export async function executeTool(workspaceRoot: string, name: string, args: Record<string, unknown>): Promise<unknown> {
    if (NETWORK_TOOLS.has(name) && settingsStore.getSettings().networkToolsEnabled === false) {
        throw new Error(`Network access for agent tools is turned off in Settings — "${name}" can't run.`);
    }
    switch (name) {
        case "read_file":
            return readFile(
                workspaceRoot,
                String(args.path ?? ""),
                typeof args.start_line === "number" ? args.start_line : undefined,
                typeof args.end_line === "number" ? args.end_line : undefined
            );
        case "write_file":
            return writeFile(workspaceRoot, String(args.path ?? ""), String(args.content ?? ""));
        case "replace_in_file":
            return replaceInFile(
                workspaceRoot,
                String(args.path ?? ""),
                String(args.old_text ?? ""),
                String(args.new_text ?? ""),
                args.replace_all === true
            );
        case "find_files":
            return findFiles(workspaceRoot, String(args.pattern ?? ""), args.path ? String(args.path) : ".");
        case "file_info":
            return fileInfo(workspaceRoot, String(args.path ?? ""));
        case "make_directory":
            return makeDirectory(workspaceRoot, String(args.path ?? ""));
        case "move_path":
            return movePath(workspaceRoot, String(args.source ?? ""), String(args.destination ?? ""));
        case "delete_path":
            return deletePath(workspaceRoot, String(args.path ?? ""), args.recursive === true);
        case "list_dir":
            return listDir(workspaceRoot, String(args.path ?? "."));
        case "search_files":
            return searchFiles(workspaceRoot, String(args.query ?? ""), args.path ? String(args.path) : ".");
        case "run_command":
            return runCommand(workspaceRoot, String(args.command ?? ""), args.cwd ? String(args.cwd) : ".", args.network === true);
        case "run_code": {
            const language = args.language === "python" ? "python" : "javascript";
            return runCode(workspaceRoot, language, String(args.code ?? ""), args.cwd ? String(args.cwd) : ".", args.network === true);
        }
        case "start_background_command":
            return startBackgroundCommand(
                workspaceRoot,
                String(args.command ?? ""),
                args.cwd ? String(args.cwd) : ".",
                args.name ? String(args.name) : undefined,
                args.network === true
            );
        case "get_background_output":
            return getBackgroundOutput(String(args.task_id ?? ""));
        case "stop_background_command":
            return stopBackgroundCommand(String(args.task_id ?? ""));
        case "list_background_commands":
            return listBackgroundCommands();
        case "git_status":
            return gitStatus(workspaceRoot);
        case "git_diff":
            return gitDiff(workspaceRoot, args.staged === true, args.path ? String(args.path) : undefined);
        case "git_log":
            return gitLog(workspaceRoot, typeof args.count === "number" ? args.count : 10);
        case "git_commit":
            return gitCommit(workspaceRoot, String(args.message ?? ""));
        case "web_search":
            return webSearch(String(args.query ?? ""));
        case "github_list_repositories":
            return githubListRepositories(String(args.visibility ?? "all"), typeof args.limit === "number" ? args.limit : 30);
        case "github_repository_tree":
            return githubRepositoryTree(String(args.repository ?? ""), args.ref ? String(args.ref) : undefined);
        case "github_read_file":
            return githubReadFile(String(args.repository ?? ""), String(args.path ?? ""), args.ref ? String(args.ref) : undefined);
        case "fetch_url":
            return fetchUrl(String(args.url ?? ""));
        case "http_request":
            return httpRequest(
                String(args.url ?? ""),
                args.method ? String(args.method) : "GET",
                args.headers && typeof args.headers === "object" ? (args.headers as Record<string, string>) : undefined,
                args.body ? String(args.body) : undefined
            );
        case "capture_page_screenshot":
            return capturePageScreenshot(
                workspaceRoot,
                String(args.url ?? ""),
                typeof args.width === "number" ? args.width : undefined,
                typeof args.height === "number" ? args.height : undefined
            );
        case "find_symbol_references":
            return findSymbolReferences(workspaceRoot, String(args.symbol ?? ""), args.path ? String(args.path) : ".");
        case "apply_patch":
            return applyPatch(workspaceRoot, String(args.patch ?? ""));
        case "read_notes":
            return readNotes(workspaceRoot);
        case "write_notes":
            return writeNotes(workspaceRoot, String(args.content ?? ""));
        default:
            throw new Error(`Unknown tool: ${name}`);
    }
}
