import { describe, it, expect, beforeEach, afterEach, afterAll, beforeAll, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
    assertValidGgufFile,
    chat,
    dispose,
    deleteModel,
    getModelTotalLayers,
    groupShardedModels,
    listModels,
    normalizeLlamaCppRuntimeConfig,
    resolveGpuLayers,
    toHistory,
    toLlamaCppFunctions,
    __setFakeLlamaCppNextChatTurnForTests,
    __getFakeLlamaCppChatRequestCountForTests,
    __getFakeLlamaCppContextCreationCountForTests,
    __getFakeLlamaCppLastContextSizeForTests,
} from "./llamacpp-manager";
import type { ChatChunk, ChatMessage } from "./providers/types";

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

    afterEach(async () => {
        await dispose();
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

/**
 * docs/LOCAL_INFERENCE_HARDENING_PLAN.md §4: hasGgufMagic (download-verification.ts)
 * existed but was never called from any production load path — a downloaded-
 * and-verified file was safe, but a GGUF file placed in the models directory
 * by any other means loaded completely unchecked. loadModel() now calls this
 * before ever handing a path to node-llama-cpp; these tests cover the guard
 * directly rather than through chat()'s node-llama-cpp dynamic-import path.
 */
describe("assertValidGgufFile", () => {
    let dir: string;

    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), "llamacpp-magic-test-"));
    });

    it("accepts a file starting with the GGUF magic header", () => {
        const file = path.join(dir, "model.gguf");
        fs.writeFileSync(file, Buffer.concat([Buffer.from("GGUF", "ascii"), Buffer.from([3, 0, 0, 0])]));
        expect(() => assertValidGgufFile(file)).not.toThrow();
    });

    it("rejects a file that doesn't start with the GGUF magic header", () => {
        const file = path.join(dir, "not-a-model.gguf");
        fs.writeFileSync(file, "this is not a real model file");
        expect(() => assertValidGgufFile(file)).toThrow(/GGUF magic header/);
    });

    it("rejects a missing file rather than throwing an unrelated fs error", () => {
        expect(() => assertValidGgufFile(path.join(dir, "missing.gguf"))).toThrow(/GGUF magic header/);
    });
});

/**
 * docs/LOCAL_INFERENCE_HARDENING_PLAN.md §2: llama.cpp previously had no
 * tool-calling support at all (chat() threw unconditionally when `tools`
 * were passed) — the single blocking gap the migration plan named before
 * Ollama could be removed. These cover the two pure mapping functions that
 * make it work; chat() itself isn't tested here, matching this file's own
 * existing convention (node-llama-cpp's dynamic-import loading isn't mocked
 * anywhere in this codebase — chat-dispatch.test.ts covers the dispatch
 * layer by mocking this whole module instead).
 */
describe("toHistory", () => {
    it("maps plain system/user/assistant messages straight across", () => {
        const messages: ChatMessage[] = [
            { role: "system", content: "be helpful" },
            { role: "user", content: "hi" },
            { role: "assistant", content: "hello" },
        ];
        expect(toHistory(messages)).toEqual([
            { type: "system", text: "be helpful" },
            { type: "user", text: "hi" },
            { type: "model", response: ["hello"] },
        ]);
    });

    it("folds an assistant tool call and its later tool-result message into one functionCall history entry", () => {
        const messages: ChatMessage[] = [
            { role: "user", content: "what's the weather?" },
            {
                role: "assistant",
                content: "",
                toolCalls: [{ id: "call-1", name: "get_weather", arguments: { city: "Paris" } }],
            },
            { role: "tool", content: "22C and sunny", toolCallId: "call-1", toolName: "get_weather" },
        ];
        const history = toHistory(messages);

        expect(history).toHaveLength(2); // the assistant + folded tool-call entry, and the user message — the "tool" message contributes no entry of its own
        expect(history[1]).toEqual({
            type: "model",
            response: [
                {
                    type: "functionCall",
                    name: "get_weather",
                    params: { city: "Paris" },
                    result: "22C and sunny",
                },
            ],
        });
    });

    it("includes any assistant text alongside a tool call in the same response array", () => {
        const messages: ChatMessage[] = [
            { role: "user", content: "hi" },
            {
                role: "assistant",
                content: "Let me check that for you.",
                toolCalls: [{ id: "call-1", name: "get_weather", arguments: {} }],
            },
            { role: "tool", content: "sunny", toolCallId: "call-1", toolName: "get_weather" },
        ];
        const history = toHistory(messages);
        const modelTurn = history[1] as { type: "model"; response: unknown[] };
        expect(modelTurn.response[0]).toBe("Let me check that for you.");
    });

    it("handles multiple tool calls in a single assistant turn", () => {
        const messages: ChatMessage[] = [
            { role: "user", content: "hi" },
            {
                role: "assistant",
                content: "",
                toolCalls: [
                    { id: "call-1", name: "get_weather", arguments: { city: "Paris" } },
                    { id: "call-2", name: "get_weather", arguments: { city: "Tokyo" } },
                ],
            },
            { role: "tool", content: "22C", toolCallId: "call-1", toolName: "get_weather" },
            { role: "tool", content: "18C", toolCallId: "call-2", toolName: "get_weather" },
        ];
        const modelTurn = toHistory(messages)[1] as { type: "model"; response: Array<{ result: unknown }> };
        expect(modelTurn.response.map((r) => r.result)).toEqual(["22C", "18C"]);
    });

    it("tolerates a tool call with no matching result message rather than crashing", () => {
        const messages: ChatMessage[] = [
            { role: "user", content: "hi" },
            { role: "assistant", content: "", toolCalls: [{ id: "call-1", name: "get_weather", arguments: {} }] },
        ];
        const modelTurn = toHistory(messages)[1] as { type: "model"; response: Array<{ result: unknown }> };
        expect(modelTurn.response[0].result).toBeNull();
    });

    it("never emits a standalone history item for a tool-role message", () => {
        const messages: ChatMessage[] = [
            { role: "user", content: "hi" },
            { role: "assistant", content: "", toolCalls: [{ id: "call-1", name: "x", arguments: {} }] },
            { role: "tool", content: "result", toolCallId: "call-1", toolName: "x" },
        ];
        const history = toHistory(messages);
        expect(history.every((h) => h.type !== ("tool" as never))).toBe(true);
        expect(history).toHaveLength(2);
    });
});

describe("toLlamaCppFunctions", () => {
    it("maps name/description/properties and forces additionalProperties true", () => {
        const result = toLlamaCppFunctions([
            {
                name: "get_weather",
                description: "Gets the current weather for a city",
                parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
            },
        ]);
        expect(result).toEqual({
            get_weather: {
                description: "Gets the current weather for a city",
                params: {
                    type: "object",
                    properties: { city: { type: "string" } },
                    additionalProperties: true,
                },
            },
        });
    });

    it("maps multiple tools by name", () => {
        const result = toLlamaCppFunctions([
            { name: "a", description: "tool a", parameters: { type: "object", properties: {} } },
            { name: "b", description: "tool b", parameters: { type: "object", properties: {} } },
        ]);
        expect(Object.keys(result).sort()).toEqual(["a", "b"]);
    });
});

/**
 * docs/LOCAL_INFERENCE_HARDENING_PLAN.md §2.5: the e2e test seam
 * (e2e/fixtures/fake-llamacpp.ts) drives this exact same fake module —
 * these tests exercise chat() itself for real (model loading, the resource-
 * orchestrator lease, streaming, tool-calling) without needing Electron or a
 * display, proving the seam actually drives real business logic rather than
 * just existing on paper. The e2e spec built on top of this
 * (e2e/tests/llamacpp-chat.spec.ts) additionally proves the UI/IPC layer,
 * but could not be executed in this sandbox (no display server) — this describe
 * block is the part of that verification that could actually be run here.
 */
describe("chat() end-to-end via the fake node-llama-cpp module", () => {
    let dir: string;
    let modelPath: string;

    // Every test here acquires mainResourceOrchestrator's real exclusive-
    // accelerator lease for real (see this describe block's own top comment
    // on why that's deliberate, not something to mock away). vitest.config.ts's
    // global 20s default (unchanged for every other file) was never
    // actually exercised on a real CI runner before this describe block's
    // very first run against a real release build — a macOS runner's lower
    // core count and/or first-call hardware-detection latency measurably
    // exceeded it. Not independently reproduced locally (no macOS access in
    // this environment); widening the budget here is the safe fix
    // regardless of which of those it turns out to be, and doesn't change
    // what's actually being verified.
    beforeAll(() => vi.setConfig({ testTimeout: 60_000 }));
    afterAll(() => vi.setConfig({ testTimeout: 20_000 }));

    beforeEach(() => {
        process.env.MODELFORGE_E2E_FAKE_LLAMACPP = "1";
        dir = fs.mkdtempSync(path.join(os.tmpdir(), "llamacpp-fake-chat-test-"));
        modelPath = path.join(dir, "fake-model.gguf");
        fs.writeFileSync(modelPath, Buffer.concat([Buffer.from("GGUF", "ascii"), Buffer.from([3, 0, 0, 0])]));
    });

    afterAll(() => {
        delete process.env.MODELFORGE_E2E_FAKE_LLAMACPP;
    });

    it("streams tokens through onToken exactly like a real generation would", async () => {
        __setFakeLlamaCppNextChatTurnForTests({ tokens: ["Hello", " world"], delayMs: 0 });
        const chunks: ChatChunk[] = [];
        await chat(modelPath, [{ role: "user", content: "hi" }], undefined, (c) => chunks.push(c));

        const text = chunks.map((c) => c.message?.content ?? "").join("");
        expect(text).toBe("Hello world");
        expect(chunks[chunks.length - 1].done).toBe(true);
    });

    it("reuses a warm context for a matching follow-up in the same conversation", async () => {
        const contextsBefore = __getFakeLlamaCppContextCreationCountForTests();
        __setFakeLlamaCppNextChatTurnForTests({ tokens: ["Hello"], delayMs: 0 });
        await chat(modelPath, [{ role: "user", content: "hi" }], undefined, () => {}, undefined, undefined, "active-inference", "turn-1", "session-1");
        const contextsAfterFirstTurn = __getFakeLlamaCppContextCreationCountForTests();

        __setFakeLlamaCppNextChatTurnForTests({ tokens: ["Fast follow-up"], delayMs: 0 });
        await chat(modelPath, [
            { role: "user", content: "hi" },
            { role: "assistant", content: "Hello" },
            { role: "user", content: "and now?" },
        ], undefined, () => {}, undefined, undefined, "active-inference", "turn-2", "session-1");

        expect(contextsAfterFirstTurn).toBe(contextsBefore + 1);
        expect(__getFakeLlamaCppContextCreationCountForTests()).toBe(contextsAfterFirstTurn);
    });

    it("rebuilds context when persisted history no longer matches the warm conversation", async () => {
        __setFakeLlamaCppNextChatTurnForTests({ tokens: ["Original"], delayMs: 0 });
        await chat(modelPath, [{ role: "user", content: "hi" }], undefined, () => {}, undefined, undefined, "active-inference", "turn-1", "session-2");
        const contextsAfterFirstTurn = __getFakeLlamaCppContextCreationCountForTests();

        __setFakeLlamaCppNextChatTurnForTests({ tokens: ["Rebuilt"], delayMs: 0 });
        await chat(modelPath, [
            { role: "user", content: "edited prompt" },
            { role: "assistant", content: "different answer" },
            { role: "user", content: "continue" },
        ], undefined, () => {}, undefined, undefined, "active-inference", "turn-2", "session-2");

        expect(__getFakeLlamaCppContextCreationCountForTests()).toBe(contextsAfterFirstTurn + 1);
    });

    it("returns a tool call through the same onToken contract every other provider uses", async () => {
        const requestCountBefore = __getFakeLlamaCppChatRequestCountForTests();
        __setFakeLlamaCppNextChatTurnForTests({ toolCall: { name: "get_weather", arguments: { city: "Paris" } }, delayMs: 0 });
        const chunks: ChatChunk[] = [];
        await chat(
            modelPath,
            [{ role: "user", content: "weather?" }],
            undefined,
            (c) => chunks.push(c),
            undefined,
            [{ name: "get_weather", description: "gets the weather", parameters: { type: "object", properties: { city: { type: "string" } } } }]
        );

        const toolCallChunk = chunks.find((c) => c.toolCalls && c.toolCalls.length > 0);
        expect(toolCallChunk?.toolCalls?.[0]).toMatchObject({ name: "get_weather", arguments: { city: "Paris" } });
        expect(chunks[chunks.length - 1].done).toBe(true);
        expect(__getFakeLlamaCppChatRequestCountForTests()).toBe(requestCountBefore + 1);
    });

    it("grows the context past a too-small configured contextLength to fit large tool definitions", async () => {
        __setFakeLlamaCppNextChatTurnForTests({ tokens: ["ok"], delayMs: 0 });
        const bigDescription = "x".repeat(2000); // ~500 tokens at the fake tokenizer's ~4 chars/token
        await chat(
            modelPath,
            [{ role: "user", content: "hi" }],
            { contextLength: 50 },
            () => {},
            undefined,
            [{ name: "big_tool", description: bigDescription, parameters: { type: "object", properties: {} } }]
        );

        const usedContextSize = __getFakeLlamaCppLastContextSizeForTests();
        expect(usedContextSize).not.toBe(50);
        expect(typeof usedContextSize === "number" && usedContextSize > 50).toBe(true);
        expect(typeof usedContextSize === "number" && usedContextSize <= 8192).toBe(true);
    });

    it("throws a clear, actionable error instead of an opaque one when tools can't fit even the model's max context", async () => {
        const hugeDescription = "x".repeat(40_000); // ~10,000 tokens — past the fake model's 8192 trainContextSize
        await expect(
            chat(
                modelPath,
                [{ role: "user", content: "hi" }],
                undefined,
                () => {},
                undefined,
                [{ name: "huge_tool", description: hugeDescription, parameters: { type: "object", properties: {} } }]
            )
        ).rejects.toThrow(/need roughly .* tokens of context, but this model supports at most 8192/);
    });

    it("propagates an abort through the fake module the same way a real generation would", async () => {
        const controller = new AbortController();
        __setFakeLlamaCppNextChatTurnForTests({ tokens: ["a", "b", "c", "d", "e"], delayMs: 20 });
        const promise = chat(modelPath, [{ role: "user", content: "hi" }], undefined, () => {}, controller.signal);
        setTimeout(() => controller.abort(), 25);

        await expect(promise).rejects.toBeTruthy();
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

describe("getModelTotalLayers", () => {
    afterEach(() => {
        delete process.env.MODELFORGE_E2E_FAKE_LLAMACPP;
    });

    it("resolves via the fake module without touching a real backend", async () => {
        process.env.MODELFORGE_E2E_FAKE_LLAMACPP = "1";
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "llamacpp-total-layers-test-"));
        const modelPath = path.join(dir, "fake-model.gguf");
        fs.writeFileSync(modelPath, Buffer.concat([Buffer.from("GGUF", "ascii"), Buffer.from([3, 0, 0, 0])]));
        await expect(getModelTotalLayers(modelPath)).resolves.toBe(32);
    });

    // Real GGUF header parsing needs a real GGUF file — readGgufFileInfo
    // can't do anything useful with the 8-byte magic-only stub the fake-module
    // tests above use. Points at whatever this machine's own real
    // llamaCppModelsDir already has (a real user's downloaded models, not a
    // repo fixture) rather than shipping a multi-hundred-MB model file in the
    // repo — skips cleanly on any other machine, matching this codebase's own
    // describe.skipIf(!DATABASE_URL) convention for real-resource-dependent
    // tests.
    const realModelPath = path.join(os.homedir(), ".config", "app", "llamacpp-models", "Llama-3.2-1B-Instruct.IQ1_M.gguf");
    describe.skipIf(!fs.existsSync(realModelPath))("against a real downloaded GGUF file", () => {
        it("reads a real, plausible layer count from the actual file header", async () => {
            const totalLayers = await getModelTotalLayers(realModelPath);
            // Llama 3.2 1B has 16 transformer blocks + this codebase's own
            // +1 for the output layer (see node-llama-cpp's GgufInsights) —
            // asserting a broad, sane range rather than the exact number so
            // this doesn't silently start failing against a different build
            // of node-llama-cpp's insight calculation.
            expect(totalLayers).toBeGreaterThan(0);
            expect(totalLayers).toBeLessThan(200);
        });
    });
});
