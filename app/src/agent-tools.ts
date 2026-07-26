import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { exec, spawn, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { getAccountToken } from "./accounts";
import { capturePageScreenshot } from "./browser-capture";
import { killProcessTree } from "./process-tree";
import { applySandbox, shellQuote } from "./command-sandbox";
import { monitorProcess } from "./resource-monitor";
import * as settingsStore from "./settings-store";
import { resolveSafePath } from "./workspace-path";
import * as terminalManager from "./terminal-manager";
import { AGENT_TOOLS } from "./agent-tools/schema";
import {
    MAX_READ_CHARS,
    readFile,
    writeFile,
    replaceInFile,
    rollbackLastWrite,
    listDir,
    findFiles,
    fileInfo,
    makeDirectory,
    movePath,
    deletePath,
    searchFiles,
    findSymbolReferences,
    applyPatch,
    readNotes,
    writeNotes,
    detectProjectScripts,
} from "./agent-tools/filesystem";
import type { RollbackResult, SearchMatch, ProjectScripts } from "./agent-tools/filesystem";

export { AGENT_TOOLS };
export {
    readFile,
    writeFile,
    replaceInFile,
    rollbackLastWrite,
    listDir,
    findFiles,
    fileInfo,
    makeDirectory,
    movePath,
    deletePath,
    searchFiles,
    findSymbolReferences,
    applyPatch,
    readNotes,
    writeNotes,
    detectProjectScripts,
};
export type { RollbackResult, SearchMatch, ProjectScripts };

const execAsync = promisify(exec);

const MAX_COMMAND_OUTPUT_CHARS = 50_000;
const COMMAND_TIMEOUT_MS = 60_000;

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
    const wrappedCommand = applySandbox(command, { workspaceRoot, allowNetwork: network, cwd });
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
    const wrappedCommand = applySandbox(command, { workspaceRoot, allowNetwork: network, cwd });
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
    const target = relativePath ? ` -- ${shellQuote(relativePath)}` : "";
    return gitCommand(workspaceRoot, `diff${staged ? " --staged" : ""}${target}`);
}

export function gitLog(workspaceRoot: string, count = 10): Promise<string> {
    return gitCommand(workspaceRoot, `log -n ${Math.max(1, Math.min(count, 100))} --oneline`);
}

export async function gitCommit(workspaceRoot: string, message: string): Promise<string> {
    await gitCommand(workspaceRoot, "add -A");
    // JSON.stringify escapes `"` and `\` but not `$` or backticks, and the
    // result is handed to `sh -c` — so it is not a shell-quoting function.
    return gitCommand(workspaceRoot, `commit -m ${shellQuote(message)}`);
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
        case "create_terminal":
            // No-op streaming callbacks: the model drives this by polling
            // read_terminal_output rather than receiving push events — live
            // streaming is reserved for the human-facing terminal panel,
            // which goes through the dedicated terminal:create IPC channel
            // instead of this tool-call path.
            return terminalManager.createTerminal(
                workspaceRoot,
                { name: args.name ? String(args.name) : undefined, cwd: args.cwd ? String(args.cwd) : undefined },
                () => {},
                () => {}
            );
        case "write_to_terminal":
            terminalManager.writeToTerminal(String(args.terminal_id ?? ""), String(args.input ?? ""));
            return { ok: true };
        case "read_terminal_output":
            return terminalManager.readTerminalOutput(String(args.terminal_id ?? ""), typeof args.tail_chars === "number" ? args.tail_chars : undefined);
        case "close_terminal":
            terminalManager.closeTerminal(String(args.terminal_id ?? ""));
            return { ok: true };
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
