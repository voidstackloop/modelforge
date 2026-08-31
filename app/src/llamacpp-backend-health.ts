import * as path from "node:path";
import { app } from "electron";
import { z } from "zod";
import { readJsonWithSchema, writeJson } from "./json-store";
import type { GpuBackend } from "./llamacpp-manager";

/**
 * Crash-loop breaker for llama.cpp GPU backend initialization
 * (llamacpp-manager.ts's getLlamaInstance()). A broken Vulkan/CUDA driver
 * stack (common under WSL/VMs, but not only there) can make node-llama-cpp's
 * *real* (non-dry-run) backend initialization crash the entire Electron
 * process with SIGILL/SIGSEGV — a hardware trap the OS delivers directly,
 * which no in-process try/catch, Promise rejection, or even a native
 * exception handler can intercept. The existing dry-run probe
 * (getAvailableGpuBackends/probeGpuBackend) does not reliably catch this: on
 * the one real report that motivated this file, the dry-run probe for
 * "vulkan" succeeded at startup, and only the later *real* generation-time
 * initialization crashed. Isolating the real initialization in a subprocess
 * would be the fully robust fix, but is a much larger architectural change
 * than this file attempts.
 *
 * What this DOES do: remember, across process restarts, whether the last
 * attempt to really initialize a given backend ever confirmed success. If
 * the process died before confirming, the file written just before the
 * attempt survives (writeJson's write-temp-then-rename is atomic, so a
 * crash mid-write can't corrupt it, and a crash *after* the write but before
 * confirmation leaves exactly the "unconfirmed" record this depends on).
 * main.ts's startup sequence checks this before automatically re-applying a
 * persisted GPU backend setting — see resolveStartupGpuBackend below.
 *
 * Deliberately scoped to the *automatic* startup path only, not to
 * llamacpp-manager.ts's setGpuBackend() itself: a user explicitly picking a
 * backend again via Settings (e.g. after updating a driver) should always
 * get to retry it, never be silently blocked by a past crash. This file
 * only stops the app from *automatically* walking back into the same crash
 * on every future launch without the user ever finding out why.
 */

const healthFileSchema = z.object({
    backend: z.string(),
    confirmed: z.boolean(),
});
type BackendHealth = z.infer<typeof healthFileSchema>;

function filePath(): string {
    return path.join(app.getPath("userData"), "llamacpp-backend-health.json");
}

/** Call immediately before the real (non-dry-run) getLlama() initialization
 * — see llamacpp-manager.ts's getLlamaInstance(). */
export function markBackendAttemptStarting(backend: GpuBackend): void {
    writeJson(filePath(), { backend, confirmed: false } satisfies BackendHealth);
}

/** Call immediately after that initialization resolves without crashing the
 * process — reaching this line at all is the actual signal of success; if
 * the process had crashed instead, this would simply never run and the
 * "confirmed: false" record from markBackendAttemptStarting would persist
 * for resolveStartupGpuBackend to find on the next launch. */
export function markBackendAttemptConfirmed(backend: GpuBackend): void {
    writeJson(filePath(), { backend, confirmed: true } satisfies BackendHealth);
}

/**
 * The one function main.ts's startup sequence should call instead of using
 * the persisted `llamaCppGpuBackend` setting directly. Downgrades to "cpu"
 * — the one backend value that never touches GPU/Vulkan/CUDA detection code
 * at all (see llamacpp-manager.ts's getLlamaInstance(): `gpu: false` for
 * "cpu") — only when the health record shows an unconfirmed attempt for
 * this *exact* configured backend value (including the literal string
 * "auto": a crash while configured for "auto" is remembered and guarded
 * against the same way a crash under an explicitly-named backend is,
 * without this module ever needing to know which concrete backend
 * node-llama-cpp's own auto-detection actually picked internally).
 */
export function resolveStartupGpuBackend(configuredBackend: GpuBackend): GpuBackend {
    const health = readJsonWithSchema<BackendHealth | null>(filePath(), null, healthFileSchema.nullable());
    if (health && health.backend === configuredBackend && !health.confirmed) {
        return "cpu";
    }
    return configuredBackend;
}
