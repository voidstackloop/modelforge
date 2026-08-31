import * as fs from "node:fs";
import { ipcMain, IpcMainInvokeEvent, dialog } from "electron";
import * as settingsStore from "../settings-store";
import * as llamacpp from "../llamacpp-manager";
import * as localServers from "../local-server-manager";
import * as pythonRuntimes from "../python-runtime-manager";
import { getSpecs } from "../system-specs";
import { getMainWindow, requireString, getLlamaCppModelsDir, getLocalRuntimeConfig } from "../app-state";
import { resolveGpuSelection, selectAutomaticGpuCohort, assertVendorHomogeneity, assertTensorParallelSizeMatches, GpuSelectionError, withGpuSelectionErrorEncoding } from "../gpu-selection";
import type { GpuInfo } from "../system-specs";

// Shared by localBackends:start/restart — resolves the persisted selection
// (stable ids) against currently-detected hardware, and fails loudly rather
// than silently starting on a different GPU than the one requested.
async function resolveStartupGpus(backend: localServers.LocalBackendId, normalized: localServers.RuntimeStartupConfig): Promise<GpuInfo[]> {
    // MLX owns placement across Apple unified memory and intentionally has no
    // CUDA/HIP-style device-selection surface in this integration.
    if (backend === "mlx") return [];
    const specs = await getSpecs();
    const resolution = resolveGpuSelection(normalized.gpuSelection, specs.gpus);
    if (resolution.stale) {
        throw new GpuSelectionError(
            "selected_gpu_missing",
            `The GPU selection for ${backend} no longer matches detected hardware (missing: ${resolution.missingIds.join(", ")}).`,
            "Use automatic selection instead, or reselect from the currently detected GPUs.",
        );
    }
    const allowedVendors = backend === "rocm" ? ["amd"] : ["nvidia", "amd"];
    const supportsBackend = (gpu: GpuInfo) => backend === "rocm"
        ? gpu.vendor === "amd" && gpu.capabilities?.rocm === true
        : (gpu.vendor === "nvidia" && gpu.capabilities?.cuda === true)
            || (gpu.vendor === "amd" && gpu.capabilities?.rocm === true);
    const automatic = !normalized.gpuSelection || normalized.gpuSelection.mode === "auto" || normalized.gpuSelection.mode === "all";
    const resolvedGpus = automatic
        ? selectAutomaticGpuCohort(resolution.gpus.filter(supportsBackend), allowedVendors)
        : resolution.gpus;
    const unavailable = resolvedGpus.filter((gpu) => gpu.computeAvailable === false || gpu.displayOnly);
    if (unavailable.length > 0) {
        throw new GpuSelectionError(
            "no_compatible_gpu",
            `The selected GPU device${unavailable.length === 1 ? " is" : "s are"} detected but not compute-available.`,
            "Repair the GPU driver/runtime or choose another detected compute device.",
        );
    }
    const incompatible = resolvedGpus.filter((gpu) => !supportsBackend(gpu));
    if (incompatible.length > 0) {
        throw new GpuSelectionError(
            "unsupported_backend_device",
            `${backend === "vllm" ? "vLLM" : "ROCm llama-server"} cannot use the selected device because its required compute backend was not detected as loadable.`,
            backend === "rocm" ? "Select an AMD GPU with a healthy ROCm runtime." : "Select GPUs with a healthy CUDA or ROCm runtime.",
        );
    }
    if (resolvedGpus.length === 0) {
        throw new GpuSelectionError(
            "no_compatible_gpu",
            `No compatible compute GPU is available for ${backend === "vllm" ? "vLLM" : "ROCm llama-server"}.`,
            backend === "rocm" ? "Verify the AMD driver and ROCm runtime, then refresh hardware detection." : "Verify CUDA or ROCm setup, then refresh hardware detection.",
        );
    }
    if (resolvedGpus.length > 1) assertVendorHomogeneity(resolvedGpus, backend === "vllm" ? "vLLM" : "ROCm llama-server");
    if (backend === "vllm") assertTensorParallelSizeMatches(normalized.tensorParallelSize, resolvedGpus.length);
    return resolvedGpus;
}

function requireBackend(value: unknown): localServers.LocalBackendId {
    if (value !== "mlx" && value !== "rocm" && value !== "vllm") throw new Error("Invalid local runtime backend.");
    return value;
}
const pythonEnvironmentOperations = new Map<string, AbortController>();
const pythonEnvironmentFamilies = new Set<string>();

export function registerLocalRuntimeIpc(): void {
    ipcMain.handle("llamacpp:listModels", () => llamacpp.listModels(getLlamaCppModelsDir()));
    ipcMain.handle("llamacpp:deleteModel", async (_event: IpcMainInvokeEvent, name: string) => {
        await llamacpp.deleteModel(getLlamaCppModelsDir(), requireString(name, "model name"));
    });
    ipcMain.handle("llamacpp:getAvailableGpuBackends", () => llamacpp.getAvailableGpuBackends());
    ipcMain.handle("llamacpp:getModelTotalLayers", async (_event: IpcMainInvokeEvent, name: string) => {
        return llamacpp.getModelTotalLayersByName(getLlamaCppModelsDir(), requireString(name, "model name"));
    });
    ipcMain.handle("llamacpp:getRuntimeInfo", () => llamacpp.getRuntimeInfo());
    ipcMain.handle("localBackends:getStatuses", async () => {
        // Reuses system-specs.ts's own 30s probe cache — this does not spawn
        // an extra nvidia-smi/rocm-smi call on every 5s status poll.
        const specs = await getSpecs();
        return localServers.getRuntimeStatuses(getLocalRuntimeConfig(), specs.gpus);
    });
    ipcMain.handle("localBackends:start", async (_event, { backend: rawBackend, model, startupConfig }: { backend: localServers.LocalBackendId; model: string; startupConfig?: localServers.RuntimeStartupConfig }) => withGpuSelectionErrorEncoding(async () => {
        const backend = requireBackend(rawBackend);
        const validatedModel = localServers.validateRuntimeModel(backend, requireString(model, "runtime model"), getLlamaCppModelsDir());
        const normalized = localServers.normalizeStartupConfig(startupConfig);
        const resolvedGpus = await resolveStartupGpus(backend, normalized);
        return localServers.startServer(backend, validatedModel, getLocalRuntimeConfig(), normalized, resolvedGpus);
    }));
    ipcMain.handle("localBackends:stop", (_event, { backend: rawBackend, force = false }: { backend: localServers.LocalBackendId; force?: boolean }) => localServers.stopServer(requireBackend(rawBackend), force === true));
    ipcMain.handle("localBackends:restart", async (_event, { backend: rawBackend, model, startupConfig }: { backend: localServers.LocalBackendId; model: string; startupConfig?: localServers.RuntimeStartupConfig }) => withGpuSelectionErrorEncoding(async () => {
        const backend = requireBackend(rawBackend);
        const validatedModel = localServers.validateRuntimeModel(backend, requireString(model, "runtime model"), getLlamaCppModelsDir());
        const normalized = localServers.normalizeStartupConfig(startupConfig);
        const resolvedGpus = await resolveStartupGpus(backend, normalized);
        return localServers.restartServer(backend, validatedModel, getLocalRuntimeConfig(), normalized, resolvedGpus);
    }));
    ipcMain.handle("localBackends:clearLogs", (_event, backend: localServers.LocalBackendId) => localServers.clearRuntimeLogs(requireBackend(backend)));
    ipcMain.handle("localBackends:exportLogs", async (_event, backend: localServers.LocalBackendId) => {
        const safeBackend = requireBackend(backend); const status = (await localServers.getRuntimeStatuses(getLocalRuntimeConfig())).find((item) => item.backend === safeBackend);
        const mainWindow = getMainWindow(); const options = { defaultPath: `${safeBackend}-runtime-${new Date().toISOString().replace(/[:.]/g, "-")}.log`, filters: [{ name: "Log files", extensions: ["log", "txt"] }] };
        const result = mainWindow ? await dialog.showSaveDialog(mainWindow, options) : await dialog.showSaveDialog(options);
        if (result.canceled || !result.filePath) return { saved: false };
        fs.writeFileSync(result.filePath, (status?.logs ?? []).join("\n"), "utf8"); return { saved: true };
    });
    ipcMain.handle("pythonRuntimes:getStatuses", () => pythonRuntimes.getPythonEnvironmentStatuses());
    ipcMain.handle("pythonRuntimes:execute", async (event, { requestId, family, operation }: { requestId: string; family: pythonRuntimes.PythonRuntimeFamily; operation: pythonRuntimes.PythonEnvironmentOperation }) => {
        const id = requireString(requestId, "environment operation id");
        if (pythonEnvironmentOperations.has(id)) throw new Error("Environment operation is already running.");
        if (pythonEnvironmentFamilies.has(family)) throw new Error(`An operation for ${family} is already running.`);
        const controller = new AbortController(); pythonEnvironmentOperations.set(id, controller); pythonEnvironmentFamilies.add(family);
        try { return await pythonRuntimes.executePythonEnvironmentOperation(family, operation, (progress) => event.sender.send(`pythonRuntimes:progress:${id}`, progress), controller.signal); }
        finally { pythonEnvironmentOperations.delete(id); pythonEnvironmentFamilies.delete(family); }
    });
    ipcMain.handle("pythonRuntimes:cancel", (_event, requestId: string) => { const id = requireString(requestId, "environment operation id"); pythonEnvironmentOperations.get(id)?.abort(); });

    ipcMain.handle("llamacpp:setGpuBackend", async (_event: IpcMainInvokeEvent, backend: llamacpp.GpuBackend) => {
        await llamacpp.setGpuBackend(backend);
        settingsStore.saveSettings({ llamaCppGpuBackend: backend });
    });
    ipcMain.handle("llamacpp:pickModelsDir", async () => {
        const mainWindow = getMainWindow();
        const result = mainWindow
            ? await dialog.showOpenDialog(mainWindow, { properties: ["openDirectory", "createDirectory"] })
            : await dialog.showOpenDialog({ properties: ["openDirectory", "createDirectory"] });
        if (result.canceled || result.filePaths.length === 0) return null;
        settingsStore.saveSettings({ llamaCppModelsDir: result.filePaths[0] });
        return result.filePaths[0];
    });
}
