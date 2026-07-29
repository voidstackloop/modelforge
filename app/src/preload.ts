import { contextBridge, ipcRenderer } from "electron";
import type { PullProgress, RestartResult } from "./ollama-manager";
import type { AttachedFile, MediaAttachment } from "./file-reader";
import type { ChatMessage, ChatChunk, ChatOptions, ProviderId } from "./providers/types";
import type { McpServerConfig, McpServerStatus } from "./mcp-client";
import type { RollbackResult, ProjectScripts } from "./agent-tools";
import type { SandboxCapabilities } from "./command-sandbox";
import type { TerminalInfo } from "./terminal-manager";
import type { PromptPreset } from "./settings-store";
import type { LocalGgufModel, GpuBackend, LlamaCppRuntimeInfo } from "./llamacpp-manager";
import type { ScheduledTask } from "./scheduled-tasks-store";
import type { LocalRuntimeStatus, RuntimeStartupConfig, StopRuntimeResult } from "./local-server-manager";
import type { PythonEnvironmentProgress, PythonEnvironmentStatus, PythonEnvironmentOperation, PythonRuntimeFamily } from "./python-runtime-manager";
import type { ChatSession } from "./sessions-store";
import type { Project } from "./projects-store";
import type { DownloadJob } from "./download-jobs-store";
import type { GpuSelection } from "./gpu-selection";
import type { GpuTelemetrySample } from "./gpu-telemetry";

export interface ToolExecuteResult {
    result?: unknown;
    error?: string;
}

// Tracked so terminal.close() can remove these deterministically instead of
// relying solely on the main-process exit event to arrive (it normally
// does, but explicit cleanup on close() is cheap insurance against a leaked
// listener if it doesn't).
const terminalListeners = new Map<string, { data: (...args: unknown[]) => void; exit: (...args: unknown[]) => void }>();

export interface ScreenSourceInfo {
    id: string;
    name: string;
    thumbnailDataUrl: string;
}

export interface ScreenCaptureResult {
    dataBase64?: string;
    mimeType?: string;
    error?: string;
}

export interface FigmaFetchResult {
    result?: { dataBase64: string; mimeType: string; name: string };
    error?: string;
}

export interface OcrResult {
    text?: string;
    error?: string;
}

export interface HfSearchResult {
    results?: { id: string; downloads: number; likes: number; tags: string[] }[];
    error?: string;
}

export interface HfListFilesResult {
    files?: { path: string; sizeBytes: number | null; sha256?: string }[];
    error?: string;
}

export interface HfDownloadProgress {
    receivedBytes: number;
    totalBytes: number | null;
}

export interface HfDownloadResult {
    path?: string;
    error?: string;
}

export interface McpConnectResult {
    tools?: { name: string; description?: string; inputSchema?: Record<string, unknown> }[];
    error?: string;
}

function randomId(): string {
    return Math.random().toString(36).slice(2);
}

export const api = {
    ollama: {
        status: () => ipcRenderer.invoke("ollama:status"),
        start: () => ipcRenderer.invoke("ollama:start"),
        stop: () => ipcRenderer.invoke("ollama:stop"),
        listModels: () => ipcRenderer.invoke("ollama:listModels"),
        deleteModel: (name: string) => ipcRenderer.invoke("ollama:deleteModel", name),
        pickModelsDir: (): Promise<string | null> => ipcRenderer.invoke("ollama:pickModelsDir"),
        setModelsDir: (dir: string | null): Promise<RestartResult> => ipcRenderer.invoke("ollama:setModelsDir", dir),

        pullModel: (name: string, onProgress: (chunk: PullProgress) => void) => {
            const requestId = randomId();
            const channel = `ollama:pull:progress:${requestId}`;
            const listener = (_event: unknown, chunk: PullProgress) => onProgress(chunk);
            ipcRenderer.on(channel, listener);
            return ipcRenderer
                .invoke("ollama:pull", { requestId, name })
                .finally(() => ipcRenderer.removeListener(channel, listener));
        },
    },

    llamacpp: {
        listModels: (): Promise<LocalGgufModel[]> => ipcRenderer.invoke("llamacpp:listModels"),
        deleteModel: (name: string): Promise<void> => ipcRenderer.invoke("llamacpp:deleteModel", name),
        getAvailableGpuBackends: (): Promise<string[]> => ipcRenderer.invoke("llamacpp:getAvailableGpuBackends"),
        getRuntimeInfo: (): Promise<LlamaCppRuntimeInfo> => ipcRenderer.invoke("llamacpp:getRuntimeInfo"),
        setGpuBackend: (backend: GpuBackend): Promise<void> => ipcRenderer.invoke("llamacpp:setGpuBackend", backend),
        pickModelsDir: (): Promise<string | null> => ipcRenderer.invoke("llamacpp:pickModelsDir"),
    },

    localBackends: {
        getStatuses: (): Promise<LocalRuntimeStatus[]> => ipcRenderer.invoke("localBackends:getStatuses"),
        start: (backend: "mlx" | "rocm" | "vllm", model: string, startupConfig?: RuntimeStartupConfig): Promise<string> => ipcRenderer.invoke("localBackends:start", { backend, model, startupConfig }),
        stop: (backend: "mlx" | "rocm" | "vllm", force = false): Promise<StopRuntimeResult> => ipcRenderer.invoke("localBackends:stop", { backend, force }),
        restart: (backend: "mlx" | "rocm" | "vllm", model: string, startupConfig?: RuntimeStartupConfig): Promise<string> => ipcRenderer.invoke("localBackends:restart", { backend, model, startupConfig }),
        clearLogs: (backend: "mlx" | "rocm" | "vllm") => ipcRenderer.invoke("localBackends:clearLogs", backend),
        exportLogs: (backend: "mlx" | "rocm" | "vllm") => ipcRenderer.invoke("localBackends:exportLogs", backend),
    },

    pythonRuntimes: {
        getStatuses: (): Promise<PythonEnvironmentStatus[]> => ipcRenderer.invoke("pythonRuntimes:getStatuses"),
        execute: (family: PythonRuntimeFamily, operation: PythonEnvironmentOperation, onProgress: (progress: PythonEnvironmentProgress) => void) => {
            const requestId = randomId(); const channel = `pythonRuntimes:progress:${requestId}`;
            const listener = (_event: unknown, progress: PythonEnvironmentProgress) => onProgress(progress);
            ipcRenderer.on(channel, listener);
            const promise: Promise<PythonEnvironmentStatus> = ipcRenderer.invoke("pythonRuntimes:execute", { requestId, family, operation }).finally(() => ipcRenderer.removeListener(channel, listener));
            return { requestId, promise };
        },
        cancel: (requestId: string): Promise<void> => ipcRenderer.invoke("pythonRuntimes:cancel", requestId),
    },

    chat: {
        send: (
            provider: ProviderId,
            model: string,
            messages: ChatMessage[],
            options: ChatOptions,
            onToken: (chunk: ChatChunk) => void,
            agentMode?: boolean
        ) => {
            const requestId = randomId();
            const channel = `chat:chunk:${requestId}`;
            const listener = (_event: unknown, chunk: ChatChunk) => onToken(chunk);
            ipcRenderer.on(channel, listener);
            const promise = ipcRenderer
                .invoke("chat:send", { requestId, provider, model, messages, options, agentMode })
                .finally(() => ipcRenderer.removeListener(channel, listener));
            return { requestId, promise };
        },

        cancel: (requestId: string) => ipcRenderer.invoke("chat:cancel", requestId),
    },

    system: {
        getSpecs: () => ipcRenderer.invoke("system:getSpecs"),
        getRecommendations: () => ipcRenderer.invoke("system:getRecommendations"),
        getActivity: () => ipcRenderer.invoke("system:getActivity"),
    },

    gpu: {
        // Inventory/topology itself lives on system.getSpecs() (SystemSpecs.gpus
        // / gpuTopology) — these cover the manual-refresh, live-telemetry, and
        // selection-preview operations layered on top of it.
        refreshTopology: (): Promise<import("./system-specs").SystemSpecs> => ipcRenderer.invoke("gpu:refreshTopology"),
        getTelemetry: (): Promise<GpuTelemetrySample[]> => ipcRenderer.invoke("gpu:getTelemetry"),
        resolveSelection: (selection: GpuSelection): Promise<{ gpus: import("./system-specs").GpuInfo[]; stale: boolean; missingIds: string[] }> => ipcRenderer.invoke("gpu:resolveSelection", selection),
    },

    settings: {
        get: () => ipcRenderer.invoke("settings:get"),
        save: (partial: Record<string, unknown>) => ipcRenderer.invoke("settings:save", partial),
    },

    sessions: {
        list: () => ipcRenderer.invoke("sessions:list"),
        get: (id: string) => ipcRenderer.invoke("sessions:get", id),
        create: (model: string | null, projectId?: string | null) =>
            ipcRenderer.invoke("sessions:create", { model, projectId: projectId ?? null }),
        update: (
            id: string,
            partial: Partial<
                Pick<
                    ChatSession,
                    | "title"
                    | "model"
                    | "messages"
                    | "params"
                    | "projectId"
                    | "systemPrompt"
                    | "agentMode"
                    | "agentWorkspace"
                    | "planSteps"
                    | "contextSummary"
                    | "contextSummaryThroughIndex"
                    | "tags"
                >
            >
        ) => ipcRenderer.invoke("sessions:update", { id, partial }),
        delete: (id: string) => ipcRenderer.invoke("sessions:delete", id),
        clearAll: () => ipcRenderer.invoke("sessions:clearAll"),
    },

    scheduledTasks: {
        list: (): Promise<ScheduledTask[]> => ipcRenderer.invoke("scheduledTasks:list"),
        create: (name: string, prompt: string, model: string, intervalMinutes: number): Promise<ScheduledTask> =>
            ipcRenderer.invoke("scheduledTasks:create", { name, prompt, model, intervalMinutes }),
        update: (id: string, partial: Record<string, unknown>): Promise<ScheduledTask | null> =>
            ipcRenderer.invoke("scheduledTasks:update", { id, partial }),
        delete: (id: string): Promise<void> => ipcRenderer.invoke("scheduledTasks:delete", id),
        runNow: (id: string): Promise<void> => ipcRenderer.invoke("scheduledTasks:runNow", id),
    },

    files: {
        openAndRead: () => ipcRenderer.invoke("files:openAndRead"),
        openFolderAndRead: () => ipcRenderer.invoke("files:openFolderAndRead"),
        openMedia: (): Promise<MediaAttachment[]> => ipcRenderer.invoke("files:openMedia"),
    },

    secrets: {
        has: (key: string) => ipcRenderer.invoke("secrets:has", key),
        set: (key: string, value: string) => ipcRenderer.invoke("secrets:set", { key, value }),
        isEncryptionAvailable: () => ipcRenderer.invoke("secrets:isEncryptionAvailable") as Promise<boolean>,
    },

    accounts: {
        status: (provider: "github" | "huggingface") => ipcRenderer.invoke("accounts:status", provider),
        connect: (provider: "github" | "huggingface", token: string) => ipcRenderer.invoke("accounts:connect", { provider, token }),
        disconnect: (provider: "github" | "huggingface") => ipcRenderer.invoke("accounts:disconnect", provider),
    },

    audio: {
        transcribe: (audioBase64: string, mimeType: string): Promise<{ text?: string; error?: string }> =>
            ipcRenderer.invoke("audio:transcribe", { audioBase64, mimeType }),
    },

    app: {
        setBusy: (busy: boolean) => ipcRenderer.invoke("app:setBusy", busy),
        getVersion: () => ipcRenderer.invoke("app:getVersion"),
        checkForUpdates: () => ipcRenderer.invoke("app:checkForUpdates"),
        getDiagnostics: () => ipcRenderer.invoke("app:getDiagnostics"),
        openLogsFolder: () => ipcRenderer.invoke("app:openLogsFolder"),
    },

    benchmark: {
        run: (request: unknown) => {
            const requestId = crypto.randomUUID();
            return { requestId, promise: ipcRenderer.invoke("benchmark:run", { requestId, request }) };
        },
        cancel: (requestId: string) => ipcRenderer.invoke("benchmark:cancel", requestId),
        getLast: () => ipcRenderer.invoke("benchmark:getLast"),
        exportReport: (result: unknown) => ipcRenderer.invoke("benchmark:exportReport", result),
    },

    energy: {
        getDashboard: () => ipcRenderer.invoke("energy:getDashboard"),
        clearHistory: () => ipcRenderer.invoke("energy:clearHistory"),
    },

    downloads: {
        list: () => ipcRenderer.invoke("downloads:list"),
        create: (input: { modelId: string; filename: string; expectedBytes: number; backend?: "automatic" | DownloadJob["backend"]; sha256?: string }) => ipcRenderer.invoke("downloads:create", input),
        pause: (id: string) => ipcRenderer.invoke("downloads:pause", id),
        resume: (id: string) => ipcRenderer.invoke("downloads:resume", id),
        retry: (id: string) => ipcRenderer.invoke("downloads:retry", id),
        retryNow: (id: string) => ipcRenderer.invoke("downloads:retryNow", id),
        cancelRetry: (id: string) => ipcRenderer.invoke("downloads:cancelRetry", id),
        cancel: (id: string) => ipcRenderer.invoke("downloads:cancel", id),
        pauseAll: () => ipcRenderer.invoke("downloads:pauseAll"),
        resumeAll: () => ipcRenderer.invoke("downloads:resumeAll"),
        describeDeletion: (id: string) => ipcRenderer.invoke("downloads:describeDeletion", id),
        removeRecord: (id: string) => ipcRenderer.invoke("downloads:removeRecord", id),
        removePartialData: (id: string) => ipcRenderer.invoke("downloads:removePartialData", id),
        removeCompletedModel: (id: string) => ipcRenderer.invoke("downloads:removeCompletedModel", id),
        openFolder: (id: string) => ipcRenderer.invoke("downloads:openFolder", id),
        forecast: (id: string) => ipcRenderer.invoke("downloads:forecast", id),
        forecastAll: () => ipcRenderer.invoke("downloads:forecastAll"),
        recoveryStatus: () => ipcRenderer.invoke("downloads:recoveryStatus"),
        getControls: () => ipcRenderer.invoke("downloads:getControls"),
        setControls: (controls: { concurrency: number; bandwidthMbps: number }) => ipcRenderer.invoke("downloads:setControls", controls),
        onUpdate: (callback: (jobs: unknown[]) => void) => {
            const listener = (_event: unknown, jobs: unknown[]) => callback(jobs);
            ipcRenderer.on("downloads:update", listener);
            return () => ipcRenderer.removeListener("downloads:update", listener);
        },
    },

    menu: {
        onNewChat: (callback: () => void) => {
            const listener = () => callback();
            ipcRenderer.on("menu:new-chat", listener);
            return () => ipcRenderer.removeListener("menu:new-chat", listener);
        },
        onOpenSettings: (callback: () => void) => {
            const listener = () => callback();
            ipcRenderer.on("menu:open-settings", listener);
            return () => ipcRenderer.removeListener("menu:open-settings", listener);
        },
    },

    data: {
        exportSession: (id: string) => ipcRenderer.invoke("data:exportSession", id),
        exportSessionMarkdown: (id: string) => ipcRenderer.invoke("data:exportSessionMarkdown", id),
        getSessionMarkdown: (id: string): Promise<string | null> => ipcRenderer.invoke("data:getSessionMarkdown", id),
        exportAll: () => ipcRenderer.invoke("data:exportAll"),
        import: () => ipcRenderer.invoke("data:import"),
        getUserDataPath: () => ipcRenderer.invoke("data:getUserDataPath"),
        openUserDataFolder: () => ipcRenderer.invoke("data:openUserDataFolder"),
        exportPromptPresets: (presets: PromptPreset[]): Promise<{ success: boolean }> =>
            ipcRenderer.invoke("data:exportPromptPresets", presets),
        importPromptPresets: (): Promise<PromptPreset[]> => ipcRenderer.invoke("data:importPromptPresets"),
    },

    projects: {
        list: () => ipcRenderer.invoke("projects:list"),
        create: (name: string) => ipcRenderer.invoke("projects:create", name),
        update: (id: string, partial: Partial<Pick<Project, "name" | "instructions" | "params">>) =>
            ipcRenderer.invoke("projects:update", { id, partial }),
        delete: (id: string) => ipcRenderer.invoke("projects:delete", id),
    },

    rag: {
        indexFolder: (input: { folderPath: string; folderName: string; files: AttachedFile[] }) =>
            ipcRenderer.invoke("rag:indexFolder", input),
        query: (collectionId: string, query: string, topK?: number) =>
            ipcRenderer.invoke("rag:query", { collectionId, query, topK }),
        listCollections: () => ipcRenderer.invoke("rag:listCollections"),
        deleteCollection: (id: string) => ipcRenderer.invoke("rag:deleteCollection", id),
    },

    agent: {
        pickWorkspace: (): Promise<string | null> => ipcRenderer.invoke("agent:pickWorkspace"),
        executeTool: (workspaceRoot: string, name: string, args: Record<string, unknown>): Promise<ToolExecuteResult> =>
            ipcRenderer.invoke("tools:execute", { workspaceRoot, name, args }),
        rollbackLastWrite: (workspaceRoot: string): Promise<RollbackResult | null> =>
            ipcRenderer.invoke("agent:rollbackLastWrite", workspaceRoot),
        detectScripts: (workspaceRoot: string): Promise<ProjectScripts> =>
            ipcRenderer.invoke("agent:detectScripts", workspaceRoot),
        closeWorkspace: (workspaceRoot: string): Promise<{ killedBackgroundTasks: number; killedTerminals: number }> =>
            ipcRenderer.invoke("agent:closeWorkspace", workspaceRoot),
        getSandboxCapabilities: (): Promise<SandboxCapabilities> => ipcRenderer.invoke("agent:getSandboxCapabilities"),
    },

    // Human-facing interactive terminals (a live pseudo-terminal panel) —
    // separate from the model's create_terminal/write_to_terminal/etc. tool
    // calls, which poll terminal state through agent.executeTool instead of
    // needing a push-streaming channel. Both sides share the same
    // terminal-manager.ts session pool, just reached through different paths:
    // this one never goes through tool approval, since the human is driving
    // it directly.
    terminal: {
        create: (
            workspaceRoot: string,
            opts: { cwd?: string; name?: string },
            onData: (chunk: string) => void,
            onExit: (exitCode: number) => void
        ): Promise<{ id: string; name: string }> =>
            ipcRenderer.invoke("terminal:create", { workspaceRoot, opts }).then((created: { id: string; name: string }) => {
                const dataListener = (_event: unknown, chunk: string) => onData(chunk);
                const exitListener = (_event: unknown, exitCode: number) => onExit(exitCode);
                ipcRenderer.on(`terminal:data:${created.id}`, dataListener);
                ipcRenderer.on(`terminal:exit:${created.id}`, exitListener);
                terminalListeners.set(created.id, {
                    data: dataListener as (...args: unknown[]) => void,
                    exit: exitListener as (...args: unknown[]) => void,
                });
                return created;
            }),
        write: (id: string, data: string): Promise<void> => ipcRenderer.invoke("terminal:write", { id, data }),
        resize: (id: string, cols: number, rows: number): Promise<void> => ipcRenderer.invoke("terminal:resize", { id, cols, rows }),
        close: (id: string): Promise<void> => {
            const listeners = terminalListeners.get(id);
            if (listeners) {
                ipcRenderer.removeListener(`terminal:data:${id}`, listeners.data);
                ipcRenderer.removeListener(`terminal:exit:${id}`, listeners.exit);
                terminalListeners.delete(id);
            }
            return ipcRenderer.invoke("terminal:close", id);
        },
        list: (workspaceRoot?: string): Promise<TerminalInfo[]> => ipcRenderer.invoke("terminal:list", workspaceRoot),
    },

    mcp: {
        connect: (config: McpServerConfig): Promise<McpConnectResult> => ipcRenderer.invoke("mcp:connect", config),
        disconnect: (id: string): Promise<void> => ipcRenderer.invoke("mcp:disconnect", id),
        status: (): Promise<Record<string, McpServerStatus>> => ipcRenderer.invoke("mcp:status"),
        isMastervaultBuiltinAvailable: (): Promise<boolean> => ipcRenderer.invoke("mcp:isMastervaultBuiltinAvailable"),
        pickMastervaultVault: (): Promise<McpServerConfig | null> => ipcRenderer.invoke("mcp:pickMastervaultVault"),
    },

    screen: {
        listSources: (): Promise<ScreenSourceInfo[]> => ipcRenderer.invoke("screen:listSources"),
        capture: (sourceId: string): Promise<ScreenCaptureResult> => ipcRenderer.invoke("screen:capture", sourceId),
    },

    figma: {
        fetchFrame: (url: string): Promise<FigmaFetchResult> => ipcRenderer.invoke("figma:fetchFrame", url),
    },

    ocr: {
        recognize: (imageBase64: string): Promise<OcrResult> => ipcRenderer.invoke("ocr:recognize", imageBase64),
    },

    huggingface: {
        search: (query: string): Promise<HfSearchResult> => ipcRenderer.invoke("hf:search", query),
        listFiles: (modelId: string): Promise<HfListFilesResult> => ipcRenderer.invoke("hf:listFiles", modelId),
        downloadFile: (
            modelId: string,
            filename: string,
            onProgress: (progress: HfDownloadProgress) => void
        ): Promise<HfDownloadResult> => {
            const requestId = randomId();
            const channel = `hf:downloadProgress:${requestId}`;
            const listener = (_event: unknown, progress: HfDownloadProgress) => onProgress(progress);
            ipcRenderer.on(channel, listener);
            return ipcRenderer
                .invoke("hf:downloadFile", { requestId, modelId, filename })
                .finally(() => ipcRenderer.removeListener(channel, listener));
        },
    },
};

contextBridge.exposeInMainWorld("api", api);
