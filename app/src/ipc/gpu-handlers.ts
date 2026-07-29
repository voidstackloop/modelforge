import { ipcMain } from "electron";
import { getSpecs, refreshGpuTopology } from "../system-specs";
import { getGpuTelemetry } from "../gpu-telemetry";
import { resolveGpuSelection, type GpuSelection } from "../gpu-selection";
import { gpuSelectionSchema, parseOrThrow } from "../schemas";

// GPU inventory/topology itself rides along on the existing `system:getSpecs`
// channel (SystemSpecs.gpus / gpuTopology) — these are the additional,
// GPU-specific operations: an explicit manual refresh (bypassing the probe
// TTL), live per-device telemetry, and a selection-resolution preview the UI
// uses to warn about a stale/incompatible selection before it's saved.
export function registerGpuIpc(): void {
    ipcMain.handle("gpu:refreshTopology", async () => {
        refreshGpuTopology();
        return getSpecs();
    });

    ipcMain.handle("gpu:getTelemetry", () => getGpuTelemetry());

    ipcMain.handle("gpu:resolveSelection", async (_event, rawSelection: unknown) => {
        const selection = parseOrThrow(gpuSelectionSchema, rawSelection, "GPU selection") as GpuSelection;
        const specs = await getSpecs();
        return resolveGpuSelection(selection, specs.gpus);
    });
}
