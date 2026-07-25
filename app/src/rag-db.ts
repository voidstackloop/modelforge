import * as fs from "node:fs";
import * as path from "node:path";
import { app } from "electron";
import Database from "better-sqlite3";

export interface CollectionRow {
    id: string;
    name: string;
    folder_path: string;
    embedding_model: string;
    created_at: number;
    updated_at: number;
}

export interface DocumentRow {
    id: string;
    collection_id: string;
    path: string;
    name: string;
    content_hash: string;
    size: number;
    mtime_ms: number;
    page_count: number | null;
    indexed_at: number;
}

export interface ChunkInput {
    text: string;
    tokenCount: number;
    heading: string | null;
    page: number | null;
    startLine: number;
    endLine: number;
    embedding: number[];
}

export interface ChunkRow {
    id: string;
    document_id: string;
    collection_id: string;
    ordinal: number;
    text: string;
    token_count: number;
    heading: string | null;
    page: number | null;
    start_line: number;
    end_line: number;
    embedding: Buffer;
}

function filePath(): string {
    return path.join(app.getPath("userData"), "rag.db");
}

let db: Database.Database | null = null;

// Module-level singleton, opened lazily so tests (and any code running
// before app.getPath is available) don't pay for it until first use.
export function getDb(): Database.Database {
    if (db) return db;
    fs.mkdirSync(path.dirname(filePath()), { recursive: true });
    db = new Database(filePath());
    db.pragma("journal_mode = WAL");
    db.exec(`
        CREATE TABLE IF NOT EXISTS collections (
            id TEXT PRIMARY KEY, name TEXT NOT NULL, folder_path TEXT NOT NULL UNIQUE,
            embedding_model TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS documents (
            id TEXT PRIMARY KEY, collection_id TEXT NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
            path TEXT NOT NULL, name TEXT NOT NULL, content_hash TEXT NOT NULL,
            size INTEGER NOT NULL, mtime_ms INTEGER NOT NULL, page_count INTEGER, indexed_at INTEGER NOT NULL,
            UNIQUE(collection_id, path)
        );
        CREATE TABLE IF NOT EXISTS chunks (
            id TEXT PRIMARY KEY, document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
            collection_id TEXT NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
            ordinal INTEGER NOT NULL, text TEXT NOT NULL, token_count INTEGER NOT NULL,
            heading TEXT, page INTEGER, start_line INTEGER NOT NULL, end_line INTEGER NOT NULL,
            embedding BLOB NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_chunks_collection ON chunks(collection_id);
        CREATE INDEX IF NOT EXISTS idx_documents_collection ON documents(collection_id);
    `);
    return db;
}

// Exposed for tests only — the electron mock points app.getPath("userData")
// at a real temp directory shared for the whole test process, so without
// this, rows from one test would leak into the next via the same rag.db file.
export function clearAllForTests(): void {
    getDb().exec(`DELETE FROM chunks; DELETE FROM documents; DELETE FROM collections;`);
}

export function encodeEmbedding(vector: number[]): Buffer {
    return Buffer.from(Float32Array.from(vector).buffer);
}

export function decodeEmbedding(buffer: Buffer): Float32Array {
    return new Float32Array(buffer.buffer, buffer.byteOffset, buffer.length / Float32Array.BYTES_PER_ELEMENT);
}

export function upsertCollection(input: { id: string; name: string; folderPath: string; embeddingModel: string }): CollectionRow {
    const now = Date.now();
    const existing = getCollectionByPath(input.folderPath);
    if (existing) {
        getDb().prepare(`UPDATE collections SET name = ?, updated_at = ? WHERE id = ?`).run(input.name, now, existing.id);
        return { ...existing, name: input.name, updated_at: now };
    }
    const row: CollectionRow = { id: input.id, name: input.name, folder_path: input.folderPath, embedding_model: input.embeddingModel, created_at: now, updated_at: now };
    getDb().prepare(`INSERT INTO collections (id, name, folder_path, embedding_model, created_at, updated_at) VALUES (@id, @name, @folder_path, @embedding_model, @created_at, @updated_at)`).run(row);
    return row;
}

export function getCollectionByPath(folderPath: string): CollectionRow | undefined {
    return getDb().prepare(`SELECT * FROM collections WHERE folder_path = ?`).get(folderPath) as CollectionRow | undefined;
}

export function getCollection(id: string): CollectionRow | undefined {
    return getDb().prepare(`SELECT * FROM collections WHERE id = ?`).get(id) as CollectionRow | undefined;
}

export function listCollections(): CollectionRow[] {
    return getDb().prepare(`SELECT * FROM collections ORDER BY updated_at DESC`).all() as CollectionRow[];
}

export function deleteCollection(id: string): void {
    getDb().prepare(`DELETE FROM collections WHERE id = ?`).run(id);
}

export function touchCollection(id: string): void {
    getDb().prepare(`UPDATE collections SET updated_at = ? WHERE id = ?`).run(Date.now(), id);
}

export function getDocument(collectionId: string, filePath: string): DocumentRow | undefined {
    return getDb().prepare(`SELECT * FROM documents WHERE collection_id = ? AND path = ?`).get(collectionId, filePath) as DocumentRow | undefined;
}

export function listDocuments(collectionId: string): DocumentRow[] {
    return getDb().prepare(`SELECT * FROM documents WHERE collection_id = ?`).all(collectionId) as DocumentRow[];
}

export function upsertDocument(input: {
    id: string; collectionId: string; path: string; name: string; contentHash: string; size: number; mtimeMs: number; pageCount: number | null;
}): void {
    const now = Date.now();
    getDb().prepare(`
        INSERT INTO documents (id, collection_id, path, name, content_hash, size, mtime_ms, page_count, indexed_at)
        VALUES (@id, @collectionId, @path, @name, @contentHash, @size, @mtimeMs, @pageCount, @now)
        ON CONFLICT(collection_id, path) DO UPDATE SET
            content_hash = excluded.content_hash, size = excluded.size, mtime_ms = excluded.mtime_ms,
            page_count = excluded.page_count, indexed_at = excluded.indexed_at
    `).run({ ...input, now });
}

export function deleteDocument(id: string): void {
    getDb().prepare(`DELETE FROM documents WHERE id = ?`).run(id);
}

export function replaceChunks(documentId: string, collectionId: string, chunks: ChunkInput[]): void {
    const db = getDb();
    const del = db.prepare(`DELETE FROM chunks WHERE document_id = ?`);
    const insert = db.prepare(`
        INSERT INTO chunks (id, document_id, collection_id, ordinal, text, token_count, heading, page, start_line, end_line, embedding)
        VALUES (@id, @document_id, @collection_id, @ordinal, @text, @token_count, @heading, @page, @start_line, @end_line, @embedding)
    `);
    const tx = db.transaction((rows: ChunkInput[]) => {
        del.run(documentId);
        rows.forEach((chunk, ordinal) => {
            insert.run({
                id: `${documentId}:${ordinal}`, document_id: documentId, collection_id: collectionId, ordinal,
                text: chunk.text, token_count: chunk.tokenCount, heading: chunk.heading, page: chunk.page,
                start_line: chunk.startLine, end_line: chunk.endLine, embedding: encodeEmbedding(chunk.embedding),
            });
        });
    });
    tx(chunks);
}

export function chunksForCollection(collectionId: string): (ChunkRow & { doc_path: string; doc_name: string })[] {
    return getDb().prepare(`
        SELECT chunks.*, documents.path AS doc_path, documents.name AS doc_name
        FROM chunks JOIN documents ON documents.id = chunks.document_id
        WHERE chunks.collection_id = ?
    `).all(collectionId) as (ChunkRow & { doc_path: string; doc_name: string })[];
}

export function countChunks(collectionId: string): number {
    const row = getDb().prepare(`SELECT COUNT(*) AS n FROM chunks WHERE collection_id = ?`).get(collectionId) as { n: number };
    return row.n;
}
