import { describe, it, expect, beforeEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { deleteModel, groupShardedModels, listModels, normalizeLlamaCppRuntimeConfig, resolveGpuLayers } from "./llamacpp-manager";

describe("resolveGpuLayers", () => {
    it("reserves VRAM for the user's requested context in automatic mode", () => {
        expect(resolveGpuLayers("auto", undefined, 32_768)).toEqual({ fitContext: { contextSize: 32_768 } });
    });

    it("keeps CPU, all-layer, and manual modes distinct", () => {
        expect(resolveGpuLayers("cpu", undefined, 8_192)).toBe(0);
        expect(resolveGpuLayers("max", undefined, 8_192)).toBe("max");
        expect(resolveGpuLayers("manual", 24, 8_192)).toBe(24);
    });
});

describe("groupShardedModels", () => {
    it("leaves a normal single-file model untouched", () => {
        const result = groupShardedModels([{ name: "llama-3.2-3b.gguf", path: "/m/llama-3.2-3b.gguf", sizeBytes: 100 }]);
        expect(result).toEqual([
            { name: "llama-3.2-3b.gguf", label: "llama-3.2-3b.gguf", path: "/m/llama-3.2-3b.gguf", sizeBytes: 100 },
        ]);
    });

    it("merges a multi-part model into a single labeled entry using the first shard as the loadable path", () => {
        const result = groupShardedModels([
            { name: "Qwen3-Coder-Next-Q6_K-00002-of-00002.gguf", path: "/m/part2.gguf", sizeBytes: 25_109_299 },
            { name: "Qwen3-Coder-Next-Q6_K-00001-of-00002.gguf", path: "/m/part1.gguf", sizeBytes: 38_883_345 },
        ]);
        expect(result).toEqual([
            {
                name: "Qwen3-Coder-Next-Q6_K-00001-of-00002.gguf",
                label: "Qwen3-Coder-Next-Q6_K.gguf (2 parts)",
                path: "/m/part1.gguf",
                sizeBytes: 25_109_299 + 38_883_345,
            },
        ]);
    });

    it("uses the lowest present part as the representative when part 1 is missing", () => {
        const result = groupShardedModels([
            { name: "model-00002-of-00003.gguf", path: "/m/p2.gguf", sizeBytes: 10 },
            { name: "model-00003-of-00003.gguf", path: "/m/p3.gguf", sizeBytes: 10 },
        ]);
        expect(result[0].name).toBe("model-00002-of-00003.gguf");
        expect(result[0].label).toBe("model.gguf (2 parts)");
    });

    it("keeps unrelated models and shard groups separate", () => {
        const result = groupShardedModels([
            { name: "other.gguf", path: "/m/other.gguf", sizeBytes: 5 },
            { name: "a-00001-of-00002.gguf", path: "/m/a1.gguf", sizeBytes: 1 },
            { name: "a-00002-of-00002.gguf", path: "/m/a2.gguf", sizeBytes: 1 },
        ]);
        expect(result).toHaveLength(2);
        expect(result.map((m) => m.name).sort()).toEqual(["a-00001-of-00002.gguf", "other.gguf"]);
    });
});

describe("listModels", () => {
    let dir: string;

    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), "llamacpp-models-test-"));
    });

    it("returns an empty list when the directory doesn't exist", () => {
        expect(listModels(path.join(dir, "missing"))).toEqual([]);
    });

    it("ignores incomplete .gguf.part downloads", () => {
        fs.writeFileSync(path.join(dir, "finished.gguf"), "x".repeat(10));
        fs.writeFileSync(path.join(dir, "still-downloading.gguf.part"), "x".repeat(3));
        const names = listModels(dir).map((m) => m.name);
        expect(names).toEqual(["finished.gguf"]);
    });

    it("finds models nested in publisher/model subfolders, e.g. LM Studio's layout", () => {
        const modelDir = path.join(dir, "bartowski", "Some-Model-GGUF");
        fs.mkdirSync(modelDir, { recursive: true });
        fs.writeFileSync(path.join(modelDir, "some-model.gguf"), "x".repeat(20));
        const models = listModels(dir);
        expect(models).toHaveLength(1);
        expect(models[0].name).toBe("bartowski/Some-Model-GGUF/some-model.gguf");
        expect(models[0].sizeBytes).toBe(20);
    });

    it("groups shards separately per subfolder instead of merging same-named shards across models", () => {
        const dirA = path.join(dir, "pub", "Model-A-GGUF");
        const dirB = path.join(dir, "pub", "Model-B-GGUF");
        fs.mkdirSync(dirA, { recursive: true });
        fs.mkdirSync(dirB, { recursive: true });
        fs.writeFileSync(path.join(dirA, "weights-00001-of-00002.gguf"), "x");
        fs.writeFileSync(path.join(dirA, "weights-00002-of-00002.gguf"), "x");
        fs.writeFileSync(path.join(dirB, "weights-00001-of-00002.gguf"), "x");
        fs.writeFileSync(path.join(dirB, "weights-00002-of-00002.gguf"), "x");
        const models = listModels(dir);
        expect(models).toHaveLength(2);
        expect(models.map((m) => m.name).sort()).toEqual([
            "pub/Model-A-GGUF/weights-00001-of-00002.gguf",
            "pub/Model-B-GGUF/weights-00001-of-00002.gguf",
        ]);
    });
});

describe("deleteModel", () => {
    let dir: string;

    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), "llamacpp-delete-test-"));
    });

    it("deletes every shard of a multi-part model, not just the representative one", async () => {
        fs.writeFileSync(path.join(dir, "big-00001-of-00002.gguf"), "x");
        fs.writeFileSync(path.join(dir, "big-00002-of-00002.gguf"), "x");
        await deleteModel(dir, "big-00001-of-00002.gguf");
        expect(fs.readdirSync(dir)).toEqual([]);
    });

    it("rejects a path-traversal attempt", async () => {
        await expect(deleteModel(dir, "../evil.gguf")).rejects.toThrow(/Invalid model file name/);
    });

    it("deletes a model nested in a subfolder, and only its own shards", async () => {
        const modelDir = path.join(dir, "pub", "Model-GGUF");
        fs.mkdirSync(modelDir, { recursive: true });
        fs.writeFileSync(path.join(modelDir, "weights-00001-of-00002.gguf"), "x");
        fs.writeFileSync(path.join(modelDir, "weights-00002-of-00002.gguf"), "x");
        const otherDir = path.join(dir, "pub", "Other-GGUF");
        fs.mkdirSync(otherDir, { recursive: true });
        fs.writeFileSync(path.join(otherDir, "weights-00001-of-00002.gguf"), "x");

        await deleteModel(dir, "pub/Model-GGUF/weights-00001-of-00002.gguf");

        expect(fs.readdirSync(modelDir)).toEqual([]);
        expect(fs.readdirSync(otherDir)).toEqual(["weights-00001-of-00002.gguf"]);
    });

    it("rejects a traversal attempt disguised inside a subfolder path", async () => {
        await expect(deleteModel(dir, "pub/../../evil.gguf")).rejects.toThrow(/Invalid model file name/);
    });
});

describe("llama.cpp runtime configuration", () => {
    it("keeps memory reserves enabled and bounds thread counts", () => {
        expect(normalizeLlamaCppRuntimeConfig({
            maxThreads: 10_000,
            vramReserveBytes: 2 * 1024 ** 3,
            ramReserveBytes: 4 * 1024 ** 3,
            numa: "auto",
        })).toEqual({
            maxThreads: 512,
            vramReserveBytes: 2 * 1024 ** 3,
            ramReserveBytes: 4 * 1024 ** 3,
            numa: "auto",
        });
    });

    it("rejects unsafe or malformed reserve and NUMA values", () => {
        expect(() => normalizeLlamaCppRuntimeConfig({ vramReserveBytes: -1 })).toThrow(/non-negative/);
        expect(() => normalizeLlamaCppRuntimeConfig({ numa: "invalid" as never })).toThrow(/NUMA/);
    });
});
