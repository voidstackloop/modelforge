export interface OllamaModel {
  name: string;
  size: number;
  modified_at: string;
}

export interface UsageInfo {
  promptTokens?: number;
  completionTokens?: number;
  // Wall-clock time from request start to this usage snapshot, measured
  // client-side (providers don't report generation speed themselves) — used
  // to derive a tokens/sec figure. Not persisted meaning across app
  // restarts in any special way; it's just another number on the message.
  elapsedMs?: number;
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

export interface RagCitation {
  path: string;
  name: string;
  heading: string | null;
  page: number | null;
  startLine: number;
  endLine: number;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  usage?: UsageInfo;
  images?: MessageImage[];
  toolCalls?: ToolCall[];
  toolCallId?: string;
  toolName?: string;
  pinned?: boolean;
  // Set on the synthetic tool-role message the verification loop appends —
  // distinguishes it from a real tool result so the UI can render it as a
  // pass/fail checklist card instead of a generic tool-output box.
  isVerification?: boolean;
  // RAG chunks that were retrieved and folded into this message's prompt
  // content, kept separately so the UI can render them as source citations
  // instead of just the flattened text that went to the model.
  citations?: RagCitation[];
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
  largestGpuVramGB: number | null;
  gpuInterconnect: "nvlink" | "pcie" | "unified" | "none" | "unknown";
  tensorParallelSupported: boolean;
  cpuMemoryBandwidthGBps: number;
  cpuMemoryBandwidthMeasured: boolean;
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
  outcome: "Runs fully on GPU" | "Runs with partial offload" | "CPU-only but usable" | "Requires tensor parallelism" | "Likely out of memory";
  quantization: string;
  estimatedWeightGB: number;
  estimatedKvCacheGB: number;
  runtimeOverheadGB: number;
  totalRequiredGB: number;
  expectedGpuOffloadPercent: number;
  estimatedTokensPerSecond: number;
  measuredTokensPerSecond?: number;
  recommendedRuntime: "ollama" | "llamacpp" | "vllm" | "mlx";
  reason: string;
}

export interface ModelRecommendations {
  usableRAMGB: number;
  usableVRAMGB: number;
  largestUsableGpuGB: number;
  aggregateUsableVramGB: number;
  cpuMemoryBandwidthGBps: number;
  gpuInterconnect: SystemSpecs["gpuInterconnect"];
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

export interface OllamaRunningModel {
  name: string;
  size: number;
  size_vram: number;
  expires_at: string;
}

export interface AppActivity {
  ollamaRunning: boolean;
  ollamaLoadedModels: OllamaRunningModel[];
  llamacppLoadedModels: string[];
  localBackendServers: { backend: "mlx" | "rocm" | "vllm"; model: string }[];
  mcpServers: Record<string, McpServerStatus>;
  memory: { rssMB: number; heapUsedMB: number };
}

export interface BenchmarkRequest {
  provider: ProviderId;
  model: string;
  maxContextLength?: number;
  outputTokens?: number;
  compareCpuGpu?: boolean;
}

export interface BenchmarkResources {
  peakSystemRamMB: number;
  peakAppRamMB: number;
  peakVramMB: number | null;
  vramMeasurement: "nvidia-smi" | "rocm-smi" | "unavailable";
}

export interface BenchmarkMeasurement {
  mode: "default" | "cpu" | "gpu";
  tokensPerSecond: number;
  promptTokensPerSecond: number;
  timeToFirstTokenMs: number;
  totalTimeMs: number;
  promptTokens: number;
  completionTokens: number;
  resources: BenchmarkResources;
}

export interface BenchmarkResult {
  schemaVersion: 1;
  id: string;
  createdAt: string;
  provider: ProviderId;
  model: string;
  health: { healthy: boolean; latencyMs: number; error?: string };
  primary: BenchmarkMeasurement | null;
  comparison: { cpu?: BenchmarkMeasurement; gpu?: BenchmarkMeasurement; supported: boolean; note?: string };
  contextTests: { requestedTokens: number; accepted: boolean; elapsedMs: number; error?: string }[];
  warnings: string[];
}

export type EnergyRuntime = "llamacpp" | "ollama" | "vllm" | "mlx" | "transformers";
export type EnergyMeasurement = "measured" | "estimated";

export interface TimeOfUseTariff {
  name: string;
  startHour: number;
  endHour: number;
  pricePerKwh: number;
}

export interface EnergyTotals {
  energyKwh: number;
  cost: number;
  carbonGrams: number;
  requestCount: number;
  promptTokens: number;
  completionTokens: number;
}

export interface EnergyUsageRecord {
  date: string;
  runtime: EnergyRuntime;
  modelId: string;
  requestCount: number;
  promptTokens: number;
  completionTokens: number;
  activeSeconds: number;
  loadingSeconds: number;
  energyKwh: number;
  cost: number;
  measurement: EnergyMeasurement;
  tariffSnapshots: { name: string; pricePerKwh: number; currency: string; energyKwh: number; cost: number }[];
  carbonGrams: number;
}

export interface RuntimeEnergyActivity {
  id: string;
  runtime: EnergyRuntime;
  modelId: string;
  backend: string;
  device: string;
  processId: number | null;
  startedAt: string;
  promptTokens: number;
  completionTokens: number;
  activeSeconds: number;
  loadingSeconds: number;
  cpuUtilization: number;
  gpuUtilization: number | null;
  currentPowerWatts: number;
  energyKwh: number;
  cost: number;
  measurement: EnergyMeasurement;
}

export interface EnergyDashboard {
  current: RuntimeEnergyActivity[];
  today: EnergyTotals;
  week: EnergyTotals;
  month: EnergyTotals;
  lifetime: EnergyTotals;
  byModel: { key: string; totals: EnergyTotals }[];
  byRuntime: { key: string; totals: EnergyTotals }[];
  measuredPercent: number;
  costPerMillionGeneratedTokens: number;
  currency: string;
  records: EnergyUsageRecord[];
}

export interface LocalRuntimeStatus {
  backend: "rocm" | "mlx" | "vllm";
  compatible: boolean;
  installed: boolean;
  running: boolean;
  state: "starting" | "running" | "unhealthy" | "stopped";
  model?: string;
  detail: string;
  device?: string;
  pid: number | null;
  port: number | null;
  startedAt: string | null;
  uptimeSeconds: number;
  ramMB: number | null;
  vramMB: number | null;
  logs: string[];
  startupError?: string;
  installCommand: string;
  environmentIssues: string[];
}

export interface PythonEnvironmentStatus {
  family: "mlx" | "vllm-cuda" | "vllm-rocm";
  state: "missing" | "healthy" | "drifted" | "incompatible";
  destination: string; pythonPath: string; pythonVersion: string | null; installedPackages: Record<string, string>; issues: string[];
  manifest: { family: string; version: number; python: string; packages: Record<string, string>; diskRequirementBytes: number; expectedDownloadBytes: number; protocolVersion: number; compatibility: string; documentationUrl: string };
  installCommand: string; repairCommand: string; removeCommand: string;
}

export interface RollbackResult {
  path: string;
  restoredContent: boolean;
}

export interface ProjectScripts {
  test?: string;
  lint?: string;
  format?: string;
  build?: string;
}

export interface SandboxCapabilities {
  filesystemConfinement: boolean;
  networkDenial: boolean;
  mechanism: "bubblewrap" | "sandbox-exec" | "none";
}

export interface TerminalInfo {
  id: string;
  name: string;
  workspaceRoot: string;
  alive: boolean;
}

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

export interface HfModelSummary {
  id: string;
  downloads: number;
  likes: number;
  tags: string[];
}

export interface HfGgufFile {
  path: string;
  sizeBytes: number | null;
}

export interface HfDownloadProgress {
  receivedBytes: number;
  totalBytes: number | null;
}

export type DownloadJobState = "queued" | "resolving" | "downloading" | "paused" | "verifying" | "installing" | "ready" | "failed" | "cancelled";
export interface DownloadShard {
  filename: string; path: string; expectedBytes: number; receivedBytes: number; sha256?: string; state: DownloadJobState;
}
export interface DownloadJob {
  id: string; kind: "huggingface" | "ollama"; modelName: string; publisher: string; quantization?: string;
  backend: "llamacpp" | "mlx" | "vllm" | "ollama" | "transformers"; destinationDir: string; modelId: string;
  shards: DownloadShard[]; state: DownloadJobState; retryCount: number; createdAt: string; updatedAt: string;
  error?: { message: string; kind: string; retryable: boolean };
  jobReceivedBytes?: number; totalBytes?: number; bytesPerSecond?: number; etaSeconds?: number; recoveredAtStartup?: boolean;
}
export interface DownloadControls { concurrency: number; bandwidthMbps: number }
export interface DiskForecast { requiredBytes: number; availableBytes: number | null; enough: boolean | null }

export interface LinkedAccount {
  provider: "github" | "huggingface";
  username: string;
  displayName: string | null;
  avatarUrl: string | null;
  profileUrl: string;
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
  uiDensity?: "comfortable" | "compact";
  reduceMotion?: boolean;
  energyMonitoringEnabled?: boolean;
  electricityPricePerKwh?: number;
  energyCurrency?: string;
  timeOfUseTariffs?: TimeOfUseTariff[];
  manualCpuWatts?: number;
  manualGpuWatts?: number;
  manualSystemIdleWatts?: number;
  includeIdleSystemConsumption?: boolean;
  energyUsageRetentionDays?: number;
  energySampleIntervalSeconds?: number;
  gridIntensityGCo2PerKwh?: number;
  agentMaxSteps?: number;
  llamaCppMaxCachedModels?: number;
  ttsVoiceURI?: string;
  ttsAutoRead?: boolean;
  mcpServers?: McpServerConfig[];
  modelsDir?: string;
  llamaCppModelsDir?: string;
  llamaCppGpuBackend?: "auto" | "vulkan" | "cuda" | "metal" | "cpu";
  preferredRuntime?: "automatic" | "ollama" | "llamacpp" | "vllm" | "mlx";
  ragEmbeddingModel?: string;
  customProviders?: CustomProviderConfig[];
  onboardingComplete?: boolean;
  keybindings?: Record<string, string>;
  mlxModels?: string[];
  mlxPythonPath?: string;
  rocmServerPath?: string;
  vllmModels?: string[];
  vllmCommand?: string;
  networkToolsEnabled?: boolean;
  sandboxMaxMemoryMB?: number;
  sandboxMaxCpuPercent?: number;
  verificationEnabled?: boolean;
  verificationCommands?: string[];
  verificationMaxRetries?: number;
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
  planSteps?: { text: string; done: boolean }[];
  contextSummary?: string;
  contextSummaryThroughIndex?: number;
  tags?: string[];
  createdAt: string;
  updatedAt: string;
}

export interface ScheduledTask {
  id: string;
  name: string;
  prompt: string;
  model: string;
  targetSessionId: string;
  intervalMinutes: number;
  enabled: boolean;
  lastRunAt: string | null;
  lastError: string | null;
  createdAt: string;
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

export type ProviderId = "ollama" | "openai" | "anthropic" | "llamacpp" | "gemini" | "custom" | "mlx" | "rocm" | "vllm";

export interface CustomProviderConfig {
  id: string;
  name: string;
  baseUrl: string;
  modelIds: string[];
  localGpuBackend?: boolean;
}

export interface LocalGgufModel {
  name: string;
  label: string;
  path: string;
  sizeBytes: number;
}

export type LlamaCppGpuBackend = "auto" | "vulkan" | "cuda" | "metal" | "cpu";

export interface RagResult {
  text: string;
  score: number;
  source: { path: string; name: string };
  heading: string | null;
  page: number | null;
  startLine: number;
  endLine: number;
}

export interface RagCollectionSummary {
  collectionId: string;
  name: string;
  folderPath?: string;
  documentCount: number;
  chunkCount: number;
  embeddingModel: string;
  updatedAt?: number;
  embedded: boolean;
  error?: string;
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
  llamacpp: {
    listModels: () => Promise<LocalGgufModel[]>;
    deleteModel: (name: string) => Promise<void>;
    getAvailableGpuBackends: () => Promise<string[]>;
    setGpuBackend: (backend: LlamaCppGpuBackend) => Promise<void>;
    pickModelsDir: () => Promise<string | null>;
  };
  localBackends: {
    getStatuses: () => Promise<LocalRuntimeStatus[]>;
    start: (backend: "mlx" | "rocm" | "vllm", model: string) => Promise<string>;
    stop: (backend: "mlx" | "rocm" | "vllm") => Promise<void>;
    restart: (backend: "mlx" | "rocm" | "vllm", model: string) => Promise<string>;
    unload: (backend: "mlx" | "rocm" | "vllm") => Promise<void>;
  };
  pythonRuntimes: {
    getStatuses: () => Promise<PythonEnvironmentStatus[]>;
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
    getActivity: () => Promise<AppActivity>;
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
    ) => Promise<ChatSession | null>;
    delete: (id: string) => Promise<void>;
    clearAll: () => Promise<void>;
  };
  scheduledTasks: {
    list: () => Promise<ScheduledTask[]>;
    create: (name: string, prompt: string, model: string, intervalMinutes: number) => Promise<ScheduledTask>;
    update: (id: string, partial: Record<string, unknown>) => Promise<ScheduledTask | null>;
    delete: (id: string) => Promise<void>;
    runNow: (id: string) => Promise<void>;
  };
  files: {
    openAndRead: () => Promise<AttachedFile[]>;
    openFolderAndRead: () => Promise<OpenFolderResult | null>;
    openMedia: () => Promise<MediaAttachment[]>;
  };
  secrets: {
    has: (key: string) => Promise<boolean>;
    set: (key: string, value: string) => Promise<void>;
    isEncryptionAvailable: () => Promise<boolean>;
  };
  accounts: {
    status: (provider: "github" | "huggingface") => Promise<LinkedAccount | null>;
    connect: (provider: "github" | "huggingface", token: string) => Promise<LinkedAccount>;
    disconnect: (provider: "github" | "huggingface") => Promise<void>;
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
  benchmark: {
    run: (request: BenchmarkRequest) => {
      requestId: string;
      promise: Promise<{ result?: BenchmarkResult; error?: string; aborted?: boolean }>;
    };
    cancel: (requestId: string) => Promise<void>;
    getLast: () => Promise<BenchmarkResult | null>;
    exportReport: (result: BenchmarkResult) => Promise<{ success: boolean }>;
  };
  energy: {
    getDashboard: () => Promise<EnergyDashboard>;
    clearHistory: () => Promise<{ success: boolean }>;
  };
  downloads: {
    list: () => Promise<DownloadJob[]>;
    create: (input: { modelId: string; filename: string; expectedBytes: number; backend?: "automatic" | DownloadJob["backend"] }) => Promise<DownloadJob>;
    pause: (id: string) => Promise<void>; resume: (id: string) => Promise<void>; retry: (id: string) => Promise<void>;
    cancel: (id: string) => Promise<void>; delete: (id: string) => Promise<void>;
    forecast: (id: string) => Promise<DiskForecast>;
    recoveryStatus: () => Promise<{ recoveredJobs: number; recoveredAt: string | null }>;
    getControls: () => Promise<DownloadControls>; setControls: (controls: DownloadControls) => Promise<DownloadControls>;
    onUpdate: (callback: (jobs: DownloadJob[]) => void) => () => void;
  };
  menu: {
    onNewChat: (callback: () => void) => () => void;
    onOpenSettings: (callback: () => void) => () => void;
  };
  data: {
    exportSession: (id: string) => Promise<{ success: boolean }>;
    exportSessionMarkdown: (id: string) => Promise<{ success: boolean }>;
    getSessionMarkdown: (id: string) => Promise<string | null>;
    exportAll: () => Promise<{ success: boolean }>;
    import: () => Promise<{ imported: number }>;
    getUserDataPath: () => Promise<string>;
    openUserDataFolder: () => Promise<void>;
    exportPromptPresets: (presets: PromptPreset[]) => Promise<{ success: boolean }>;
    importPromptPresets: () => Promise<PromptPreset[]>;
  };
  projects: {
    list: () => Promise<Project[]>;
    create: (name: string) => Promise<Project>;
    update: (id: string, partial: Partial<Pick<Project, "name" | "instructions" | "params">>) => Promise<Project | null>;
    delete: (id: string) => Promise<void>;
  };
  rag: {
    indexFolder: (input: { folderPath: string; folderName: string; files: AttachedFile[] }) => Promise<RagCollectionSummary>;
    query: (collectionId: string, query: string, topK?: number) => Promise<RagResult[]>;
    listCollections: () => Promise<RagCollectionSummary[]>;
    deleteCollection: (id: string) => Promise<void>;
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
    closeWorkspace: (workspaceRoot: string) => Promise<{ killedBackgroundTasks: number; killedTerminals: number }>;
    getSandboxCapabilities: () => Promise<SandboxCapabilities>;
  };
  terminal: {
    create: (
      workspaceRoot: string,
      opts: { cwd?: string; name?: string },
      onData: (chunk: string) => void,
      onExit: (exitCode: number) => void
    ) => Promise<{ id: string; name: string }>;
    write: (id: string, data: string) => Promise<void>;
    resize: (id: string, cols: number, rows: number) => Promise<void>;
    close: (id: string) => Promise<void>;
    list: (workspaceRoot?: string) => Promise<TerminalInfo[]>;
  };
  mcp: {
    connect: (
      config: McpServerConfig
    ) => Promise<{ tools?: { name: string; description?: string; inputSchema?: Record<string, unknown> }[]; error?: string }>;
    disconnect: (id: string) => Promise<void>;
    status: () => Promise<Record<string, McpServerStatus>>;
  };
  screen: {
    listSources: () => Promise<ScreenSourceInfo[]>;
    capture: (sourceId: string) => Promise<ScreenCaptureResult>;
  };
  figma: {
    fetchFrame: (url: string) => Promise<FigmaFetchResult>;
  };
  ocr: {
    recognize: (imageBase64: string) => Promise<OcrResult>;
  };
  huggingface: {
    search: (query: string) => Promise<{ results?: HfModelSummary[]; error?: string }>;
    listFiles: (modelId: string) => Promise<{ files?: HfGgufFile[]; error?: string }>;
    downloadFile: (
      modelId: string,
      filename: string,
      onProgress: (progress: HfDownloadProgress) => void
    ) => Promise<{ path?: string; error?: string }>;
  };
}

declare global {
  interface Window {
    api: ElectronApi;
  }
}
