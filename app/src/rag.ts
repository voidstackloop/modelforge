import * as path from "node:path";
import { createHash } from "node:crypto";
import { randomUUID } from "node:crypto";
import * as llamacpp from "./llamacpp-manager";
import * as media from "./media";
import { approximateTokens } from "./benchmark-runner";
import { findPdfFiles, type AttachedFile } from "./file-reader";
import * as ragDb from "./rag-db";
import type { ChunkRow } from "./rag-db";
import { mainResourceOrchestrator } from "./resource-orchestrator";
import { getLlamaCppModelsDir } from "./app-state";

export const DEFAULT_EMBEDDING_MODEL = "nomic-embed-text";
const EMBED_BATCH_SIZE = 8;
const TARGET_TOKENS = 400;
const OVERLAP_TOKENS = 60;
const HEADING_RE = /^#{1,6}\s+(.*)/;

// A ragEmbeddingModel/collection.embedding_model value is either a bare
// Ollama tag (unprefixed — every value ever stored before this backend
// existed, so this stays the implicit default with zero migration needed)
// or "llamacpp:<relative-path-under-the-llama.cpp-models-dir>", matching
// frontend/src/lib/providers.ts's formatModelRef("provider", "model") — the
// same single-colon convention already used for the chat model picker.
// Collision note: this only misparses if an Ollama tag were literally named
// "llamacpp" with a tag suffix, which doesn't exist in practice.
const LLAMACPP_EMBEDDING_PREFIX = "llamacpp:";

export function parseEmbeddingModelRef(ref: string): { backend: "ollama" | "llamacpp"; model: string } {
    if (ref.startsWith(LLAMACPP_EMBEDDING_PREFIX)) {
        return { backend: "llamacpp", model: ref.slice(LLAMACPP_EMBEDDING_PREFIX.length) };
    }
    return { backend: "ollama", model: ref };
}

// docs/LOCAL_INFERENCE_HARDENING_PLAN.md §2/§3: embedding calls to llama.cpp
// run in-process and genuinely contend for the same GPU/CPU budget as chat
// generation, unlike Ollama embeddings (a separate daemon process this app's
// own resource accounting has never needed to cover). Callers use this to
// pick real admission requirements instead of the `accelerator: "none"`
// that was only ever correct for the Ollama case.
function embeddingLeaseRequirements(ref: string, cpuThreads: number) {
    return parseEmbeddingModelRef(ref).backend === "llamacpp"
        ? { cpuThreads, accelerator: "preferred" as const, allowCpuFallback: true, exclusiveAccelerator: true }
        : { cpuThreads, accelerator: "none" as const };
}

export interface LineChunk {
    text: string;
    startLine: number;
    endLine: number;
    heading: string | null;
    tokenCount: number;
}

// Document-aware, token-budgeted chunking: packs consecutive lines into a
// chunk until ~TARGET_TOKENS is hit (never splitting mid-line), carries the
// nearest preceding markdown heading as context, and re-includes ~OVERLAP_TOKENS
// worth of trailing lines at the start of the next chunk so a fact split
// across a chunk boundary still appears whole in at least one chunk.
export function chunkDocument(content: string): LineChunk[] {
    const lines = content.split(/\r?\n/);
    const chunks: LineChunk[] = [];
    let currentHeading: string | null = null;
    let buffer: { idx: number; line: string; heading: string | null }[] = [];
    let bufferTokens = 0;

    const flush = () => {
        if (buffer.length === 0) return;
        const text = buffer.map((b) => b.line).join("\n");
        if (text.trim().length > 0) {
            chunks.push({
                text,
                startLine: buffer[0].idx + 1,
                endLine: buffer[buffer.length - 1].idx + 1,
                heading: buffer[0].heading,
                tokenCount: approximateTokens(text),
            });
        }
    };

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const headingMatch = line.match(HEADING_RE);
        if (headingMatch) currentHeading = headingMatch[1].trim();

        const lineTokens = approximateTokens(line);
        if (buffer.length > 0 && bufferTokens + lineTokens > TARGET_TOKENS) {
            flush();
            let overlapTokens = 0;
            const overlap: typeof buffer = [];
            for (let j = buffer.length - 1; j >= 0 && overlapTokens < OVERLAP_TOKENS; j--) {
                overlap.unshift(buffer[j]);
                overlapTokens += approximateTokens(buffer[j].line);
            }
            buffer = overlap;
            bufferTokens = overlapTokens;
        }
        buffer.push({ idx: i, line, heading: currentHeading });
        bufferTokens += lineTokens;
    }
    flush();
    return chunks;
}

async function embed(text: string, modelRef: string): Promise<number[] | null> {
    const { backend, model } = parseEmbeddingModelRef(modelRef);
    if (backend === "llamacpp") {
        // Same path-containment discipline as chat-dispatch.ts's llamacpp/rocm
        // branches: `model` is a renderer-supplied relative path that must
        // stay inside the configured models directory.
        const root = path.resolve(getLlamaCppModelsDir());
        const modelPath = path.resolve(root, model);
        if (modelPath === root || !modelPath.startsWith(root + path.sep)) return null;
        try {
            return await llamacpp.embed(modelPath, text);
        } catch {
            return null;
        }
    }
    // Ollama is removed (docs/LOCAL_INFERENCE_HARDENING_PLAN.md) — an
    // unprefixed ref (`backend === "ollama"`) can never be embedded again.
    // This is reached for two real cases: (1) DEFAULT_EMBEDDING_MODEL itself
    // is still the Ollama tag "nomic-embed-text" (no safe llama.cpp default
    // exists to guess at — a fresh install has no GGUF embedding model on
    // disk at all, so a wrong guess would fail just as loudly, less
    // honestly), and (2) an existing collection created before this removal
    // still has an Ollama tag as its stored `embedding_model`. Returning
    // `null` here (rather than throwing) is deliberate: indexFolderTask's
    // existing `embedFailure` handling turns this into a clear "Embedding
    // model \"X\" is unavailable" message for new indexing attempts, and
    // query()'s existing null-embedding fallback still returns a collection's
    // already-embedded results (unranked) rather than nothing at all for
    // pre-existing data — both paths already handle this correctly with no
    // further change needed, this is just where the chain now ends instead
    // of reaching a live Ollama server.
    void model;
    return null;
}

async function embedChunks(texts: string[], model: string): Promise<number[][] | null> {
    const out: number[][] = [];
    for (let i = 0; i < texts.length; i += EMBED_BATCH_SIZE) {
        const batch = texts.slice(i, i + EMBED_BATCH_SIZE);
        const embeddings = await Promise.all(batch.map((t) => embed(t, model)));
        for (const e of embeddings) {
            if (!e) return null;
            out.push(e);
        }
    }
    return out;
}

export function cosineSimilarity(a: number[] | Float32Array, b: number[] | Float32Array): number {
    let dot = 0;
    let normA = 0;
    let normB = 0;
    for (let i = 0; i < a.length; i++) {
        dot += a[i] * b[i];
        normA += a[i] * a[i];
        normB += b[i] * b[i];
    }
    if (normA === 0 || normB === 0) return 0;
    return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

function hashContent(content: string): string {
    return createHash("sha256").update(content).digest("hex");
}

export interface IndexFolderInput {
    folderPath: string;
    folderName: string;
    files: AttachedFile[];
    embeddingModel?: string;
}

export interface CollectionSummary {
    collectionId: string;
    name: string;
    folderPath?: string;
    documentCount: number;
    chunkCount: number;
    embeddingModel: string;
    updatedAt?: number;
    embedded: boolean;
    error?: string;
}

// Indexes (or incrementally re-indexes) a folder into a persistent,
// named collection. Unchanged files (by content hash) are skipped entirely —
// only new/changed files get re-chunked and re-embedded. Files present in the
// DB for this collection but absent from the current file list are removed
// (stale-document cleanup on manual re-index; this is not live file watching).
//
// Item 1/19: "Embeddings/RAG indexing — Background, pauseable." Wrapped in a
// background-compute lease so an active chat's own embedding query
// (query(), below) — and any local-inference lease — always outranks it in
// the admission queue; a large folder re-index never delays a live response.
export async function indexFolder(input: IndexFolderInput): Promise<CollectionSummary> {
    const embeddingModel = input.embeddingModel ?? DEFAULT_EMBEDDING_MODEL;
    return mainResourceOrchestrator.withLease(
        { workloadKind: "indexing", priority: "background-compute", requirements: embeddingLeaseRequirements(embeddingModel, 2) },
        () => indexFolderTask({ ...input, embeddingModel })
    );
}

async function indexFolderTask(input: IndexFolderInput): Promise<CollectionSummary> {
    const embeddingModel = input.embeddingModel ?? DEFAULT_EMBEDDING_MODEL;
    const existingCollection = ragDb.getCollectionByPath(input.folderPath);
    const collection = ragDb.upsertCollection({
        id: existingCollection?.id ?? randomUUID(),
        name: input.folderName,
        folderPath: input.folderPath,
        embeddingModel: existingCollection?.embedding_model ?? embeddingModel,
    });

    const currentPaths = new Set<string>();
    let embedFailure: string | null = null;

    for (const file of input.files) {
        currentPaths.add(file.path);
        if (embedFailure) break;
        const hash = hashContent(file.content);
        const existingDoc = ragDb.getDocument(collection.id, file.path);
        if (existingDoc && existingDoc.content_hash === hash) continue;

        const chunks = chunkDocument(file.content);
        const embeddings = chunks.length > 0 ? await embedChunks(chunks.map((c) => c.text), collection.embedding_model) : [];
        if (!embeddings) { embedFailure = `Embedding model "${collection.embedding_model}" is unavailable`; break; }

        const documentId = existingDoc?.id ?? randomUUID();
        ragDb.upsertDocument({
            id: documentId, collectionId: collection.id, path: file.path, name: file.name,
            contentHash: hash, size: file.content.length, mtimeMs: Date.now(), pageCount: null,
        });
        ragDb.replaceChunks(documentId, collection.id, chunks.map((c, i) => ({
            text: c.text, tokenCount: c.tokenCount, heading: c.heading, page: null,
            startLine: c.startLine, endLine: c.endLine, embedding: embeddings[i],
        })));
    }

    if (!embedFailure) {
        for (const pdfPath of findPdfFiles(input.folderPath)) {
            currentPaths.add(pdfPath);
            if (embedFailure) break;
            const { text, pages } = await media.extractPdfPages(pdfPath);
            const hash = hashContent(text);
            const existingDoc = ragDb.getDocument(collection.id, pdfPath);
            if (existingDoc && existingDoc.content_hash === hash) continue;

            const pageChunks: (LineChunk & { page: number })[] = [];
            for (const page of pages) {
                for (const c of chunkDocument(page.text)) pageChunks.push({ ...c, page: page.num });
            }
            const embeddings = pageChunks.length > 0 ? await embedChunks(pageChunks.map((c) => c.text), collection.embedding_model) : [];
            if (!embeddings) { embedFailure = `Embedding model "${collection.embedding_model}" is unavailable`; break; }

            const name = path.relative(input.folderPath, pdfPath).split(path.sep).join("/");
            const documentId = existingDoc?.id ?? randomUUID();
            ragDb.upsertDocument({
                id: documentId, collectionId: collection.id, path: pdfPath, name,
                contentHash: hash, size: text.length, mtimeMs: Date.now(), pageCount: pages.length,
            });
            ragDb.replaceChunks(documentId, collection.id, pageChunks.map((c, i) => ({
                text: c.text, tokenCount: c.tokenCount, heading: c.heading, page: c.page,
                startLine: c.startLine, endLine: c.endLine, embedding: embeddings[i],
            })));
        }
    }

    if (!embedFailure) {
        for (const doc of ragDb.listDocuments(collection.id)) {
            if (!currentPaths.has(doc.path)) ragDb.deleteDocument(doc.id);
        }
    }

    ragDb.touchCollection(collection.id);
    const documentCount = ragDb.listDocuments(collection.id).length;
    const chunkCount = ragDb.countChunks(collection.id);

    return {
        collectionId: collection.id, name: collection.name, folderPath: collection.folder_path,
        documentCount, chunkCount, embeddingModel: collection.embedding_model,
        embedded: !embedFailure, error: embedFailure ?? undefined,
    };
}

export interface RagResult {
    text: string;
    score: number;
    source: { path: string; name: string };
    heading: string | null;
    page: number | null;
    startLine: number;
    endLine: number;
}

function toResult(row: ChunkRow & { doc_path: string; doc_name: string }, score: number): RagResult {
    return {
        text: row.text, score, source: { path: row.doc_path, name: row.doc_name },
        heading: row.heading, page: row.page, startLine: row.start_line, endLine: row.end_line,
    };
}

// Retrieval is still brute-force cosine similarity over every chunk in the
// collection — fine at the scale a single folder attach produces, but a real
// ANN index is the natural next step for large collections (deferred).
export async function query(collectionId: string, queryText: string, topK = 8): Promise<RagResult[]> {
    const collection = ragDb.getCollection(collectionId);
    if (!collection) return [];
    const rows = ragDb.chunksForCollection(collectionId);

    // A single, fast embedding call made synchronously as part of answering
    // a live chat message — user-interactive, not background-compute like
    // indexFolder above, so it is never left waiting behind a large re-index.
    const queryEmbedding = await mainResourceOrchestrator.withLease(
        { workloadKind: "user-rag", priority: "user-interactive", requirements: embeddingLeaseRequirements(collection.embedding_model, 1) },
        () => embed(queryText, collection.embedding_model)
    );
    if (!queryEmbedding) {
        return rows.slice(0, topK).map((row) => toResult(row, 0));
    }

    const scored = rows.map((row) => ({ row, score: cosineSimilarity(ragDb.decodeEmbedding(row.embedding), queryEmbedding) }));
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, topK).map(({ row, score }) => toResult(row, score));
}

export function listCollections(): CollectionSummary[] {
    return ragDb.listCollections().map((c) => ({
        collectionId: c.id, name: c.name, folderPath: c.folder_path,
        documentCount: ragDb.listDocuments(c.id).length, chunkCount: ragDb.countChunks(c.id),
        embeddingModel: c.embedding_model, updatedAt: c.updated_at, embedded: true,
    }));
}

export function deleteCollection(id: string): void {
    ragDb.deleteCollection(id);
}
