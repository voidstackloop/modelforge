// Compatibility facade for existing local-runtime call sites. Admission is
// owned by the central ResourceOrchestrator; this wrapper keeps the former
// API while llama.cpp and external local-server launch paths migrate to typed
// workload requests incrementally.
import { mainResourceOrchestrator } from "./resource-orchestrator";
import type { ResourceRequirements, ResourceTelemetry } from "./resource-contracts";

export interface InferenceResourceSchedulerState {
    activeOperation: string | null;
    queuedOperations: number;
}

let activeOperation: string | null = null;
let queuedOperations = 0;

export function getInferenceResourceSchedulerState(): InferenceResourceSchedulerState {
    return { activeOperation, queuedOperations };
}

export function getInferenceResourceTelemetry(): ResourceTelemetry {
    return mainResourceOrchestrator.getTelemetry();
}

export function shutdownInferenceResourceScheduler(): void {
    mainResourceOrchestrator.shutdown();
}

/**
 * `requirementsOverride` lets a caller that actually knows the model's size
 * (llamacpp-manager.ts, via model-fit-estimator.ts) declare real ramMB/
 * vramMB instead of the 0/0 placeholder every other caller here still uses.
 * Item 4: "Do not silently place two heavyweight models on one GPU" needs
 * the orchestrator's own RAM/VRAM budget to see honest numbers — a
 * declared 0 lets two large loads both get admitted concurrently no matter
 * how much memory either actually needs.
 */
export async function withInferenceResourceLock<T>(
    operation: string,
    task: () => Promise<T>,
    requirementsOverride?: Partial<ResourceRequirements>
): Promise<T> {
    queuedOperations++;
    let admitted = false;
    try {
        return await mainResourceOrchestrator.withLease({
            workloadKind: "model-load",
            priority: "explicit-model-load",
            requirements: {
                cpuThreads: 1,
                ramMB: 0,
                accelerator: "preferred",
                allowCpuFallback: true,
                exclusiveAccelerator: true,
                ...requirementsOverride,
            },
        }, async () => {
            admitted = true;
            queuedOperations--;
            activeOperation = operation;
            try {
                return await task();
            } finally {
                activeOperation = null;
            }
        });
    } finally {
        // Admission failures and shutdown cancellation happen before the task
        // callback gets a chance to decrement the queued count.
        if (!admitted) queuedOperations = Math.max(0, queuedOperations - 1);
    }
}
