import * as fs from "node:fs";
import { ipcMain, IpcMainInvokeEvent, dialog } from "electron";
import * as ollama from "../ollama-manager";
import { logger } from "../logger";
import * as settingsStore from "../settings-store";
import * as llamacpp from "../llamacpp-manager";
import * as localServers from "../local-server-manager";
import * as pythonRuntimes from "../python-runtime-manager";
import { getMainWindow, requireString, getLlamaCppModelsDir, getLocalRuntimeConfig } from "../app-state";

export function registerOllamaIpc(): void {
    ipcMain.handle("ollama:status", () => ollama.isRunning());
    ipcMain.handle("ollama:start", () => ollama.start());
    ipcMain.handle("ollama:stop", () => ollama.stop());
    ipcMain.handle("ollama:listModels", () => ollama.listModels());
    ipcMain.handle("ollama:pickModelsDir", async () => {
        const mainWindow = getMainWindow();
        const result = mainWindow
            ? await dialog.showOpenDialog(mainWindow, { properties: ["openDirectory", "createDirectory"] })
            : await dialog.showOpenDialog({ properties: ["openDirectory", "createDirectory"] });
        return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0];
    });

    ipcMain.handle("ollama:setModelsDir", async (_event: IpcMainInvokeEvent, dir: string | null) => {
        if (dir) {
            requireString(dir, "models directory");
            try {
                fs.mkdirSync(dir, { recursive: true });
                fs.accessSync(dir, fs.constants.W_OK);
            } catch (err) {
                return { error: `Can't use that folder: ${(err as Error).message}` };
            }
        }
        settingsStore.saveSettings({ modelsDir: dir ?? undefined });
        ollama.setModelsDir(dir);
        try {
            return await ollama.restartWithCurrentConfig();
        } catch (err) {
            const error = err as Error;
            logger.error(`Failed to restart Ollama after changing models directory: ${error.message}`);
            return { started: false, error: error.message };
        }
    });

    ipcMain.handle("ollama:deleteModel", (_event: IpcMainInvokeEvent, name: string) =>
        ollama.deleteModel(requireString(name, "model name"))
    );

    ipcMain.handle("llamacpp:listModels", () => llamacpp.listModels(getLlamaCppModelsDir()));
    ipcMain.handle("llamacpp:deleteModel", async (_event: IpcMainInvokeEvent, name: string) => {
        await llamacpp.deleteModel(getLlamaCppModelsDir(), requireString(name, "model name"));
    });
    ipcMain.handle("llamacpp:getAvailableGpuBackends", () => llamacpp.getAvailableGpuBackends());
    ipcMain.handle("localBackends:getStatuses", () => {
        return localServers.getRuntimeStatuses(getLocalRuntimeConfig());
    });
    ipcMain.handle("localBackends:start", (_event, { backend, model }: { backend: localServers.LocalBackendId; model: string }) =>
        localServers.startServer(backend, requireString(model, "runtime model"), getLocalRuntimeConfig())
    );
    ipcMain.handle("localBackends:stop", (_event, backend: localServers.LocalBackendId) => localServers.stopServer(backend));
    ipcMain.handle("localBackends:restart", (_event, { backend, model }: { backend: localServers.LocalBackendId; model: string }) =>
        localServers.restartServer(backend, requireString(model, "runtime model"), getLocalRuntimeConfig())
    );
    ipcMain.handle("localBackends:unload", (_event, backend: localServers.LocalBackendId) => localServers.stopServer(backend));
    ipcMain.handle("pythonRuntimes:getStatuses", () => pythonRuntimes.getPythonEnvironmentStatuses());
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

    ipcMain.handle(
        "ollama:pull",
        async (event: IpcMainInvokeEvent, { requestId, name }: { requestId: string; name: string }) => {
            const channel = `ollama:pull:progress:${requestId}`;
            try {
                await ollama.pullModel(requireString(name, "model name"), (chunk) => event.sender.send(channel, chunk));
                return { done: true };
            } catch (err) {
                logger.error(`Model pull failed for "${name}": ${(err as Error).message}`);
                return { done: true, error: (err as Error).message };
            }
        }
    );
}
