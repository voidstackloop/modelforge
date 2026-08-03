import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { app } from "electron";
import { readJsonWithSchema, writeJson } from "./json-store";
import { evidenceSourcesFileSchema } from "./schemas";
import type { z } from "zod";

export type EvidenceSourceType = "peer-reviewed" | "guideline" | "reference-database" | "local-document" | "other";

export interface EvidenceSource {
    id: string;
    url: string;
    title: string;
    organization?: string;
    publishedOrUpdated?: string;
    retrievedAt: string;
    sourceType: EvidenceSourceType;
    excerpt?: string;
    addedAt: string;
}

const FETCH_TIMEOUT_MS = 15_000;
const MAX_EXCERPT_CHARS = 500;

// Domains with an established editorial/regulatory process, used only to
// pick a reasonable default `sourceType` — it does not gate what a user can
// add. This is not a claim that every page on these domains is
// peer-reviewed; guideline/reference-database bodies are mixed in
// deliberately since that's what these domains mostly publish.
const KNOWN_ORGANIZATIONS: { hostSuffix: string; organization: string; sourceType: EvidenceSourceType }[] = [
    { hostSuffix: "pubmed.ncbi.nlm.nih.gov", organization: "PubMed / NLM", sourceType: "peer-reviewed" },
    { hostSuffix: "ncbi.nlm.nih.gov", organization: "NCBI", sourceType: "reference-database" },
    { hostSuffix: "nih.gov", organization: "NIH", sourceType: "reference-database" },
    { hostSuffix: "who.int", organization: "World Health Organization", sourceType: "guideline" },
    { hostSuffix: "cdc.gov", organization: "CDC", sourceType: "guideline" },
    { hostSuffix: "fda.gov", organization: "FDA", sourceType: "guideline" },
    { hostSuffix: "cochranelibrary.com", organization: "Cochrane Library", sourceType: "peer-reviewed" },
    { hostSuffix: "uptodate.com", organization: "UpToDate", sourceType: "reference-database" },
];

function filePath(): string {
    return path.join(app.getPath("userData"), "evidence-sources.json");
}

function readAll(): EvidenceSource[] {
    return readJsonWithSchema<EvidenceSource[]>(
        filePath(),
        [],
        evidenceSourcesFileSchema as unknown as z.ZodType<EvidenceSource[]>
    );
}

function writeAll(sources: EvidenceSource[]): void {
    writeJson(filePath(), sources);
}

export function listSources(): EvidenceSource[] {
    return readAll().sort((a, b) => b.addedAt.localeCompare(a.addedAt));
}

export function getSource(id: string): EvidenceSource | null {
    return readAll().find((s) => s.id === id) ?? null;
}

export function deleteSource(id: string): void {
    writeAll(readAll().filter((s) => s.id !== id));
}

function guessOrganization(hostname: string): { organization?: string; sourceType: EvidenceSourceType } {
    const match = KNOWN_ORGANIZATIONS.find((o) => hostname === o.hostSuffix || hostname.endsWith(`.${o.hostSuffix}`));
    return match ? { organization: match.organization, sourceType: match.sourceType } : { sourceType: "other" };
}

function extractTitle(html: string): string | null {
    const match = html.match(/<title[^>]*>([^<]*)<\/title>/i);
    return match ? match[1].trim().slice(0, 300) : null;
}

function extractMetaDescription(html: string): string | null {
    const match = html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["']/i);
    return match ? match[1].trim().slice(0, MAX_EXCERPT_CHARS) : null;
}

/**
 * Fetches a URL and records it as an evidence source with whatever metadata
 * can be honestly extracted (page `<title>`, meta description, a
 * best-guess organization from the hostname). This never fabricates a
 * title, author, or date it couldn't find — missing fields are left
 * undefined rather than guessed, so the UI can show "unavailable" instead
 * of a plausible-looking but invented value.
 */
export async function addSourceFromUrl(url: string): Promise<EvidenceSource> {
    let parsed: URL;
    try {
        parsed = new URL(url);
    } catch {
        throw new Error(`"${url}" is not a valid URL.`);
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        throw new Error("Only http:// and https:// URLs can be added as evidence sources.");
    }

    const res = await fetch(parsed, {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        headers: { "User-Agent": "Mozilla/5.0 (compatible; ModelForgeMedical/1.0)" },
    });
    if (!res.ok) throw new Error(`Failed to fetch ${url}: HTTP ${res.status}`);
    const html = await res.text();

    const title = extractTitle(html) ?? parsed.pathname;
    const excerpt = extractMetaDescription(html) ?? undefined;
    const { organization, sourceType } = guessOrganization(parsed.hostname);

    const now = new Date().toISOString();
    const source: EvidenceSource = {
        id: randomUUID(),
        url: parsed.toString(),
        title,
        organization,
        retrievedAt: now,
        sourceType,
        excerpt,
        addedAt: now,
    };
    const all = readAll();
    all.push(source);
    writeAll(all);
    return source;
}
