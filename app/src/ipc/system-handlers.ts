import { ipcMain, IpcMainInvokeEvent } from "electron";
import { logger } from "../logger";
import * as systemSpecs from "../system-specs";
import * as settingsStore from "../settings-store";
import * as llamacpp from "../llamacpp-manager";
import * as localServers from "../local-server-manager";
import * as mcpClient from "../mcp-client";
import * as energyUsageStore from "../energy-usage-store";
import * as powerMonitor from "../power-monitor";
import type * as benchmarkRunner from "../benchmark-runner";
import { runBenchmark } from "../benchmark-runner";
import { requireString, activeBenchmarkRequests, getEnergyMonitorSettings } from "../app-state";
import { dispatchChat } from "../chat-dispatch";
import { saveBenchmarkResult, getBenchmarkObservations, getLastBenchmarkResult, exportDiagnosticReport } from "../benchmark-persistence";

export function registerSystemIpc(): void {
    ipcMain.handle("system:getSpecs", () => systemSpecs.getSpecs());
    ipcMain.handle("system:getRecommendations", async () => {
        const specs = await systemSpecs.getSpecs();
        const settings = settingsStore.getSettings();
        return systemSpecs.recommendModelsWithML(specs, { contextLength: settings.contextLength, quantization: "Q4_K_M", runtime: settings.preferredRuntime ?? "automatic", goal: settings.recommendationGoal ?? "balanced" }, getBenchmarkObservations());
    });
    ipcMain.handle("system:assessGgufFiles", async (_event, rawInputs: unknown) => {
        if (!Array.isArray(rawInputs) || rawInputs.length > 200) throw new Error("Expected at most 200 GGUF files.");
        const inputs = rawInputs.map((value) => {
            if (!value || typeof value !== "object") throw new Error("Invalid GGUF assessment input.");
            const input = value as Record<string, unknown>;
            const modelId = requireString(input.modelId, "Hugging Face model id");
            const filename = requireString(input.filename, "GGUF filename");
            const sizeBytes = input.sizeBytes === null ? null : Number(input.sizeBytes);
            if (sizeBytes !== null && (!Number.isFinite(sizeBytes) || sizeBytes < 0)) throw new Error("Invalid GGUF file size.");
            return { modelId, filename, sizeBytes };
        });
        const specs = await systemSpecs.getSpecs();
        const settings = settingsStore.getSettings();
        return systemSpecs.assessGgufFiles(specs, inputs, settings.contextLength);
    });
    ipcMain.handle("system:getActivity", async () => {
        const mem = process.memoryUsage();
        return {
            llamacppLoadedModels: llamacpp.listLoadedModels(),
            localBackendServers: localServers.getRunningBackends(),
            mcpServers: mcpClient.getServerStatuses(),
            memory: { rssMB: +(mem.rss / 1e6).toFixed(1), heapUsedMB: +(mem.heapUsed / 1e6).toFixed(1) },
        };
    });

    ipcMain.handle(
        "benchmark:run",
        async (
            _event: IpcMainInvokeEvent,
            { requestId, request }: { requestId: string; request: benchmarkRunner.BenchmarkRequest }
        ) => {
            requireString(requestId, "benchmark request id");
            requireString(request?.provider, "benchmark provider");
            requireString(request?.model, "benchmark model");
            const controller = new AbortController();
            activeBenchmarkRequests.set(requestId, controller);
            try {
                const result = await runBenchmark(
                    (provider, model, messages, options, onToken, signal) =>
                        dispatchChat(provider, model, messages, options, onToken, signal),
                    request,
                    controller.signal
                );
                saveBenchmarkResult(result);
                return { result };
            } catch (error) {
                if ((error as Error).name === "AbortError") return { aborted: true };
                logger.error(`Benchmark failed (provider=${request.provider}, model=${request.model}): ${(error as Error).message}`);
                return { error: (error as Error).message };
            } finally {
                activeBenchmarkRequests.delete(requestId);
            }
        }
    );
    ipcMain.handle("benchmark:cancel", (_event: IpcMainInvokeEvent, requestId: string) => {
        activeBenchmarkRequests.get(requireString(requestId, "benchmark request id"))?.abort();
    });
    ipcMain.handle("benchmark:getLast", () => getLastBenchmarkResult());
    ipcMain.handle("benchmark:exportReport", (_event: IpcMainInvokeEvent, result: benchmarkRunner.BenchmarkResult) =>
        exportDiagnosticReport(result)
    );
    ipcMain.handle("energy:getDashboard", () => powerMonitor.getDashboard(getEnergyMonitorSettings()));
    ipcMain.handle("energy:clearHistory", () => {
        energyUsageStore.clearRecords();
        return { success: true };
    });
}
