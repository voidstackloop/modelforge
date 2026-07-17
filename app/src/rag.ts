import { randomUUID } from "node:crypto";
import * as ollama from "./ollama-manager";
import type { AttachedFile } from "./file-reader";

export interface RagChunk {
    text: string;
    source: string;
}

interface IndexedChunk extends RagChunk {
    embedding: number[];
}

interface RagIndexEntry {
    chunks: IndexedChunk[];
    createdAt: number;
}

export interface IndexFilesResult {
    indexId: string;
    chunkCount: number;
    embedded: boolean;
}

const indexes = new Map<string, RagIndexEntry>();
const MAX_INDEXES = 8;
const MAX_CHUNKS = 200;
const CHUNK_SIZE = 1000;
const CHUNK_OVERLAP = 150;
const EMBED_BATCH_SIZE = 8;
const EMBEDDING_MODEL = "nomic-embed-text";

function chunkText(text: string): string[] {
    if (text.length <= CHUNK_SIZE) return [text];
    const chunks: string[] = [];
    let start = 0;
    while (start < text.length) {
        const end = Math.min(start + CHUNK_SIZE, text.length);
        chunks.push(text.slice(start, end));
        start += CHUNK_SIZE - CHUNK_OVERLAP;
    }
    return chunks;
}

async function embed(text: string): Promise<number[] | null> {
    try {
        const res = await fetch(`${ollama.getHost()}/api/embeddings`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ model: EMBEDDING_MODEL, prompt: text }),
            signal: AbortSignal.timeout(15000),
        });
        if (!res.ok) return null;
        const data = await res.json();
        return Array.isArray(data.embedding) ? data.embedding : null;
    } catch {
        return null;
    }
}

function cosineSimilarity(a: number[], b: number[]): number {
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

function evictOldestIfFull(): void {
    if (indexes.size < MAX_INDEXES) return;
    let oldestId: string | null = null;
    let oldestTime = Infinity;
    for (const [id, entry] of indexes) {
        if (entry.createdAt < oldestTime) {
            oldestTime = entry.createdAt;
            oldestId = id;
        }
    }
    if (oldestId) indexes.delete(oldestId);
}

export async function indexFiles(files: AttachedFile[]): Promise<IndexFilesResult> {
    const rawChunks: RagChunk[] = [];
    for (const file of files) {
        for (const piece of chunkText(file.content)) {
            rawChunks.push({ text: piece, source: file.name });
            if (rawChunks.length >= MAX_CHUNKS) break;
        }
        if (rawChunks.length >= MAX_CHUNKS) break;
    }

    const indexed: IndexedChunk[] = [];
    for (let i = 0; i < rawChunks.length; i += EMBED_BATCH_SIZE) {
        const batch = rawChunks.slice(i, i + EMBED_BATCH_SIZE);
        const embeddings = await Promise.all(batch.map((c) => embed(c.text)));
        for (let j = 0; j < batch.length; j++) {
            const embedding = embeddings[j];
            // Embedding model unavailable (not pulled, or Ollama unreachable) —
            // bail out entirely so the caller falls back to dumping raw content.
            if (!embedding) return { indexId: "", chunkCount: 0, embedded: false };
            indexed.push({ ...batch[j], embedding });
        }
    }

    evictOldestIfFull();
    const indexId = randomUUID();
    indexes.set(indexId, { chunks: indexed, createdAt: Date.now() });
    return { indexId, chunkCount: indexed.length, embedded: true };
}

export async function query(indexId: string, queryText: string, topK = 8): Promise<RagChunk[]> {
    const entry = indexes.get(indexId);
    if (!entry) return [];

    const queryEmbedding = await embed(queryText);
    if (!queryEmbedding) {
        return entry.chunks.slice(0, topK).map(({ text, source }) => ({ text, source }));
    }

    const scored = entry.chunks.map((c) => ({ ...c, score: cosineSimilarity(c.embedding, queryEmbedding) }));
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, topK).map(({ text, source }) => ({ text, source }));
}
