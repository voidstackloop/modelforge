import { contextBridge, ipcRenderer } from "electron";
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
import type { PatientCase, PatientCasesBackendScope } from "./patient-cases-store";
import type { SyncStatus } from "./case-offline-cache";
import type { AuditEvent } from "./audit-log-store";
import type { EvidenceSource } from "./evidence-store";
import type { ApprovedModel } from "./model-registry-store";
import type { MedicationSafetyResult, MedicationSafetyCoverage } from "./medical-safety";
import type { SharedBackendConfig } from "./shared-backend-config-store";
import type { MigrationSession } from "@modelforge/contracts";
import type { StagedMigrationResult } from "./case-migration";
import type { OrganizationMembership } from "./shared-backend-client";
import type { CreateImagingShareInput, ImagingStudyDetail } from "./imaging-client";
import type { ImagingIngestionJob, ImagingShareGrant, ImagingStudy } from "@modelforge/contracts";
import type { AiConsent, AiReview } from "@modelforge/contracts";
import type { ClinicalAiImagingOption, ClinicalAiModelOption, ClinicalAiRequestDetail, ClinicalAiSubmitInput } from "./clinical-ai-client";
import type { Hl7ResolveDecision } from "./hl7-client";
import type { Hl7IngestionJob, SmartLaunchToken, SmartTrustedIssuer } from "@modelforge/contracts";

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
    llamacpp: {
        listModels: (): Promise<LocalGgufModel[]> => ipcRenderer.invoke("llamacpp:listModels"),
        deleteModel: (name: string): Promise<void> => ipcRenderer.invoke("llamacpp:deleteModel", name),
        getAvailableGpuBackends: (): Promise<string[]> => ipcRenderer.invoke("llamacpp:getAvailableGpuBackends"),
        getModelTotalLayers: (name: string): Promise<number> => ipcRenderer.invoke("llamacpp:getModelTotalLayers", name),
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
            agentMode?: boolean,
            conversationId?: string
        ) => {
            const requestId = randomId();
            const channel = `chat:chunk:${requestId}`;
            const listener = (_event: unknown, chunk: ChatChunk) => onToken(chunk);
            ipcRenderer.on(channel, listener);
            const promise = ipcRenderer
                .invoke("chat:send", { requestId, provider, model, messages, options, agentMode, conversationId })
                // The invoke reply and a final webContents.send() chunk use
                // separate IPC routes. The reply can arrive first even when
                // main sent the chunk first; removing this listener
                // immediately dropped single-chunk tool calls and final usage
                // metadata. Keep it through one short renderer turn, and
                // delay promise resolution so Chat flushes those chunks before
                // it inspects the completed assistant message.
                .finally(() => new Promise<void>((resolve) => setTimeout(() => {
                    ipcRenderer.removeListener(channel, listener);
                    resolve();
                }, 25)));
            return { requestId, promise };
        },

        cancel: (requestId: string) => ipcRenderer.invoke("chat:cancel", requestId),
    },

    system: {
        getSpecs: () => ipcRenderer.invoke("system:getSpecs"),
        getRecommendations: () => ipcRenderer.invoke("system:getRecommendations"),
        assessGgufFiles: (files: import("./system-specs").GgufAssessmentInput[]): Promise<import("./system-specs").GgufAssessment[]> => ipcRenderer.invoke("system:assessGgufFiles", files),
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

    resource: {
        // Read-only, PHI-safe by construction — see ipc/resource-handlers.ts's
        // own doc comment. Poll this (same convention as gpu.getTelemetry)
        // for the Runtime Manager's Workloads view and the header indicator.
        getTelemetry: (): Promise<import("./resource-contracts").ResourceTelemetry> => ipcRenderer.invoke("resource:getTelemetry"),
    },

    settings: {
        get: () => ipcRenderer.invoke("settings:get"),
        save: (partial: Record<string, unknown>) => ipcRenderer.invoke("settings:save", partial),
    },

    policy: {
        status: (): Promise<import("./policy-store").PolicyStatus> => ipcRenderer.invoke("policy:status"),
        reload: (): Promise<import("./policy-store").PolicyStatus> => ipcRenderer.invoke("policy:reload"),
    },

    backup: {
        create: (passphrase: string): Promise<{ success: boolean; filePath?: string }> => ipcRenderer.invoke("backup:create", passphrase),
        pickFile: (): Promise<{ canceled: boolean; filePath?: string }> => ipcRenderer.invoke("backup:pickFile"),
        verifyFile: (filePath: string, passphrase: string): Promise<import("./backup-store").BackupSummary> =>
            ipcRenderer.invoke("backup:verifyFile", filePath, passphrase),
        restoreFile: (filePath: string, passphrase: string): Promise<import("./backup-store").RestoreResult> =>
            ipcRenderer.invoke("backup:restoreFile", filePath, passphrase),

        getSchedule: (): Promise<import("./backup-schedule-store").BackupSchedule> => ipcRenderer.invoke("backup:getSchedule"),
        setSchedule: (
            partial: Partial<Pick<import("./backup-schedule-store").BackupSchedule, "enabled" | "intervalHours" | "retentionCount">>
        ): Promise<import("./backup-schedule-store").BackupSchedule> => ipcRenderer.invoke("backup:setSchedule", partial),
        pickScheduleDestination: (): Promise<{ canceled: boolean; destinationDir?: string }> =>
            ipcRenderer.invoke("backup:pickScheduleDestination"),
        hasAutoPassphrase: (): Promise<boolean> => ipcRenderer.invoke("backup:hasAutoPassphrase"),
        setAutoPassphrase: (passphrase: string): Promise<void> => ipcRenderer.invoke("backup:setAutoPassphrase", passphrase),
        clearAutoPassphrase: (): Promise<void> => ipcRenderer.invoke("backup:clearAutoPassphrase"),

        getCloudConfig: (): Promise<import("./cloud-backup-store").CloudBackupConfig> => ipcRenderer.invoke("backup:getCloudConfig"),
        setCloudConfig: (
            partial: Partial<import("./cloud-backup-store").CloudBackupConfig>
        ): Promise<import("./cloud-backup-store").CloudBackupConfig> => ipcRenderer.invoke("backup:setCloudConfig", partial),
        hasCloudSecret: (): Promise<boolean> => ipcRenderer.invoke("backup:hasCloudSecret"),
        setCloudSecret: (secretAccessKey: string): Promise<void> => ipcRenderer.invoke("backup:setCloudSecret", secretAccessKey),
        clearCloudSecret: (): Promise<void> => ipcRenderer.invoke("backup:clearCloudSecret"),
        testCloudConnection: (): Promise<void> => ipcRenderer.invoke("backup:testCloudConnection"),
    },

    sessions: {
        list: () => ipcRenderer.invoke("sessions:list"),
        listBackends: (): Promise<{ active: string; backends: { name: string; label: string; scope: "local" | "shared"; available: boolean }[] }> =>
            ipcRenderer.invoke("sessions:listBackends"),
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
                    | "assignedUserIds"
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
        executeTool: (workspaceRoot: string, name: string, args: Record<string, unknown>, clinicalContext?: { patientCaseId?: string; humanApproved?: boolean }): Promise<ToolExecuteResult> =>
            ipcRenderer.invoke("tools:execute", { workspaceRoot, name, args, clinicalContext }),
        // Only meaningfully different from executeTool for MCP tools — a
        // requestId lets main thread progress notifications back on a push
        // channel and lets the caller cancel mid-call. Built-in tools ignore
        // both (no requestId means agent-handlers.ts skips this path
        // entirely), so this is additive, not a second code path to keep in
        // sync with executeTool's behavior.
        executeToolWithProgress: (
            workspaceRoot: string,
            name: string,
            args: Record<string, unknown>,
            onProgress: (progress: { progress: number; total?: number; message?: string }) => void,
            clinicalContext?: { patientCaseId?: string; humanApproved?: boolean }
        ): { requestId: string; promise: Promise<ToolExecuteResult> } => {
            const requestId = randomId();
            const channel = `mcp:toolProgress:${requestId}`;
            const listener = (_event: unknown, progress: { progress: number; total?: number; message?: string }) => onProgress(progress);
            ipcRenderer.on(channel, listener);
            const promise = ipcRenderer
                .invoke("tools:execute", { workspaceRoot, name, args, requestId, clinicalContext })
                .finally(() => ipcRenderer.removeListener(channel, listener));
            return { requestId, promise };
        },
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

    patientCases: {
        list: (): Promise<PatientCase[]> => ipcRenderer.invoke("patientCases:list"),
        listBackends: (): Promise<{ active: string; backends: { name: string; label: string; scope: PatientCasesBackendScope; available: boolean }[] }> =>
            ipcRenderer.invoke("patientCases:listBackends"),
        get: (id: string): Promise<PatientCase | null> => ipcRenderer.invoke("patientCases:get", id),
        create: (title: string): Promise<PatientCase> => ipcRenderer.invoke("patientCases:create", title),
        // expectedVersion: the version the caller last loaded this case at
        // — omitted means "no caller-tracked version, fall back to a
        // freshest-possible read" (see patient-cases-store.ts's mutateCase
        // doc comment). Passing it is what turns optimistic concurrency
        // into a real "someone else edited this since you loaded it" check
        // instead of one that can only catch races within a single call.
        update: (id: string, partial: Record<string, unknown>, expectedVersion?: string | null): Promise<PatientCase | null> =>
            ipcRenderer.invoke("patientCases:update", { id, partial, expectedVersion }),
        delete: (id: string, expectedVersion?: string | null): Promise<void> =>
            ipcRenderer.invoke("patientCases:delete", { id, expectedVersion }),
        buildContext: (id: string): Promise<{ text: string; includedFields: string[] } | null> =>
            ipcRenderer.invoke("patientCases:buildContext", id),
        checkConflicts: (allergies: string[], medications: string[]): Promise<MedicationSafetyResult> =>
            ipcRenderer.invoke("patientCases:checkConflicts", { allergies, medications }),
        grantConsent: (
            caseId: string,
            scope: "ai-assistance" | "remote-model-use" | "research",
            method: string
        ): Promise<PatientCase | null> => ipcRenderer.invoke("patientCases:grantConsent", { caseId, scope, method }),
        revokeConsent: (caseId: string, consentId: string): Promise<PatientCase | null> =>
            ipcRenderer.invoke("patientCases:revokeConsent", { caseId, consentId }),
        addNote: (caseId: string, author: "clinician" | "model-inference", text: string): Promise<PatientCase | null> =>
            ipcRenderer.invoke("patientCases:addNote", { caseId, author, text }),
        reviewNote: (
            caseId: string,
            noteId: string,
            reviewedBy: string,
            outcome: "accepted" | "accepted-with-edits" | "rejected",
            comment?: string
        ): Promise<PatientCase | null> => ipcRenderer.invoke("patientCases:reviewNote", { caseId, noteId, reviewedBy, outcome, comment }),
        // P1 item 5 (case-offline-cache.ts): pending/conflicted counts for
        // the shared backend's offline outbox — {pendingCount: 0, ...} when
        // no organization is connected (local mode), never an error.
        getSyncStatus: (): Promise<SyncStatus> => ipcRenderer.invoke("patientCases:getSyncStatus"),
        discardSyncConflict: (idempotencyKey: string): Promise<void> => ipcRenderer.invoke("patientCases:discardSyncConflict", idempotencyKey),
    },

    audit: {
        list: (): Promise<AuditEvent[]> => ipcRenderer.invoke("audit:list"),
        clearAll: (): Promise<void> => ipcRenderer.invoke("audit:clearAll"),
        record: (
            actionCategory: AuditEvent["actionCategory"],
            fields?: {
                targetType?: AuditEvent["targetType"];
                targetId?: string;
                detail?: string;
                mcpServerId?: string;
                mcpServerName?: string;
                mcpToolName?: string;
                approvalOutcome?: AuditEvent["approvalOutcome"];
                durationMs?: number;
            }
        ): Promise<AuditEvent> => ipcRenderer.invoke("audit:record", { actionCategory, fields }),
        verifyIntegrity: (): Promise<{ valid: boolean; checkedCount: number; brokenAtIndex?: number; reason?: string }> =>
            ipcRenderer.invoke("audit:verifyIntegrity"),
        sqliteCapability: (): Promise<{ available: boolean; reason?: string; detail?: string }> =>
            ipcRenderer.invoke("audit:sqliteCapability"),
        pickSqliteDir: (): Promise<string | null> => ipcRenderer.invoke("audit:pickSqliteDir"),
        setSqliteDir: (dir: string | null): Promise<{ customDir: string | null } | { error: string }> => ipcRenderer.invoke("audit:setSqliteDir", dir),
    },

    encryption: {
        status: (): Promise<{ enabled: boolean; unlocked: boolean }> => ipcRenderer.invoke("encryption:status"),
        setup: (passphrase: string): Promise<{ success: boolean; error?: string }> => ipcRenderer.invoke("encryption:setup", passphrase),
        unlock: (passphrase: string): Promise<{ success: boolean }> => ipcRenderer.invoke("encryption:unlock", passphrase),
        lock: (): Promise<void> => ipcRenderer.invoke("encryption:lock"),
        disable: (passphrase: string): Promise<{ success: boolean; error?: string }> => ipcRenderer.invoke("encryption:disable", passphrase),
        changePassphrase: (oldPassphrase: string, newPassphrase: string): Promise<{ success: boolean; error?: string }> =>
            ipcRenderer.invoke("encryption:changePassphrase", { oldPassphrase, newPassphrase }),
    },

    modelRegistry: {
        list: (): Promise<ApprovedModel[]> => ipcRenderer.invoke("modelRegistry:list"),
        isActive: (): Promise<boolean> => ipcRenderer.invoke("modelRegistry:isActive"),
        isApproved: (provider: string, modelId: string): Promise<boolean> =>
            ipcRenderer.invoke("modelRegistry:isApproved", { provider, modelId }),
        approve: (provider: string, modelId: string, approvedUseCases: string[], approvedBy?: string): Promise<ApprovedModel> =>
            ipcRenderer.invoke("modelRegistry:approve", { provider, modelId, approvedUseCases, approvedBy }),
        retire: (id: string): Promise<void> => ipcRenderer.invoke("modelRegistry:retire", id),
        remove: (id: string): Promise<void> => ipcRenderer.invoke("modelRegistry:remove", id),
    },

    medicalSafety: {
        checkEmergency: (text: string): Promise<{ isEmergency: boolean; flags: { matched: string; category: string }[] }> =>
            ipcRenderer.invoke("medicalSafety:checkEmergency", text),
        redact: (text: string): Promise<{ redacted: string; counts: Record<string, number> }> =>
            ipcRenderer.invoke("medicalSafety:redact", text),
        checkCitations: (text: string, knownSourceIds: string[]): Promise<{ unverifiedMarkers: string[]; missingCitations: boolean }> =>
            ipcRenderer.invoke("medicalSafety:checkCitations", { text, knownSourceIds }),
        listMedicationProviders: (): Promise<{ active: string; providers: { name: string; label: string; coverage: MedicationSafetyCoverage }[] }> =>
            ipcRenderer.invoke("medicalSafety:listMedicationProviders"),
    },

    evidence: {
        list: (): Promise<EvidenceSource[]> => ipcRenderer.invoke("evidence:list"),
        addFromUrl: (url: string): Promise<{ source?: EvidenceSource; error?: string }> =>
            ipcRenderer.invoke("evidence:addFromUrl", url),
        delete: (id: string): Promise<void> => ipcRenderer.invoke("evidence:delete", id),
    },

    sharedBackend: {
        getConfig: (): Promise<SharedBackendConfig | null> => ipcRenderer.invoke("sharedBackend:getConfig"),
        setConfig: (config: SharedBackendConfig): Promise<void> => ipcRenderer.invoke("sharedBackend:setConfig", config),
        clearConfig: (): Promise<void> => ipcRenderer.invoke("sharedBackend:clearConfig"),
        status: (): Promise<{ configured: boolean; connected: boolean }> => ipcRenderer.invoke("sharedBackend:status"),
        connect: (): Promise<{ connected: boolean; error?: string }> => ipcRenderer.invoke("sharedBackend:connect"),
        disconnect: (): Promise<void> => ipcRenderer.invoke("sharedBackend:disconnect"),
        listOrganizations: (): Promise<OrganizationMembership[]> => ipcRenderer.invoke("sharedBackend:listOrganizations"),
        createOrganization: (name: string): Promise<{ organization: { id: string; name: string }; user: { id: string } }> =>
            ipcRenderer.invoke("sharedBackend:createOrganization", name),
        selectOrganization: (organizationId: string): Promise<void> => ipcRenderer.invoke("sharedBackend:selectOrganization", organizationId),
        clearSelectedOrganization: (): Promise<void> => ipcRenderer.invoke("sharedBackend:clearSelectedOrganization"),
        stageLocalCases: (): Promise<StagedMigrationResult> => ipcRenderer.invoke("sharedBackend:stageLocalCases"),
        activateCaseMigration: (migrationId: string): Promise<MigrationSession> => ipcRenderer.invoke("sharedBackend:activateCaseMigration", migrationId),
        rollbackCaseMigration: (migrationId: string): Promise<MigrationSession> => ipcRenderer.invoke("sharedBackend:rollbackCaseMigration", migrationId),
    },

    computeAgent: {
        getIdentity: (): Promise<{ fingerprint256: string }> => ipcRenderer.invoke("computeAgent:getIdentity"),
        getStatus: (): Promise<{ enabled: boolean; nodeId: string | null; running: boolean }> => ipcRenderer.invoke("computeAgent:getStatus"),
    },

    imaging: {
        listStudies: (caseId: string): Promise<ImagingStudy[]> => ipcRenderer.invoke("imaging:listStudies", caseId),
        getStudy: (studyId: string): Promise<ImagingStudyDetail> => ipcRenderer.invoke("imaging:getStudy", studyId),
        listActivity: (): Promise<ImagingIngestionJob[]> => ipcRenderer.invoke("imaging:listActivity"),
        upload: (caseId: string, fileName: string, bytes: Uint8Array) => ipcRenderer.invoke("imaging:upload", { caseId, fileName, bytes }),
        resolveIngestionJob: (jobId: string, decision: "attach" | "reject", caseId?: string): Promise<{ job: ImagingIngestionJob; studyId?: string; requiresReview: boolean }> =>
            ipcRenderer.invoke("imaging:resolveIngestionJob", { jobId, decision, caseId }),
        listShares: (studyId: string): Promise<ImagingShareGrant[]> => ipcRenderer.invoke("imaging:listShares", studyId),
        createShare: (studyId: string, share: CreateImagingShareInput) => ipcRenderer.invoke("imaging:createShare", { studyId, share }),
        openViewer: (studyId: string): Promise<{ viewerUrl: string; expiresAt: string }> => ipcRenderer.invoke("imaging:openViewer", studyId),
        closeViewer: (viewerUrl: string): Promise<void> => ipcRenderer.invoke("imaging:closeViewer", viewerUrl),
    },

    clinicalAi: {
        listModels: (): Promise<ClinicalAiModelOption[]> => ipcRenderer.invoke("clinicalAi:listModels"),
        listConsents: (caseId: string): Promise<AiConsent[]> => ipcRenderer.invoke("clinicalAi:listConsents", caseId),
        createConsent: (caseId: string, consent: { purpose: AiConsent["purpose"]; dataCategories: string[]; expiresAt?: string }): Promise<AiConsent> => ipcRenderer.invoke("clinicalAi:createConsent", { caseId, consent }),
        revokeConsent: (caseId: string, consentId: string, reason: string): Promise<AiConsent> => ipcRenderer.invoke("clinicalAi:revokeConsent", { caseId, consentId, reason }),
        listImagingOptions: (caseId: string): Promise<ClinicalAiImagingOption[]> => ipcRenderer.invoke("clinicalAi:listImagingOptions", caseId),
        preview: (caseId: string, request: ClinicalAiSubmitInput): Promise<unknown> => ipcRenderer.invoke("clinicalAi:preview", { caseId, request }),
        submit: (caseId: string, request: ClinicalAiSubmitInput): Promise<unknown> => ipcRenderer.invoke("clinicalAi:submit", { caseId, request }),
        listActivity: (caseId: string): Promise<ClinicalAiRequestDetail[]> => ipcRenderer.invoke("clinicalAi:listActivity", caseId),
        review: (outputId: string, review: { decision: AiReview["decision"]; correctedText?: string; escalationReason?: string }): Promise<AiReview> => ipcRenderer.invoke("clinicalAi:review", { outputId, review }),
    },

    mcp: {
        listManagedClinicalServers: (): Promise<{ servers?: McpServerConfig[]; error?: string }> => ipcRenderer.invoke("mcp:listManagedClinicalServers"),
        connect: (config: McpServerConfig): Promise<McpConnectResult> => ipcRenderer.invoke("mcp:connect", config),
        disconnect: (id: string): Promise<void> => ipcRenderer.invoke("mcp:disconnect", id),
        status: (): Promise<Record<string, McpServerStatus>> => ipcRenderer.invoke("mcp:status"),
        isMastervaultBuiltinAvailable: (): Promise<boolean> => ipcRenderer.invoke("mcp:isMastervaultBuiltinAvailable"),
        pickMastervaultVault: (): Promise<McpServerConfig | null> => ipcRenderer.invoke("mcp:pickMastervaultVault"),
        cancelTool: (requestId: string): Promise<void> => ipcRenderer.invoke("mcp:cancelTool", requestId),
        startOAuthFlow: (config: McpServerConfig): Promise<{ authorized: boolean; error?: string }> =>
            ipcRenderer.invoke("mcp:startOAuthFlow", config),
        hasOAuthTokens: (serverId: string): Promise<boolean> => ipcRenderer.invoke("mcp:hasOAuthTokens", serverId),
        clearOAuthCredentials: (serverId: string): Promise<void> => ipcRenderer.invoke("mcp:clearOAuthCredentials", serverId),
    },

    hl7: {
        listJobs: (status?: Hl7IngestionJob["status"]): Promise<Hl7IngestionJob[]> => ipcRenderer.invoke("hl7:listJobs", status),
        resolveJob: (jobId: string, decision: Hl7ResolveDecision): Promise<Hl7IngestionJob> => ipcRenderer.invoke("hl7:resolveJob", { jobId, decision }),
    },

    smartLaunch: {
        listTrustedIssuers: (): Promise<SmartTrustedIssuer[]> => ipcRenderer.invoke("smartLaunch:listTrustedIssuers"),
        upsertTrustedIssuer: (input: { issuer: string; clientId: string; redirectUris: string[] }): Promise<SmartTrustedIssuer> =>
            ipcRenderer.invoke("smartLaunch:upsertTrustedIssuer", input),
        deleteTrustedIssuer: (issuer: string): Promise<void> => ipcRenderer.invoke("smartLaunch:deleteTrustedIssuer", issuer),
        listSessions: (): Promise<SmartLaunchToken[]> => ipcRenderer.invoke("smartLaunch:listSessions"),
        revokeSession: (sessionId: string): Promise<void> => ipcRenderer.invoke("smartLaunch:revokeSession", sessionId),
        start: (issuer: string): Promise<{ token?: SmartLaunchToken; error?: string }> => ipcRenderer.invoke("smartLaunch:start", issuer),
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
