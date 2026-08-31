import * as fs from "node:fs";
import * as path from "node:path";
import { app } from "electron";
import Database from "better-sqlite3";
import * as caseEncryption from "./case-encryption";
import { CaseDataLockedError } from "./case-encryption";

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

// --- At-rest encryption for extracted document content ---------------------
//
// RAG folders are arbitrary local directories a user points the app at —
// just as capable of containing clinical documents as a Patient Case is,
// and unlike Patient Cases/chat sessions this store had no encryption at
// all until now. Reuses case-encryption.ts's existing passphrase-derived
// key and AES-256-GCM primitives — the same "Enable encryption" toggle in
// Settings → Audit & Privacy covers this store too, not a second one to
// configure separately.
//
// What's encrypted: `collections.name`, `documents.name`, `chunks.text`,
// `chunks.heading` — the actual retrievable/displayable content.
//
// What's deliberately NOT encrypted, and why:
//   - `documents.path` / `collections.folder_path`: both are SQL
//     equality-lookup/uniqueness keys (`getDocument`, `getCollectionByPath`,
//     the `UNIQUE` constraints themselves). AES-GCM's random IV makes the
//     same plaintext produce different ciphertext every time, which breaks
//     exact-match lookups entirely without a separate deterministic/
//     blind-index scheme this file doesn't implement. A filename or folder
//     name is a real but smaller information leak than the full extracted
//     text of every document in it — this tradeoff is deliberate and
//     documented, not an oversight.
//   - `chunks.embedding`: not human-readable, and similarity search
//     (`cosineSimilarity` in rag.ts) needs to compute against it directly —
//     encrypting it would mean decrypting every row on every query just to
//     search, with no confidentiality benefit since the vector itself
//     doesn't reveal document content the way its source text does.
//   - Everything else (hashes, sizes, timestamps, ordinals, line/page
//     numbers): structural metadata, not content.
//
// Same locked-state guarantee as patient-cases-store.ts/sessions-store.ts:
// reading or writing an encrypted field while enabled-but-locked throws
// CaseDataLockedError rather than silently returning garbage or an empty
// result.

function readField(raw: string): string {
    if (!caseEncryption.isEnabled()) return raw;
    if (!caseEncryption.isUnlocked()) throw new CaseDataLockedError();
    const payload = JSON.parse(raw) as caseEncryption.EncryptedPayload;
    return caseEncryption.decrypt(payload, caseEncryption.getSessionKey()!);
}

function writeField(plain: string): string {
    if (!caseEncryption.isEnabled()) return plain;
    if (!caseEncryption.isUnlocked()) throw new CaseDataLockedError();
    return JSON.stringify(caseEncryption.encrypt(plain, caseEncryption.getSessionKey()!));
}

function decryptCollection(row: CollectionRow): CollectionRow {
    return { ...row, name: readField(row.name) };
}

function decryptDocument(row: DocumentRow): DocumentRow {
    return { ...row, name: readField(row.name) };
}

function decryptChunk<T extends { text: string; heading: string | null }>(row: T): T {
    return { ...row, text: readField(row.text), heading: row.heading === null ? null : readField(row.heading) };
}

export interface RagContentForMigration {
    collections: { id: string; name: string }[];
    documents: { id: string; name: string }[];
    chunks: { id: string; text: string; heading: string | null }[];
}

/** Reads every collection/document/chunk's encrypted-or-plaintext content
 * fields under whichever mode is active right now, decrypted to plaintext
 * — mirrors patient-cases-store.ts's getAllCasesForMigration(): used by the
 * encryption setup/disable/rotate-passphrase flows (encryption-handlers.ts)
 * to move this content between plaintext and encrypted storage. Never
 * touches embeddings, paths, or any other column, so no re-embedding is
 * ever needed just to change encryption state. */
export function getAllContentForMigration(): RagContentForMigration {
    const db = getDb();
    const collections = (db.prepare(`SELECT id, name FROM collections`).all() as { id: string; name: string }[]).map((r) => ({
        id: r.id,
        name: readField(r.name),
    }));
    const documents = (db.prepare(`SELECT id, name FROM documents`).all() as { id: string; name: string }[]).map((r) => ({
        id: r.id,
        name: readField(r.name),
    }));
    const chunks = (db.prepare(`SELECT id, text, heading FROM chunks`).all() as { id: string; text: string; heading: string | null }[]).map(
        (r) => ({ id: r.id, text: readField(r.text), heading: r.heading === null ? null : readField(r.heading) })
    );
    return { collections, documents, chunks };
}

/** Writes the given (plaintext) content back under whichever mode is active
 * right now — paired with getAllContentForMigration() so a caller can read
 * under the old key/mode, change the key/mode, then write back under the
 * new one. */
export function overwriteAllContent(data: RagContentForMigration): void {
    const db = getDb();
    const tx = db.transaction(() => {
        for (const c of data.collections) {
            db.prepare(`UPDATE collections SET name = ? WHERE id = ?`).run(writeField(c.name), c.id);
        }
        for (const d of data.documents) {
            db.prepare(`UPDATE documents SET name = ? WHERE id = ?`).run(writeField(d.name), d.id);
        }
        for (const c of data.chunks) {
            db.prepare(`UPDATE chunks SET text = ?, heading = ? WHERE id = ?`).run(
                writeField(c.text),
                c.heading === null ? null : writeField(c.heading),
                c.id
            );
        }
    });
    tx();
}

export function upsertCollection(input: { id: string; name: string; folderPath: string; embeddingModel: string }): CollectionRow {
    const now = Date.now();
    const existing = getCollectionByPath(input.folderPath);
    if (existing) {
        getDb().prepare(`UPDATE collections SET name = ?, updated_at = ? WHERE id = ?`).run(writeField(input.name), now, existing.id);
        return { ...existing, name: input.name, updated_at: now };
    }
    const row: CollectionRow = { id: input.id, name: input.name, folder_path: input.folderPath, embedding_model: input.embeddingModel, created_at: now, updated_at: now };
    getDb()
        .prepare(`INSERT INTO collections (id, name, folder_path, embedding_model, created_at, updated_at) VALUES (@id, @name, @folder_path, @embedding_model, @created_at, @updated_at)`)
        .run({ ...row, name: writeField(row.name) });
    return row;
}

export function getCollectionByPath(folderPath: string): CollectionRow | undefined {
    const row = getDb().prepare(`SELECT * FROM collections WHERE folder_path = ?`).get(folderPath) as CollectionRow | undefined;
    return row ? decryptCollection(row) : undefined;
}

export function getCollection(id: string): CollectionRow | undefined {
    const row = getDb().prepare(`SELECT * FROM collections WHERE id = ?`).get(id) as CollectionRow | undefined;
    return row ? decryptCollection(row) : undefined;
}

export function listCollections(): CollectionRow[] {
    const rows = getDb().prepare(`SELECT * FROM collections ORDER BY updated_at DESC`).all() as CollectionRow[];
    return rows.map(decryptCollection);
}

export function deleteCollection(id: string): void {
    getDb().prepare(`DELETE FROM collections WHERE id = ?`).run(id);
}

export function touchCollection(id: string): void {
    getDb().prepare(`UPDATE collections SET updated_at = ? WHERE id = ?`).run(Date.now(), id);
}

export function getDocument(collectionId: string, filePath: string): DocumentRow | undefined {
    const row = getDb().prepare(`SELECT * FROM documents WHERE collection_id = ? AND path = ?`).get(collectionId, filePath) as DocumentRow | undefined;
    return row ? decryptDocument(row) : undefined;
}

export function listDocuments(collectionId: string): DocumentRow[] {
    const rows = getDb().prepare(`SELECT * FROM documents WHERE collection_id = ?`).all(collectionId) as DocumentRow[];
    return rows.map(decryptDocument);
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
    `).run({ ...input, name: writeField(input.name), now });
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
                text: writeField(chunk.text), token_count: chunk.tokenCount, heading: chunk.heading === null ? null : writeField(chunk.heading),
                page: chunk.page, start_line: chunk.startLine, end_line: chunk.endLine, embedding: encodeEmbedding(chunk.embedding),
            });
        });
    });
    tx(chunks);
}

export function chunksForCollection(collectionId: string): (ChunkRow & { doc_path: string; doc_name: string })[] {
    const rows = getDb().prepare(`
        SELECT chunks.*, documents.path AS doc_path, documents.name AS doc_name
        FROM chunks JOIN documents ON documents.id = chunks.document_id
        WHERE chunks.collection_id = ?
    `).all(collectionId) as (ChunkRow & { doc_path: string; doc_name: string })[];
    return rows.map((row) => ({ ...decryptChunk(row), doc_name: readField(row.doc_name) }));
}

export function countChunks(collectionId: string): number {
    const row = getDb().prepare(`SELECT COUNT(*) AS n FROM chunks WHERE collection_id = ?`).get(collectionId) as { n: number };
    return row.n;
}
