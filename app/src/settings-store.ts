import * as path from "node:path";
import { app } from "electron";
import { readJson, readJsonWithSchema, writeJson } from "./json-store";
import { appSettingsSchema } from "./schemas";
import { getManagedSettings, isSettingManaged, MANAGED_SETTING_KEYS } from "./policy-store";
import type { ManagedSettingKey } from "./policy-store";
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
    temperature: number;
    topP: number;
    maxTokens: number;
    frequencyPenalty: number;
    presencePenalty: number;
    contextLength: number;
    // undefined = auto (the built-in llama.cpp runtime's own GPU-layer
    // placement heuristic — see resolveGpuLayers in llamacpp-manager.ts).
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
    llamaCppModelsDir?: string;
    llamaCppGpuBackend?: "auto" | "vulkan" | "cuda" | "metal" | "cpu";
    // Embedding model used to index new RAG collections. Existing collections
    // keep whatever model they were created with (stored per-collection in
    // rag.db) — this only governs newly created ones. Either a bare Ollama
    // tag (legacy — no longer selectable in Settings, but an existing
    // collection can still reference one) or "llamacpp:<relative-gguf-path>"
    // — see rag.ts's parseEmbeddingModelRef.
    ragEmbeddingModel?: string;
    // Which backend runs a model. "automatic" (the default) picks per-model
    // based on file format and detected hardware — see resolveAutomaticRuntime
    // in system-specs.ts. Any other value pins every recommendation/download
    // to that one backend regardless of format/hardware fit.
    preferredRuntime?: "automatic" | "llamacpp" | "vllm" | "mlx";
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
    // Custom directory for the SQLite audit database (audit-log.sqlite3, +
    // its -wal/-shm sidecars) when auditLogBackend is "sqlite" — unset means
    // the default userData folder, same as every other store. Read live on
    // every call (audit-log-store.ts's sqliteDbPath()), not applied once at
    // startup, so a change takes effect immediately.
    auditLogSqliteDir?: string;
    // Selects a registered MedicationSafetyProvider by name (see
    // medical-safety.ts's provider registry) — unset means "whatever's
    // already active" (the built-in demonstration list by default). Only
    // ever a name, never a provider object/credentials/endpoint — those
    // belong to the provider implementation itself, not to persisted config.
    medicationSafetyProviderId?: string;
    // Selects a registered PatientCasesBackend by name (see
    // patient-cases-store.ts's backend registry) — unset means "whatever's
    // already active" (the local, this-device-only JSON store by default).
    // Only ever a name, never connection details/credentials — those belong
    // to the backend implementation itself, not to persisted config.
    patientCasesBackendId?: string;
    // Selects a registered SessionsBackend by name (see sessions-store.ts's
    // backend registry) — same unset/"local by default" contract as
    // patientCasesBackendId above.
    sessionsBackendId?: string;
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
    runtimeGpuConfigs?: Partial<Record<"llamacpp" | "mlx" | "rocm" | "vllm", RuntimeGpuConfig>>;
    // The resource-orchestrator's cross-workload OS-reserve budget mode —
    // see resource-budget.ts. Distinct from llamaCppVramReserveGB/
    // llamaCppRamReserveGB above, which only configure node-llama-cpp's own
    // internal context-sizing math for that one backend.
    resourceBudgetMode?: "balanced" | "performance" | "efficient" | "manual";
    // Only consulted when resourceBudgetMode === "manual".
    resourceMaxRamMB?: number;
    resourceMaxVramMB?: number;
    resourceCpuThreadCeiling?: number;
    resourceRuntimeProfile?: "interactive" | "balanced" | "throughput" | "energy-efficient";
    // Opt-in: makes this install act as a compute-control-plane fleet agent
    // (compute-agent.ts) on top of an already-connected shared backend. Off
    // by default — standalone operation never depends on this.
    computeAgentEnabled?: boolean;
    // The node id an organization compute admin assigned this install via
    // POST /compute/nodes — see compute-agent.ts's own doc comment.
    computeNodeId?: string;
}

const DEFAULTS: AppSettings = {
    defaultModel: null,
    temperature: 0.7,
    topP: 1,
    // Local 3B/4B models should finish ordinary answers promptly. Users can
    // still raise this per chat/project for long-form generation.
    maxTokens: 512,
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

// docs/LOCAL_INFERENCE_HARDENING_PLAN.md: Ollama removal. appSettingsSchema
// is .passthrough(), so an old settings.json's now-unrecognized `ollamaHost`/
// `modelsDir` fields are harmless — they just ride along unused, and
// `runtimeGpuConfigs` is validated as a generic `Record<string, ...>` (see
// its own schema comment), so a stray `runtimeGpuConfigs.ollama` key doesn't
// fail validation either. `preferredRuntime` is the one genuinely dangerous
// case: it's a *recognized* field with a closed z.enum(), "ollama" is no
// longer a member, and zod fails the *entire* object's .safeParse() over one
// invalid enum value, not just that field. Without this pre-pass,
// readJsonWithSchema's existing (correct, for genuine corruption) "back up
// and reset to defaults" behavior would silently wipe every setting a user
// with `preferredRuntime: "ollama"` had ever configured. Also drops the
// now-fully-vestigial `runtimeGpuConfigs.ollama` entry while here, though
// that part is tidiness, not a crash-prevention necessity. Runs once per
// process (guarded by `migratedLegacyRuntimeSettings`), since getSettings()
// is called frequently and the fix is idempotent after the first successful
// run.
let migratedLegacyRuntimeSettings = false;

/** Test-only — same pattern as policy-store.ts's resetPolicyStateForTests().
 * Lets a test observe the migration actually running against a freshly
 * written legacy-shaped settings.json, instead of the guard having already
 * flipped true from an earlier getSettings() call in the same process. */
export function __resetLegacyRuntimeSettingsMigrationForTests(): void {
    migratedLegacyRuntimeSettings = false;
}

function migrateLegacyRuntimeSettings(): void {
    if (migratedLegacyRuntimeSettings) return;
    migratedLegacyRuntimeSettings = true;
    const raw = readJson<Record<string, unknown> | null>(filePath(), null);
    if (!raw || typeof raw !== "object") return;

    let changed = false;
    if (raw.preferredRuntime === "ollama") {
        raw.preferredRuntime = "automatic";
        changed = true;
    }
    const runtimeGpuConfigs = raw.runtimeGpuConfigs;
    if (runtimeGpuConfigs && typeof runtimeGpuConfigs === "object" && "ollama" in runtimeGpuConfigs) {
        delete (runtimeGpuConfigs as Record<string, unknown>).ollama;
        changed = true;
    }
    if (changed) writeJson(filePath(), raw);
}

// Managed settings (see policy-store.ts) always win over whatever's in
// settings.json — applied last, after DEFAULTS and the stored file, so a
// verified organization policy overrides a locally-saved value regardless of
// how or when that local value was set (including a value that predates the
// policy ever existing). This is the single choke point every caller of
// getSettings() shares (agent-tools.ts's network-tool gate among them), so
// enforcement doesn't depend on each call site separately checking policy.
export function getSettings(): AppSettings {
    migrateLegacyRuntimeSettings();
    const stored = readJsonWithSchema(filePath(), {}, appSettingsSchema) as Partial<AppSettings>;
    return { ...DEFAULTS, ...stored, ...getManagedSettings() };
}

/** Which of the given patch's keys are currently policy-managed, and would
 * therefore have no effect if written — for a caller (settings:save's IPC
 * handler) to report back to the renderer, so "I changed it and it silently
 * didn't take" has an explanation rather than being a confusing no-op. Pure:
 * does not itself save or filter anything. */
export function getRejectedPolicyKeys(partial: Partial<AppSettings>): ManagedSettingKey[] {
    return MANAGED_SETTING_KEYS.filter((key): key is ManagedSettingKey => key in partial && isSettingManaged(key));
}

// A managed field is silently stripped from `partial` before merging — the
// write happens as if that key was never in the patch at all, rather than
// writing it to settings.json and relying solely on getSettings()'s overlay
// to hide it. Belt-and-braces: getSettings() already guarantees a managed
// field's value is never *observed* as the local one, but not writing it in
// the first place also means it can't take effect the moment policy is later
// removed (a managed value silently "coming back" would be surprising).
export function saveSettings(partial: Partial<AppSettings>): AppSettings {
    const filtered: Partial<AppSettings> = { ...partial };
    for (const key of getRejectedPolicyKeys(partial)) delete filtered[key];
    const merged = { ...getSettings(), ...filtered };
    writeJson(filePath(), merged);
    return merged;
}
