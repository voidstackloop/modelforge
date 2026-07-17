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

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
  usage?: UsageInfo;
  images?: MessageImage[];
}

export interface ChatChunk {
  message?: { role: string; content: string };
  done: boolean;
  usage?: UsageInfo;
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
}

export interface RecommendedModel {
  name: string;
  label: string;
  minRAMGB: number;
  description: string;
  fits: boolean;
  runsOnGpu: boolean;
  recommended: boolean;
}

export interface ModelRecommendations {
  usableRAMGB: number;
  usableVRAMGB: number;
  effectiveGB: number;
  best: string | null;
  models: RecommendedModel[];
}

export interface PromptPreset {
  id: string;
  name: string;
  prompt: string;
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
  systemPrompt: string;
  promptPresets: PromptPreset[];
  theme: "light" | "dark" | "system";
  language: "en" | "tr";
}

export interface ChatOptions {
  temperature?: number;
  topP?: number;
  maxTokens?: number;
  frequencyPenalty?: number;
  presencePenalty?: number;
  contextLength?: number;
}

export interface OllamaStartResult {
  alreadyRunning?: boolean;
  started?: boolean;
  error?: string;
}

export interface ChatSession {
  id: string;
  title: string;
  model: string | null;
  messages: ChatMessage[];
  params?: ChatOptions | null;
  projectId?: string | null;
  systemPrompt?: string | null;
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
    pullModel: (name: string, onProgress: (chunk: PullProgress) => void) => Promise<{ done: boolean; error?: string }>;
  };
  chat: {
    send: (
      provider: ProviderId,
      model: string,
      messages: ChatMessage[],
      options: ChatOptions,
      onToken: (chunk: ChatChunk) => void
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
      partial: Partial<Pick<ChatSession, "title" | "model" | "messages" | "params" | "projectId" | "systemPrompt">>
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
  app: {
    setBusy: (busy: boolean) => Promise<void>;
    getVersion: () => Promise<string>;
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
}

declare global {
  interface Window {
    api: ElectronApi;
  }
}
