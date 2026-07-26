const WEB_FETCH_TIMEOUT_MS = 15_000;
const MAX_FETCH_CHARS = 30_000;
const MAX_SEARCH_RESULTS_WEB = 5;
const MAX_HTTP_BODY_CHARS = 20_000;

// Tools that reach the network — gated by settings.networkToolsEnabled as a
// baseline that's 100% enforceable on every platform (refusing to run the
// tool at all, rather than trying to block network access after the fact,
// which is what command-sandbox.ts's per-call `network` argument does for
// run_command/run_code/start_background_command instead).
export const NETWORK_TOOLS = new Set([
    "web_search",
    "fetch_url",
    "http_request",
    "capture_page_screenshot",
    "github_list_repositories",
    "github_repository_tree",
    "github_read_file",
]);

// Crude HTML-to-text: drop non-content tags outright, then strip remaining
// markup and collapse whitespace. Not a real HTML parser — good enough for
// giving a model readable page text without pulling in a DOM library in the
// main process.
export function htmlToText(html: string): string {
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
