export interface OllamaModel {
  name: string;
  size: number;
  modified_at: string;
}

export interface UsageInfo {
  promptTokens?: number;
  completionTokens?: number;
}

export interface MessageImage {
  mimeType: string;
  data: string;
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  usage?: UsageInfo;
  images?: MessageImage[];
  toolCalls?: ToolCall[];
  toolCallId?: string;
  toolName?: string;
}

export interface ChatChunk {
  message?: { role: string; content: string };
  done: boolean;
  usage?: UsageInfo;
  toolCalls?: ToolCall[];
}

export interface PullProgress {
  status: string;
  digest?: string;
  total?: number;
  completed?: number;
}

export interface GpuInfo {
  name: string;
  vramGB: number | null;
  vendor: string;
}

export interface SystemSpecs {
  totalRAMGB: number;
  freeRAMGB: number;
  cpuModel: string;
  cpuCores: number;
  platform: string;
  arch: string;
  gpu: GpuInfo | null;
  gpus: GpuInfo[];
  totalVramGB: number | null;
}

export interface RecommendedModel {
  name: string;
  label: string;
  minRAMGB: number;
  description: string;
  fits: boolean;
  runsOnGpu: boolean;
  recommended: boolean;
  supportsTools: boolean;
}

export interface ModelRecommendations {
  usableRAMGB: number;
  usableVRAMGB: number;
  effectiveGB: number;
  best: string | null;
  models: RecommendedModel[];
}

export interface PromptVersion {
  prompt: string;
  savedAt: string;
}

export interface PromptPreset {
  id: string;
  name: string;
  prompt: string;
  versions?: PromptVersion[];
  createdAt?: string;
  updatedAt?: string;
}

export interface McpServerConfig {
  id: string;
  name: string;
  transport: "stdio" | "http";
  enabled: boolean;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
}

export interface McpServerStatus {
  connected: boolean;
  toolCount: number;
  error?: string;
}

export interface RollbackResult {
  path: string;
  restoredContent: boolean;
}

export interface ProjectScripts {
  test?: string;
  lint?: string;
  format?: string;
}

export interface AppSettings {
  defaultModel: string | null;
  ollamaHost: string;
  temperature: number;
  topP: number;
  maxTokens: number;
  frequencyPenalty: number;
  presencePenalty: number;
  contextLength: number;
  gpuLayers?: number;
  seed?: number;
  topK?: number;
  repeatPenalty?: number;
  stop?: string[];
  systemPrompt: string;
  promptPresets: PromptPreset[];
  theme: "light" | "dark" | "system";
  language: "en" | "tr";
  ttsVoiceURI?: string;
  ttsAutoRead?: boolean;
  mcpServers?: McpServerConfig[];
  modelsDir?: string;
}

export interface ChatOptions {
  temperature?: number;
  topP?: number;
  maxTokens?: number;
  frequencyPenalty?: number;
  presencePenalty?: number;
  contextLength?: number;
  gpuLayers?: number;
  seed?: number;
  topK?: number;
  repeatPenalty?: number;
  stop?: string[];
}

export interface OllamaStartResult {
  alreadyRunning?: boolean;
  started?: boolean;
  error?: string;
}

export interface RestartResult extends OllamaStartResult {
  external?: boolean;
}

export interface ChatSession {
  id: string;
  title: string;
  model: string | null;
  messages: ChatMessage[];
  params?: ChatOptions | null;
  projectId?: string | null;
  systemPrompt?: string | null;
  agentMode?: boolean;
  agentWorkspace?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Project {
  id: string;
  name: string;
  instructions: string;
  params?: ChatOptions | null;
  createdAt: string;
  updatedAt: string;
}

export interface AttachedFile {
  name: string;
  path: string;
  content: string;
  truncated: boolean;
}

export interface OpenFolderResult {
  folderName: string;
  folderPath: string;
  files: AttachedFile[];
  skippedCount: number;
  budgetExceeded: boolean;
}

export interface TextAttachment {
  kind: "text";
  name: string;
  path: string;
  content: string;
  truncated: boolean;
}

export interface ImageAttachment {
  kind: "image";
  name: string;
  path: string;
  mimeType: string;
  dataBase64: string;
  sourceVideo?: string;
}

export type MediaAttachment = TextAttachment | ImageAttachment;

export type ProviderId = "ollama" | "openai" | "anthropic";

export interface RagChunk {
  text: string;
  source: string;
}

export interface IndexFilesResult {
  indexId: string;
  chunkCount: number;
  embedded: boolean;
}

export interface ElectronApi {
  ollama: {
    status: () => Promise<boolean>;
    start: () => Promise<OllamaStartResult>;
    stop: () => Promise<void>;
    listModels: () => Promise<OllamaModel[]>;
    deleteModel: (name: string) => Promise<{ deleted: boolean }>;
    pickModelsDir: () => Promise<string | null>;
    setModelsDir: (dir: string | null) => Promise<RestartResult>;
    pullModel: (name: string, onProgress: (chunk: PullProgress) => void) => Promise<{ done: boolean; error?: string }>;
  };
  chat: {
    send: (
      provider: ProviderId,
      model: string,
      messages: ChatMessage[],
      options: ChatOptions,
      onToken: (chunk: ChatChunk) => void,
      agentMode?: boolean
    ) => { requestId: string; promise: Promise<{ done: boolean; error?: string; aborted?: boolean }> };
    cancel: (requestId: string) => Promise<void>;
  };
  system: {
    getSpecs: () => Promise<SystemSpecs>;
    getRecommendations: () => Promise<ModelRecommendations>;
  };
  settings: {
    get: () => Promise<AppSettings>;
    save: (partial: Partial<AppSettings>) => Promise<AppSettings>;
  };
  sessions: {
    list: () => Promise<ChatSession[]>;
    get: (id: string) => Promise<ChatSession | null>;
    create: (model: string | null, projectId?: string | null) => Promise<ChatSession>;
    update: (
      id: string,
      partial: Partial<
        Pick<
          ChatSession,
          "title" | "model" | "messages" | "params" | "projectId" | "systemPrompt" | "agentMode" | "agentWorkspace"
        >
      >
    ) => Promise<ChatSession | null>;
    delete: (id: string) => Promise<void>;
    clearAll: () => Promise<void>;
  };
  files: {
    openAndRead: () => Promise<AttachedFile[]>;
    openFolderAndRead: () => Promise<OpenFolderResult | null>;
    openMedia: () => Promise<MediaAttachment[]>;
  };
  secrets: {
    has: (key: string) => Promise<boolean>;
    set: (key: string, value: string) => Promise<void>;
  };
  audio: {
    transcribe: (audioBase64: string, mimeType: string) => Promise<{ text?: string; error?: string }>;
  };
  app: {
    setBusy: (busy: boolean) => Promise<void>;
    getVersion: () => Promise<string>;
    checkForUpdates: () => Promise<void>;
    getDiagnostics: () => Promise<{
      appVersion: string;
      electron: string;
      chrome: string;
      node: string;
      platform: string;
      arch: string;
      ollamaHost: string;
      ollamaRunning: boolean;
      logTail: string;
    }>;
    openLogsFolder: () => Promise<void>;
  };
  menu: {
    onNewChat: (callback: () => void) => () => void;
    onOpenSettings: (callback: () => void) => () => void;
  };
  data: {
    exportSession: (id: string) => Promise<{ success: boolean }>;
    exportAll: () => Promise<{ success: boolean }>;
    import: () => Promise<{ imported: number }>;
    getUserDataPath: () => Promise<string>;
    openUserDataFolder: () => Promise<void>;
  };
  projects: {
    list: () => Promise<Project[]>;
    create: (name: string) => Promise<Project>;
    update: (id: string, partial: Partial<Pick<Project, "name" | "instructions" | "params">>) => Promise<Project | null>;
    delete: (id: string) => Promise<void>;
  };
  rag: {
    indexFiles: (files: AttachedFile[]) => Promise<IndexFilesResult>;
    query: (indexId: string, query: string, topK?: number) => Promise<RagChunk[]>;
  };
  agent: {
    pickWorkspace: () => Promise<string | null>;
    executeTool: (
      workspaceRoot: string,
      name: string,
      args: Record<string, unknown>
    ) => Promise<{ result?: unknown; error?: string }>;
    rollbackLastWrite: (workspaceRoot: string) => Promise<RollbackResult | null>;
    detectScripts: (workspaceRoot: string) => Promise<ProjectScripts>;
  };
  mcp: {
    connect: (
      config: McpServerConfig
    ) => Promise<{ tools?: { name: string; description?: string; inputSchema?: Record<string, unknown> }[]; error?: string }>;
    disconnect: (id: string) => Promise<void>;
    status: () => Promise<Record<string, McpServerStatus>>;
  };
}

declare global {
  interface Window {
    api: ElectronApi;
  }
}
