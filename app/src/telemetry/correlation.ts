import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";

// Ambient correlation-id propagation for call sites where threading an id
// through every function argument (what download-worker.ts does with the
// download job's own id, mirroring lib/src/manager.rs's job_id threading)
// isn't practical — e.g. a future chat/inference call chain crossing many
// intermediate async functions. Node's own AsyncLocalStorage propagates
// across `await` boundaries and into functions spawned from within
// `withCorrelation`'s callback without any explicit passing, and correctly
// isolates concurrent operations (two overlapping withCorrelation() calls
// each see only their own id, including inside interleaved async work).
//
// Not used by the downloads slice itself — a download job already has a
// natural, existing id (JobEvent.jobId) that's simpler and more direct to
// pass explicitly. This exists as tested, reusable foundation for the call
// sites that don't have that luxury.
const storage = new AsyncLocalStorage<string>();

export function newCorrelationId(): string {
    return randomUUID();
}

/** Runs `fn` with `correlationId` available to getCorrelationId() for the
 * duration of `fn` and everything it awaits/spawns — including nested
 * withCorrelation() calls, which see the innermost id while active. */
export function withCorrelation<T>(correlationId: string, fn: () => T): T {
    return storage.run(correlationId, fn);
}

/** The correlation id of the innermost active withCorrelation() call on this
 * async execution path, or undefined outside of one. */
export function getCorrelationId(): string | undefined {
    return storage.getStore();
}
