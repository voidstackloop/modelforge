import { getAccountToken } from "./accounts";
import { capturePageScreenshot } from "./browser-capture";
import * as settingsStore from "./settings-store";
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
import {
    findDangerousCommandReason,
    runCommand,
    runCode,
    startBackgroundCommand,
    getBackgroundOutput,
    stopBackgroundCommand,
    listBackgroundCommands,
    killAllBackgroundCommands,
    killBackgroundCommandsForWorkspace,
} from "./agent-tools/execution";
import { gitStatus, gitDiff, gitLog, gitCommit } from "./agent-tools/git";
import { NETWORK_TOOLS, fetchUrl, httpRequest, webSearch } from "./agent-tools/network";
import type { WebSearchResult } from "./agent-tools/network";

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
export {
    findDangerousCommandReason,
    runCommand,
    runCode,
    startBackgroundCommand,
    getBackgroundOutput,
    stopBackgroundCommand,
    listBackgroundCommands,
    killAllBackgroundCommands,
    killBackgroundCommandsForWorkspace,
};
export { gitStatus, gitDiff, gitLog, gitCommit };
export { fetchUrl, httpRequest, webSearch };
export type { WebSearchResult };

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
