// Serializes memory-intensive local-runtime transitions. Native runtimes do
// their largest, least-recoverable allocations while loading model weights
// and creating the first context; allowing two of those phases to race can
// transiently double VRAM/RAM use even when either plan fits on its own.

export interface InferenceResourceSchedulerState {
    activeOperation: string | null;
    queuedOperations: number;
}

let queueTail: Promise<void> = Promise.resolve();
let activeOperation: string | null = null;
let queuedOperations = 0;

export function getInferenceResourceSchedulerState(): InferenceResourceSchedulerState {
    return { activeOperation, queuedOperations };
}

export async function withInferenceResourceLock<T>(operation: string, task: () => Promise<T>): Promise<T> {
    queuedOperations++;
    const previous = queueTail;
    let release!: () => void;
    queueTail = new Promise<void>((resolve) => { release = resolve; });
    await previous.catch(() => undefined);
    queuedOperations--;
    activeOperation = operation;
    try {
        return await task();
    } finally {
        activeOperation = null;
        release();
    }
}
