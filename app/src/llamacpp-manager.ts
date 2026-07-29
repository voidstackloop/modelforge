import * as fs from "node:fs";
import * as path from "node:path";
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
import type { ChatHistoryItem, Llama, LlamaContextOptions, LlamaModel, LlamaModelOptions, LlamaNuma } from "node-llama-cpp";
import type { ChatMessage, ChatChunk, ChatOptions, GpuLayerMode, ToolDefinition } from "./providers/types";
import { withInferenceResourceLock } from "./inference-resource-scheduler";

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

function loadNodeLlamaCpp(): Promise<NodeLlamaCppModule> {
    if (!modulePromise) modulePromise = dynamicImport("node-llama-cpp");
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
let maxCachedModels = 2;
// Keep warm weights for fast follow-up prompts, then release their RAM/VRAM
// after inactivity. Headless deployments can override the default without a
// new UI setting; 0 disables time-based eviction.
const configuredIdleMinutes = Number(process.env.OLLAMA_CUSTOM_UI_LLAMA_IDLE_MINUTES ?? 15);
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

function resolveGpuLayers(mode: GpuLayerMode | undefined, manualLayers: number | undefined): LlamaModelOptions["gpuLayers"] {
    const resolvedMode = mode ?? (manualLayers === undefined ? "auto" : manualLayers === 0 ? "cpu" : "manual");
    if (resolvedMode === "cpu") return 0;
    // node-llama-cpp's "auto" is already maximum memory-safe placement and
    // preserves the Llama instance's VRAM padding. It is therefore also the
    // correct implementation of the user-facing "Maximum safe offload".
    if (resolvedMode === "auto" || resolvedMode === "max") return "auto";
    if (!Number.isInteger(manualLayers) || manualLayers! < 0) throw new Error("Manual GPU layer mode requires a non-negative integer layer count.");
    return manualLayers;
}

function modelCacheKey(modelPath: string, gpuLayers: LlamaModelOptions["gpuLayers"]): string {
    return `${modelPath}\0${JSON.stringify(gpuLayers)}`;
}

async function releaseNativeState(): Promise<void> {
    const oldModels = [...modelCache.values()];
    const oldLlama = llamaInstance;
    backendRevision++;
    llamaInstance = null;
    llamaInstancePromise = null;
    modelCache.clear();
    modelLoads.clear();
    modelLastUsed.clear();
    activeModelUsers.clear();
    clearIdleEvictionTimer();
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
    if (backend === activeBackend && runtimeReconfigurationsPending === 0) return;
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
        const instance = await getLlama({
            gpu: backend === "cpu" ? false : backend,
            maxThreads: runtimeConfig.maxThreads,
            vramPadding: runtimeConfig.vramReserveBytes,
            ramPadding: runtimeConfig.ramReserveBytes,
            numa: runtimeConfig.numa === "auto" || runtimeConfig.numa === undefined ? false : runtimeConfig.numa,
        });
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

async function loadModel(modelPath: string, gpuLayers: LlamaModelOptions["gpuLayers"]): Promise<LlamaModel> {
    const key = modelCacheKey(modelPath, gpuLayers);
    const cached = modelCache.get(key);
    if (cached) {
        modelLastUsed.set(key, Date.now());
        scheduleIdleEviction();
        return cached;
    }
    const pending = modelLoads.get(key);
    if (pending) return pending;

    // Coalesce simultaneous first requests. Loading the same weights twice
    // can briefly double RAM/VRAM use and OOM an otherwise suitable GPU.
    const revision = backendRevision;
    const load = withInferenceResourceLock(`llamacpp:model-load:${modelPath}`, async () => {
        const llama = await getLlamaInstance();
        const model = await llama.loadModel({ modelPath, gpuLayers });
        if (revision !== backendRevision) {
            await model.dispose();
            throw new Error("The GPU backend changed while the model was loading. Please retry the request.");
        }
        modelCache.set(key, model);
        modelLastUsed.set(key, Date.now());
        await evictIdleModels(key);
        scheduleIdleEviction();
        return model;
    });
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

export async function deleteModel(modelsDir: string, name: string): Promise<void> {
    const root = path.resolve(modelsDir);
    // `name` may now be a relative path with subfolders (see LocalGgufModel),
    // so unlike before this can't reject on path separators — instead it
    // rejects ".." segments and requires the resolved path to still land
    // inside `root`, which is what actually prevents escaping the directory.
    if (path.isAbsolute(name) || name.split(/[\\/]/).includes("..") || !name.toLowerCase().endsWith(".gguf")) {
        throw new Error("Invalid model file name.");
    }
    const target = path.resolve(root, name);
    if (target === root || !target.startsWith(root + path.sep)) {
        throw new Error("Invalid model file name.");
    }
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
// node-llama-cpp's ChatHistoryItem[] shape. Tool/function-calling isn't
// wired up for this backend yet, so "tool" role messages and any tool calls
// on assistant messages are dropped rather than mistranslated.
function toHistory(messages: ChatMessage[]): ChatHistoryItem[] {
    const history: ChatHistoryItem[] = [];
    for (const m of messages) {
        if (m.role === "system") history.push({ type: "system", text: m.content });
        else if (m.role === "user") history.push({ type: "user", text: m.content });
        else if (m.role === "assistant") history.push({ type: "model", response: [m.content] });
        // "tool" messages are skipped — see note above.
    }
    return history;
}

export async function chat(
    modelPath: string,
    messages: ChatMessage[],
    options: ChatOptions | undefined,
    onToken: (chunk: ChatChunk) => void,
    signal?: AbortSignal,
    tools?: ToolDefinition[]
): Promise<void> {
    if (tools && tools.length > 0) {
        throw new Error(
            "Agent mode isn't supported yet for the llama.cpp backend — switch to Ollama, OpenAI, or Claude for tool-calling, or turn Agent mode off."
        );
    }

    assertGenerationCanStart();

    let lastUserIndex = -1;
    for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].role === "user") {
            lastUserIndex = i;
            break;
        }
    }
    if (lastUserIndex === -1) throw new Error("No user message to respond to.");

    const resolvedGpuLayers = resolveGpuLayers(options?.gpuLayerMode, options?.gpuLayers);
    const cacheKey = modelCacheKey(modelPath, resolvedGpuLayers);
    const model = await loadModel(modelPath, resolvedGpuLayers);
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
    // A fresh context per call re-evaluates the whole conversation history
    // every turn instead of reusing a warm KV cache across turns — simpler
    // and always correct, at the cost of redoing prompt-processing work on
    // every message. Session-affinity caching (keeping a session alive
    // across turns of the same conversation) would fix that but needs a
    // stable conversation identity to key off of, which isn't threaded
    // through this call today.
    let context: Awaited<ReturnType<LlamaModel["createContext"]>> | null = null;
    try {
        const { LlamaChatSession } = await loadNodeLlamaCpp();
        const flashAttention: LlamaContextOptions["flashAttention"] = options?.flashAttention === "on"
            ? true
            : options?.flashAttention === "off" ? false : "auto";
        const contextOptions: LlamaContextOptions = {
            contextSize: options?.contextLength ?? "auto",
            batchSize: options?.batchSize,
            threads: options?.cpuThreads,
            flashAttention,
            failedCreationRemedy: options?.contextLength === undefined ? { retries: 6, autoContextSizeShrink: 0.16 } : false,
            performanceTracking: options?.performanceTracking === true,
        };
        context = await model.createContext(contextOptions);
        const sequence = context.getSequence();
        const priorMessages = messages.slice(0, lastUserIndex);
        const session = new LlamaChatSession({ contextSequence: sequence });
        if (priorMessages.length > 0) session.setChatHistory(toHistory(priorMessages));

        await session.prompt(messages[lastUserIndex].content, {
            signal,
            temperature: options?.temperature,
            topP: options?.topP,
            topK: options?.topK,
            maxTokens: options?.maxTokens,
            seed: options?.seed,
            customStopTriggers: options?.stop,
            onTextChunk: (text) => onToken({ message: { role: "assistant", content: text }, done: false }),
        });
        onToken({ done: true });
    } finally {
        if (context) await context.dispose();
        const users = Math.max(0, (activeModelUsers.get(cacheKey) ?? 1) - 1);
        if (users === 0) activeModelUsers.delete(cacheKey);
        else activeModelUsers.set(cacheKey, users);
        modelLastUsed.set(cacheKey, Date.now());
        await evictIdleModels();
        scheduleIdleEviction();
    }
}
