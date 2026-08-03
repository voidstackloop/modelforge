import * as path from "node:path";
import { app } from "electron";
import { readJsonWithSchema, writeJson } from "./json-store";
import { appSettingsSchema } from "./schemas";
import type { McpServerConfig } from "./mcp-client";
import type { TimeOfUseTariff } from "./energy-types";
import type { GpuSelection, GpuSelectionMode } from "./gpu-selection";

export interface RuntimeGpuConfig {
    selection?: GpuSelection;
    // Explicit user-supplied split, or undefined = auto-generate from
    // detected per-device VRAM (see generateAutoTensorSplit in
    // gpu-selection.ts) at startup time.
    tensorSplit?: number[];
    splitMode?: "layer" | "tensor";
    mainGpuId?: string;
    tensorParallelSize?: number;
    memoryReserveGB?: number;
}

export interface PromptVersion {
    prompt: string;
    savedAt: string;
}

export interface PromptPreset {
    id: string;
    name: string;
    prompt: string;
    // Previous versions of `prompt`, newest first, capped at 10 — pushed here
    // whenever an edit overwrites the current content, so a bad edit can be
    // undone.
    versions?: PromptVersion[];
    createdAt?: string;
    updatedAt?: string;
}

export interface CustomProviderConfig {
    id: string;
    name: string;
    // Base URL up to and including the version segment, e.g.
    // "https://api.groq.com/openai/v1" — "/chat/completions" is appended.
    baseUrl: string;
    modelIds: string[];
    // Local GPU runtimes such as vLLM, LocalAI, TGI, or custom llama-server
    // builds commonly expose an unauthenticated OpenAI-compatible endpoint.
    localGpuBackend?: boolean;
}

export interface AppSettings {
    defaultModel: string | null;
    ollamaHost: string;
    // undefined = Ollama's own default location. Only takes effect the next
    // time this app (re)starts a local `ollama serve` process.
    modelsDir?: string;
    temperature: number;
    topP: number;
    maxTokens: number;
    frequencyPenalty: number;
    presencePenalty: number;
    contextLength: number;
    // undefined = auto (let Ollama decide how many layers to offload to GPU).
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
    agentMaxSteps?: number;
    llamaCppMaxCachedModels?: number;
    llamaCppMaxThreads?: number;
    llamaCppVramReserveGB?: number;
    llamaCppRamReserveGB?: number;
    llamaCppNumaPolicy?: "auto" | "distribute" | "isolate" | "numactl" | "mirror";
    llamaCppBatchSize?: number;
    llamaCppFlashAttention?: "auto" | "on" | "off";
    // Text-to-speech: which browser/OS voice to use (voiceURI from
    // speechSynthesis.getVoices(), chosen client-side) and whether assistant
    // responses should be read aloud automatically as they finish.
    ttsVoiceURI?: string;
    ttsAutoRead?: boolean;
    // MCP (Model Context Protocol) servers the user has configured. Only
    // configuration is persisted here — live connection state (process
    // handles, discovered tools) lives in mcp-client.ts and is rebuilt on
    // launch / reconnect, never serialized.
    mcpServers?: McpServerConfig[];
    // Where downloaded GGUF files for the llama.cpp backend are stored.
    // Separate from `modelsDir` (which configures Ollama's own OLLAMA_MODELS
    // directory) since the two backends use incompatible on-disk layouts.
    llamaCppModelsDir?: string;
    llamaCppGpuBackend?: "auto" | "vulkan" | "cuda" | "metal" | "cpu";
    // Embedding model used to index new RAG collections. Existing collections
    // keep whatever model they were created with (stored per-collection in
    // rag.db) — this only governs newly created ones.
    ragEmbeddingModel?: string;
    // Which backend runs a model. "automatic" (the default) picks per-model
    // based on file format and detected hardware — see resolveAutomaticRuntime
    // in system-specs.ts. Any other value pins every recommendation/download
    // to that one backend regardless of format/hardware fit.
    preferredRuntime?: "automatic" | "ollama" | "llamacpp" | "vllm" | "mlx";
    // What the hardware-recommender's "best" pick should optimize for — see
    // RecommendationGoal/pickBest in system-specs.ts. Defaults to "balanced".
    recommendationGoal?: "quality" | "speed" | "memory" | "energy" | "agent" | "balanced";
    // User-added OpenAI-compatible endpoints (Groq, Mistral, DeepSeek, xAI,
    // OpenRouter, or anything else that speaks the same API) — each one's
    // API key is stored separately via secretsStore, keyed by its id.
    customProviders?: CustomProviderConfig[];
    // Set once the first-run provider setup wizard has been completed (or
    // explicitly skipped), so it doesn't reappear on every launch.
    onboardingComplete?: boolean;
    // User-remapped shortcuts, keyed by action name, normalized as
    // "mod+shift+k" (mod = Ctrl/Cmd). Covers both menu-accelerator actions
    // (KeybindingAction, above) and renderer-only ones the frontend matches
    // in JS (command palette, shortcuts dialog) — this store doesn't
    // distinguish the two, it just persists whatever the renderer sends.
    keybindings?: Record<string, string>;
    // MLX backend (Apple Silicon): Hugging Face repo ids (e.g.
    // "mlx-community/Llama-3.2-3B-Instruct-4bit") or local paths served via
    // `python -m mlx_lm.server`.
    mlxModels?: string[];
    // Python interpreter used to launch mlx_lm.server. Default: python3.
    mlxPythonPath?: string;
    // Path to a ROCm/HIP build of llama.cpp's llama-server binary — enables
    // the "rocm" provider against the same GGUF dir as the llama.cpp backend.
    rocmServerPath?: string;
    // Hugging Face model ids or local model paths served by the app-managed
    // vLLM runtime. The `vllm` executable is discovered from PATH by default.
    vllmModels?: string[];
    vllmCommand?: string;
    // Agent-mode sandboxing. Network tools (web_search, fetch_url,
    // http_request, capture_page_screenshot, the GitHub tools) are gated by
    // this flag directly — 100% enforceable on every platform, since it's
    // just refusing to run the tool at all rather than trying to block
    // network access after the fact.
    networkToolsEnabled?: boolean;
    // Safety-net resource caps applied to run_command/run_code/background
    // commands (see resource-monitor.ts) — generous defaults, meant to catch
    // a runaway process rather than act as a real resource quota system.
    sandboxMaxMemoryMB?: number;
    sandboxMaxCpuPercent?: number;
    // Verification loop (Agent mode): once a turn ends with the model
    // calling no more tools, optionally run these command(s) for real and
    // feed the result back before treating the turn as actually finished.
    // Off by default — running commands automatically after every turn
    // would surprise anyone who didn't explicitly turn it on.
    // verificationCommands unset falls back to the workspace's detected
    // build/test scripts (see detectProjectScripts) at the point of use.
    verificationEnabled?: boolean;
    verificationCommands?: string[];
    // Distinct from agentMaxSteps — bounds verify-fail-retry cycles
    // specifically, so a persistently failing check can't loop forever.
    verificationMaxRetries?: number;
    caseAutoLockMinutes?: number;
    redactBeforeRemoteSend?: boolean;
    auditLogRetentionDays?: number;
    auditLogBackend?: "json" | "sqlite";
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
    downloadGlobalConcurrency?: number;
    downloadBandwidthMbps?: number;
    gridIntensityGCo2PerKwh?: number;
    // Default selection mode offered for a runtime that has no explicit
    // per-runtime GPU config yet. Individual runtimes in `runtimeGpuConfigs`
    // override this per-backend.
    defaultGpuSelectionMode?: GpuSelectionMode;
    // Keyed by runtime backend id. A saved config whose `selection.deviceIds`
    // no longer resolve to present hardware is never silently rewritten here —
    // see resolveGpuSelection in gpu-selection.ts, which reports staleness at
    // read time instead so the UI can offer an explicit repair action.
    runtimeGpuConfigs?: Partial<Record<"ollama" | "llamacpp" | "mlx" | "rocm" | "vllm", RuntimeGpuConfig>>;
}

const DEFAULTS: AppSettings = {
    defaultModel: null,
    ollamaHost: "http://127.0.0.1:11434",
    temperature: 0.7,
    topP: 1,
    maxTokens: 2048,
    frequencyPenalty: 0,
    presencePenalty: 0,
    contextLength: 4096,
    systemPrompt: "You are a helpful assistant.",
    promptPresets: [],
    theme: "system",
    language: "en",
    uiDensity: "comfortable",
    reduceMotion: false,
    agentMaxSteps: 25,
    llamaCppMaxCachedModels: 2,
    gpuLayerMode: "auto",
    llamaCppFlashAttention: "auto",
    networkToolsEnabled: true,
    sandboxMaxMemoryMB: 2048,
    verificationEnabled: false,
    verificationMaxRetries: 3,
    energyMonitoringEnabled: false,
    electricityPricePerKwh: 0.2,
    energyCurrency: "USD",
    timeOfUseTariffs: [],
    includeIdleSystemConsumption: true,
    energyUsageRetentionDays: 365,
    energySampleIntervalSeconds: 2,
    downloadGlobalConcurrency: 2,
    downloadBandwidthMbps: 0,
    defaultGpuSelectionMode: "auto",
};

function filePath(): string {
    return path.join(app.getPath("userData"), "settings.json");
}

export function getSettings(): AppSettings {
    const stored = readJsonWithSchema(filePath(), {}, appSettingsSchema) as Partial<AppSettings>;
    return { ...DEFAULTS, ...stored };
}

export function saveSettings(partial: Partial<AppSettings>): AppSettings {
    const merged = { ...getSettings(), ...partial };
    writeJson(filePath(), merged);
    return merged;
}
