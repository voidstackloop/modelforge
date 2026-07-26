import { getAccountToken } from "../accounts";
import { MAX_READ_CHARS } from "./filesystem";

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
