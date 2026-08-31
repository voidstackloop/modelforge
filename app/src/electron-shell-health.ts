import * as path from "node:path";
import { app } from "electron";
import { z } from "zod";
import { readJsonWithSchema, writeJson } from "./json-store";

/**
 * Crash-loop breaker for Electron/Chromium's OWN GPU-acceleration and
 * OS-level sandbox subsystems — not node-llama-cpp's model-inference GPU
 * backend (see llamacpp-backend-health.ts for that; a separate subsystem
 * with its own crash history). Disabling either of these here never affects
 * AI inference GPU usage or the AI agent's tool-execution sandbox
 * (sandboxMaxMemoryMB) — both of those are independent mechanisms.
 *
 * On some virtualized/software-rendered hosts (WSL/WSLg in particular, some
 * VMs, remote desktops, some CI containers) Chromium's GPU process or its
 * sandboxed renderer process can crash the entire Electron process with an
 * uncatchable SIGILL/SIGTRAP before any window opens or any application log
 * line prints — the same kind of hardware trap documented in
 * llamacpp-backend-health.ts. There is no way to detect a broken host ahead
 * of time short of actually trying to launch with both protections on.
 *
 * Both GPU acceleration and the OS sandbox stay ON by default on every
 * launch on every machine — this module never disables them by default and
 * never changes that default. It only remembers, across process restarts on
 * THIS machine, whether the most recently attempted configuration ever
 * reached a confirmed-working signal (main.ts calls
 * markShellAttemptConfirmed from the main window's "ready-to-show" event —
 * the earliest point at which the renderer, and therefore the GPU/sandbox
 * subsystems, are known to have started without crashing the process). If a
 * full-protection attempt crashed before confirming, the next launch falls
 * back to disabling both; once a configuration is confirmed working, later
 * launches keep using it, so a host that's already settled into safe mode
 * won't re-attempt (and re-crash into) full mode on every single launch.
 * Deleting this file, or fixing the underlying driver/environment issue and
 * clearing it, gives full mode another try.
 */

export interface ShellSafetyConfig {
    gpuAccelerationEnabled: boolean;
    sandboxEnabled: boolean;
}

export const FULL_SHELL_SAFETY: ShellSafetyConfig = { gpuAccelerationEnabled: true, sandboxEnabled: true };
export const SAFE_SHELL_SAFETY: ShellSafetyConfig = { gpuAccelerationEnabled: false, sandboxEnabled: false };

const shellHealthSchema = z.object({
    gpuAccelerationEnabled: z.boolean(),
    sandboxEnabled: z.boolean(),
    confirmed: z.boolean(),
});
type ShellHealth = z.infer<typeof shellHealthSchema>;

function filePath(): string {
    return path.join(app.getPath("userData"), "electron-shell-health.json");
}

/** Call as early as possible — before app.disableHardwareAcceleration()/
 * app.commandLine.appendSwitch("no-sandbox") are conditionally applied in
 * main.ts — with whatever config resolveStartupShellSafety just decided. */
export function markShellAttemptStarting(config: ShellSafetyConfig): void {
    writeJson(filePath(), { ...config, confirmed: false } satisfies ShellHealth);
}

/** Call once the process is known to have survived the danger window (the
 * main window's "ready-to-show" event in main.ts) — reaching this line at
 * all is the actual signal of success; a crash instead simply never runs
 * it, leaving the "confirmed: false" record for the next launch to find. */
export function markShellAttemptConfirmed(config: ShellSafetyConfig): void {
    writeJson(filePath(), { ...config, confirmed: true } satisfies ShellHealth);
}

/**
 * The one function main.ts's startup sequence should call to decide this
 * launch's GPU-acceleration/sandbox configuration. Always resolves to full
 * protection when there's no history yet. Downgrades to fully-safe only
 * when the persisted record shows a *full-protection* attempt that never
 * confirmed; otherwise replays whatever configuration last confirmed (or,
 * on the floor case where even safe mode hasn't confirmed yet, keeps
 * retrying safe mode — there is nothing safer left to fall back to).
 */
export function resolveStartupShellSafety(): ShellSafetyConfig {
    const health = readJsonWithSchema<ShellHealth | null>(filePath(), null, shellHealthSchema.nullable());
    if (!health) {
        return FULL_SHELL_SAFETY;
    }
    if (!health.confirmed && health.gpuAccelerationEnabled && health.sandboxEnabled) {
        return SAFE_SHELL_SAFETY;
    }
    return { gpuAccelerationEnabled: health.gpuAccelerationEnabled, sandboxEnabled: health.sandboxEnabled };
}
