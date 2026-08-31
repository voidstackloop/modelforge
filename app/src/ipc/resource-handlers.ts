import { ipcMain } from "electron";
import { mainResourceOrchestrator } from "../resource-orchestrator";

/**
 * Read-only telemetry for the Runtime Manager's Workloads view (item 7's
 * "sanitized snapshots and explanations through validated IPC" — there is
 * nothing to validate on the way IN since this channel takes no arguments,
 * and ResourceTelemetry is PHI-safe by construction: it carries only
 * workload-kind enums, numeric capacity, and lease/queue bookkeeping, never
 * prompt content, file paths, or model output (see resource-orchestrator.ts's
 * own getTelemetry(), which already strips requestId from active leases).
 *
 * There is deliberately no channel here that lets the renderer acquire or
 * release a lease directly, or override a budget/priority — "the renderer
 * must never directly start unrestricted workers or override enforced
 * safety limits." Every actual workload is scheduled from the main process
 * at the call site that does the real work (chat-dispatch.ts, rag.ts,
 * ocr.ts, etc.), never in response to a renderer-originated resource
 * command.
 */
export function registerResourceIpc(): void {
    ipcMain.handle("resource:getTelemetry", () => mainResourceOrchestrator.getTelemetry());
}
