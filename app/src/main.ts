import * as path from "node:path";
import * as fs from "node:fs";
import { app, BrowserWindow, ipcMain, IpcMainInvokeEvent, dialog, shell, desktopCapturer } from "electron";
import * as ollama from "./ollama-manager";
import { logger, getLogPath, getLogTail } from "./logger";
import * as systemSpecs from "./system-specs";
import * as settingsStore from "./settings-store";
import type { PromptPreset } from "./settings-store";
import * as sessionsStore from "./sessions-store";
import * as projectsStore from "./projects-store";
import * as fileReader from "./file-reader";
import * as secretsStore from "./secrets-store";
import * as dataTransfer from "./data-transfer";
import * as rag from "./rag";
import * as agentTools from "./agent-tools";
import * as mcpClient from "./mcp-client";
import * as figma from "./figma";
import * as ocr from "./ocr";
import * as huggingface from "./huggingface";
import * as llamacpp from "./llamacpp-manager";
import type { McpServerConfig } from "./mcp-client";
import type { AttachedFile } from "./file-reader";
import * as openaiProvider from "./providers/openai";
import * as anthropicProvider from "./providers/anthropic";
import { setupMenu } from "./menu";
import { setupAutoUpdater, checkForUpdatesManually } from "./updater";
import type { ChatMessage, ChatChunk, ChatOptions, ProviderId } from "./providers/types";

const PROVIDER_SECRET_KEYS: Record<Exclude<ProviderId, "ollama" | "llamacpp">, string> = {
    openai: "openai_api_key",
    anthropic: "anthropic_api_key",
};

const activeChatRequests = new Map<string, AbortController>();
let isBusy = false;
let forceClose = false;

// Every ipcMain.handle callback below is only reachable from this app's own
// preload-bridged renderer (contextIsolation is on, nodeIntegration is off),
// so this isn't a hostile-input boundary in the way a public API would be.
// Still, a malformed/undefined argument reaching a store function as `id`
// would throw a raw TypeError several layers deep — validating up front
// turns that into one clear, loggable error instead.
function requireString(value: unknown, label: string): string {
    if (typeof value !== "string" || !value) {
        throw new Error(`Invalid ${label}: expected a non-empty string`);
    }
    return value;
}

function getLlamaCppModelsDir(): string {
    const configured = settingsStore.getSettings().llamaCppModelsDir;
    const dir = configured || path.join(app.getPath("userData"), "llamacpp-models");
    fs.mkdirSync(dir, { recursive: true });
    return dir;
}

// Without these, an unexpected error anywhere in the main process (a bad file
// parse, a network hiccup, a third-party library throwing) would crash the
// entire app instead of just failing the one operation that triggered it.
process.on("uncaughtException", (err) => {
    logger.error(`Uncaught exception in main process: ${err.stack ?? err.message}`);
});
process.on("unhandledRejection", (reason) => {
    logger.error(`Unhandled rejection in main process: ${reason instanceof Error ? (reason.stack ?? reason.message) : String(reason)}`);
});

// Chromium's GPU process crashes on some virtualized/software-rendered setups
// (WSLg, some VMs, remote desktops). Set DISABLE_GPU=1 to work around the
// fatal "GPU process isn't usable" shutdown on those hosts.
if (process.env.DISABLE_GPU === "1") {
    app.disableHardwareAcceleration();
}

let mainWindow: BrowserWindow | null = null;

function createWindow(): void {
    // Reset so a fresh window (e.g. re-created via macOS "activate" after all
    // windows closed) gets its own busy-quit confirmation instead of
    // inheriting a stale bypass from a previously confirmed close.
    forceClose = false;
    isBusy = false;

    mainWindow = new BrowserWindow({
        width: 1280,
        height: 820,
        minWidth: 820,
        minHeight: 560,
        backgroundColor: "#171717",
        resizable: true,
        show: false,
        title: "Modelforge",
        icon: path.join(__dirname, "../build/icon.png"),
        webPreferences: {
            preload: path.join(__dirname, "preload.js"),
            contextIsolation: true,
            nodeIntegration: false,
        },
    });

    // Start maximized (normal windowed maximize, not OS-level fullscreen/kiosk
    // mode) so the app makes good use of the screen by default while still
    // keeping window controls, the taskbar, and free resizing available.
    mainWindow.once("ready-to-show", () => {
        mainWindow?.maximize();
        mainWindow?.show();
    });

    mainWindow.on("close", (event) => {
        if (isBusy && !forceClose) {
            event.preventDefault();
            dialog
                .showMessageBox(mainWindow!, {
                    type: "question",
                    buttons: ["Quit", "Cancel"],
                    defaultId: 1,
                    cancelId: 1,
                    title: "Response still generating",
                    message: "A response is still generating. Quit anyway?",
                })
                .then(({ response }) => {
                    if (response === 0) {
                        forceClose = true;
                        mainWindow?.close();
                    }
                });
        }
    });

    // Chat content can contain links (from the user or from a model's output).
    // Without this, clicking one would either silently do nothing or open an
    // unmanaged Electron window; instead hand it to the OS's default browser
    // and keep every window in this app on our own trusted content only.
    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
        shell.openExternal(url);
        return { action: "deny" };
    });
    mainWindow.webContents.on("will-navigate", (event, url) => {
        const currentUrl = mainWindow?.webContents.getURL() ?? "";
        const sameOrigin = (() => {
            try {
                return new URL(url).origin === new URL(currentUrl).origin;
            } catch {
                return false;
            }
        })();
        if (!sameOrigin) {
            event.preventDefault();
            shell.openExternal(url);
        }
    });

    if (!app.isPackaged) {
        mainWindow.loadURL("http://localhost:5173");
    } else {
        // extraResources (electron-builder) copies frontend/dist to resources/frontend-dist.
        mainWindow.loadFile(path.join(process.resourcesPath, "frontend-dist", "index.html"));
    }
}

function registerIpcHandlers(): void {
    ipcMain.handle("ollama:status", () => ollama.isRunning());
    ipcMain.handle("ollama:start", () => ollama.start());
    ipcMain.handle("ollama:stop", () => ollama.stop());
    ipcMain.handle("ollama:listModels", () => ollama.listModels());
    ipcMain.handle("ollama:pickModelsDir", async () => {
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
    ipcMain.handle("llamacpp:deleteModel", (_event: IpcMainInvokeEvent, name: string) => {
        llamacpp.deleteModel(getLlamaCppModelsDir(), requireString(name, "model name"));
    });
    ipcMain.handle("llamacpp:getAvailableGpuBackends", () => llamacpp.getAvailableGpuBackends());
    ipcMain.handle("llamacpp:setGpuBackend", (_event: IpcMainInvokeEvent, backend: llamacpp.GpuBackend) => {
        llamacpp.setGpuBackend(backend);
        settingsStore.saveSettings({ llamaCppGpuBackend: backend });
    });
    ipcMain.handle("llamacpp:pickModelsDir", async () => {
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

    ipcMain.handle(
        "chat:send",
        async (
            event: IpcMainInvokeEvent,
            {
                requestId,
                provider,
                model,
                messages,
                options,
                agentMode,
            }: {
                requestId: string;
                provider: ProviderId;
                model: string;
                messages: ChatMessage[];
                options?: ChatOptions;
                agentMode?: boolean;
            }
        ) => {
            const channel = `chat:chunk:${requestId}`;
            const onToken = (chunk: ChatChunk) => event.sender.send(channel, chunk);
            const controller = new AbortController();
            activeChatRequests.set(requestId, controller);
            const tools = agentMode ? [...agentTools.AGENT_TOOLS, ...mcpClient.getConnectedTools()] : undefined;
            try {
                if (provider === "ollama") {
                    await ollama.chat(model, messages, options, onToken, controller.signal, tools);
                } else if (provider === "llamacpp") {
                    const modelPath = path.join(getLlamaCppModelsDir(), model);
                    await llamacpp.chat(modelPath, messages, options, onToken, controller.signal, tools);
                } else {
                    const secretKey = PROVIDER_SECRET_KEYS[provider];
                    const apiKey = secretsStore.getSecret(secretKey);
                    if (!apiKey) {
                        throw new Error(`No API key set for ${provider}. Add one in Settings.`);
                    }
                    const providerFn = provider === "openai" ? openaiProvider.chat : anthropicProvider.chat;
                    await providerFn(apiKey, model, messages, options, onToken, controller.signal, tools);
                }
                return { done: true };
            } catch (err) {
                const error = err as Error;
                if (error.name === "AbortError") {
                    return { done: true, aborted: true };
                }
                logger.error(`Chat request failed (provider=${provider}, model=${model}): ${error.message}`);
                return { done: true, error: error.message };
            } finally {
                activeChatRequests.delete(requestId);
            }
        }
    );

    ipcMain.handle("chat:cancel", (_event: IpcMainInvokeEvent, requestId: string) => {
        activeChatRequests.get(requestId)?.abort();
    });

    ipcMain.handle("system:getSpecs", () => systemSpecs.getSpecs());
    ipcMain.handle("system:getRecommendations", async () => {
        const specs = await systemSpecs.getSpecs();
        return systemSpecs.recommendModels(specs);
    });

    ipcMain.handle("settings:get", () => settingsStore.getSettings());
    ipcMain.handle("settings:save", (_event: IpcMainInvokeEvent, partial) => {
        const saved = settingsStore.saveSettings(partial);
        if (partial.ollamaHost !== undefined) ollama.setHost(saved.ollamaHost);
        return saved;
    });

    ipcMain.handle("sessions:list", () => sessionsStore.listSessions());
    ipcMain.handle("sessions:get", (_event: IpcMainInvokeEvent, id: string) =>
        sessionsStore.getSession(requireString(id, "session id"))
    );
    ipcMain.handle(
        "sessions:create",
        (_event: IpcMainInvokeEvent, { model, projectId }: { model: string | null; projectId?: string | null }) =>
            sessionsStore.createSession(model, projectId ?? null)
    );
    ipcMain.handle("sessions:update", (_event: IpcMainInvokeEvent, { id, partial }) =>
        sessionsStore.updateSession(requireString(id, "session id"), partial)
    );
    ipcMain.handle("sessions:delete", (_event: IpcMainInvokeEvent, id: string) =>
        sessionsStore.deleteSession(requireString(id, "session id"))
    );
    ipcMain.handle("sessions:clearAll", () => sessionsStore.clearAll());

    ipcMain.handle("projects:list", () => projectsStore.listProjects());
    ipcMain.handle("projects:create", (_event: IpcMainInvokeEvent, name: string) =>
        projectsStore.createProject(requireString(name, "project name"))
    );
    ipcMain.handle("projects:update", (_event: IpcMainInvokeEvent, { id, partial }) =>
        projectsStore.updateProject(requireString(id, "project id"), partial)
    );
    ipcMain.handle("projects:delete", (_event: IpcMainInvokeEvent, id: string) => {
        requireString(id, "project id");
        sessionsStore.unassignProject(id);
        projectsStore.deleteProject(id);
    });

    ipcMain.handle("files:openAndRead", () => fileReader.openAndReadFiles(mainWindow));
    ipcMain.handle("files:openFolderAndRead", () => fileReader.openFolderAndRead(mainWindow));
    ipcMain.handle("files:openMedia", () => fileReader.openAndReadMedia(mainWindow));

    ipcMain.handle("secrets:has", (_event: IpcMainInvokeEvent, key: string) =>
        secretsStore.hasSecret(requireString(key, "secret key"))
    );
    ipcMain.handle("secrets:set", (_event: IpcMainInvokeEvent, { key, value }: { key: string; value: string }) =>
        secretsStore.setSecret(requireString(key, "secret key"), value ?? "")
    );

    ipcMain.handle(
        "audio:transcribe",
        async (_event: IpcMainInvokeEvent, { audioBase64, mimeType }: { audioBase64: string; mimeType: string }) => {
            requireString(audioBase64, "audio data");
            const apiKey = secretsStore.getSecret("openai_api_key");
            if (!apiKey) {
                return { error: "Voice input needs an OpenAI API key — add one in Settings to use it." };
            }
            try {
                const buffer = Buffer.from(audioBase64, "base64");
                const ext = mimeType.includes("webm") ? "webm" : mimeType.includes("ogg") ? "ogg" : "wav";
                const text = await openaiProvider.transcribeAudio(apiKey, buffer, `audio.${ext}`);
                return { text };
            } catch (err) {
                const error = err as Error;
                logger.error(`Audio transcription failed: ${error.message}`);
                return { error: error.message };
            }
        }
    );

    ipcMain.handle("app:setBusy", (_event: IpcMainInvokeEvent, busy: boolean) => {
        isBusy = busy;
    });
    ipcMain.handle("app:getVersion", () => app.getVersion());
    ipcMain.handle("app:checkForUpdates", () => checkForUpdatesManually(() => mainWindow));
    ipcMain.handle("app:getDiagnostics", async () => ({
        appVersion: app.getVersion(),
        electron: process.versions.electron,
        chrome: process.versions.chrome,
        node: process.versions.node,
        platform: process.platform,
        arch: process.arch,
        ollamaHost: ollama.getHost(),
        ollamaRunning: await ollama.isRunning(),
        logTail: getLogTail(),
    }));
    ipcMain.handle("app:openLogsFolder", () => shell.showItemInFolder(getLogPath()));

    ipcMain.handle("data:exportSession", (_event: IpcMainInvokeEvent, id: string) =>
        dataTransfer.exportSession(mainWindow, requireString(id, "session id"))
    );
    ipcMain.handle("data:exportAll", () => dataTransfer.exportAllSessions(mainWindow));
    ipcMain.handle("data:import", () => dataTransfer.importSessions(mainWindow));
    ipcMain.handle("data:getUserDataPath", () => dataTransfer.getUserDataPath());
    ipcMain.handle("data:openUserDataFolder", () => dataTransfer.openUserDataFolder());

    ipcMain.handle("data:exportPromptPresets", (_event: IpcMainInvokeEvent, presets: PromptPreset[]) =>
        dataTransfer.exportPromptPresets(mainWindow, presets ?? [])
    );
    ipcMain.handle("data:importPromptPresets", () => dataTransfer.importPromptPresets(mainWindow));

    ipcMain.handle("rag:indexFiles", (_event: IpcMainInvokeEvent, files: AttachedFile[]) => rag.indexFiles(files));
    ipcMain.handle(
        "rag:query",
        (_event: IpcMainInvokeEvent, { indexId, query, topK }: { indexId: string; query: string; topK?: number }) =>
            rag.query(indexId, query, topK)
    );

    ipcMain.handle("hf:search", async (_event: IpcMainInvokeEvent, query: string) => {
        try {
            return { results: await huggingface.searchGgufModels(String(query ?? "")) };
        } catch (err) {
            return { error: (err as Error).message };
        }
    });

    ipcMain.handle("hf:listFiles", async (_event: IpcMainInvokeEvent, modelId: string) => {
        requireString(modelId, "model id");
        try {
            return { files: await huggingface.listGgufFiles(modelId) };
        } catch (err) {
            return { error: (err as Error).message };
        }
    });

    ipcMain.handle(
        "hf:downloadFile",
        async (
            event: IpcMainInvokeEvent,
            { requestId, modelId, filename }: { requestId: string; modelId: string; filename: string }
        ) => {
            requireString(modelId, "model id");
            requireString(filename, "filename");
            const dir = getLlamaCppModelsDir();
            const destPath = path.join(dir, filename.replace(/[/\\]/g, "_"));
            const channel = `hf:downloadProgress:${requestId}`;
            try {
                await huggingface.downloadGgufFile(modelId, filename, destPath, (progress) =>
                    event.sender.send(channel, progress)
                );
                return { path: destPath };
            } catch (err) {
                const error = err as Error;
                logger.error(`Hugging Face download failed (${modelId}/${filename}): ${error.message}`);
                fs.rmSync(destPath, { force: true });
                return { error: error.message };
            }
        }
    );

    ipcMain.handle("ocr:recognize", async (_event: IpcMainInvokeEvent, imageBase64: string) => {
        requireString(imageBase64, "image data");
        try {
            return { text: await ocr.recognizeText(imageBase64) };
        } catch (err) {
            const error = err as Error;
            logger.error(`OCR failed: ${error.message}`);
            return { error: `OCR failed: ${error.message}` };
        }
    });

    ipcMain.handle("figma:fetchFrame", async (_event: IpcMainInvokeEvent, url: string) => {
        requireString(url, "Figma URL");
        const token = secretsStore.getSecret("figma_token");
        if (!token) return { error: "Add a Figma personal access token in Settings first." };
        try {
            return { result: await figma.fetchFigmaFrameImage(token, url) };
        } catch (err) {
            return { error: (err as Error).message };
        }
    });

    ipcMain.handle("screen:listSources", async () => {
        try {
            const sources = await desktopCapturer.getSources({
                types: ["screen", "window"],
                thumbnailSize: { width: 400, height: 250 },
            });
            return sources.map((s) => ({ id: s.id, name: s.name, thumbnailDataUrl: s.thumbnail.toDataURL() }));
        } catch (err) {
            logger.error(`Failed to list screen capture sources: ${(err as Error).message}`);
            return [];
        }
    });

    ipcMain.handle("screen:capture", async (_event: IpcMainInvokeEvent, sourceId: string) => {
        requireString(sourceId, "source id");
        try {
            // Re-query at full size rather than reusing the small picker
            // thumbnail — sources can also disappear between listing and
            // capture (a window closed, a display disconnected).
            const sources = await desktopCapturer.getSources({
                types: ["screen", "window"],
                thumbnailSize: { width: 2560, height: 1440 },
            });
            const match = sources.find((s) => s.id === sourceId);
            if (!match) return { error: "That screen/window is no longer available." };
            const dataUrl = match.thumbnail.toDataURL();
            const dataBase64 = dataUrl.split(",")[1] ?? "";
            if (!dataBase64) return { error: "Capture returned an empty image." };
            return { dataBase64, mimeType: "image/png" };
        } catch (err) {
            const error = err as Error;
            logger.error(`Screen capture failed: ${error.message}`);
            return { error: error.message };
        }
    });

    ipcMain.handle("agent:pickWorkspace", async () => {
        const result = mainWindow
            ? await dialog.showOpenDialog(mainWindow, { properties: ["openDirectory"] })
            : await dialog.showOpenDialog({ properties: ["openDirectory"] });
        return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0];
    });

    ipcMain.handle(
        "tools:execute",
        async (
            _event: IpcMainInvokeEvent,
            { workspaceRoot, name, args }: { workspaceRoot: string; name: string; args: Record<string, unknown> }
        ) => {
            requireString(workspaceRoot, "workspace root");
            requireString(name, "tool name");
            try {
                const result = mcpClient.isMcpTool(name)
                    ? await mcpClient.callMcpTool(name, args ?? {})
                    : await agentTools.executeTool(workspaceRoot, name, args ?? {});
                return { result };
            } catch (err) {
                const error = err as Error;
                logger.error(`Tool execution failed (tool=${name}): ${error.message}`);
                return { error: error.message };
            }
        }
    );

    ipcMain.handle("agent:rollbackLastWrite", (_event: IpcMainInvokeEvent, workspaceRoot: string) => {
        requireString(workspaceRoot, "workspace root");
        return agentTools.rollbackLastWrite(workspaceRoot);
    });

    ipcMain.handle("agent:detectScripts", (_event: IpcMainInvokeEvent, workspaceRoot: string) => {
        requireString(workspaceRoot, "workspace root");
        return agentTools.detectProjectScripts(workspaceRoot);
    });

    ipcMain.handle("mcp:connect", async (_event: IpcMainInvokeEvent, config: McpServerConfig) => {
        try {
            const { tools } = await mcpClient.connectServer(config);
            return { tools };
        } catch (err) {
            const error = err as Error;
            logger.error(`MCP connect failed (server=${config?.name}): ${error.message}`);
            return { error: error.message };
        }
    });

    ipcMain.handle("mcp:disconnect", (_event: IpcMainInvokeEvent, id: string) => {
        requireString(id, "server id");
        mcpClient.disconnectServer(id);
    });

    ipcMain.handle("mcp:status", () => mcpClient.getServerStatuses());
}

// Best-effort: connect every enabled MCP server on launch so its tools are
// available in Agent mode without the user having to manually reconnect each
// session. A server that fails to start (bad command, unreachable URL) just
// logs and stays disconnected — it doesn't block app startup.
async function connectEnabledMcpServers(): Promise<void> {
    const servers = settingsStore.getSettings().mcpServers ?? [];
    for (const server of servers.filter((s) => s.enabled)) {
        try {
            await mcpClient.connectServer(server);
        } catch (err) {
            logger.error(`MCP server "${server.name}" failed to connect on launch: ${(err as Error).message}`);
        }
    }
}

app.whenReady().then(async () => {
    registerIpcHandlers();
    setupMenu(() => mainWindow, () => checkForUpdatesManually(() => mainWindow));
    createWindow();
    ollama.setHost(settingsStore.getSettings().ollamaHost);
    ollama.setModelsDir(settingsStore.getSettings().modelsDir);
    await ollama.start();
    llamacpp.setGpuBackend(settingsStore.getSettings().llamaCppGpuBackend ?? "auto");
    setupAutoUpdater(() => mainWindow);
    void connectEnabledMcpServers();

    app.on("activate", () => {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
});

app.on("window-all-closed", () => {
    ollama.stop();
    mcpClient.disconnectAll();
    if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
    ollama.stop();
});
