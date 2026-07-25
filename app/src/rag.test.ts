import { describe, it, expect, beforeEach, vi } from "vitest";
import { chunkDocument, cosineSimilarity, indexFolder, query, listCollections, deleteCollection } from "./rag";
import { clearAllForTests, listDocuments, getCollectionByPath } from "./rag-db";
import type { AttachedFile } from "./file-reader";

// Deterministic fake embeddings keyed by exact prompt text, so retrieval
// ranking is verifiable without a real embedding model. Falls back to a
// neutral vector for anything not explicitly registered below.
const VECTORS: Record<string, number[]> = {};
function mockEmbeddingFor(text: string, vector: number[]) {
    VECTORS[text] = vector;
}

beforeEach(() => {
    clearAllForTests();
    for (const key of Object.keys(VECTORS)) delete VECTORS[key];
    vi.stubGlobal(
        "fetch",
        vi.fn(async (_url: string, init: { body: string }) => {
            const body = JSON.parse(init.body);
            return { ok: true, json: async () => ({ embedding: VECTORS[body.prompt] ?? [0, 0, 1] }) };
        })
    );
});

function file(partial: Partial<AttachedFile>): AttachedFile {
    return { name: "file.txt", path: "/test/file.txt", content: "content", truncated: false, ...partial };
}

describe("chunkDocument", () => {
    it("returns the whole text as one chunk when it's under the token budget", () => {
        const chunks = chunkDocument("line one\nline two\nline three");
        expect(chunks).toHaveLength(1);
        expect(chunks[0].startLine).toBe(1);
        expect(chunks[0].endLine).toBe(3);
    });

    it("never splits a line across chunk boundaries", () => {
        const longLine = "word ".repeat(2000); // ~2500 tokens on one physical line
        const content = `${longLine}\nshort line after`;
        const chunks = chunkDocument(content);
        for (const chunk of chunks) {
            for (const line of chunk.text.split("\n")) {
                expect(content.includes(line)).toBe(true);
            }
        }
    });

    it("splits long content into multiple token-budgeted chunks with overlap", () => {
        const lines = Array.from({ length: 400 }, (_, i) => `line number ${i} with some extra words to add tokens`);
        const chunks = chunkDocument(lines.join("\n"));
        expect(chunks.length).toBeGreaterThan(1);
        // consecutive chunks overlap: the second chunk's start line is not
        // simply one past the first chunk's end line.
        expect(chunks[1].startLine).toBeLessThanOrEqual(chunks[0].endLine);
    });

    it("tags each chunk with the nearest preceding markdown heading", () => {
        const content = "# Intro\nsome intro text\n\n## Details\nmore text here";
        const chunks = chunkDocument(content);
        expect(chunks[0].heading).toBe("Intro");
    });
});

describe("cosineSimilarity", () => {
    it("returns 1 for identical vectors", () => {
        expect(cosineSimilarity([1, 2, 3], [1, 2, 3])).toBeCloseTo(1);
    });
    it("returns 0 for a zero vector instead of NaN", () => {
        expect(cosineSimilarity([0, 0], [1, 2])).toBe(0);
    });
});

describe("indexFolder", () => {
    it("creates a persistent collection with chunk/document counts", async () => {
        mockEmbeddingFor("hello world", [1, 0, 0]);
        const result = await indexFolder({
            folderPath: "/test/folder-a", folderName: "folder-a",
            files: [file({ path: "/test/folder-a/a.txt", name: "a.txt", content: "hello world" })],
        });
        expect(result.embedded).toBe(true);
        expect(result.documentCount).toBe(1);
        expect(result.chunkCount).toBe(1);
        expect(getCollectionByPath("/test/folder-a")).toBeDefined();
    });

    it("skips re-embedding a file whose content hash is unchanged", async () => {
        mockEmbeddingFor("hello world", [1, 0, 0]);
        const files = [file({ path: "/test/folder-b/a.txt", name: "a.txt", content: "hello world" })];
        await indexFolder({ folderPath: "/test/folder-b", folderName: "folder-b", files });

        const fetchSpy = global.fetch as unknown as ReturnType<typeof vi.fn>;
        const callsBefore = fetchSpy.mock.calls.length;
        const result = await indexFolder({ folderPath: "/test/folder-b", folderName: "folder-b", files });
        expect(fetchSpy.mock.calls.length).toBe(callsBefore); // no new embed calls
        expect(result.documentCount).toBe(1);
    });

    it("re-embeds a file whose content changed", async () => {
        mockEmbeddingFor("version one", [1, 0, 0]);
        mockEmbeddingFor("version two", [0, 1, 0]);
        const folderPath = "/test/folder-c";
        await indexFolder({ folderPath, folderName: "folder-c", files: [file({ path: `${folderPath}/a.txt`, content: "version one" })] });

        const fetchSpy = global.fetch as unknown as ReturnType<typeof vi.fn>;
        const callsBefore = fetchSpy.mock.calls.length;
        await indexFolder({ folderPath, folderName: "folder-c", files: [file({ path: `${folderPath}/a.txt`, content: "version two" })] });
        expect(fetchSpy.mock.calls.length).toBeGreaterThan(callsBefore);
    });

    it("removes documents that are no longer present on re-index", async () => {
        mockEmbeddingFor("keep me", [1, 0, 0]);
        mockEmbeddingFor("remove me", [0, 1, 0]);
        const folderPath = "/test/folder-d";
        const first = await indexFolder({
            folderPath, folderName: "folder-d",
            files: [file({ path: `${folderPath}/keep.txt`, content: "keep me" }), file({ path: `${folderPath}/gone.txt`, content: "remove me" })],
        });
        expect(listDocuments(first.collectionId)).toHaveLength(2);

        const second = await indexFolder({
            folderPath, folderName: "folder-d",
            files: [file({ path: `${folderPath}/keep.txt`, content: "keep me" })],
        });
        const docs = listDocuments(second.collectionId);
        expect(docs).toHaveLength(1);
        expect(docs[0].path).toBe(`${folderPath}/keep.txt`);
    });

    it("reports a failure reason instead of silently swallowing an embedding failure", async () => {
        vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false })));
        const result = await indexFolder({
            folderPath: "/test/folder-e", folderName: "folder-e",
            files: [file({ path: "/test/folder-e/a.txt", content: "hello" })],
        });
        expect(result.embedded).toBe(false);
        expect(result.error).toMatch(/unavailable/i);
    });
});

describe("query", () => {
    it("returns results sorted by similarity with full metadata", async () => {
        mockEmbeddingFor("about cats", [1, 0, 0]);
        mockEmbeddingFor("about dogs", [0, 1, 0]);
        mockEmbeddingFor("cats please", [0.9, 0.1, 0]);
        const folderPath = "/test/folder-f";
        const indexed = await indexFolder({
            folderPath, folderName: "folder-f",
            files: [
                file({ path: `${folderPath}/cats.txt`, name: "cats.txt", content: "about cats" }),
                file({ path: `${folderPath}/dogs.txt`, name: "dogs.txt", content: "about dogs" }),
            ],
        });

        const results = await query(indexed.collectionId, "cats please", 8);
        expect(results).toHaveLength(2);
        expect(results[0].source.name).toBe("cats.txt");
        expect(results[0].score).toBeGreaterThan(results[1].score);
        expect(results[0].startLine).toBe(1);
        expect(results[0].endLine).toBe(1);
    });

    it("returns an empty array for an unknown collection", async () => {
        expect(await query("does-not-exist", "anything")).toEqual([]);
    });
});

describe("listCollections / deleteCollection", () => {
    it("lists persisted collections and removes them on delete", async () => {
        mockEmbeddingFor("hello", [1, 0, 0]);
        const result = await indexFolder({
            folderPath: "/test/folder-g", folderName: "folder-g",
            files: [file({ path: "/test/folder-g/a.txt", content: "hello" })],
        });
        expect(listCollections().some((c) => c.collectionId === result.collectionId)).toBe(true);

        deleteCollection(result.collectionId);
        expect(listCollections().some((c) => c.collectionId === result.collectionId)).toBe(false);
    });
});
