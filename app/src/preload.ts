import { contextBridge, ipcRenderer } from "electron";
import type { PullProgress, RestartResult } from "./ollama-manager";
import type { AttachedFile, MediaAttachment } from "./file-reader";
import type { ChatMessage, ChatChunk, ChatOptions, ProviderId } from "./providers/types";
import type { McpServerConfig, McpServerStatus } from "./mcp-client";
import type { RollbackResult, ProjectScripts } from "./agent-tools";
import type { SandboxCapabilities } from "./command-sandbox";
import type { PromptPreset } from "./settings-store";
import type { LocalGgufModel, GpuBackend } from "./llamacpp-manager";
import type { ScheduledTask } from "./scheduled-tasks-store";
import type { LocalRuntimeStatus } from "./local-server-manager";

interface ToolExecuteResult {
    result?: unknown;
    error?: string;
}

interface ScreenSourceInfo {
    id: string;
    name: string;
    thumbnailDataUrl: string;
}

interface ScreenCaptureResult {
    dataBase64?: string;
    mimeType?: string;
    error?: string;
}

interface FigmaFetchResult {
    result?: { dataBase64: string; mimeType: string; name: string };
    error?: string;
}

interface OcrResult {
    text?: string;
    error?: string;
}

interface HfSearchResult {
    results?: { id: string; downloads: number; likes: number; tags: string[] }[];
    error?: string;
}

interface HfListFilesResult {
    files?: { path: string; sizeBytes: number | null }[];
    error?: string;
}

interface HfDownloadProgress {
    receivedBytes: number;
    totalBytes: number | null;
}

interface HfDownloadResult {
    path?: string;
    error?: string;
}

interface McpConnectResult {
    tools?: { name: string; description?: string; inputSchema?: Record<string, unknown> }[];
    error?: string;
}

function randomId(): string {
    return Math.random().toString(36).slice(2);
}

contextBridge.exposeInMainWorld("api", {
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
        setGpuBackend: (backend: GpuBackend): Promise<void> => ipcRenderer.invoke("llamacpp:setGpuBackend", backend),
        pickModelsDir: (): Promise<string | null> => ipcRenderer.invoke("llamacpp:pickModelsDir"),
    },

    localBackends: {
        getStatuses: (): Promise<LocalRuntimeStatus[]> => ipcRenderer.invoke("localBackends:getStatuses"),
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

    settings: {
        get: () => ipcRenderer.invoke("settings:get"),
        save: (partial: Record<string, unknown>) => ipcRenderer.invoke("settings:save", partial),
    },

    sessions: {
        list: () => ipcRenderer.invoke("sessions:list"),
        get: (id: string) => ipcRenderer.invoke("sessions:get", id),
        create: (model: string | null, projectId?: string | null) =>
            ipcRenderer.invoke("sessions:create", { model, projectId: projectId ?? null }),
        update: (id: string, partial: Record<string, unknown>) =>
            ipcRenderer.invoke("sessions:update", { id, partial }),
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
        update: (id: string, partial: Record<string, unknown>) =>
            ipcRenderer.invoke("projects:update", { id, partial }),
        delete: (id: string) => ipcRenderer.invoke("projects:delete", id),
    },

    rag: {
        indexFiles: (files: AttachedFile[]) => ipcRenderer.invoke("rag:indexFiles", files),
        query: (indexId: string, query: string, topK?: number) =>
            ipcRenderer.invoke("rag:query", { indexId, query, topK }),
    },

    agent: {
        pickWorkspace: (): Promise<string | null> => ipcRenderer.invoke("agent:pickWorkspace"),
        executeTool: (workspaceRoot: string, name: string, args: Record<string, unknown>): Promise<ToolExecuteResult> =>
            ipcRenderer.invoke("tools:execute", { workspaceRoot, name, args }),
        rollbackLastWrite: (workspaceRoot: string): Promise<RollbackResult | null> =>
            ipcRenderer.invoke("agent:rollbackLastWrite", workspaceRoot),
        detectScripts: (workspaceRoot: string): Promise<ProjectScripts> =>
            ipcRenderer.invoke("agent:detectScripts", workspaceRoot),
        closeWorkspace: (workspaceRoot: string): Promise<{ killedBackgroundTasks: number }> =>
            ipcRenderer.invoke("agent:closeWorkspace", workspaceRoot),
        getSandboxCapabilities: (): Promise<SandboxCapabilities> => ipcRenderer.invoke("agent:getSandboxCapabilities"),
    },

    mcp: {
        connect: (config: McpServerConfig): Promise<McpConnectResult> => ipcRenderer.invoke("mcp:connect", config),
        disconnect: (id: string): Promise<void> => ipcRenderer.invoke("mcp:disconnect", id),
        status: (): Promise<Record<string, McpServerStatus>> => ipcRenderer.invoke("mcp:status"),
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
});
