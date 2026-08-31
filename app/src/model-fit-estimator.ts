import * as fs from "node:fs";
import * as path from "node:path";
import { getSpecs, assessGgufFiles, type GgufAssessment, type RecommendationOutcome, type SystemSpecs } from "./system-specs";

/**
 * Item 6: "Before loading a model, return: Can run comfortably / Can run
 * with reduced context/batch/offload / CPU-only fallback / Cannot run
 * safely." This is a thin adapter over assessGgufFiles' own weight/KV-cache/
 * runtime-overhead math (system-specs.ts) — not a second, parallel
 * estimator — mapping its five-way RecommendationOutcome onto the four-way
 * verdict language item 6 asks for, and splitting its single
 * totalRequiredGB into the RAM-vs-VRAM shares a resource-orchestrator lease
 * request actually needs (item 2's WorkloadRequest.requirements).
 */
export type ModelFitVerdict = "comfortable" | "degraded" | "cpu-fallback" | "unsafe" | "unknown";

const OUTCOME_TO_VERDICT: Record<RecommendationOutcome | "Unknown size", ModelFitVerdict> = {
    "Runs fully on GPU": "comfortable",
    "Runs with partial offload": "degraded",
    "CPU-only but usable": "cpu-fallback",
    // Neither outcome is safe on the single-primary-accelerator admission
    // model this orchestrator uses today (item 5: "support one primary GPU
    // lease at a time" for the first production version) — a model that
    // needs tensor parallelism across GPUs this codebase doesn't yet
    // schedule for is exactly as unsafe here as one that's simply too big.
    "Requires tensor parallelism": "unsafe",
    "Likely out of memory": "unsafe",
    "Unknown size": "unknown",
};

export interface ModelFitResult {
    verdict: ModelFitVerdict;
    assessment: GgufAssessment;
    /** RAM a model-load lease should request. Deliberately conservative:
     * covers everything NOT counted in estimatedVramMB (non-offloaded
     * weights, KV cache, runtime overhead) rather than trying to split KV
     * cache placement precisely — this codebase has no authoritative
     * signal on where node-llama-cpp actually places KV cache for a given
     * offload configuration, and overestimating RAM (the safe direction:
     * more conservative admission, never a silent underestimate that risks
     * OOM) is preferable to guessing wrong in the other direction. */
    estimatedRamMB: number;
    estimatedVramMB: number;
}

/** Known, disclosed limitation: `sizeBytes` comes from a single stat() of
 * `modelPath` — the representative first shard for a multi-part GGUF model
 * (see llamacpp-manager.ts's groupShardedModels), not the sum of every
 * shard. This under-estimates total size for sharded models specifically;
 * the common single-file GGUF case is unaffected. */
export async function estimateModelFit(
    modelPath: string,
    options: { contextLength?: number; specs?: SystemSpecs } = {}
): Promise<ModelFitResult> {
    const [specs, sizeBytes] = await Promise.all([
        options.specs ? Promise.resolve(options.specs) : getSpecs(),
        fs.promises.stat(modelPath).then((stat) => stat.size).catch(() => null),
    ]);
    const [assessment] = assessGgufFiles(specs, [{ modelId: modelPath, filename: path.basename(modelPath), sizeBytes }], options.contextLength);
    const verdict = OUTCOME_TO_VERDICT[assessment.outcome] ?? "unknown";

    if (!assessment.canAssess || assessment.totalRequiredGB === null || assessment.estimatedWeightGB === null) {
        // Unknown size — never invent a number; a zeroed requirement is the
        // pre-existing behavior this replaces for the not-yet-estimable
        // case, not a regression.
        return { verdict, assessment, estimatedRamMB: 0, estimatedVramMB: 0 };
    }

    const offloadFraction = (assessment.expectedGpuOffloadPercent ?? 0) / 100;
    const canUseGpu = verdict === "comfortable" || verdict === "degraded";
    const vramGB = canUseGpu ? assessment.estimatedWeightGB * offloadFraction : 0;
    const ramGB = Math.max(0, assessment.totalRequiredGB - vramGB);

    return {
        verdict,
        assessment,
        estimatedRamMB: Math.round(ramGB * 1024),
        estimatedVramMB: Math.round(vramGB * 1024),
    };
}
