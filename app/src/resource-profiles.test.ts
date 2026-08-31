import { describe, expect, it } from "vitest";
import { applyRuntimeProfile } from "./resource-profiles";

describe("applyRuntimeProfile", () => {
    it("uses an interactive prefill profile without reducing context or output limits", () => {
        expect(applyRuntimeProfile({ contextLength: 16_384, maxTokens: 2_048 }, "interactive")).toMatchObject({ contextLength: 16_384, maxTokens: 2_048, batchSize: 512, gpuLayerMode: "auto", performanceTracking: true });
    });
    it("clamps local choices to centrally managed CPU and batch guardrails", () => {
        expect(applyRuntimeProfile({ cpuThreads: 32, batchSize: 2_048 }, "throughput", { maxCpuThreads: 8, maxBatchSize: 512 })).toMatchObject({ cpuThreads: 8, batchSize: 512 });
    });
    it("keeps an explicit safer value below the central ceiling", () => {
        expect(applyRuntimeProfile({ cpuThreads: 4, batchSize: 128 }, "interactive", { maxCpuThreads: 8, maxBatchSize: 512 })).toMatchObject({ cpuThreads: 4, batchSize: 128 });
    });
});
