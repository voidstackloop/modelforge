import * as path from "node:path";
import * as fs from "node:fs";
import { pathToFileURL } from "node:url";
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
import { detectSandboxCapabilities } from "./command-sandbox";
import * as mcpClient from "./mcp-client";
import * as figma from "./figma";
import * as ocr from "./ocr";
import * as huggingface from "./huggingface";
import * as accounts from "./accounts";
import * as llamacpp from "./llamacpp-manager";
import * as scheduledTasksStore from "./scheduled-tasks-store";
import * as scheduler from "./scheduler";
import * as localServers from "./local-server-manager";
import type { McpServerConfig } from "./mcp-client";
import type { AttachedFile } from "./file-reader";
import * as openaiProvider from "./providers/openai";
import * as anthropicProvider from "./providers/anthropic";
import * as geminiProvider from "./providers/gemini";
import { createOpenAiCompatibleChat } from "./providers/openai-compatible";
import { setupMenu } from "./menu";
import { setupAutoUpdater, checkForUpdatesManually } from "./updater";
import type { ChatMessage, ChatChunk, ChatOptions, ProviderId, ToolDefinition } from "./providers/types";

const PROVIDER_SECRET_KEYS: Record<Exclude<ProviderId, "ollama" | "llamacpp" | "custom" | "mlx" | "rocm" | "vllm">, string> = {
    openai: "openai_api_key",
    anthropic: "anthropic_api_key",
    gemini: "gemini_api_key",
};

function customProviderSecretKey(customProviderId: string): string {
    return `custom_${customProviderId}_api_key`;
}

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

    // The app's one legitimate page — loaded via this exact URL below, so
    // will-navigate can tell "the app reloading itself" apart from
    // "something is trying to navigate away" by exact match, rather than by
    // comparing .origin. Comparing .origin doesn't work here:
    // packaged builds load over file:, and *every* file: URL reports
    // origin "null", so two completely unrelated local files would compare
    // as "same origin" and be allowed to navigate straight through.
    const homeUrl = app.isPackaged
        ? pathToFileURL(path.join(process.resourcesPath, "frontend-dist", "index.html")).href
        : "http://localhost:5173/";

    // Only http(s) ever gets handed to the OS — chat content can contain
    // arbitrary links (from the user or from a model's output), and hitting
    // shell.openExternal() with whatever protocol it happens to be would let
    // a crafted file:, custom-scheme, or OS-handler URL launch an unintended
    // local application or open an arbitrary local file.
    function isSafeExternalUrl(url: string): boolean {
        try {
            const protocol = new URL(url).protocol;
            return protocol === "http:" || protocol === "https:";
        } catch {
            return false;
        }
    }

    // Chat content can contain links. Without this, clicking one would
    // either silently do nothing or open an unmanaged Electron window;
    // instead hand safe links to the OS's default browser and keep this
    // window on the app's own content only.
    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
        if (isSafeExternalUrl(url)) shell.openExternal(url);
        return { action: "deny" };
    });
    mainWindow.webContents.on("will-navigate", (event, url) => {
        if (url === homeUrl) return;
        event.preventDefault();
        if (isSafeExternalUrl(url)) shell.openExternal(url);
    });

    // Loading homeUrl itself here (rather than loadFile(), which builds its
    // own file: URL independently) guarantees this is byte-identical to what
    // will-navigate compares against above — any discrepancy between the two
    // encodings (e.g. a non-ASCII character in the install path) would make
    // the app's own initial load fail the exact-match check and get blocked.
    // extraResources (electron-builder) copies frontend/dist to resources/frontend-dist.
    mainWindow.loadURL(homeUrl);
}

// Shared by chat:send (renderer-driven, streams tokens back over IPC) and
// the scheduled-task runner (background, wants the full text once done) —
// same provider dispatch and error handling either way.
async function dispatchChat(
    provider: ProviderId,
    model: string,
    messages: ChatMessage[],
    options: ChatOptions | undefined,
    onToken: (chunk: ChatChunk) => void,
    signal?: AbortSignal,
    tools?: ToolDefinition[]
): Promise<void> {
    if (provider === "ollama") {
        await ollama.chat(model, messages, options, onToken, signal, tools);
    } else if (provider === "llamacpp") {
        // Same containment rule as the rocm branch below: the model ref is a
        // renderer-supplied relative path (may include subfolders), and
        // path.join would happily walk ".." segments out of the models dir.
        const root = path.resolve(getLlamaCppModelsDir());
        const modelPath = path.resolve(root, model);
        if (modelPath === root || !modelPath.startsWith(root + path.sep)) {
            throw new Error(`Model file "${model}" is outside the models directory.`);
        }
        await llamacpp.chat(modelPath, messages, options, onToken, signal, tools);
    } else if (provider === "mlx" || provider === "rocm" || provider === "vllm") {
        const settings = settingsStore.getSettings();
        // ROCm serves the same GGUF files as the llama.cpp backend, so the
        // model ref is a filename that must stay inside the models dir; MLX
        // models are HF repo ids the server resolves itself.
        let serverModel = model;
        if (provider === "rocm") {
            const root = path.resolve(getLlamaCppModelsDir());
            const resolved = path.resolve(root, model);
            // Was `resolved !== root && !startsWith(...)` (AND) — that only
            // threw when BOTH conditions held, so a ref resolving to exactly
            // the models dir itself (e.g. "rocm:.") satisfied neither and
            // slipped through, handing the whole directory to llama-server
            // -m as if it were a single model file.
            if (resolved === root || !resolved.startsWith(root + path.sep)) {
                throw new Error(`Model file "${model}" is outside the models directory.`);
            }
            serverModel = resolved;
        }
        const lease = await localServers.acquireServer(provider, serverModel, {
            mlxPythonPath: settings.mlxPythonPath,
            rocmServerPath: settings.rocmServerPath,
            vllmCommand: settings.vllmCommand,
        });
        try {
            // Managed runtimes are local and unauthenticated; the key is a
            // compatibility placeholder for their OpenAI-shaped APIs.
            const providerLabel = provider === "mlx" ? "MLX" : provider === "vllm" ? "vLLM" : "ROCm llama-server";
            await createOpenAiCompatibleChat(`${lease.baseUrl}/v1`, providerLabel)(
                "local",
                model,
                messages,
                options,
                onToken,
                signal,
                tools
            );
        } finally {
            lease.release();
        }
    } else if (provider === "custom") {
        // model is "<customProviderId>::<actual model id>" — see
        // frontend/src/lib/providers.ts's formatCustomModelRef.
        const sep = model.indexOf("::");
        if (sep === -1) throw new Error(`Malformed custom model reference: ${model}`);
        const customProviderId = model.slice(0, sep);
        const actualModel = model.slice(sep + 2);
        const config = settingsStore.getSettings().customProviders?.find((p) => p.id === customProviderId);
        if (!config) throw new Error(`Custom provider "${customProviderId}" is no longer configured.`);
        const apiKey = secretsStore.getSecret(customProviderSecretKey(customProviderId));
        if (!apiKey && !config.localGpuBackend) throw new Error(`No API key set for ${config.name}. Add one in Settings.`);
        await createOpenAiCompatibleChat(config.baseUrl, config.name)(
            apiKey ?? "local-gpu-backend",
            actualModel,
            messages,
            options,
            onToken,
            signal,
            tools
        );
    } else {
        const secretKey = PROVIDER_SECRET_KEYS[provider];
        const apiKey = secretsStore.getSecret(secretKey);
        if (!apiKey) throw new Error(`No API key set for ${provider}. Add one in Settings.`);
        const providerFn =
            provider === "openai" ? openaiProvider.chat : provider === "anthropic" ? anthropicProvider.chat : geminiProvider.chat;
        await providerFn(apiKey, model, messages, options, onToken, signal, tools);
    }
}

// Runs a single-turn prompt to completion and returns the full text —
// what the scheduled-task runner needs, as opposed to chat:send's
// token-by-token streaming back to the renderer.
async function completePrompt(provider: ProviderId, model: string, prompt: string): Promise<string> {
    let text = "";
    await dispatchChat(provider, model, [{ role: "user", content: prompt }], undefined, (chunk) => {
        text += chunk.message?.content ?? "";
    });
    return text;
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
    ipcMain.handle("llamacpp:deleteModel", async (_event: IpcMainInvokeEvent, name: string) => {
        await llamacpp.deleteModel(getLlamaCppModelsDir(), requireString(name, "model name"));
    });
    ipcMain.handle("llamacpp:getAvailableGpuBackends", () => llamacpp.getAvailableGpuBackends());
    ipcMain.handle("localBackends:getStatuses", () => {
        const settings = settingsStore.getSettings();
        return localServers.getRuntimeStatuses({
            mlxPythonPath: settings.mlxPythonPath,
            rocmServerPath: settings.rocmServerPath,
            vllmCommand: settings.vllmCommand,
        });
    });
    ipcMain.handle("llamacpp:setGpuBackend", async (_event: IpcMainInvokeEvent, backend: llamacpp.GpuBackend) => {
        await llamacpp.setGpuBackend(backend);
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
                await dispatchChat(provider, model, messages, options, onToken, controller.signal, tools);
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
    ipcMain.handle("system:getActivity", async () => {
        const ollamaRunning = await ollama.isRunning();
        const ollamaLoadedModels = ollamaRunning
            ? await ollama.listRunningModels().catch(() => [])
            : [];
        const mem = process.memoryUsage();
        return {
            ollamaRunning,
            ollamaLoadedModels,
            llamacppLoadedModels: llamacpp.listLoadedModels(),
            localBackendServers: localServers.getRunningBackends(),
            mcpServers: mcpClient.getServerStatuses(),
            memory: { rssMB: +(mem.rss / 1e6).toFixed(1), heapUsedMB: +(mem.heapUsed / 1e6).toFixed(1) },
        };
    });

    ipcMain.handle("settings:get", () => settingsStore.getSettings());
    ipcMain.handle("settings:save", (_event: IpcMainInvokeEvent, partial) => {
        const saved = settingsStore.saveSettings(partial);
        if (partial.ollamaHost !== undefined) ollama.setHost(saved.ollamaHost);
        if (partial.llamaCppMaxCachedModels !== undefined) llamacpp.setModelCacheLimit(saved.llamaCppMaxCachedModels ?? 2);
        if (partial.keybindings !== undefined) {
            setupMenu(() => mainWindow, () => checkForUpdatesManually(() => mainWindow), saved.keybindings);
        }
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

    ipcMain.handle("scheduledTasks:list", () => scheduledTasksStore.listTasks());

    ipcMain.handle(
        "scheduledTasks:create",
        (
            _event: IpcMainInvokeEvent,
            {
                name,
                prompt,
                model,
                intervalMinutes,
            }: { name: string; prompt: string; model: string; intervalMinutes: number }
        ) => {
            requireString(name, "task name");
            requireString(prompt, "task prompt");
            requireString(model, "task model");
            // Each task gets a dedicated chat session it appends results to —
            // created here so the task always has somewhere to write to.
            const session = sessionsStore.createSession(model);
            sessionsStore.updateSession(session.id, { title: name });
            const task = scheduledTasksStore.createTask({
                name,
                prompt,
                model,
                targetSessionId: session.id,
                intervalMinutes: Math.max(1, intervalMinutes || 60),
            });
            scheduler.rescheduleAll();
            return task;
        }
    );

    ipcMain.handle(
        "scheduledTasks:update",
        (_event: IpcMainInvokeEvent, { id, partial }: { id: string; partial: Record<string, unknown> }) => {
            requireString(id, "task id");
            const updated = scheduledTasksStore.updateTask(id, partial);
            scheduler.rescheduleAll();
            return updated;
        }
    );

    ipcMain.handle("scheduledTasks:delete", (_event: IpcMainInvokeEvent, id: string) => {
        requireString(id, "task id");
        scheduledTasksStore.deleteTask(id);
        scheduler.rescheduleAll();
    });

    ipcMain.handle("scheduledTasks:runNow", (_event: IpcMainInvokeEvent, id: string) => {
        requireString(id, "task id");
        return scheduler.runTask(id);
    });

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

    ipcMain.handle("accounts:status", (_event: IpcMainInvokeEvent, provider: accounts.AccountProvider) =>
        accounts.getLinkedAccount(provider)
    );
    ipcMain.handle("accounts:connect", async (_event: IpcMainInvokeEvent, { provider, token }: { provider: accounts.AccountProvider; token: string }) =>
        accounts.connectAccount(provider, requireString(token, "access token"))
    );
    ipcMain.handle("accounts:disconnect", (_event: IpcMainInvokeEvent, provider: accounts.AccountProvider) =>
        accounts.disconnectAccount(provider)
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
    ipcMain.handle("data:exportSessionMarkdown", (_event: IpcMainInvokeEvent, id: string) =>
        dataTransfer.exportSessionMarkdown(mainWindow, requireString(id, "session id"))
    );
    ipcMain.handle("data:getSessionMarkdown", (_event: IpcMainInvokeEvent, id: string) => {
        const session = sessionsStore.getSession(requireString(id, "session id"));
        return session ? dataTransfer.sessionToMarkdown(session) : null;
    });
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
            return { results: await huggingface.searchGgufModels(String(query ?? ""), 20, accounts.getAccountToken("huggingface")) };
        } catch (err) {
            return { error: (err as Error).message };
        }
    });

    ipcMain.handle("hf:listFiles", async (_event: IpcMainInvokeEvent, modelId: string) => {
        requireString(modelId, "model id");
        try {
            return { files: await huggingface.listGgufFiles(modelId, accounts.getAccountToken("huggingface")) };
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
                , accounts.getAccountToken("huggingface"));
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

    // Called when the renderer is about to stop using a workspace (switching
    // to a different folder, or loading a session that points elsewhere) —
    // without this, background tasks started against the old workspace kept
    // running indefinitely, since killAllBackgroundCommands() only ever ran
    // on app quit.
    ipcMain.handle("agent:closeWorkspace", (_event: IpcMainInvokeEvent, workspaceRoot: string) => {
        requireString(workspaceRoot, "workspace root");
        const killedBackgroundTasks = agentTools.killBackgroundCommandsForWorkspace(workspaceRoot);
        return { killedBackgroundTasks };
    });

    ipcMain.handle("agent:getSandboxCapabilities", () => detectSandboxCapabilities());

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
    setupMenu(() => mainWindow, () => checkForUpdatesManually(() => mainWindow), settingsStore.getSettings().keybindings);
    createWindow();
    ollama.setHost(settingsStore.getSettings().ollamaHost);
    ollama.setModelsDir(settingsStore.getSettings().modelsDir);
    await ollama.start();
    llamacpp.setModelCacheLimit(settingsStore.getSettings().llamaCppMaxCachedModels ?? 2);
    await llamacpp.setGpuBackend(settingsStore.getSettings().llamaCppGpuBackend ?? "auto");
    setupAutoUpdater(() => mainWindow);
    void connectEnabledMcpServers();
    scheduler.init((provider, model, prompt) => completePrompt(provider as ProviderId, model, prompt));

    app.on("activate", () => {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
});

app.on("window-all-closed", () => {
    ollama.stop();
    localServers.stopAll();
    agentTools.killAllBackgroundCommands();
    mcpClient.disconnectAll();
    if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
    ollama.stop();
    localServers.stopAll();
    agentTools.killAllBackgroundCommands();
    void llamacpp.dispose();
});
