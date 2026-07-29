import { describe, expect, it } from "vitest";
import { approximateTokens, benchmarkPlacementOptions, buildContextPrompt, contextTestSizes, runBenchmark, type BenchmarkChatExecutor } from "./benchmark-runner";

describe("benchmark helpers", () => {
    it("builds bounded power-of-two context steps plus an exact cap", () => {
        expect(contextTestSizes(10_000)).toEqual([2048, 4096, 8192, 10_000]);
        expect(contextTestSizes(100)).toEqual([2048]);
    });

    it("creates approximately the requested prompt size", () => {
        const prompt = buildContextPrompt(4096);
        expect(approximateTokens(prompt)).toBeGreaterThan(4000);
        expect(approximateTokens(prompt)).toBeLessThan(5200);
    });

    it("uses explicit safe placement modes instead of a magic GPU layer sentinel", () => {
        expect(benchmarkPlacementOptions("default")).toEqual({});
        expect(benchmarkPlacementOptions("cpu")).toEqual({ gpuLayerMode: "cpu", gpuLayers: 0 });
        expect(benchmarkPlacementOptions("gpu")).toEqual({ gpuLayerMode: "max" });
        expect(JSON.stringify(benchmarkPlacementOptions("gpu"))).not.toContain("999");
    });

    it("returns health, timing, comparison and context results", async () => {
        const execute: BenchmarkChatExecutor = async (_provider, _model, messages, _options, onToken) => {
            if (messages[0].content.startsWith("Context capacity")) return;
            onToken({ done: false, message: { role: "assistant", content: "benchmark output" } });
            onToken({ done: true, usage: { promptTokens: 20, completionTokens: 4 } });
        };
        const result = await runBenchmark(execute, {
            provider: "ollama",
            model: "test",
            maxContextLength: 4096,
            compareCpuGpu: true,
        });
        expect(result.health.healthy).toBe(true);
        expect(result.primary?.completionTokens).toBe(4);
        expect(result.comparison.supported).toBe(true);
        expect(result.contextTests).toHaveLength(2);
    });
});
