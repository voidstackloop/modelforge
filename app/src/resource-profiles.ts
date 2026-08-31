import * as os from "node:os";
import type { ResourceProfile } from "@modelforge/contracts";
import type { ChatOptions } from "./providers/types";

export interface RuntimeGuardrails {
    maxCpuThreads?: number;
    maxBatchSize?: number;
}

interface ProfileDefaults {
    batchSize: number;
    flashAttention: NonNullable<ChatOptions["flashAttention"]>;
    gpuLayerMode: NonNullable<ChatOptions["gpuLayerMode"]>;
    performanceTracking: boolean;
}

const PROFILE_DEFAULTS: Readonly<Record<ResourceProfile, ProfileDefaults>> = {
    interactive: { batchSize: 512, flashAttention: "auto", gpuLayerMode: "auto", performanceTracking: true },
    balanced: { batchSize: 256, flashAttention: "auto", gpuLayerMode: "auto", performanceTracking: true },
    throughput: { batchSize: 1_024, flashAttention: "auto", gpuLayerMode: "auto", performanceTracking: true },
    "energy-efficient": { batchSize: 128, flashAttention: "auto", gpuLayerMode: "auto", performanceTracking: true },
};

/** Applies workload profile defaults, then clamps tunable values to signed
 * local guardrails. Explicit session options are preserved when they are
 * safer than the ceiling; clinical context/max-token values are never
 * silently reduced by a performance profile. */
export function applyRuntimeProfile(options: ChatOptions | undefined, profile: ResourceProfile, guardrails: RuntimeGuardrails = {}): ChatOptions {
    const defaults = PROFILE_DEFAULTS[profile];
    const requestedThreads = options?.cpuThreads ?? (profile === "energy-efficient" ? Math.max(1, Math.floor(os.cpus().length / 2)) : undefined);
    const cpuThreads = requestedThreads === undefined ? undefined : Math.max(1, Math.min(requestedThreads, guardrails.maxCpuThreads ?? requestedThreads));
    const requestedBatch = options?.batchSize ?? defaults.batchSize;
    const batchSize = Math.max(1, Math.min(requestedBatch, guardrails.maxBatchSize ?? requestedBatch));
    return { ...defaults, ...options, cpuThreads, batchSize };
}
