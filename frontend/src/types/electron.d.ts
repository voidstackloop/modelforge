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
  // Provider-qualified model ref captured for the request that produced an
  // assistant message. Older saved messages legitimately leave this unset.
  model?: string;
  // Preserve the message in the transcript while excluding it from future
  // model context (for example, a renderer-created runtime error card).
  excludedFromContext?: boolean;
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

export interface GpuCapabilities {
  cuda: boolean;
  rocm: boolean;
  metal: boolean;
  vulkan: boolean;
  directml: boolean;
}

export interface GpuInfo {
  name: string;
  vramGB: number | null;
  vendor: string;
  id?: string;
  index?: number;
  busId?: string | null;
  driverVersion?: string | null;
  architecture?: string | null;
  usedVramGB?: number | null;
  freeVramGB?: number | null;
  isIntegrated?: boolean;
  computeAvailable?: boolean;
  displayOnly?: boolean;
  migInfo?: string | null;
  capabilities?: GpuCapabilities;
  compatibilityIssue?: string | null;
  lastProbedAt?: number;
}

export interface GpuTopology {
  interconnect: "nvlink" | "xgmi" | "pcie" | "unified" | "none" | "unknown";
  homogeneous: boolean;
  deviceCount: number;
  aggregateVramGB: number | null;
  smallestGpuVramGB: number | null;
  largestGpuVramGB: number | null;
  usableVramGB: number | null;
  peerToPeerCapable: boolean;
  tensorParallelRecommended: boolean;
  layerSplitOnly: boolean;
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
  gpuInterconnect: "nvlink" | "xgmi" | "pcie" | "unified" | "none" | "unknown";
  tensorParallelSupported: boolean;
  gpuTopology: GpuTopology;
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
  recommendedRuntime: "llamacpp" | "vllm" | "mlx";
  reason: string;
  huggingFaceSearchQuery: string;
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

export interface GgufAssessmentInput {
  modelId: string;
  filename: string;
  sizeBytes: number | null;
}

export interface GgufAssessment {
  modelId: string;
  filename: string;
  canAssess: boolean;
  fits: boolean | null;
  outcome: RecommendedModel["outcome"] | "Unknown size";
  quantization: string;
  estimatedParametersB: number | null;
  estimatedWeightGB: number | null;
  estimatedKvCacheGB: number | null;
  runtimeOverheadGB: number | null;
  totalRequiredGB: number | null;
  expectedGpuOffloadPercent: number | null;
  estimatedTokensPerSecond: number | null;
  recommendedRuntime: "llamacpp";
  reason: string;
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
  trustProfile?: { autoApprovedTools: string[] };
  auth?: { type: "none" | "oauth2" };
  blockedTools?: string[];
  warningBanner?: string;
}

export interface McpServerToolSummary {
  name: string;
  description?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
}

export interface McpServerStatus {
  connected: boolean;
  toolCount: number;
  protocolVersion?: string;
  error?: string;
  tools: McpServerToolSummary[];
}

export interface AppActivity {
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

// A stored energy record from before Ollama support was removed may still
// carry the historical "ollama" runtime tag — accepted structurally
// wherever this type is read back, but never produced going forward.
export type EnergyRuntime = "llamacpp" | "vllm" | "mlx" | "transformers";
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
  state: "starting" | "running" | "stopping" | "restarting" | "unhealthy" | "failed" | "stopped";
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
  activeRequests: number;
  idleTimeoutMinutes: number;
  lastHealthCheckAt: string | null;
  operation: "starting" | "stopping" | "restarting" | null;
  currentConfig?: RuntimeStartupConfig;
  errorCategory?: string;
  recoveryAction?: string;
  commandCapabilities?: RuntimeCommandCapabilities;
}

export type GpuSelectionMode = "auto" | "single" | "group" | "all" | "cpu";

export interface GpuSelection {
  mode: GpuSelectionMode;
  // Stable GpuInfo.id values, in display/selection order.
  deviceIds: string[];
}

export interface RuntimeStartupConfig {
  contextLength?: number | null; idleTimeoutMinutes?: number; device?: "auto" | "cpu" | "gpu";
  gpuLayerMode?: "auto" | "cpu" | "max" | "manual"; gpuLayers?: number; cpuThreads?: number; cpuBatchThreads?: number;
  flashAttention?: "auto" | boolean; batchSize?: number; vramReserveGB?: number;
  gpuMemoryUtilization?: number; tensorParallelSize?: number; pipelineParallelSize?: number; cpuOffloadGB?: number; swapSpaceGB?: number;
  gpuSelection?: GpuSelection;
  tensorSplit?: number[];
  splitMode?: "layer" | "tensor";
  mainGpuId?: string;
}

export interface ResolvedGpuSelection {
  gpus: GpuInfo[];
  stale: boolean;
  missingIds: string[];
}

export interface GpuTelemetrySample {
  id: string;
  index: number;
  vendor: string;
  utilizationPercent: number | null;
  usedVramGB: number | null;
  freeVramGB: number | null;
  temperatureC: number | null;
  powerWatts: number | null;
  powerLimitWatts: number | null;
  source: "nvidia-smi" | "rocm-smi";
  confidence: "high" | "medium" | "low";
  lastUpdatedAt: number;
}

// Mirrors app/src/resource-contracts.ts — kept in sync by hand, same as
// every other type in this file (frontend/ and app/ are separate packages
// with no shared type import path). PHI-safe by construction: workload-kind
// enums, numeric capacity/budget, and lease/queue bookkeeping only, never
// prompt content or file paths.
export type ResourceWorkloadKind =
  | "active-inference" | "user-ocr" | "user-rag" | "user-media" | "model-load"
  | "scheduled-inference" | "embedding" | "indexing" | "download" | "backup"
  | "maintenance" | "python-worker" | "mcp-tool";
export type ResourcePriority =
  | "active-inference" | "user-interactive" | "explicit-model-load"
  | "scheduled-inference" | "background-compute" | "transfer" | "maintenance";
export type ResourcePressureLevel = "normal" | "warning" | "critical";
export interface ResourceBudget {
  cpuThreads: number;
  ramMB: number;
  acceleratorDeviceIds: string[];
  vramMB: number;
  exclusiveAccelerator: boolean;
}
export interface ResourceActiveLease {
  leaseId: string;
  workloadKind: ResourceWorkloadKind;
  priority: ResourcePriority;
  decision: "granted" | "granted-degraded";
  budget: ResourceBudget;
  reasons: string[];
  grantedAt: number;
  expiresAt: number;
}
export interface ResourceQueuedRequest {
  workloadKind: ResourceWorkloadKind;
  priority: ResourcePriority;
  queuedAt: number;
}
export interface ResourceTelemetry {
  capturedAt: number;
  capacity: {
    cpuThreads: number;
    availableCpuThreads: number;
    totalRamMB: number;
    availableRamMB: number;
    gpuCount: number;
    availableGpuCount: number;
  } | null;
  activeLeases: ResourceActiveLease[];
  queuedRequests: ResourceQueuedRequest[];
  pressure: ResourcePressureLevel;
}

export interface RuntimeGpuConfig {
  selection?: GpuSelection;
  tensorSplit?: number[];
  splitMode?: "layer" | "tensor";
  mainGpuId?: string;
  tensorParallelSize?: number;
  memoryReserveGB?: number;
}

export interface StopRuntimeResult { stopped: boolean; activeRequests: number; forced: boolean }

export interface RuntimeCommandCapabilities { checked: boolean; flags: string[]; backendDeviceNames: string[]; warnings: string[] }

export interface LlamaCppRuntimeInfo {
  requestedBackend: LlamaCppGpuBackend; activeBackend: string | null; supportsGpuOffloading: boolean | null;
  cpuMathCores: number | null; maxThreads: number | null; vramPaddingBytes: number | null; ramPaddingBytes: number | null;
  gpuDeviceNames: string[]; vramState: { total: number; used: number; free: number; unifiedSize: number } | null;
  swapState: { maxSize: number; allocated: number; used: number } | null;
  loadedModels: { path: string; gpuLayers: number; totalLayers: number; flashAttentionSupported: boolean; activeGenerations: number }[];
}

export interface PythonEnvironmentStatus {
  family: "mlx" | "vllm-cuda" | "vllm-rocm" | "hardware-recommender";
  state: "missing" | "healthy" | "drifted" | "incompatible";
  destination: string; pythonPath: string; pythonVersion: string | null; installedPackages: Record<string, string>; issues: string[];
  manifest: { family: string; version: number; python: string; packages: Record<string, string>; diskRequirementBytes: number; expectedDownloadBytes: number; protocolVersion: number; compatibility: string; documentationUrl: string };
  installCommand: string; repairCommand: string; removeCommand: string;
}
export interface PythonEnvironmentProgress { step: number; totalSteps: number; message: string; stream: "manager" | "stdout" | "stderr" }

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
  sha256?: string;
}

export interface HfDownloadProgress {
  receivedBytes: number;
  totalBytes: number | null;
}

export type DownloadJobState = "queued" | "resolving" | "downloading" | "paused" | "verifying" | "installing" | "ready" | "failed" | "cancelled";
export interface DownloadShard {
  filename: string; path: string; expectedBytes: number; receivedBytes: number; sha256?: string; etag?: string; state: DownloadJobState;
  verificationState?: "pending" | "verifying" | "verified" | "unavailable" | "failed";
}
export interface DownloadJob {
  id: string; kind: "huggingface"; modelName: string; publisher: string; quantization?: string;
  backend: "llamacpp" | "mlx" | "vllm" | "transformers"; destinationDir: string; modelId: string;
  shards: DownloadShard[]; state: DownloadJobState; retryCount: number; maxAttempts: number; nextRetryAt?: string;
  retryHistory: { attempt: number; at: string; errorKind: string; message: string }[]; createdAt: string; updatedAt: string;
  error?: { message: string; kind: string; retryable: boolean };
  jobReceivedBytes?: number; totalBytes?: number; bytesPerSecond?: number; etaSeconds?: number; recoveredAtStartup?: boolean;
}
export interface DownloadControls { concurrency: number; bandwidthMbps: number }
export interface DiskForecast { requiredBytes: number; availableBytes: number | null; enough: boolean | null; reserveBytes: number; destination: string }

export interface LinkedAccount {
  provider: "github" | "huggingface";
  username: string;
  displayName: string | null;
  avatarUrl: string | null;
  profileUrl: string;
}

// Mirrors app/src/policy-store.ts's ManagedSettingKey union — the fixed,
// closed subset of AppSettings a signed organization policy can govern. Kept
// as a plain string list here (not re-derived from AppSettings) since this
// file has no runtime access to that module's MANAGED_SETTING_KEYS const.
export type ManagedSettingKey =
  | "networkToolsEnabled"
  | "verificationEnabled"
  | "verificationMaxRetries"
  | "agentMaxSteps"
  | "caseAutoLockMinutes"
  | "redactBeforeRemoteSend"
  | "auditLogRetentionDays"
  | "auditLogBackend"
  | "medicationSafetyProviderId"
  | "patientCasesBackendId"
  | "sessionsBackendId";

export interface PolicyPayload {
  version: 1;
  issuer: string;
  issuedAt: string;
  expiresAt: string;
  settings: Partial<Pick<AppSettings, ManagedSettingKey>>;
}

export type PolicyState = "unmanaged" | "active" | "expired_grace" | "invalid";

export interface PolicyStatus {
  state: PolicyState;
  policy?: PolicyPayload;
  error?: string;
  lastVerifiedAt?: string;
}

export interface BackupSummary {
  createdAt: string;
  appVersion: string;
  fileNames: string[];
}

export interface BackupSchedule {
  enabled: boolean;
  intervalHours: number;
  destinationDir: string | null;
  retentionCount: number;
  lastRunAt: string | null;
  lastError: string | null;
  lastBackupPath: string | null;
  lastCloudError: string | null;
}

export interface CloudBackupConfig {
  enabled: boolean;
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  pathStyle: boolean;
}

export interface RestoreResult {
  filesRestored: string[];
  safetySnapshotPath: string;
}

export interface AppSettings {
  defaultModel: string | null;
  temperature: number;
  topP: number;
  maxTokens: number;
  frequencyPenalty: number;
  presencePenalty: number;
  contextLength: number;
  gpuLayers?: number;
  gpuLayerMode?: "auto" | "cpu" | "max" | "manual";
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
  defaultGpuSelectionMode?: GpuSelectionMode;
  runtimeGpuConfigs?: Partial<Record<"llamacpp" | "mlx" | "rocm" | "vllm", RuntimeGpuConfig>>;
  // Cross-workload OS-reserve budget mode (resource-budget.ts) — distinct
  // from llamaCppVramReserveGB/llamaCppRamReserveGB below, which only
  // configure the llama.cpp backend's own internal context sizing.
  resourceBudgetMode?: "balanced" | "performance" | "efficient" | "manual";
  resourceMaxRamMB?: number;
  resourceMaxVramMB?: number;
  resourceCpuThreadCeiling?: number;
  computeAgentEnabled?: boolean;
  computeNodeId?: string;
  agentMaxSteps?: number;
  llamaCppMaxCachedModels?: number;
  llamaCppMaxThreads?: number;
  llamaCppVramReserveGB?: number;
  llamaCppRamReserveGB?: number;
  llamaCppNumaPolicy?: "auto" | "distribute" | "isolate" | "numactl" | "mirror";
  llamaCppBatchSize?: number;
  llamaCppFlashAttention?: "auto" | "on" | "off";
  ttsVoiceURI?: string;
  ttsAutoRead?: boolean;
  mcpServers?: McpServerConfig[];
  llamaCppModelsDir?: string;
  llamaCppGpuBackend?: "auto" | "vulkan" | "cuda" | "metal" | "cpu";
  preferredRuntime?: "automatic" | "llamacpp" | "vllm" | "mlx";
  recommendationGoal?: "quality" | "speed" | "memory" | "energy" | "agent" | "balanced";
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
  caseAutoLockMinutes?: number;
  redactBeforeRemoteSend?: boolean;
  auditLogRetentionDays?: number;
  auditLogBackend?: "json" | "sqlite";
  auditLogSqliteDir?: string;
  medicationSafetyProviderId?: string;
  patientCasesBackendId?: string;
  sessionsBackendId?: string;
}

export interface ChatOptions {
  temperature?: number;
  topP?: number;
  maxTokens?: number;
  frequencyPenalty?: number;
  presencePenalty?: number;
  contextLength?: number;
  gpuLayers?: number;
  gpuLayerMode?: "auto" | "cpu" | "max" | "manual";
  cpuThreads?: number;
  batchSize?: number;
  flashAttention?: "auto" | "on" | "off";
  performanceTracking?: boolean;
  seed?: number;
  topK?: number;
  repeatPenalty?: number;
  stop?: string[];
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
  assignedUserIds?: string[] | null;
  version?: string;
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

export type ProviderId = "openai" | "anthropic" | "llamacpp" | "gemini" | "custom" | "mlx" | "rocm" | "vllm";

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

export type CaseField<T> = SharedCaseField<T>;
export type LabResult = SharedLabResult;
export type ClinicalNoteReview = SharedClinicalNoteReview;
export type ClinicalNote = SharedClinicalNote;
export type AttachmentRef = SharedAttachmentRef;
export type CaseConsent = SharedCaseConsent;

export type PatientCasesBackendScope = "local" | "shared";

// P1 item 5 (app/src/case-offline-cache.ts) — mirrors that module's own
// SyncStatus interface; kept as a hand-maintained mirror here the same way
// every other Shared*/local type pair in this file already is.
export interface SyncStatus {
  pendingCount: number;
  oldestQueuedAt: string | null;
  lastSyncedAt: string | null;
  conflicts: { caseId: string; idempotencyKey: string; detectedAt: string }[];
}

export type PatientCase = SharedPatientCase;
export type ImagingStudy = SharedImagingStudy;
export type ImagingIngestionJob = SharedImagingIngestionJob;
export type ImagingShareGrant = SharedImagingShareGrant;
export type ViewerSession = SharedViewerSession;

export interface CreateImagingShareInput {
  mode: "internal" | "cross-organization" | "external-portal";
  recipientUserId?: string;
  recipientOrganizationId?: string;
  recipientEmail?: string;
  recipientName?: string;
  purposeOfUse: string;
  message?: string;
  expiresInHours: number;
  consentBasis: string;
}

export interface ImagingStudyDetail {
  study: ImagingStudy;
  series: Array<{ id: string; modality: string; numberOfInstances: number; description?: string }>;
  instances: Array<Array<{ id: string; seriesId: string; sopInstanceUid: string; instanceNumber?: string; hasThumbnail: boolean }>>;
}

export interface ClinicalAiModelOption { provider: SharedAiProvider; model: SharedAiProviderModel; enabled: boolean; phiAllowed: boolean; }
export interface ClinicalAiImagingOption { studyId: string; modalities: string[]; numberOfSeries: number; numberOfInstances: number; job: SharedDeidentificationJob; }
export interface ClinicalAiSubmitInput { providerModelId: string; purposeOfUse: SharedAiRequestEnvelope["purposeOfUse"]; requestedCategories: string[]; selectedDeidentificationJobIds: string[]; maxTokens?: number; }
export interface ClinicalAiRequestDetail { request: SharedAiRequestEnvelope; inputs: Array<{ id: string; requestId: string; resourceType: string; resourceId: string; includedInPrompt: boolean }>; transformations: SharedAiDataTransformation[]; outputs: Array<{ output: SharedAiOutput; citations: SharedAiCitation[]; review: SharedAiReview | null }>; }
export type MigrationPreview = SharedMigrationPreview;
export type MigrationSession = SharedMigrationSession;
export interface StagedMigrationResult {
  session: MigrationSession;
  preview: MigrationPreview;
  backupPath: string;
  recoveryKey: string;
}

export interface MedicationConflictWarning {
  kind: "allergy" | "duplicate-class" | "known-interaction";
  medication: string;
  conflictsWith: string;
  detail: string;
}

export type MedicationSafetyCoverage = "demonstration" | "clinically-authoritative";

// Mirrors app/src/medical-safety.ts's MedicationSafetyResult — see that
// file's doc comment for why `status`/`applicable`/`warnings` are kept as
// separate axes rather than collapsed into a single "did it find anything"
// boolean. In particular: `warnings.length === 0` is never sufficient on its
// own to render "no conflicts" — always check `status`/`applicable` first.
export interface MedicationSafetyResult {
  providerName: string;
  providerLabel: string;
  status: MedicationSafetyCoverage | "unavailable" | "failed";
  evaluatedAt: string;
  applicable: boolean;
  warnings: MedicationConflictWarning[];
  limitations: string;
  error?: string;
}

export type AuditActionCategory =
  | "case-created"
  | "case-updated"
  | "case-deleted"
  | "case-viewed"
  | "model-call-local"
  | "model-call-remote"
  | "mcp-tool-call"
  | "export"
  | "data-deleted"
  | "settings-changed"
  | "backup-created"
  | "backup-restored";

export interface AuditEvent {
  id: string;
  timestamp: string;
  actionCategory: AuditActionCategory;
  targetType?: "patient-case" | "session" | "export" | "settings" | "backup";
  targetId?: string;
  detail?: string;
  mcpServerId?: string;
  mcpServerName?: string;
  mcpToolName?: string;
  approvalOutcome?: "approved" | "auto-approved" | "denied";
  durationMs?: number;
  previousEventHash?: string | null;
  eventHash?: string;
}

export interface ApprovedModel {
  id: string;
  provider: string;
  modelId: string;
  approvedUseCases: string[];
  approvedBy?: string;
  approvedAt: string;
  retiredAt?: string;
}

export interface AuditChainVerificationResult {
  valid: boolean;
  checkedCount: number;
  brokenAtIndex?: number;
  reason?: string;
}

export type EvidenceSourceType = "peer-reviewed" | "guideline" | "reference-database" | "local-document" | "other";

export interface EvidenceSource {
  id: string;
  url: string;
  title: string;
  organization?: string;
  publishedOrUpdated?: string;
  retrievedAt: string;
  sourceType: EvidenceSourceType;
  excerpt?: string;
  addedAt: string;
}

// Mirrors app/src/shared-backend-config-store.ts's SharedBackendConfig —
// see that file for what each field means and why connection config lives
// in its own store rather than AppSettings or secrets.
export interface SharedBackendConfig {
  baseUrl: string;
  issuer: string;
  clientId: string;
  audience?: string;
  organizationId?: string;
}

// Mirrors packages/server/src/routes/me.ts's GET /me response shape (one entry per
// organization the connected identity has a User record in).
export interface OrganizationMembership {
  organization: { id: string; name: string; createdAt: string } | null;
  user: { id: string; displayName: string; status: string };
  effectivePolicyNames: string[];
}

export interface ElectronApi {
  llamacpp: {
    listModels: () => Promise<LocalGgufModel[]>;
    deleteModel: (name: string) => Promise<void>;
    getAvailableGpuBackends: () => Promise<string[]>;
    getModelTotalLayers: (name: string) => Promise<number>;
    getRuntimeInfo: () => Promise<LlamaCppRuntimeInfo>;
    setGpuBackend: (backend: LlamaCppGpuBackend) => Promise<void>;
    pickModelsDir: () => Promise<string | null>;
  };
  localBackends: {
    getStatuses: () => Promise<LocalRuntimeStatus[]>;
    start: (backend: "mlx" | "rocm" | "vllm", model: string, startupConfig?: RuntimeStartupConfig) => Promise<string>;
    stop: (backend: "mlx" | "rocm" | "vllm", force?: boolean) => Promise<StopRuntimeResult>;
    restart: (backend: "mlx" | "rocm" | "vllm", model: string, startupConfig?: RuntimeStartupConfig) => Promise<string>;
    clearLogs: (backend: "mlx" | "rocm" | "vllm") => Promise<void>;
    exportLogs: (backend: "mlx" | "rocm" | "vllm") => Promise<{ saved: boolean }>;
  };
  pythonRuntimes: {
    getStatuses: () => Promise<PythonEnvironmentStatus[]>;
    execute: (family: PythonEnvironmentStatus["family"], operation: "install" | "repair", onProgress: (progress: PythonEnvironmentProgress) => void) => { requestId: string; promise: Promise<PythonEnvironmentStatus> };
    cancel: (requestId: string) => Promise<void>;
  };
  chat: {
    send: (
      provider: ProviderId,
      model: string,
      messages: ChatMessage[],
      options: ChatOptions,
      onToken: (chunk: ChatChunk) => void,
      agentMode?: boolean,
      conversationId?: string
    ) => { requestId: string; promise: Promise<{ done: boolean; error?: string; aborted?: boolean }> };
    cancel: (requestId: string) => Promise<void>;
  };
  system: {
    getSpecs: () => Promise<SystemSpecs>;
    getRecommendations: () => Promise<ModelRecommendations>;
    assessGgufFiles: (files: GgufAssessmentInput[]) => Promise<GgufAssessment[]>;
    getActivity: () => Promise<AppActivity>;
  };
  gpu: {
    refreshTopology: () => Promise<SystemSpecs>;
    getTelemetry: () => Promise<GpuTelemetrySample[]>;
    resolveSelection: (selection: GpuSelection) => Promise<ResolvedGpuSelection>;
  };
  resource: {
    getTelemetry: () => Promise<ResourceTelemetry>;
  };
  settings: {
    get: () => Promise<AppSettings>;
    save: (partial: Partial<AppSettings>) => Promise<AppSettings>;
  };
  policy: {
    status: () => Promise<PolicyStatus>;
    reload: () => Promise<PolicyStatus>;
  };
  backup: {
    create: (passphrase: string) => Promise<{ success: boolean; filePath?: string }>;
    pickFile: () => Promise<{ canceled: boolean; filePath?: string }>;
    verifyFile: (filePath: string, passphrase: string) => Promise<BackupSummary>;
    restoreFile: (filePath: string, passphrase: string) => Promise<RestoreResult>;

    getSchedule: () => Promise<BackupSchedule>;
    setSchedule: (partial: Partial<Pick<BackupSchedule, "enabled" | "intervalHours" | "retentionCount">>) => Promise<BackupSchedule>;
    pickScheduleDestination: () => Promise<{ canceled: boolean; destinationDir?: string }>;
    hasAutoPassphrase: () => Promise<boolean>;
    setAutoPassphrase: (passphrase: string) => Promise<void>;
    clearAutoPassphrase: () => Promise<void>;

    getCloudConfig: () => Promise<CloudBackupConfig>;
    setCloudConfig: (partial: Partial<CloudBackupConfig>) => Promise<CloudBackupConfig>;
    hasCloudSecret: () => Promise<boolean>;
    setCloudSecret: (secretAccessKey: string) => Promise<void>;
    clearCloudSecret: () => Promise<void>;
    testCloudConnection: () => Promise<void>;
  };
  sessions: {
    list: () => Promise<ChatSession[]>;
    listBackends: () => Promise<{
      active: string;
      backends: { name: string; label: string; scope: PatientCasesBackendScope; available: boolean }[];
    }>;
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
          | "assignedUserIds"
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
    create: (input: { modelId: string; filename: string; expectedBytes: number; backend?: "automatic" | DownloadJob["backend"]; sha256?: string }) => Promise<DownloadJob>;
    pause: (id: string) => Promise<void>; resume: (id: string) => Promise<void>; retry: (id: string) => Promise<void>; retryNow: (id: string) => Promise<void>;
    cancelRetry: (id: string) => Promise<void>; cancel: (id: string) => Promise<void>; pauseAll: () => Promise<void>; resumeAll: () => Promise<void>;
    describeDeletion: (id: string) => Promise<{ partialFiles: string[]; completedFiles: string[] }>;
    removeRecord: (id: string) => Promise<void>; removePartialData: (id: string) => Promise<void>; removeCompletedModel: (id: string) => Promise<void>;
    openFolder: (id: string) => Promise<void>;
    forecast: (id: string) => Promise<DiskForecast>;
    forecastAll: () => Promise<DiskForecast[]>;
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
    executeToolWithProgress: (
      workspaceRoot: string,
      name: string,
      args: Record<string, unknown>,
      onProgress: (progress: { progress: number; total?: number; message?: string }) => void
    ) => { requestId: string; promise: Promise<{ result?: unknown; error?: string }> };
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
  patientCases: {
    list: () => Promise<PatientCase[]>;
    listBackends: () => Promise<{
      active: string;
      backends: { name: string; label: string; scope: PatientCasesBackendScope; available: boolean }[];
    }>;
    get: (id: string) => Promise<PatientCase | null>;
    create: (title: string) => Promise<PatientCase>;
    update: (id: string, partial: Record<string, unknown>, expectedVersion?: string | null) => Promise<PatientCase | null>;
    delete: (id: string, expectedVersion?: string | null) => Promise<void>;
    buildContext: (id: string) => Promise<{ text: string; includedFields: string[] } | null>;
    checkConflicts: (allergies: string[], medications: string[]) => Promise<MedicationSafetyResult>;
    grantConsent: (caseId: string, scope: CaseConsent["scope"], method: string) => Promise<PatientCase | null>;
    revokeConsent: (caseId: string, consentId: string) => Promise<PatientCase | null>;
    addNote: (caseId: string, author: ClinicalNote["author"], text: string) => Promise<PatientCase | null>;
    reviewNote: (
      caseId: string,
      noteId: string,
      reviewedBy: string,
      outcome: ClinicalNoteReview["outcome"],
      comment?: string
    ) => Promise<PatientCase | null>;
    // P1 item 5 (app/src/case-offline-cache.ts): the shared backend's
    // encrypted offline cache/outbox status — {pendingCount: 0, ...} when
    // no organization is connected (local mode), never an error.
    getSyncStatus: () => Promise<SyncStatus>;
    discardSyncConflict: (idempotencyKey: string) => Promise<void>;
  };
  audit: {
    list: () => Promise<AuditEvent[]>;
    clearAll: () => Promise<void>;
    record: (
      actionCategory: AuditActionCategory,
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
    ) => Promise<AuditEvent>;
    verifyIntegrity: () => Promise<AuditChainVerificationResult>;
    sqliteCapability: () => Promise<{ available: boolean; reason?: string; detail?: string }>;
    pickSqliteDir: () => Promise<string | null>;
    setSqliteDir: (dir: string | null) => Promise<{ customDir: string | null } | { error: string }>;
  };
  encryption: {
    status: () => Promise<{ enabled: boolean; unlocked: boolean }>;
    setup: (passphrase: string) => Promise<{ success: boolean; error?: string }>;
    unlock: (passphrase: string) => Promise<{ success: boolean }>;
    lock: () => Promise<void>;
    disable: (passphrase: string) => Promise<{ success: boolean; error?: string }>;
    changePassphrase: (oldPassphrase: string, newPassphrase: string) => Promise<{ success: boolean; error?: string }>;
  };
  modelRegistry: {
    list: () => Promise<ApprovedModel[]>;
    isActive: () => Promise<boolean>;
    isApproved: (provider: string, modelId: string) => Promise<boolean>;
    approve: (provider: string, modelId: string, approvedUseCases: string[], approvedBy?: string) => Promise<ApprovedModel>;
    retire: (id: string) => Promise<void>;
    remove: (id: string) => Promise<void>;
  };
  medicalSafety: {
    checkEmergency: (text: string) => Promise<{ isEmergency: boolean; flags: { matched: string; category: string }[] }>;
    redact: (text: string) => Promise<{ redacted: string; counts: Record<string, number> }>;
    checkCitations: (text: string, knownSourceIds: string[]) => Promise<{ unverifiedMarkers: string[]; missingCitations: boolean }>;
    listMedicationProviders: () => Promise<{ active: string; providers: { name: string; label: string; coverage: MedicationSafetyCoverage }[] }>;
  };
  evidence: {
    list: () => Promise<EvidenceSource[]>;
    addFromUrl: (url: string) => Promise<{ source?: EvidenceSource; error?: string }>;
    delete: (id: string) => Promise<void>;
  };
  sharedBackend: {
    getConfig: () => Promise<SharedBackendConfig | null>;
    setConfig: (config: SharedBackendConfig) => Promise<void>;
    clearConfig: () => Promise<void>;
    status: () => Promise<{ configured: boolean; connected: boolean }>;
    connect: () => Promise<{ connected: boolean; error?: string }>;
    disconnect: () => Promise<void>;
    listOrganizations: () => Promise<OrganizationMembership[]>;
    createOrganization: (name: string) => Promise<{ organization: { id: string; name: string }; user: { id: string } }>;
    selectOrganization: (organizationId: string) => Promise<void>;
    clearSelectedOrganization: () => Promise<void>;
    stageLocalCases: () => Promise<StagedMigrationResult>;
    activateCaseMigration: (migrationId: string) => Promise<MigrationSession>;
    rollbackCaseMigration: (migrationId: string) => Promise<MigrationSession>;
  };
  computeAgent: {
    getIdentity: () => Promise<{ fingerprint256: string }>;
    getStatus: () => Promise<{ enabled: boolean; nodeId: string | null; running: boolean }>;
  };
  imaging: {
    listStudies: (caseId: string) => Promise<ImagingStudy[]>;
    getStudy: (studyId: string) => Promise<ImagingStudyDetail>;
    listActivity: () => Promise<ImagingIngestionJob[]>;
    upload: (caseId: string, fileName: string, bytes: Uint8Array) => Promise<{ job: ImagingIngestionJob; studyId?: string; requiresReview: boolean }>;
    resolveIngestionJob: (jobId: string, decision: "attach" | "reject", caseId?: string) => Promise<{ job: ImagingIngestionJob; studyId?: string; requiresReview: boolean }>;
    listShares: (studyId: string) => Promise<ImagingShareGrant[]>;
    createShare: (studyId: string, share: CreateImagingShareInput) => Promise<{ grant: ImagingShareGrant; external?: { accessToken: string; verificationCode: string } }>;
    openViewer: (studyId: string) => Promise<{ viewerUrl: string; expiresAt: string }>;
    closeViewer: (viewerUrl: string) => Promise<void>;
  };
  clinicalAi: {
    listModels: () => Promise<ClinicalAiModelOption[]>;
    listConsents: (caseId: string) => Promise<SharedAiConsent[]>;
    createConsent: (caseId: string, consent: { purpose: SharedAiConsent["purpose"]; dataCategories: string[]; expiresAt?: string }) => Promise<SharedAiConsent>;
    revokeConsent: (caseId: string, consentId: string, reason: string) => Promise<SharedAiConsent>;
    listImagingOptions: (caseId: string) => Promise<ClinicalAiImagingOption[]>;
    preview: (caseId: string, request: ClinicalAiSubmitInput) => Promise<unknown>;
    submit: (caseId: string, request: ClinicalAiSubmitInput) => Promise<unknown>;
    listActivity: (caseId: string) => Promise<ClinicalAiRequestDetail[]>;
    review: (outputId: string, review: { decision: SharedAiReview["decision"]; correctedText?: string; escalationReason?: string }) => Promise<SharedAiReview>;
  };
  mcp: {
    connect: (
      config: McpServerConfig
    ) => Promise<{ tools?: { name: string; description?: string; inputSchema?: Record<string, unknown> }[]; error?: string }>;
    disconnect: (id: string) => Promise<void>;
    status: () => Promise<Record<string, McpServerStatus>>;
    isMastervaultBuiltinAvailable: () => Promise<boolean>;
    pickMastervaultVault: () => Promise<McpServerConfig | null>;
    cancelTool: (requestId: string) => Promise<void>;
    startOAuthFlow: (config: McpServerConfig) => Promise<{ authorized: boolean; error?: string }>;
    hasOAuthTokens: (serverId: string) => Promise<boolean>;
    clearOAuthCredentials: (serverId: string) => Promise<void>;
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
import type {
  AttachmentRef as SharedAttachmentRef,
  CaseConsent as SharedCaseConsent,
  CaseField as SharedCaseField,
  ClinicalNote as SharedClinicalNote,
  ClinicalNoteReview as SharedClinicalNoteReview,
  LabResult as SharedLabResult,
  PatientCase as SharedPatientCase,
  MigrationPreview as SharedMigrationPreview,
  MigrationSession as SharedMigrationSession,
  ImagingStudy as SharedImagingStudy,
  ImagingIngestionJob as SharedImagingIngestionJob,
  ImagingShareGrant as SharedImagingShareGrant,
  ViewerSession as SharedViewerSession,
  AiProvider as SharedAiProvider,
  AiProviderModel as SharedAiProviderModel,
  AiConsent as SharedAiConsent,
  AiRequestEnvelope as SharedAiRequestEnvelope,
  AiDataTransformation as SharedAiDataTransformation,
  AiOutput as SharedAiOutput,
  AiCitation as SharedAiCitation,
  AiReview as SharedAiReview,
  DeidentificationJob as SharedDeidentificationJob,
} from "@modelforge/contracts";
