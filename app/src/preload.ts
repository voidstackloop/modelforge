import { contextBridge, ipcRenderer } from "electron";
import type { PullProgress } from "./ollama-manager";
import type { AttachedFile, MediaAttachment } from "./file-reader";
import type { ChatMessage, ChatChunk, ChatOptions, ProviderId } from "./providers/types";

interface ToolExecuteResult {
    result?: unknown;
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

    files: {
        openAndRead: () => ipcRenderer.invoke("files:openAndRead"),
        openFolderAndRead: () => ipcRenderer.invoke("files:openFolderAndRead"),
        openMedia: (): Promise<MediaAttachment[]> => ipcRenderer.invoke("files:openMedia"),
    },

    secrets: {
        has: (key: string) => ipcRenderer.invoke("secrets:has", key),
        set: (key: string, value: string) => ipcRenderer.invoke("secrets:set", { key, value }),
    },

    app: {
        setBusy: (busy: boolean) => ipcRenderer.invoke("app:setBusy", busy),
        getVersion: () => ipcRenderer.invoke("app:getVersion"),
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
        exportAll: () => ipcRenderer.invoke("data:exportAll"),
        import: () => ipcRenderer.invoke("data:import"),
        getUserDataPath: () => ipcRenderer.invoke("data:getUserDataPath"),
        openUserDataFolder: () => ipcRenderer.invoke("data:openUserDataFolder"),
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
    },
});
