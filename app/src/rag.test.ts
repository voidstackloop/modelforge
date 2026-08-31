import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { chunkDocument, cosineSimilarity, indexFolder, query, listCollections, deleteCollection, parseEmbeddingModelRef } from "./rag";
import { clearAllForTests, listDocuments, getCollectionByPath, getDb, getAllContentForMigration, overwriteAllContent } from "./rag-db";
import * as caseEncryption from "./case-encryption";
import { CaseDataLockedError } from "./case-encryption";
import type { AttachedFile } from "./file-reader";
import { mainResourceOrchestrator } from "./resource-orchestrator";
import * as llamacpp from "./llamacpp-manager";

// docs/LOCAL_INFERENCE_HARDENING_PLAN.md §2: Ollama is removed — embed()'s
// "ollama" backend branch is gone entirely (it now unconditionally returns
// null), so llama.cpp is the only embedding backend these tests (or this
// app) can actually exercise. TEST_EMBEDDING_MODEL is what every test below
// passes explicitly, since DEFAULT_EMBEDDING_MODEL itself is still the
// now-permanently-dead Ollama tag "nomic-embed-text" (see rag.ts's own
// comment on why that wasn't changed to a guessed GGUF filename).
vi.mock("./llamacpp-manager", () => ({ embed: vi.fn(async (_modelPath: string, text: string) => VECTORS[text] ?? [0, 0, 1]) }));
const TEST_EMBEDDING_MODEL = "llamacpp:test-embedding-model.gguf";

// Deterministic fake embeddings keyed by exact prompt text, so retrieval
// ranking is verifiable without a real embedding model. Falls back to a
// neutral vector for anything not explicitly registered below.
const VECTORS: Record<string, number[]> = {};
function mockEmbeddingFor(text: string, vector: number[]) {
    VECTORS[text] = vector;
}

beforeEach(() => {
    clearAllForTests();
    vi.clearAllMocks();
    for (const key of Object.keys(VECTORS)) delete VECTORS[key];
});

function file(partial: Partial<AttachedFile>): AttachedFile {
    return { name: "file.txt", path: "/test/file.txt", content: "content", truncated: false, ...partial };
}

// Every test below indexes through TEST_EMBEDDING_MODEL unless it's
// specifically testing what happens with none configured at all.
function indexTestFolder(input: Parameters<typeof indexFolder>[0]) {
    return indexFolder({ embeddingModel: TEST_EMBEDDING_MODEL, ...input });
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
        const result = await indexTestFolder({
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
        await indexTestFolder({ folderPath: "/test/folder-b", folderName: "folder-b", files });

        const callsBefore = vi.mocked(llamacpp.embed).mock.calls.length;
        const result = await indexTestFolder({ folderPath: "/test/folder-b", folderName: "folder-b", files });
        expect(vi.mocked(llamacpp.embed).mock.calls.length).toBe(callsBefore); // no new embed calls
        expect(result.documentCount).toBe(1);
    });

    it("re-embeds a file whose content changed", async () => {
        mockEmbeddingFor("version one", [1, 0, 0]);
        mockEmbeddingFor("version two", [0, 1, 0]);
        const folderPath = "/test/folder-c";
        await indexTestFolder({ folderPath, folderName: "folder-c", files: [file({ path: `${folderPath}/a.txt`, content: "version one" })] });

        const callsBefore = vi.mocked(llamacpp.embed).mock.calls.length;
        await indexTestFolder({ folderPath, folderName: "folder-c", files: [file({ path: `${folderPath}/a.txt`, content: "version two" })] });
        expect(vi.mocked(llamacpp.embed).mock.calls.length).toBeGreaterThan(callsBefore);
    });

    it("removes documents that are no longer present on re-index", async () => {
        mockEmbeddingFor("keep me", [1, 0, 0]);
        mockEmbeddingFor("remove me", [0, 1, 0]);
        const folderPath = "/test/folder-d";
        const first = await indexTestFolder({
            folderPath, folderName: "folder-d",
            files: [file({ path: `${folderPath}/keep.txt`, content: "keep me" }), file({ path: `${folderPath}/gone.txt`, content: "remove me" })],
        });
        expect(listDocuments(first.collectionId)).toHaveLength(2);

        const second = await indexTestFolder({
            folderPath, folderName: "folder-d",
            files: [file({ path: `${folderPath}/keep.txt`, content: "keep me" })],
        });
        const docs = listDocuments(second.collectionId);
        expect(docs).toHaveLength(1);
        expect(docs[0].path).toBe(`${folderPath}/keep.txt`);
    });

    // docs/LOCAL_INFERENCE_HARDENING_PLAN.md §2: this is now the *default*
    // behavior, not a simulated failure — DEFAULT_EMBEDDING_MODEL is still
    // the Ollama tag "nomic-embed-text", and Ollama's embedding path no
    // longer exists at all, so omitting embeddingModel entirely (as every
    // caller that never explicitly configures one does) always hits this.
    it("reports a failure reason instead of silently swallowing an unavailable embedding backend", async () => {
        // indexFolder acquires its resource-orchestrator lease before ever
        // checking whether an embedding model is configured, so on a
        // CI runner with little real spare CPU capacity the *lease
        // acquisition itself* can fail first — masking the "unavailable
        // embedding backend" path this test actually wants to exercise
        // with an unrelated ResourceAdmissionError (observed on a macOS
        // release-build runner). Bypassing real admission here isolates
        // the test from host capacity entirely; the "resource-orchestrator
        // integration" describe block below is where real admission is
        // deliberately still exercised.
        const withLeaseSpy = vi.spyOn(mainResourceOrchestrator, "withLease").mockImplementation((_request, task) => task(undefined as never));
        try {
            const result = await indexFolder({
                folderPath: "/test/folder-e", folderName: "folder-e",
                files: [file({ path: "/test/folder-e/a.txt", content: "hello" })],
            });
            expect(result.embedded).toBe(false);
            expect(result.error).toMatch(/unavailable/i);
            expect(llamacpp.embed).not.toHaveBeenCalled();
        } finally {
            withLeaseSpy.mockRestore();
        }
    });
});

describe("query", () => {
    it("returns results sorted by similarity with full metadata", async () => {
        mockEmbeddingFor("about cats", [1, 0, 0]);
        mockEmbeddingFor("about dogs", [0, 1, 0]);
        mockEmbeddingFor("cats please", [0.9, 0.1, 0]);
        const folderPath = "/test/folder-f";
        const indexed = await indexTestFolder({
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
        const result = await indexTestFolder({
            folderPath: "/test/folder-g", folderName: "folder-g",
            files: [file({ path: "/test/folder-g/a.txt", content: "hello" })],
        });
        expect(listCollections().some((c) => c.collectionId === result.collectionId)).toBe(true);

        deleteCollection(result.collectionId);
        expect(listCollections().some((c) => c.collectionId === result.collectionId)).toBe(false);
    });
});

describe("encryption at rest (shares case-encryption's passphrase gate)", () => {
    afterEach(() => caseEncryption.clearConfig());

    it("does not store readable chunk text or document/collection names in the DB when encryption is enabled", async () => {
        caseEncryption.setup("a strong passphrase");
        mockEmbeddingFor("a secret clinical note", [1, 0, 0]);
        await indexTestFolder({
            folderPath: "/test/enc-folder", folderName: "Encrypted Folder Name",
            files: [file({ path: "/test/enc-folder/note.txt", name: "note.txt", content: "a secret clinical note" })],
        });

        // Bypass rag-db.ts's own decrypt-on-read entirely — read the exact
        // bytes SQLite has on disk, the same thing a stolen/copied device
        // would expose.
        const rawChunk = getDb().prepare(`SELECT text FROM chunks`).get() as { text: string };
        const rawDoc = getDb().prepare(`SELECT name FROM documents`).get() as { name: string };
        const rawCollection = getDb().prepare(`SELECT name FROM collections`).get() as { name: string };

        expect(rawChunk.text).not.toContain("a secret clinical note");
        expect(rawDoc.name).not.toContain("note.txt");
        expect(rawCollection.name).not.toContain("Encrypted Folder Name");
        // Ciphertext, not garbage — still valid EncryptedPayload JSON.
        expect(() => JSON.parse(rawChunk.text)).not.toThrow();
    });

    it("reads and writes normally while unlocked, round-tripping the original content", async () => {
        caseEncryption.setup("a strong passphrase");
        mockEmbeddingFor("hello world", [1, 0, 0]);
        const indexed = await indexTestFolder({
            folderPath: "/test/enc-folder-2", folderName: "folder-2",
            files: [file({ path: "/test/enc-folder-2/a.txt", name: "a.txt", content: "hello world" })],
        });

        const results = await query(indexed.collectionId, "hello world", 8);
        expect(results[0].text).toBe("hello world");
        expect(results[0].source.name).toBe("a.txt");
    });

    it("throws CaseDataLockedError instead of returning empty/garbage results when locked", async () => {
        caseEncryption.setup("a strong passphrase");
        mockEmbeddingFor("hello world", [1, 0, 0]);
        const indexed = await indexTestFolder({
            folderPath: "/test/enc-folder-3", folderName: "folder-3",
            files: [file({ path: "/test/enc-folder-3/a.txt", content: "hello world" })],
        });
        caseEncryption.lock();

        await expect(query(indexed.collectionId, "hello world", 8)).rejects.toThrow(CaseDataLockedError);
        await expect(
            indexTestFolder({ folderPath: "/test/enc-folder-4", folderName: "folder-4", files: [file({ path: "/test/enc-folder-4/b.txt", content: "more text" })] })
        ).rejects.toThrow(CaseDataLockedError);
    });

    it("recovers access after unlocking with the correct passphrase", async () => {
        caseEncryption.setup("a strong passphrase");
        mockEmbeddingFor("hello world", [1, 0, 0]);
        const indexed = await indexTestFolder({
            folderPath: "/test/enc-folder-5", folderName: "folder-5",
            files: [file({ path: "/test/enc-folder-5/a.txt", name: "a.txt", content: "hello world" })],
        });
        caseEncryption.lock();
        expect(caseEncryption.unlock("a strong passphrase")).toBe(true);

        const results = await query(indexed.collectionId, "hello world", 8);
        expect(results[0].text).toBe("hello world");
    });

    it("migrates existing plaintext content to encrypted storage when encryption is enabled, without re-embedding", async () => {
        mockEmbeddingFor("plaintext first", [1, 0, 0]);
        await indexTestFolder({
            folderPath: "/test/enc-folder-6", folderName: "folder-6",
            files: [file({ path: "/test/enc-folder-6/a.txt", name: "a.txt", content: "plaintext first" })],
        });
        const rawBefore = getDb().prepare(`SELECT text FROM chunks`).get() as { text: string };
        expect(rawBefore.text).toBe("plaintext first"); // sanity: genuinely plaintext before migration

        const data = getAllContentForMigration();
        caseEncryption.setup("a strong passphrase");
        overwriteAllContent(data);

        const rawAfter = getDb().prepare(`SELECT text FROM chunks`).get() as { text: string };
        expect(rawAfter.text).not.toContain("plaintext first");

        const callsBefore = vi.mocked(llamacpp.embed).mock.calls.length;
        const collection = getCollectionByPath("/test/enc-folder-6")!;
        const results = await query(collection.id, "plaintext first", 8);
        expect(results[0].text).toBe("plaintext first"); // content survived the migration intact
        expect(vi.mocked(llamacpp.embed).mock.calls.length).toBe(callsBefore + 1); // only the query's own embed call — no re-indexing/re-embedding of existing chunks
    });

    it("moving back to plaintext restores readable content and stops encrypting new writes", async () => {
        caseEncryption.setup("a strong passphrase");
        mockEmbeddingFor("will go back to plaintext", [1, 0, 0]);
        const indexed = await indexTestFolder({
            folderPath: "/test/enc-folder-7", folderName: "folder-7",
            files: [file({ path: "/test/enc-folder-7/a.txt", content: "will go back to plaintext" })],
        });

        const data = getAllContentForMigration();
        caseEncryption.clearConfig();
        overwriteAllContent(data);

        const raw = getDb().prepare(`SELECT text FROM chunks`).get() as { text: string };
        expect(raw.text).toBe("will go back to plaintext");
        const results = await query(indexed.collectionId, "will go back to plaintext", 8);
        expect(results[0].text).toBe("will go back to plaintext");
    });
});

describe("resource-orchestrator integration (item 1/19: indexing is background, retrieval is interactive)", () => {
    it("indexFolder runs as a background-compute lease", async () => {
        const withLeaseSpy = vi.spyOn(mainResourceOrchestrator, "withLease");
        mockEmbeddingFor("indexed via a lease", [1, 0, 0]);
        await indexTestFolder({
            folderPath: "/test/lease-folder", folderName: "lease-folder",
            files: [file({ path: "/test/lease-folder/a.txt", content: "indexed via a lease" })],
        });
        expect(withLeaseSpy).toHaveBeenCalledOnce();
        expect(withLeaseSpy.mock.calls[0][0]).toMatchObject({ workloadKind: "indexing", priority: "background-compute" });
    });

    it("query's embedding call runs as a user-interactive lease, never background-compute", async () => {
        mockEmbeddingFor("interactive retrieval text", [1, 0, 0]);
        const indexed = await indexTestFolder({
            folderPath: "/test/lease-folder-2", folderName: "lease-folder-2",
            files: [file({ path: "/test/lease-folder-2/a.txt", content: "interactive retrieval text" })],
        });
        const withLeaseSpy = vi.spyOn(mainResourceOrchestrator, "withLease");
        mockEmbeddingFor("a live query", [1, 0, 0]);
        await query(indexed.collectionId, "a live query", 8);
        expect(withLeaseSpy).toHaveBeenCalledOnce();
        expect(withLeaseSpy.mock.calls[0][0]).toMatchObject({ workloadKind: "user-rag", priority: "user-interactive" });
    });

    it("a live query still completes rather than deadlocking behind a concurrent background indexing job", async () => {
        // Both now request the single exclusive-accelerator slot (llama.cpp
        // embedding, unlike Ollama's, genuinely contends for it — see
        // embeddingLeaseRequirements() in rag.ts) — so unlike before this
        // removal, these two no longer necessarily run truly concurrently;
        // whichever admits first, the other queues rather than failing. This
        // still checks the property that actually matters here: a background
        // index competing for the same slot must never deadlock or starve a
        // live query out entirely, priority ordering resolves it instead.
        mockEmbeddingFor("concurrent index text", [1, 0, 0]);
        mockEmbeddingFor("concurrent query text", [0, 1, 0]);
        const indexed = await indexTestFolder({
            folderPath: "/test/lease-folder-3", folderName: "lease-folder-3",
            files: [file({ path: "/test/lease-folder-3/seed.txt", content: "seed" })],
        });
        const [, queryResults] = await Promise.all([
            indexTestFolder({
                folderPath: "/test/lease-folder-3", folderName: "lease-folder-3",
                files: [file({ path: "/test/lease-folder-3/seed.txt", content: "seed" }), file({ path: "/test/lease-folder-3/new.txt", content: "concurrent index text" })],
            }),
            query(indexed.collectionId, "concurrent query text", 8),
        ]);
        expect(queryResults).toBeDefined();
    });
});

/**
 * docs/LOCAL_INFERENCE_HARDENING_PLAN.md §2: rag.ts previously called
 * Ollama's /api/embeddings directly with no llama.cpp alternative at all.
 * Ollama is now removed entirely — an unprefixed ref is permanently dead
 * (embed() returns null unconditionally for it), kept only as the shape
 * every value persisted before this removal still has.
 */
describe("parseEmbeddingModelRef", () => {
    it("treats an unprefixed value as an Ollama tag — every value ever stored before llama.cpp support existed", () => {
        expect(parseEmbeddingModelRef("nomic-embed-text")).toEqual({ backend: "ollama", model: "nomic-embed-text" });
    });

    it("parses a llamacpp:-prefixed value into its relative model path", () => {
        expect(parseEmbeddingModelRef("llamacpp:bge-small-en.gguf")).toEqual({ backend: "llamacpp", model: "bge-small-en.gguf" });
    });

    it("preserves subfolder paths after the prefix", () => {
        expect(parseEmbeddingModelRef("llamacpp:pub/Model-GGUF/weights.gguf")).toEqual({
            backend: "llamacpp",
            model: "pub/Model-GGUF/weights.gguf",
        });
    });
});

describe("llama.cpp embedding backend", () => {
    it("indexes and queries a collection using the llama.cpp backend", async () => {
        mockEmbeddingFor("local embedding text", [1, 0, 0]);
        mockEmbeddingFor("local embedding text query", [0.9, 0.1, 0]);
        const indexed = await indexFolder({
            folderPath: "/test/llamacpp-folder", folderName: "llamacpp-folder",
            files: [file({ path: "/test/llamacpp-folder/a.txt", name: "a.txt", content: "local embedding text" })],
            embeddingModel: "llamacpp:bge-small-en.gguf",
        });
        expect(indexed.embedded).toBe(true);
        expect(indexed.embeddingModel).toBe("llamacpp:bge-small-en.gguf");
        expect(llamacpp.embed).toHaveBeenCalled();

        const results = await query(indexed.collectionId, "local embedding text query", 8);
        expect(results[0].source.name).toBe("a.txt");
    });

    it("uses an accelerator-requesting, exclusive lease for llama.cpp embeddings — unlike Ollama's accelerator: none", async () => {
        mockEmbeddingFor("needs a real lease", [1, 0, 0]);
        const withLeaseSpy = vi.spyOn(mainResourceOrchestrator, "withLease");
        await indexFolder({
            folderPath: "/test/llamacpp-lease", folderName: "llamacpp-lease",
            files: [file({ path: "/test/llamacpp-lease/a.txt", content: "needs a real lease" })],
            embeddingModel: "llamacpp:bge-small-en.gguf",
        });
        const [request] = withLeaseSpy.mock.calls[0];
        expect(request.requirements).toMatchObject({ accelerator: "preferred", exclusiveAccelerator: true });
    });

    it("rejects a path-traversal attempt in the embedding model reference", async () => {
        const callsBefore = vi.mocked(llamacpp.embed).mock.calls.length;
        const result = await indexFolder({
            folderPath: "/test/llamacpp-traversal", folderName: "llamacpp-traversal",
            files: [file({ path: "/test/llamacpp-traversal/a.txt", content: "hello" })],
            embeddingModel: "llamacpp:../../evil.gguf",
        });
        expect(result.embedded).toBe(false);
        expect(vi.mocked(llamacpp.embed).mock.calls.length).toBe(callsBefore); // never reached llamacpp.embed — rejected before that
    });
});
