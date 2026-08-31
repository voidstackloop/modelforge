import * as fs from "node:fs";
import * as path from "node:path";
import { createHash, randomUUID } from "node:crypto";
// node-llama-cpp is ESM with top-level await — this app compiles to
// CommonJS, and `require()`-ing an ESM module with top-level await throws
// (ERR_REQUIRE_ASYNC_MODULE) instead of loading. A plain dynamic `import()`
// doesn't dodge this: TypeScript's CommonJS output rewrites `import(x)` into
// `Promise.resolve().then(() => require(x))`, which just wraps the same
// broken require() in a promise. The only way to get Node's *real* dynamic
// import from CJS output is to hide the `import()` call from TypeScript's
// transform entirely — building it via `new Function` does that, since tsc
// can't statically see (or rewrite) an import expression inside a string.
// Type-only imports are erased at compile time and don't hit this problem,
// so those stay static.
import type {
    ChatHistoryItem,
    ChatModelFunctionCall,
    ChatModelFunctions,
    GbnfJsonSchema,
    Llama,
    LlamaChatSession,
    LlamaContext,
    LlamaContextOptions,
    LlamaModel,
    LlamaModelOptions,
    LlamaNuma,
} from "node-llama-cpp";
import type { ChatMessage, ChatChunk, ChatOptions, GpuLayerMode, ToolDefinition } from "./providers/types";
import { withInferenceResourceLock } from "./inference-resource-scheduler";
import { mainResourceOrchestrator } from "./resource-orchestrator";
import type { ResourcePriority } from "./resource-contracts";
import { estimateModelFit } from "./model-fit-estimator";
import { hasGgufMagic } from "./download-verification";
import { markBackendAttemptStarting, markBackendAttemptConfirmed } from "./llamacpp-backend-health";
import { logger } from "./logger";

export type GpuBackend = "auto" | "vulkan" | "cuda" | "metal" | "cpu";
export type LlamaCppNumaPolicy = "auto" | Exclude<LlamaNuma, false>;

export interface LlamaCppRuntimeConfig {
    maxThreads?: number;
    vramReserveBytes?: number;
    ramReserveBytes?: number;
    numa?: LlamaCppNumaPolicy;
}

export interface LlamaCppLoadedModelInfo {
    path: string;
    gpuLayers: number;
    totalLayers: number;
    flashAttentionSupported: boolean;
    activeGenerations: number;
}

export interface LlamaCppRuntimeInfo {
    requestedBackend: GpuBackend;
    activeBackend: string | null;
    supportsGpuOffloading: boolean | null;
    cpuMathCores: number | null;
    maxThreads: number | null;
    vramPaddingBytes: number | null;
    ramPaddingBytes: number | null;
    gpuDeviceNames: string[];
    vramState: { total: number; used: number; free: number; unifiedSize: number } | null;
    swapState: { maxSize: number; allocated: number; used: number } | null;
    loadedModels: LlamaCppLoadedModelInfo[];
}

type NodeLlamaCppModule = typeof import("node-llama-cpp");
const dynamicImport = new Function("specifier", "return import(specifier)") as (
    specifier: string
) => Promise<NodeLlamaCppModule>;
let modulePromise: Promise<NodeLlamaCppModule> | null = null;

// docs/LOCAL_INFERENCE_HARDENING_PLAN.md §2.5: llama.cpp has no HTTP surface
// to intercept the way e2e/fixtures/fake-ollama.ts does for Ollama (it runs
// in-process via this native addon, not as a spawned server) — before this,
// there was no way to exercise real chat/streaming/cancel/tool-calling flow
// in the e2e suite without a real GGUF model and a real native build. This
// swaps the whole module for a deterministic fake, entirely in-process,
// gated behind an env var only an e2e launch ever sets (see
// e2e/fixtures/fake-llamacpp.ts) — never reachable from a real packaged app,
// since nothing in the normal launch path ever sets this variable.
const FAKE_MODULE_ENV_VAR = "MODELFORGE_E2E_FAKE_LLAMACPP";

interface FakeChatTurn {
    tokens?: string[];
    toolCall?: { name: string; arguments: Record<string, unknown> };
    delayMs?: number;
}

// Shared, mutable state the fake classes below read from and the exported
// test-only setter writes to — module-scoped rather than passed through
// loadNodeLlamaCpp() since e2e/fixtures/fake-llamacpp.ts controls it from
// outside this process entirely, via Playwright's app.evaluate() re-
// require()-ing this same compiled file (Node's require cache guarantees
// it's the same module instance chat-dispatch.ts already loaded).
const fakeState: { nextTurn: FakeChatTurn | null; chatRequestCount: number; contextCreationCount: number; lastContextSize: number | "auto" | null } =
    { nextTurn: null, chatRequestCount: 0, contextCreationCount: 0, lastContextSize: null };

/** e2e-only control surface — see e2e/fixtures/fake-llamacpp.ts. A complete
 * no-op whenever the fake module isn't active (the common case for every
 * real launch and every non-llama.cpp-focused test), so this export is safe
 * to leave present unconditionally rather than needing its own gate. */
export function __setFakeLlamaCppNextChatTurnForTests(turn: FakeChatTurn | null): void {
    fakeState.nextTurn = turn;
}

export function __getFakeLlamaCppChatRequestCountForTests(): number {
    return fakeState.chatRequestCount;
}

export function __getFakeLlamaCppContextCreationCountForTests(): number {
    return fakeState.contextCreationCount;
}

/** The `contextSize` chat() actually asked the fake model to create — lets a
 * test observe the tool-aware sizing logic in chat() without needing a real
 * node-llama-cpp context to inspect. */
export function __getFakeLlamaCppLastContextSizeForTests(): number | "auto" | null {
    return fakeState.lastContextSize;
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

const FAKE_DEFAULT_DELAY_MS = 15;

// A deliberately small fake — only the surface llamacpp-manager.ts itself
// calls (getLlama, getLlamaGpuTypes, LlamaChatSession, LlamaChat), not a
// full node-llama-cpp reimplementation. Cast to NodeLlamaCppModule at the
// call site below rather than exhaustively typed against it.
function createFakeNodeLlamaCppModule(): NodeLlamaCppModule {
    function makeFakeModel() {
        return {
            fileInsights: { totalLayers: 32 },
            gpuLayers: 0,
            flashAttentionSupported: false,
            trainContextSize: 8192,
            // A rough ~4-chars-per-token approximation — real code only ever
            // reads the returned array's `.length`, never the token values.
            tokenize: (text: string) => new Array(Math.ceil(text.length / 4)).fill(0),
            dispose: async () => {},
            createContext: async (options: { contextSize?: number | "auto" }) => {
                fakeState.contextCreationCount++;
                fakeState.lastContextSize = options.contextSize ?? "auto";
                return {
                    getSequence: () => ({}),
                    dispose: async () => {},
                };
            },
            createEmbeddingContext: async () => ({
                getEmbeddingFor: async (input: unknown) => ({
                    vector: [0.1, 0.2, 0.3, typeof input === "string" ? input.length / 1000 : 0],
                }),
                dispose: async () => {},
            }),
        };
    }

    function makeFakeLlama() {
        return {
            gpu: "cpu",
            supportsGpuOffloading: false,
            cpuMathCores: 4,
            maxThreads: 4,
            vramPaddingSize: 0,
            ramPaddingSize: 0,
            getGpuDeviceNames: async () => [] as string[],
            getVramState: async () => ({ total: 0, used: 0, free: 0, unifiedSize: 0 }),
            getSwapState: async () => ({ maxSize: 0, allocated: 0, used: 0 }),
            dispose: async () => {},
            loadModel: async () => makeFakeModel(),
        };
    }

    // Runs one configured turn against the real onTextChunk/signal contract
    // both LlamaChatSession.prompt() and LlamaChat.generateResponse() expose
    // — shared so the two fakes below can't drift from each other.
    async function runFakeTurn(options: {
        onTextChunk?: (text: string) => void;
        signal?: AbortSignal;
    }): Promise<{ text: string; toolCall?: FakeChatTurn["toolCall"] }> {
        fakeState.chatRequestCount++;
        const turn = fakeState.nextTurn ?? { tokens: ["Hello", " from", " the", " fake", " llama.cpp", " backend."] };
        fakeState.nextTurn = null; // one-shot, matching fake-ollama.ts's own reasoning
        const delayMs = turn.delayMs ?? FAKE_DEFAULT_DELAY_MS;

        if (turn.toolCall) {
            if (delayMs) await sleep(delayMs);
            if (options.signal?.aborted) throw options.signal.reason ?? new Error("aborted");
            return { text: "", toolCall: turn.toolCall };
        }

        let text = "";
        for (const token of turn.tokens ?? []) {
            if (delayMs) await sleep(delayMs);
            if (options.signal?.aborted) throw options.signal.reason ?? new Error("aborted");
            text += token;
            options.onTextChunk?.(token);
        }
        return { text };
    }

    class FakeLlamaChatSession {
        constructor(_options: unknown) {}
        setChatHistory(_history: unknown): void {}
        dispose(): void {}
        async prompt(_text: string, options: { onTextChunk?: (text: string) => void; signal?: AbortSignal } = {}): Promise<string> {
            const { text } = await runFakeTurn(options);
            return text;
        }
    }

    class FakeLlamaChat {
        constructor(_options: unknown) {}
        async generateResponse(_history: unknown, options: { onTextChunk?: (text: string) => void; signal?: AbortSignal } = {}) {
            const { text, toolCall } = await runFakeTurn(options);
            const functionCalls = toolCall ? [{ functionName: toolCall.name, params: toolCall.arguments, raw: "" }] : undefined;
            return {
                response: text,
                fullResponse: [text],
                functionCalls,
                lastEvaluation: { cleanHistory: [], contextWindow: [], contextShiftMetadata: null },
                metadata: { stopReason: functionCalls ? "functionCalls" : "eogToken" },
            };
        }
    }

    return {
        getLlama: async () => makeFakeLlama(),
        getLlamaGpuTypes: async () => ["cpu"],
        LlamaChatSession: FakeLlamaChatSession,
        LlamaChat: FakeLlamaChat,
        readGgufFileInfo: async () => ({}),
        // A fixed, plausible layer count — e2e specs only need
        // getModelTotalLayers() to resolve to *some* finite number, not to
        // reflect any particular fixture's real architecture.
        GgufInsights: { from: async () => ({ totalLayers: 32 }) },
    } as unknown as NodeLlamaCppModule;
}

function loadNodeLlamaCpp(): Promise<NodeLlamaCppModule> {
    if (!modulePromise) {
        modulePromise = process.env[FAKE_MODULE_ENV_VAR] === "1"
            ? Promise.resolve(createFakeNodeLlamaCppModule())
            : dynamicImport("node-llama-cpp");
    }
    return modulePromise;
}

let llamaInstance: Llama | null = null;
let llamaInstancePromise: Promise<Llama> | null = null;
let activeBackend: GpuBackend = "auto";
let backendRevision = 0;
let runtimeConfig: LlamaCppRuntimeConfig = {};
// Set synchronously before a backend/runtime-config transition waits on the
// global inference lock. New generations check this gate both before and
// after model loading, closing the cached-model race where native state could
// otherwise be disposed between `loadModel()` returning and context creation.
let runtimeReconfigurationsPending = 0;
let backendProbeCache: { values: string[]; expiresAt: number } | null = null;
// Loaded model weights are the expensive, slow-to-load part (can be several
// GB) — kept warm across chat turns. The lightweight per-turn context/session
// below is deliberately NOT cached across turns; see chat() for why.
const modelCache = new Map<string, LlamaModel>();
const modelLoads = new Map<string, Promise<LlamaModel>>();
const modelLastUsed = new Map<string, number>();
const activeModelUsers = new Map<string, number>();
interface CachedConversation {
    modelCacheKey: string;
    contextConfigKey: string;
    context: LlamaContext;
    session: LlamaChatSession;
    expectedPriorHistory: string;
    inUse: boolean;
    lastUsedAt: number;
}
// One warm interactive conversation gives the common follow-up path KV-cache
// reuse without allowing inactive chats to accumulate large context buffers
// in VRAM. Switching chats evicts the previous context; model weights remain
// governed independently by maxCachedModels.
const conversationCache = new Map<string, CachedConversation>();
let maxCachedModels = 2;
// Keep warm weights for fast follow-up prompts, then release their RAM/VRAM
// after inactivity. Headless deployments can override the default without a
// new UI setting; 0 disables time-based eviction.
const configuredIdleMinutes = Number(process.env.MODELFORGE_LLAMACPP_IDLE_MINUTES ?? 15);
const modelIdleTimeoutMs = Number.isFinite(configuredIdleMinutes)
    ? Math.max(0, configuredIdleMinutes) * 60_000
    : 15 * 60_000;
let idleEvictionTimer: NodeJS.Timeout | null = null;

function clearIdleEvictionTimer(): void {
    if (!idleEvictionTimer) return;
    clearTimeout(idleEvictionTimer);
    idleEvictionTimer = null;
}

function scheduleIdleEviction(): void {
    clearIdleEvictionTimer();
    if (modelIdleTimeoutMs === 0 || modelCache.size === 0) return;

    const now = Date.now();
    const nextExpiry = [...modelCache.keys()]
        .filter((key) => (activeModelUsers.get(key) ?? 0) === 0)
        .map((key) => (modelLastUsed.get(key) ?? now) + modelIdleTimeoutMs)
        .sort((a, b) => a - b)[0];
    if (nextExpiry === undefined) return;

    idleEvictionTimer = setTimeout(() => {
        idleEvictionTimer = null;
        void evictExpiredModels();
    }, Math.max(1_000, nextExpiry - now));
    idleEvictionTimer.unref();
}

async function evictExpiredModels(): Promise<void> {
    const cutoff = Date.now() - modelIdleTimeoutMs;
    const expiredModels: LlamaModel[] = [];
    for (const [key, model] of modelCache) {
        if ((activeModelUsers.get(key) ?? 0) > 0) continue;
        if ((modelLastUsed.get(key) ?? 0) > cutoff) continue;
        modelCache.delete(key);
        modelLastUsed.delete(key);
        expiredModels.push(model);
    }
    await Promise.allSettled(expiredModels.map((model) => model.dispose()));
    scheduleIdleEviction();
}

export function setModelCacheLimit(limit: number): void {
    if (!Number.isFinite(limit)) return;
    maxCachedModels = Math.max(1, Math.min(Math.floor(limit), 8));
    void evictIdleModels();
}

export function normalizeLlamaCppRuntimeConfig(input: LlamaCppRuntimeConfig = {}): LlamaCppRuntimeConfig {
    const integer = (value: number | undefined, maximum: number): number | undefined => {
        if (value === undefined) return undefined;
        if (!Number.isFinite(value)) throw new Error("llama.cpp runtime settings must be finite numbers.");
        return Math.max(1, Math.min(maximum, Math.floor(value)));
    };
    const bytes = (value: number | undefined): number | undefined => {
        if (value === undefined) return undefined;
        if (!Number.isFinite(value) || value < 0) throw new Error("llama.cpp memory reserves must be finite non-negative byte counts.");
        return Math.min(Number.MAX_SAFE_INTEGER, Math.floor(value));
    };
    const numa = input.numa ?? "auto";
    if (!["auto", "distribute", "isolate", "numactl", "mirror"].includes(numa)) throw new Error("Unsupported llama.cpp NUMA policy.");
    return { maxThreads: integer(input.maxThreads, 512), vramReserveBytes: bytes(input.vramReserveBytes), ramReserveBytes: bytes(input.ramReserveBytes), numa };
}

export function resolveGpuLayers(mode: GpuLayerMode | undefined, manualLayers: number | undefined, contextLength?: number): LlamaModelOptions["gpuLayers"] {
    const resolvedMode = mode ?? (manualLayers === undefined ? "auto" : manualLayers === 0 ? "cpu" : "manual");
    if (resolvedMode === "cpu") return 0;
    // Explicitly include the requested context in node-llama-cpp's model
    // placement calculation. Plain "auto" only reserves space for an
    // automatically-sized context, which can over-offload weights and then
    // fail when the user requests a larger context.
    if (resolvedMode === "auto") {
        return contextLength && Number.isFinite(contextLength)
            ? { fitContext: { contextSize: Math.max(512, Math.floor(contextLength)) } }
            : "auto";
    }
    // Advanced escape hatch: request every layer and let node-llama-cpp fail
    // clearly when current VRAM cannot hold it.
    if (resolvedMode === "max") return "max";
    if (!Number.isInteger(manualLayers) || manualLayers! < 0) throw new Error("Manual GPU layer mode requires a non-negative integer layer count.");
    return manualLayers;
}

// Guards a load against a corrupted, mislabeled, or tampered file — a cheap,
// independent sanity check (see download-verification.ts's own comment on
// hasGgufMagic) that this codebase already had but never actually wired into
// any load path (docs/LOCAL_INFERENCE_HARDENING_PLAN.md §4). Not a substitute
// for the Hugging Face download path's own checksum verification — this
// catches a file that arrived by any *other* means (a manual copy, a
// compromised sync folder, another app writing into the models directory)
// where no reference checksum exists to compare against at all.
export function assertValidGgufFile(modelPath: string): void {
    if (!hasGgufMagic(modelPath)) {
        throw new Error(`"${modelPath}" does not look like a valid GGUF model file (missing GGUF magic header) — refusing to load it.`);
    }
}

function modelCacheKey(modelPath: string, gpuLayers: LlamaModelOptions["gpuLayers"]): string {
    return `${modelPath}\0${JSON.stringify(gpuLayers)}`;
}

function historyFingerprint(messages: ChatMessage[]): string {
    return createHash("sha256").update(JSON.stringify(toHistory(messages))).digest("hex");
}

async function disposeCachedConversation(key: string, expected?: CachedConversation): Promise<void> {
    const entry = conversationCache.get(key);
    if (!entry || (expected && entry !== expected)) return;
    conversationCache.delete(key);
    entry.session.dispose({ disposeSequence: false });
    await entry.context.dispose();
    const users = Math.max(0, (activeModelUsers.get(entry.modelCacheKey) ?? 1) - 1);
    if (users === 0) activeModelUsers.delete(entry.modelCacheKey);
    else activeModelUsers.set(entry.modelCacheKey, users);
    modelLastUsed.set(entry.modelCacheKey, Date.now());
}

async function releaseNativeState(): Promise<void> {
    const oldConversations = [...conversationCache.values()];
    const oldModels = [...modelCache.values()];
    const oldLlama = llamaInstance;
    backendRevision++;
    llamaInstance = null;
    llamaInstancePromise = null;
    modelCache.clear();
    modelLoads.clear();
    modelLastUsed.clear();
    activeModelUsers.clear();
    conversationCache.clear();
    clearIdleEvictionTimer();
    for (const entry of oldConversations) entry.session.dispose({ disposeSequence: false });
    await Promise.allSettled(oldConversations.map((entry) => entry.context.dispose()));
    await Promise.allSettled([
        ...oldModels.map((model) => model.dispose()),
        ...(oldLlama ? [oldLlama.dispose()] : []),
    ]);
}

function hasActiveGenerations(): boolean {
    return [...activeModelUsers.values()].some((users) => users > 0);
}

function assertGenerationCanStart(): void {
    if (runtimeReconfigurationsPending > 0) {
        throw new Error("llama.cpp is changing its backend or runtime configuration. Retry when the transition finishes.");
    }
}

async function withRuntimeReconfiguration<T>(operation: string, activeError: string, task: () => Promise<T>): Promise<T> {
    if (hasActiveGenerations()) throw new Error(activeError);
    runtimeReconfigurationsPending++;
    try {
        return await withInferenceResourceLock(operation, async () => {
            // A generation may have passed its first gate just before this
            // transition was announced. Recheck after all earlier model-load
            // operations have drained and refuse rather than disposing live
            // contexts or model weights.
            if (hasActiveGenerations()) throw new Error(activeError);
            return task();
        });
    } finally {
        runtimeReconfigurationsPending = Math.max(0, runtimeReconfigurationsPending - 1);
    }
}

async function probeGpuBackend(backend: GpuBackend): Promise<void> {
    const { getLlama } = await loadNodeLlamaCpp();
    await getLlama({
        gpu: backend === "cpu" ? false : backend,
        build: "never",
        skipDownload: true,
        dryRun: true,
    });
}

export async function setGpuBackend(backend: GpuBackend): Promise<void> {
    if (!["auto", "vulkan", "cuda", "metal", "cpu"].includes(backend)) {
        throw new Error(`Unsupported llama.cpp GPU backend: ${String(backend)}`);
    }
    if (backend === activeBackend && runtimeReconfigurationsPending === 0) {
        // The default backend is "auto", which is also activeBackend's
        // initial value. Returning here used to defer native backend startup
        // until the first chat, making that first basic question absorb all
        // initialization latency. Initialize now while the app is starting.
        await getLlamaInstance();
        return;
    }
    const activeError = "The GPU backend cannot be changed while a llama.cpp response is being generated.";
    await withRuntimeReconfiguration(`llamacpp:backend:${backend}`, activeError, async () => {
        if (backend === activeBackend) return;
        const previousBackend = activeBackend;

        // Validate the exact prebuilt backend before releasing the currently
        // working instance. Then initialize a real Llama instance before the
        // IPC call succeeds, so the renderer never persists a backend that
        // only passed a dry-run probe but failed actual initialization.
        await probeGpuBackend(backend);
        await releaseNativeState();
        activeBackend = backend;
        try {
            await getLlamaInstance();
        } catch (switchError) {
            await releaseNativeState();
            activeBackend = previousBackend;
            try {
                await getLlamaInstance();
            } catch (rollbackError) {
                throw new Error(
                    `Failed to initialize llama.cpp backend "${backend}", and restoring "${previousBackend}" also failed: ${(rollbackError as Error).message}`,
                    { cause: switchError },
                );
            }
            throw new Error(
                `Failed to initialize llama.cpp backend "${backend}"; restored "${previousBackend}". ${(switchError as Error).message}`,
                { cause: switchError },
            );
        }
    });
}

export async function setLlamaCppRuntimeConfig(input: LlamaCppRuntimeConfig): Promise<void> {
    const next = normalizeLlamaCppRuntimeConfig(input);
    if (JSON.stringify(next) === JSON.stringify(runtimeConfig)) return;
    const activeError = "llama.cpp CPU, memory-reserve, and NUMA settings cannot change during generation.";
    await withRuntimeReconfiguration("llamacpp:runtime-config", activeError, async () => {
        const previousConfig = runtimeConfig;
        await releaseNativeState();
        runtimeConfig = next;
        try {
            await getLlamaInstance();
        } catch (switchError) {
            await releaseNativeState();
            runtimeConfig = previousConfig;
            try {
                await getLlamaInstance();
            } catch (rollbackError) {
                throw new Error(
                    `Failed to apply llama.cpp runtime configuration, and restoring the previous configuration also failed: ${(rollbackError as Error).message}`,
                    { cause: switchError },
                );
            }
            throw new Error(
                `Failed to apply llama.cpp runtime configuration; restored the previous configuration. ${(switchError as Error).message}`,
                { cause: switchError },
            );
        }
    });
}

async function getLlamaInstance(): Promise<Llama> {
    if (llamaInstance) return llamaInstance;
    if (llamaInstancePromise) return llamaInstancePromise;

    const revision = backendRevision;
    const backend = activeBackend;
    const creation = (async () => {
        const { getLlama } = await loadNodeLlamaCpp();
        // See llamacpp-backend-health.ts's doc comment: this is the one
        // *real* (non-dry-run) native backend initialization, and the one
        // that can crash the whole process with a signal no in-process
        // handler can catch. Marking "starting" just before it, and
        // "confirmed" only once it returns without crashing, is what lets
        // main.ts's resolveStartupGpuBackend() notice on the *next* launch
        // that this attempt never made it back.
        markBackendAttemptStarting(backend);
        const instance = await getLlama({
            gpu: backend === "cpu" ? false : backend,
            maxThreads: runtimeConfig.maxThreads,
            vramPadding: runtimeConfig.vramReserveBytes,
            ramPadding: runtimeConfig.ramReserveBytes,
            numa: runtimeConfig.numa === "auto" || runtimeConfig.numa === undefined ? false : runtimeConfig.numa,
        });
        markBackendAttemptConfirmed(backend);
        // A backend change may happen while native initialization is still
        // running. Never publish an instance created for the stale backend.
        if (revision !== backendRevision) {
            await instance.dispose();
            return getLlamaInstance();
        }
        llamaInstance = instance;
        return instance;
    })();
    llamaInstancePromise = creation;
    try {
        return await creation;
    } finally {
        if (llamaInstancePromise === creation) llamaInstancePromise = null;
    }
}

export async function getAvailableGpuBackends(): Promise<string[]> {
    if (backendProbeCache && backendProbeCache.expiresAt > Date.now()) return backendProbeCache.values;
    try {
        const { getLlamaGpuTypes } = await loadNodeLlamaCpp();
        const types = await getLlamaGpuTypes("supported");
        const candidates = types.filter((t): t is Exclude<typeof t, false> => t !== false);
        const results = await Promise.all(candidates.map(async (backend) => {
            try { await probeGpuBackend(backend); return backend; } catch { return null; }
        }));
        const values = results.filter((backend): backend is Exclude<typeof backend, null> => backend !== null);
        backendProbeCache = { values, expiresAt: Date.now() + 60_000 };
        return values;
    } catch {
        return [];
    }
}

async function loadModel(modelPath: string, gpuLayers: LlamaModelOptions["gpuLayers"], contextLength?: number): Promise<LlamaModel> {
    const key = modelCacheKey(modelPath, gpuLayers);
    const cached = modelCache.get(key);
    if (cached) {
        modelLastUsed.set(key, Date.now());
        scheduleIdleEviction();
        return cached;
    }
    const pending = modelLoads.get(key);
    if (pending) return pending;

    // Item 6: estimate this specific model's RAM/VRAM footprint before
    // admission, so the orchestrator's budget sees honest numbers instead
    // of a 0/0 placeholder (see inference-resource-scheduler.ts's own doc
    // comment on why that matters). Estimates hardware-optimal placement,
    // not this call's own manual gpuLayers override if one was set — a
    // deliberate, safe-direction approximation: it never underestimates
    // actual usage in a way that risks OOM, at worst it reserves VRAM
    // budget a CPU-forced load won't actually use.
    const fit = await estimateModelFit(modelPath, { contextLength }).catch(() => null);

    // Coalesce simultaneous first requests. Loading the same weights twice
    // can briefly double RAM/VRAM use and OOM an otherwise suitable GPU.
    const revision = backendRevision;
    const load = withInferenceResourceLock(
        `llamacpp:model-load:${modelPath}`,
        async () => {
            assertValidGgufFile(modelPath);
            const llama = await getLlamaInstance();
            logger.info(
                `llama.cpp model-load start model=${path.basename(modelPath)} backend=${activeBackend} ` +
                `gpuLayers=${JSON.stringify(gpuLayers)} context=${contextLength ?? "auto"}`
            );
            const model = await llama.loadModel({ modelPath, gpuLayers });
            if (revision !== backendRevision) {
                await model.dispose();
                throw new Error("The GPU backend changed while the model was loading. Please retry the request.");
            }
            modelCache.set(key, model);
            modelLastUsed.set(key, Date.now());
            const metadata = model.fileInfo?.metadata;
            const architecture = metadata?.general?.architecture ?? "unknown";
            const chatTemplate = metadata?.tokenizer?.chat_template;
            const templateFingerprint = typeof chatTemplate === "string"
                ? createHash("sha256").update(chatTemplate).digest("hex").slice(0, 12)
                : "none";
            logger.info(
                `llama.cpp model-load complete model=${path.basename(modelPath)} architecture=${architecture} ` +
                `layers=${model.fileInsights.totalLayers} gpuLayers=${model.gpuLayers} trainContext=${model.trainContextSize} ` +
                `chatTemplateChars=${typeof chatTemplate === "string" ? chatTemplate.length : 0} chatTemplateSha256=${templateFingerprint}`
            );
            await evictIdleModels(key);
            scheduleIdleEviction();
            return model;
        },
        fit ? { ramMB: fit.estimatedRamMB, vramMB: fit.estimatedVramMB } : undefined
    );
    modelLoads.set(key, load);
    try {
        return await load;
    } finally {
        if (modelLoads.get(key) === load) modelLoads.delete(key);
    }
}

async function evictIdleModels(protectedKey?: string): Promise<void> {
    while (modelCache.size > maxCachedModels) {
        const candidate = [...modelCache.keys()]
            .filter((key) => key !== protectedKey && (activeModelUsers.get(key) ?? 0) === 0)
            .sort((a, b) => (modelLastUsed.get(a) ?? 0) - (modelLastUsed.get(b) ?? 0))[0];
        if (!candidate) return;
        const model = modelCache.get(candidate);
        modelCache.delete(candidate);
        modelLastUsed.delete(candidate);
        if (model) await model.dispose();
    }
    scheduleIdleEviction();
}

export async function dispose(): Promise<void> {
    await releaseNativeState();
}

export interface LocalGgufModel {
    // Path of the representative shard (part 1, or the lowest part present)
    // relative to the configured models folder, forward-slash separated
    // (e.g. "bartowski/Some-Model-GGUF/some-model.gguf") — this is what gets
    // passed back to loadModel/deleteModel. Tools like LM Studio organize
    // downloads as <publisher>/<model>-GGUF/<file>.gguf, so a flat single
    // folder isn't enough to find them.
    name: string;
    // What to show in the UI. Same as `name` for a normal single-file model;
    // for a multi-part one it's a synthetic "(N parts)" label instead, since
    // showing the raw "-00001-of-00002.gguf" filename as if it were the
    // whole model's name is misleading.
    label: string;
    path: string;
    sizeBytes: number;
}

// Matches Hugging Face's multi-part GGUF naming convention, e.g.
// "Qwen3-Coder-Next-Q6_K-00001-of-00002.gguf". node-llama-cpp loads every
// part automatically once given the path to part 1, so listing each shard
// as its own separate model is both confusing (one weight file looks like
// two different models) and wrong (selecting a non-first shard on its own
// doesn't work) — group them into a single entry instead.
const SHARD_PATTERN = /^(.*)-(\d+)-of-(\d+)(\.gguf)$/i;

interface RawGgufFile {
    name: string;
    path: string;
    sizeBytes: number;
}

export function groupShardedModels(files: RawGgufFile[]): LocalGgufModel[] {
    const groups = new Map<string, { totalSize: number; parts: Map<number, RawGgufFile> }>();
    const standalone: LocalGgufModel[] = [];

    for (const file of files) {
        const match = file.name.match(SHARD_PATTERN);
        if (!match) {
            standalone.push({ ...file, label: file.name });
            continue;
        }
        const [, base, partStr, , ext] = match;
        const key = `${base}${ext}`;
        const part = Number(partStr);
        const group = groups.get(key) ?? { totalSize: 0, parts: new Map() };
        group.totalSize += file.sizeBytes;
        group.parts.set(part, file);
        groups.set(key, group);
    }

    const grouped: LocalGgufModel[] = [...groups.entries()].map(([key, group]) => {
        const lowestPart = Math.min(...group.parts.keys());
        const representative = group.parts.get(lowestPart)!;
        const partCount = group.parts.size;
        return {
            name: representative.name,
            label: partCount > 1 ? `${key} (${partCount} parts)` : representative.name,
            path: representative.path,
            sizeBytes: group.totalSize,
        };
    });

    return [...standalone, ...grouped];
}

// Bounds the recursive scan below — comfortably covers real-world layouts
// like LM Studio's <publisher>/<model>-GGUF/<file>.gguf (2 levels deep)
// without walking into an unrelated, arbitrarily deep folder someone
// accidentally pointed this setting at.
const MAX_SCAN_DEPTH = 6;

function walkGgufFiles(root: string, dir: string, depth: number): RawGgufFile[] {
    if (depth > MAX_SCAN_DEPTH) return [];
    const files: RawGgufFile[] = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            files.push(...walkGgufFiles(root, full, depth + 1));
        } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".gguf")) {
            const relative = path.relative(root, full).split(path.sep).join("/");
            files.push({ name: relative, path: full, sizeBytes: fs.statSync(full).size });
        }
    }
    return files;
}

// Settings/Chat's manual-GPU-layer-count input has no way to know a real
// upper bound without this: "how many transformer layers does this GGUF
// file actually have" is answerable from the file's header/tensor-info
// metadata alone, via node-llama-cpp's own readGgufFileInfo/GgufInsights —
// no backend init, no memory-mapped weight loading, none of the real-GPU
// risk chat()'s actual getLlamaInstance() carries (see
// llamacpp-backend-health.ts). Safe to call for any GGUF file regardless of
// whether it's ever been loaded.
export async function getModelTotalLayers(modelPath: string): Promise<number> {
    const { readGgufFileInfo, GgufInsights } = await loadNodeLlamaCpp();
    const fileInfo = await readGgufFileInfo(modelPath);
    const insights = await GgufInsights.from(fileInfo);
    return insights.totalLayers;
}

export function listModels(modelsDir: string): LocalGgufModel[] {
    if (!fs.existsSync(modelsDir)) return [];
    return groupShardedModels(walkGgufFiles(modelsDir, modelsDir, 0));
}

// Model paths currently kept warm in modelCache — used for the
// activity/resource usage view. Doesn't report VRAM/RAM footprint since
// node-llama-cpp doesn't expose per-model memory usage.
export function listLoadedModels(): string[] {
    return [...new Set([...modelCache.keys()].map((key) => key.split("\0", 1)[0]))];
}

export async function getRuntimeInfo(): Promise<LlamaCppRuntimeInfo> {
    const llama = llamaInstance;
    const loadedModels = [...modelCache.entries()].map(([key, model]) => ({
        path: key.split("\0", 1)[0],
        gpuLayers: model.gpuLayers,
        totalLayers: model.fileInsights.totalLayers,
        flashAttentionSupported: model.flashAttentionSupported,
        activeGenerations: activeModelUsers.get(key) ?? 0,
    }));
    if (!llama) {
        return {
            requestedBackend: activeBackend, activeBackend: null, supportsGpuOffloading: null,
            cpuMathCores: null, maxThreads: runtimeConfig.maxThreads ?? null,
            vramPaddingBytes: runtimeConfig.vramReserveBytes ?? null, ramPaddingBytes: runtimeConfig.ramReserveBytes ?? null,
            gpuDeviceNames: [], vramState: null, swapState: null, loadedModels,
        };
    }
    const [gpuDeviceNames, vramState, swapState] = await Promise.all([
        llama.getGpuDeviceNames().catch(() => []),
        llama.getVramState().catch(() => null),
        llama.getSwapState().catch(() => null),
    ]);
    return {
        requestedBackend: activeBackend,
        activeBackend: String(llama.gpu),
        supportsGpuOffloading: llama.supportsGpuOffloading,
        cpuMathCores: llama.cpuMathCores,
        maxThreads: llama.maxThreads,
        vramPaddingBytes: llama.vramPaddingSize,
        ramPaddingBytes: llama.ramPaddingSize,
        gpuDeviceNames,
        vramState,
        swapState,
        loadedModels,
    };
}

// `name` may be a relative path with subfolders (see LocalGgufModel), so
// this can't reject on path separators — instead it rejects ".." segments
// and requires the resolved path to still land inside `root`, which is what
// actually prevents a renderer-supplied name from escaping the configured
// models directory. Shared by deleteModel and getModelTotalLayersByName —
// the one path-escape check every renderer-facing "act on this model file
// by name" entry point must apply identically.
function resolveModelPathWithinDir(modelsDir: string, name: string): string {
    const root = path.resolve(modelsDir);
    if (path.isAbsolute(name) || name.split(/[\\/]/).includes("..") || !name.toLowerCase().endsWith(".gguf")) {
        throw new Error("Invalid model file name.");
    }
    const target = path.resolve(root, name);
    if (target === root || !target.startsWith(root + path.sep)) {
        throw new Error("Invalid model file name.");
    }
    return target;
}

export async function getModelTotalLayersByName(modelsDir: string, name: string): Promise<number> {
    return getModelTotalLayers(resolveModelPathWithinDir(modelsDir, name));
}

export async function deleteModel(modelsDir: string, name: string): Promise<void> {
    const target = resolveModelPathWithinDir(modelsDir, name);
    const matchingKeys = [...modelCache.keys()].filter((key) => key.startsWith(`${target}\0`));
    if (matchingKeys.some((key) => (activeModelUsers.get(key) ?? 0) > 0)) {
        throw new Error("This model cannot be deleted while it is generating a response.");
    }
    if ([...modelLoads.keys()].some((key) => key.startsWith(`${target}\0`))) {
        throw new Error("This model cannot be deleted while it is still loading.");
    }

    const modelsToDispose: LlamaModel[] = [];
    for (const [key, model] of modelCache) {
        if (key.startsWith(`${target}\0`)) {
            modelCache.delete(key);
            modelLastUsed.delete(key);
            modelsToDispose.push(model);
        }
    }
    await Promise.allSettled(modelsToDispose.map((model) => model.dispose()));
    fs.rmSync(target, { force: true });

    // A multi-part model's sibling shards live under the same name pattern
    // in the same directory as the target — leaving them behind would orphan
    // otherwise-unusable files that just sit there confusing the next
    // listModels() call.
    const targetDir = path.dirname(target);
    const targetBasename = path.basename(target);
    const shardMatch = targetBasename.match(SHARD_PATTERN);
    if (shardMatch) {
        const [, base, , , ext] = shardMatch;
        const siblingPattern = new RegExp(`^${escapeRegExp(base)}-\\d+-of-\\d+${escapeRegExp(ext)}$`, "i");
        for (const f of fs.readdirSync(targetDir)) {
            if (f !== targetBasename && siblingPattern.test(f)) fs.rmSync(path.join(targetDir, f), { force: true });
        }
    }

    scheduleIdleEviction();
}

function escapeRegExp(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Maps this app's provider-agnostic ChatMessage[] (system/user/assistant,
// full history resent on every call — same shape every provider gets) onto
// node-llama-cpp's ChatHistoryItem[] shape. This app represents a tool call
// and its result as two separate messages (an assistant message with
// `toolCalls`, then a later "tool"-role message carrying the result,
// matching the OpenAI/Ollama wire shape) — node-llama-cpp instead bundles a
// call and its result into one `ChatModelFunctionCall` entry inside the
// assistant turn's own `response` array, so a tool-role message is never
// pushed as its own history item; it's folded into the assistant message
// that requested it, found by matching `toolCallId`.
export function toHistory(messages: ChatMessage[]): ChatHistoryItem[] {
    const history: ChatHistoryItem[] = [];
    for (const m of messages) {
        if (m.role === "system") {
            history.push({ type: "system", text: m.content });
        } else if (m.role === "user") {
            history.push({ type: "user", text: m.content });
        } else if (m.role === "assistant") {
            if (m.toolCalls && m.toolCalls.length > 0) {
                const response: Array<string | ChatModelFunctionCall> = [];
                if (m.content) response.push(m.content);
                for (const call of m.toolCalls) {
                    // The result lives on a later "tool" message referencing
                    // this call's id — normally always present by the time
                    // history is replayed (the caller appends it before ever
                    // asking for the next turn), but tolerated as missing
                    // rather than crashing, since a malformed/truncated
                    // history shouldn't take down generation entirely.
                    const resultMessage = messages.find((mm) => mm.role === "tool" && mm.toolCallId === call.id);
                    response.push({
                        type: "functionCall",
                        name: call.name,
                        params: call.arguments,
                        result: resultMessage?.content ?? null,
                    });
                }
                history.push({ type: "model", response });
            } else {
                history.push({ type: "model", response: [m.content] });
            }
        }
        // "tool" messages carry no history item of their own — see above.
    }
    return history;
}

// Maps this app's generic ToolDefinition (plain JSON-Schema-shaped
// parameters, used identically by every other provider) onto node-llama-cpp's
// GBNF-JSON-schema function-definition shape. Two behavior differences from
// every other provider are disclosed here rather than silently accepted:
// (1) GBNF-JSON-schema's `additionalProperties` defaults to `false` (vs.
// unrestricted in standard JSON Schema) — restored to `true` below to match
// what every existing tool schema (MCP-server-supplied or built-in) actually
// assumes, since none of them were authored with llama.cpp's stricter
// default in mind; (2) node-llama-cpp always treats every declared property
// as required regardless of this schema's own `required` list (its own type
// definition documents this as a current library limitation) — there is no
// way to express a genuinely optional tool parameter to the llama.cpp
// backend today, unlike Ollama/OpenAI.
export function toLlamaCppFunctions(tools: ToolDefinition[]): ChatModelFunctions {
    const functions: Record<string, { description?: string; params?: GbnfJsonSchema }> = {};
    for (const t of tools) {
        functions[t.name] = {
            description: t.description,
            params: {
                type: "object",
                properties: t.parameters.properties as Record<string, GbnfJsonSchema>,
                additionalProperties: true,
            },
        };
    }
    return functions;
}

export async function chat(
    modelPath: string,
    messages: ChatMessage[],
    options: ChatOptions | undefined,
    onToken: (chunk: ChatChunk) => void,
    signal?: AbortSignal,
    tools?: ToolDefinition[],
    priority: Extract<ResourcePriority, "active-inference" | "scheduled-inference"> = "active-inference",
    diagnosticId = "interactive",
    conversationId?: string
): Promise<void> {
    assertGenerationCanStart();

    let lastUserIndex = -1;
    for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].role === "user") {
            lastUserIndex = i;
            break;
        }
    }
    if (lastUserIndex === -1) throw new Error("No user message to respond to.");

    const resolvedGpuLayers = resolveGpuLayers(options?.gpuLayerMode, options?.gpuLayers, options?.contextLength);
    const traceId = diagnosticId.slice(0, 64);
    logger.info(
        `[inference:${traceId}] llama.cpp prepare model=${path.basename(modelPath)} backend=${activeBackend} ` +
        `gpuLayers=${JSON.stringify(resolvedGpuLayers)} lastUserIndex=${lastUserIndex} messages=${messages.length}`
    );
    const cacheKey = modelCacheKey(modelPath, resolvedGpuLayers);
    const model = await loadModel(modelPath, resolvedGpuLayers, options?.contextLength);
    // A transition can be announced while this call is awaiting a queued or
    // cached model load. Never create a context from a model that the pending
    // transition is about to dispose.
    assertGenerationCanStart();
    if (typeof resolvedGpuLayers === "number" && resolvedGpuLayers > model.fileInsights.totalLayers) {
        modelCache.delete(cacheKey);
        modelLastUsed.delete(cacheKey);
        await model.dispose();
        throw new Error(`Manual GPU layer count ${resolvedGpuLayers} exceeds this model's ${model.fileInsights.totalLayers} layers.`);
    }
    activeModelUsers.set(cacheKey, (activeModelUsers.get(cacheKey) ?? 0) + 1);
    modelLastUsed.set(cacheKey, Date.now());
    // The renderer now threads a stable conversation id into interactive
    // calls. One matching tool-free conversation keeps its context/session
    // warm so follow-ups reuse the evaluated KV cache instead of processing
    // the entire history again. Missing ids, agent/tool turns, changed
    // history, model changes, or context-setting changes all stay on the
    // conservative fresh-context path.
    // Generation gets its own lease, acquired here — strictly after
    // loadModel() above has already released its own exclusive-accelerator
    // lease on a cache miss (see that function). Acquiring the two
    // sequentially, never nested, is what avoids deadlocking on the single
    // exclusive-accelerator admission slot.
    await mainResourceOrchestrator.withLease({
        workloadKind: priority,
        priority,
        requirements: { cpuThreads: 1, ramMB: 0, accelerator: "preferred", allowCpuFallback: true, exclusiveAccelerator: true },
    }, async () => {
        let context: Awaited<ReturnType<LlamaModel["createContext"]>> | null = null;
        let reusedConversation: CachedConversation | null = null;
        let retainModelUser = false;
        let generationSucceeded = false;
        try {
            const { LlamaChatSession, LlamaChat } = await loadNodeLlamaCpp();
            const flashAttention: LlamaContextOptions["flashAttention"] = options?.flashAttention === "on"
                ? true
                : options?.flashAttention === "off" ? false : "auto";

            // Agent mode's tool definitions (this app's full built-in list, plus
            // any connected MCP server tools) get embedded into every prompt
            // node-llama-cpp builds for a tools-enabled turn. For cloud providers
            // with huge context windows that's negligible; for a local model it
            // can easily exceed a small configured context on its own, before a
            // single conversation turn is even considered. When that happens,
            // node-llama-cpp's context-shift strategy has no room to fit even
            // the minimum required prompt and throws an opaque internal error
            // ("...did not return a history that fits the context size...").
            // Estimate the real cost with this model's own tokenizer, grow the
            // context up to what the model actually supports rather than let
            // that surface, and fail fast with an actionable message instead if
            // even the model's max context genuinely isn't enough.
            let contextSize: LlamaContextOptions["contextSize"] = options?.contextLength ?? "auto";
            if (tools && tools.length > 0) {
                const toolTokens = model.tokenize(JSON.stringify(toLlamaCppFunctions(tools))).length;
                const historyTokens = messages.reduce((sum, m) => sum + model.tokenize(m.content).length, 0);
                const generationReserve = options?.maxTokens ?? 512;
                // Fixed margin for chat-template/grammar wrapping overhead this
                // estimate doesn't account for exactly.
                const requiredContextSize = toolTokens + historyTokens + generationReserve + 256;
                const maxSupported = model.trainContextSize;
                if (requiredContextSize > maxSupported) {
                    throw new Error(
                        `Agent mode's enabled tools need roughly ${requiredContextSize} tokens of context, but this model supports at most ${maxSupported}. Disable some MCP tools, shorten the conversation, or switch to a model with a larger context window.`
                    );
                }
                contextSize = Math.min(maxSupported, Math.max(options?.contextLength ?? 0, requiredContextSize));
            }

            const contextOptions: LlamaContextOptions = {
                contextSize,
                batchSize: options?.batchSize,
                threads: options?.cpuThreads,
                flashAttention,
                failedCreationRemedy: contextSize === "auto" ? { retries: 6, autoContextSizeShrink: 0.16 } : false,
                performanceTracking: options?.performanceTracking === true,
            };
            const priorMessages = messages.slice(0, lastUserIndex);
            const priorHistory = historyFingerprint(priorMessages);
            const contextConfigKey = JSON.stringify({
                contextSize,
                batchSize: options?.batchSize ?? null,
                threads: options?.cpuThreads ?? null,
                flashAttention,
            });
            if (!tools?.length && conversationId) {
                const existing = conversationCache.get(conversationId);
                if (existing && !existing.inUse && existing.modelCacheKey === cacheKey
                    && existing.contextConfigKey === contextConfigKey && existing.expectedPriorHistory === priorHistory) {
                    existing.inUse = true;
                    reusedConversation = existing;
                    context = existing.context;
                } else if (existing) {
                    await disposeCachedConversation(conversationId, existing);
                }
            }
            if (!context) context = await model.createContext(contextOptions);
            const sequence = context.getSequence();
            let outputChunks = 0;
            let outputChars = 0;
            const generationStartedAt = Date.now();
            let firstTokenAt: number | null = null;
            const emitText = (text: string) => {
                if (firstTokenAt === null) firstTokenAt = Date.now();
                outputChunks++;
                outputChars += text.length;
                onToken({ message: { role: "assistant", content: text }, done: false });
            };
            logger.info(
                `[inference:${traceId}] llama.cpp context-${reusedConversation ? "reused" : "created"} model=${path.basename(modelPath)} ` +
                `context=${contextSize} batch=${options?.batchSize ?? "default"} threads=${options?.cpuThreads ?? "default"} ` +
                `flashAttention=${flashAttention}`
            );

            if (tools && tools.length > 0) {
                // The lower-level LlamaChat (not LlamaChatSession) is used here
                // deliberately: LlamaChatSession's function-calling requires a
                // synchronous `handler` per function that it executes and
                // resolves internally, which has no place for this app's
                // per-call human-approval gate (agent-tools.ts's Allow/Deny UI).
                // LlamaChat.generateResponse() has no such handler concept at
                // all — it just stops generation and reports the requested
                // call, exactly like every other provider here (Ollama/OpenAI
                // pause after one tool-call request and let the caller execute
                // and resume in a new turn) — see toLlamaCppFunctions()'s doc
                // comment for the two disclosed schema-translation differences.
                const llamaChat = new LlamaChat({ contextSequence: sequence });
                const { functionCalls } = await llamaChat.generateResponse(toHistory(messages), {
                    functions: toLlamaCppFunctions(tools),
                    signal,
                    temperature: options?.temperature,
                    topP: options?.topP,
                    topK: options?.topK,
                    maxTokens: options?.maxTokens,
                    seed: options?.seed,
                    customStopTriggers: options?.stop,
                    onTextChunk: emitText,
                });
                if (functionCalls && functionCalls.length > 0) {
                    onToken({
                        done: false,
                        toolCalls: functionCalls.map((call) => ({
                            id: randomUUID(),
                            name: call.functionName,
                            arguments: (call.params ?? {}) as Record<string, unknown>,
                        })),
                    });
                }
                onToken({ done: true });
                generationSucceeded = true;
                logger.info(`[inference:${traceId}] llama.cpp generated chunks=${outputChunks} chars=${outputChars} toolCalls=${functionCalls?.length ?? 0} firstTokenMs=${firstTokenAt === null ? "none" : firstTokenAt - generationStartedAt} totalMs=${Date.now() - generationStartedAt}`);
            } else {
                const session = reusedConversation?.session ?? new LlamaChatSession({ contextSequence: sequence });
                if (!reusedConversation && priorMessages.length > 0) session.setChatHistory(toHistory(priorMessages));

                const response = await session.prompt(messages[lastUserIndex].content, {
                    signal,
                    temperature: options?.temperature,
                    topP: options?.topP,
                    topK: options?.topK,
                    maxTokens: options?.maxTokens,
                    seed: options?.seed,
                    customStopTriggers: options?.stop,
                    onTextChunk: emitText,
                });
                onToken({ done: true });
                generationSucceeded = true;
                if (conversationId) {
                    const expectedPriorHistory = historyFingerprint([
                        ...priorMessages,
                        messages[lastUserIndex],
                        { role: "assistant", content: response },
                    ]);
                    if (reusedConversation) {
                        reusedConversation.expectedPriorHistory = expectedPriorHistory;
                        reusedConversation.inUse = false;
                        reusedConversation.lastUsedAt = Date.now();
                    } else {
                        for (const [key, entry] of [...conversationCache]) {
                            if (key !== conversationId) await disposeCachedConversation(key, entry);
                        }
                        conversationCache.set(conversationId, {
                            modelCacheKey: cacheKey,
                            contextConfigKey,
                            context,
                            session,
                            expectedPriorHistory,
                            inUse: false,
                            lastUsedAt: Date.now(),
                        });
                        retainModelUser = true;
                    }
                    context = null;
                }
                logger.info(`[inference:${traceId}] llama.cpp generated chunks=${outputChunks} chars=${outputChars} toolCalls=0 firstTokenMs=${firstTokenAt === null ? "none" : firstTokenAt - generationStartedAt} totalMs=${Date.now() - generationStartedAt} contextCache=${reusedConversation ? "hit" : conversationId ? "stored" : "off"}`);
            }
        } finally {
            if (reusedConversation && !generationSucceeded) {
                await disposeCachedConversation(conversationId!, reusedConversation);
                context = null;
            }
            if (context) await context.dispose();
            if (!retainModelUser) {
                const users = Math.max(0, (activeModelUsers.get(cacheKey) ?? 1) - 1);
                if (users === 0) activeModelUsers.delete(cacheKey);
                else activeModelUsers.set(cacheKey, users);
            }
            modelLastUsed.set(cacheKey, Date.now());
            await evictIdleModels();
            scheduleIdleEviction();
        }
    });
}

// RAG embeddings via llama.cpp (docs/LOCAL_INFERENCE_HARDENING_PLAN.md §2's
// other blocking gap alongside tool-calling — rag.ts previously called
// Ollama's /api/embeddings with no local alternative at all). Reuses the
// same model cache, refcounting, and backend-transition guards as chat()
// above; the caller (rag.ts) is responsible for its own resource-orchestrator
// lease around a batch of calls, matching how it already leases a batch of
// Ollama embedding calls today — this function does not acquire one itself.
export async function embed(modelPath: string, text: string): Promise<number[]> {
    assertGenerationCanStart();
    const gpuLayers = resolveGpuLayers("auto", undefined, undefined);
    const cacheKey = modelCacheKey(modelPath, gpuLayers);
    const model = await loadModel(modelPath, gpuLayers);
    assertGenerationCanStart();
    activeModelUsers.set(cacheKey, (activeModelUsers.get(cacheKey) ?? 0) + 1);
    modelLastUsed.set(cacheKey, Date.now());
    let embeddingContext: Awaited<ReturnType<LlamaModel["createEmbeddingContext"]>> | null = null;
    try {
        embeddingContext = await model.createEmbeddingContext();
        const embedding = await embeddingContext.getEmbeddingFor(text);
        return [...embedding.vector];
    } finally {
        if (embeddingContext) await embeddingContext.dispose();
        const users = Math.max(0, (activeModelUsers.get(cacheKey) ?? 1) - 1);
        if (users === 0) activeModelUsers.delete(cacheKey);
        else activeModelUsers.set(cacheKey, users);
        modelLastUsed.set(cacheKey, Date.now());
        await evictIdleModels();
        scheduleIdleEviction();
    }
}
