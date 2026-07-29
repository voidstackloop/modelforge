import { spawn, execFile, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { promisify } from "node:util";
import * as fs from "node:fs";
import * as path from "node:path";
import pidusage from "pidusage";
import { logger } from "./logger";
import { killProcessTree } from "./process-tree";
import { environmentPython } from "./python-runtime-manager";
import type { GpuInfo } from "./system-specs";
import { assertTensorParallelSizeMatches, assertVendorHomogeneity, buildGpuVisibilityEnv, generateAutoTensorSplit, resolveMainGpuIndex, validateTensorSplit, type GpuSelection } from "./gpu-selection";
import { withInferenceResourceLock } from "./inference-resource-scheduler";

const execFileAsync = promisify(execFile);
export type LocalBackendId = "mlx" | "rocm" | "vllm";
export type RuntimeLifecycleState = "starting" | "running" | "stopping" | "restarting" | "unhealthy" | "failed" | "stopped";
export type RuntimeOperation = "starting" | "stopping" | "restarting" | null;
export type GpuLayerMode = "auto" | "cpu" | "max" | "manual";
export type RuntimeSplitMode = "layer" | "tensor";
export type FlashAttentionMode = "auto" | boolean;

export interface RuntimeStartupConfig {
    contextLength?: number | null;
    idleTimeoutMinutes?: number;
    device?: "auto" | "cpu" | "gpu";
    gpuLayerMode?: GpuLayerMode;
    gpuLayers?: number;
    cpuThreads?: number;
    cpuBatchThreads?: number;
    flashAttention?: FlashAttentionMode;
    batchSize?: number;
    vramReserveGB?: number;
    gpuMemoryUtilization?: number;
    tensorParallelSize?: number;
    pipelineParallelSize?: number;
    cpuOffloadGB?: number;
    swapSpaceGB?: number;
    // The persisted selection (mode + stable device ids) — carried here only
    // so it participates in the reuse/cache-identity check in
    // startOrReuseServer (JSON.stringify(startupConfig) comparison). The
    // actual GPUs it resolves to are passed separately as `resolvedGpus` to
    // buildServerCommand/startServer/restartServer, since resolution requires
    // live hardware state this config object doesn't carry.
    gpuSelection?: GpuSelection;
    // Explicit split, or undefined = auto-generate from resolvedGpus' VRAM.
    tensorSplit?: number[];
    splitMode?: RuntimeSplitMode;
    mainGpuId?: string;
}

export interface LocalBackendConfig { rocmServerPath?: string; mlxPythonPath?: string; vllmCommand?: string }
export interface RuntimeProbe { compatible: boolean; command: string; args: string[]; detail: string }
export interface RuntimeCommandCapabilities {
    checked: boolean;
    flags: string[];
    backendDeviceNames: string[];
    warnings: string[];
}
export interface LocalRuntimeStatus {
    backend: LocalBackendId; compatible: boolean; installed: boolean; running: boolean; state: RuntimeLifecycleState;
    model?: string; detail: string; device?: string; pid: number | null; port: number | null; startedAt: string | null;
    uptimeSeconds: number; ramMB: number | null; vramMB: number | null; logs: string[]; startupError?: string;
    installCommand: string; environmentIssues: string[]; activeRequests: number; idleTimeoutMinutes: number;
    lastHealthCheckAt: string | null; operation: RuntimeOperation; currentConfig?: RuntimeStartupConfig;
    errorCategory?: RuntimeErrorCategory; recoveryAction?: string; commandCapabilities?: RuntimeCommandCapabilities;
}

export type RuntimeErrorCategory = "missing_executable" | "package_mismatch" | "unsupported_platform" | "driver_failure" | "gpu_initialization" | "insufficient_memory" | "invalid_model" | "model_format" | "port_failure" | "health_timeout" | "permission" | "device_changed_after_startup" | "unknown";
export interface StopRuntimeResult { stopped: boolean; activeRequests: number; forced: boolean }

function managedVllmExecutable(platform: NodeJS.Platform): string | undefined {
    const executableName = platform === "win32" ? "vllm.exe" : "vllm";
    const cudaExecutable = path.join(path.dirname(environmentPython("vllm-cuda", platform)), executableName);
    const rocmExecutable = path.join(path.dirname(environmentPython("vllm-rocm", platform)), executableName);
    return fs.existsSync(cudaExecutable) ? cudaExecutable : fs.existsSync(rocmExecutable) ? rocmExecutable : undefined;
}

interface RunningServer {
    process: ChildProcess; model: string; baseUrl: string; port: number; state: RuntimeLifecycleState; exited: boolean;
    startedAt: number; activeRequests: number; idleTimer: NodeJS.Timeout | null; logs: string[]; logRemainder: string;
    startupError?: string; startupConfig: RuntimeStartupConfig; lastHealthCheckAt: number | null;
    // Stable ids of the GPUs this process was actually launched against —
    // compared against live hardware on every status poll (see
    // deviceChangeIssue()) so a GPU that disappears mid-session (eGPU
    // unplug, driver crash, WSL device change) is surfaced instead of
    // silently going unnoticed until the next restart attempt fails.
    resolvedGpuIds: string[];
}

const STARTUP_TIMEOUT_MS = 180_000;
const HEALTH_POLL_MS = 750;
const MAX_LOG_LINES = 500;
const MAX_LOG_LINE_CHARS = 4_000;
const requestedIdleMinutes = Number(process.env.OLLAMA_CUSTOM_UI_LOCAL_BACKEND_IDLE_MINUTES ?? 10);
const configuredIdleMinutes = Number.isFinite(requestedIdleMinutes) ? Math.max(0, requestedIdleMinutes) : 10;
const servers = new Map<LocalBackendId, RunningServer>();
const serverStarts = new Map<LocalBackendId, { model: string; promise: Promise<string> }>();
const runtimeOperations = new Map<LocalBackendId, Exclude<RuntimeOperation, null>>();
const stoppedSnapshots = new Map<LocalBackendId, Pick<LocalRuntimeStatus, "logs" | "startupError" | "model">>();
const probeCache = new Map<string, { installed: boolean; expiresAt: number }>();
const capabilityCache = new Map<string, { value: RuntimeCommandCapabilities; expiresAt: number }>();
const gpuMemoryCache = new Map<number, { value: { device?: string; vramMB: number | null }; expiresAt: number }>();

export function buildRuntimeProbe(backend: LocalBackendId, config: LocalBackendConfig, platform: NodeJS.Platform = process.platform, arch = process.arch): RuntimeProbe {
    if (backend === "mlx") {
        const compatible = platform === "darwin" && arch === "arm64";
        const managedPython = environmentPython("mlx", platform);
        return { compatible, command: config.mlxPythonPath?.trim() || (fs.existsSync(managedPython) ? managedPython : "python3"), args: ["-c", "import mlx_lm"], detail: compatible ? "Apple Silicon accelerated runtime" : "Requires an Apple Silicon Mac" };
    }
    if (backend === "vllm") {
        const compatible = platform === "linux" || platform === "win32";
        const managed = managedVllmExecutable(platform);
        if (!config.vllmCommand?.trim() && !managed && platform === "win32") return { compatible, command: "wsl.exe", args: ["--", "vllm", "--version"], detail: "CUDA or ROCm runtime through WSL" };
        return { compatible, command: config.vllmCommand?.trim() || managed || "vllm", args: ["--version"], detail: compatible ? "High-throughput CUDA or ROCm runtime" : "Requires Linux or Windows with WSL" };
    }
    const compatible = platform === "linux" || !!config.rocmServerPath?.trim();
    return { compatible, command: config.rocmServerPath?.trim() || "llama-server", args: ["--version"], detail: compatible ? "AMD GPU runtime for local GGUF models" : "Requires Linux and a ROCm-capable AMD GPU" };
}

export function installCommand(backend: LocalBackendId): string {
    if (backend === "mlx") return "python3 -m pip install mlx-lm";
    if (backend === "vllm") return "python3 -m pip install vllm";
    return "Install a ROCm/HIP llama-server build, then configure its executable in Settings";
}

export function describeSpawnFailure(backend: LocalBackendId): string {
    if (backend === "mlx") return `Couldn't launch MLX. Install mlx-lm on an Apple Silicon Mac (${installCommand("mlx")}) and verify the configured Python interpreter.`;
    if (backend === "vllm") return `Couldn't launch vLLM. Install it in Linux/WSL (${installCommand("vllm")}) and verify that its CUDA or ROCm requirements match the GPU driver.`;
    return `Couldn't launch ROCm llama-server. ${installCommand("rocm")} and verify ROCm device access.`;
}

async function commandSucceeds(command: string, args: string[]): Promise<boolean> {
    return new Promise((resolve) => {
        let settled = false; let child: ChildProcess;
        const finish = (value: boolean) => { if (settled) return; settled = true; clearTimeout(timer); resolve(value); };
        try { child = spawn(command, args, { stdio: "ignore", windowsHide: true }); } catch { resolve(false); return; }
        const timer = setTimeout(() => { child.kill(); finish(false); }, 5_000); timer.unref();
        child.once("error", () => finish(false)); child.once("exit", (code) => finish(code === 0));
    });
}

async function cachedCommandSucceeds(command: string, args: string[]): Promise<boolean> {
    const key = JSON.stringify([command, args]); const cached = probeCache.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached.installed;
    const installed = await commandSucceeds(command, args);
    probeCache.set(key, { installed, expiresAt: Date.now() + 30_000 });
    return installed;
}

const CAPABILITY_TTL_MS = 5 * 60_000;
const MAX_PROBE_OUTPUT_BYTES = 512 * 1024;

async function boundedCommandOutput(command: string, args: string[]): Promise<string | null> {
    try {
        const { stdout, stderr } = await execFileAsync(command, args, {
            timeout: 8_000,
            maxBuffer: MAX_PROBE_OUTPUT_BYTES,
            windowsHide: true,
        });
        return `${stdout}\n${stderr}`;
    } catch (reason) {
        const error = reason as { stdout?: string; stderr?: string };
        const output = `${error.stdout ?? ""}\n${error.stderr ?? ""}`.trim();
        return output || null;
    }
}

export function parseRuntimeCommandCapabilities(
    backend: LocalBackendId,
    helpOutput: string | null,
    deviceOutput: string | null = null,
): RuntimeCommandCapabilities {
    if (backend === "mlx") return { checked: true, flags: [], backendDeviceNames: [], warnings: [] };
    if (!helpOutput) {
        return {
            checked: false,
            flags: [],
            backendDeviceNames: [],
            warnings: ["The runtime help probe failed, so optional startup flags cannot be verified."],
        };
    }
    const candidates = backend === "vllm"
        ? ["--max-model-len", "--gpu-memory-utilization", "--tensor-parallel-size", "--pipeline-parallel-size", "--cpu-offload-gb", "--swap-space"]
        : ["--n-gpu-layers", "--ctx-size", "--threads", "--threads-batch", "--batch-size", "--flash-attn", "--tensor-split", "--split-mode", "--main-gpu", "--fit", "--fit-target", "--list-devices"];
    const flags = candidates.filter((flag) => helpOutput.includes(flag));
    const backendDeviceNames = (deviceOutput ?? "")
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0 && !/^available devices:?$/i.test(line))
        .slice(0, 64);
    const warnings: string[] = [];
    if (backend === "rocm" && !flags.includes("--fit")) {
        warnings.push("This llama-server build does not advertise automatic memory fitting; Auto leaves its safe defaults unchanged.");
    }
    return { checked: true, flags, backendDeviceNames, warnings };
}

export async function probeRuntimeCommandCapabilities(
    backend: LocalBackendId,
    config: LocalBackendConfig,
    platform: NodeJS.Platform = process.platform,
): Promise<RuntimeCommandCapabilities> {
    if (backend === "mlx") return parseRuntimeCommandCapabilities(backend, "mlx");
    const probe = buildRuntimeProbe(backend, config, platform);
    const key = JSON.stringify([backend, probe.command, config, platform]);
    const cached = capabilityCache.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached.value;

    const isWindowsWslVllm = backend === "vllm" && probe.command === "wsl.exe";
    const helpArgs = isWindowsWslVllm ? ["--", "vllm", "serve", "--help"] : backend === "vllm" ? ["serve", "--help"] : ["--help"];
    const helpOutput = await boundedCommandOutput(probe.command, helpArgs);
    let deviceOutput: string | null = null;
    if (backend === "rocm" && helpOutput?.includes("--list-devices")) {
        deviceOutput = await boundedCommandOutput(probe.command, ["--list-devices"]);
    }
    const value = parseRuntimeCommandCapabilities(backend, helpOutput, deviceOutput);
    capabilityCache.set(key, { value, expiresAt: Date.now() + CAPABILITY_TTL_MS });
    return value;
}

function requireAdvertisedFlag(capabilities: RuntimeCommandCapabilities | undefined, flag: string, setting: string): void {
    if (!capabilities) return;
    if (!capabilities.checked) throw new Error(`Cannot apply ${setting}: the runtime's --help output could not be inspected.`);
    if (!capabilities.flags.includes(flag)) throw new Error(`The managed runtime does not advertise ${flag}; ${setting} is unsupported by this installed version.`);
}

export async function allocatePort(): Promise<number> {
    return new Promise((resolve, reject) => {
        const socket = createServer();
        socket.unref(); socket.once("error", reject);
        socket.listen({ host: "127.0.0.1", port: 0, exclusive: true }, () => {
            const address = socket.address();
            if (!address || typeof address === "string") { socket.close(); reject(new Error("Could not allocate a local runtime port")); return; }
            const port = address.port; socket.close((error) => error ? reject(error) : resolve(port));
        });
    });
}

function boundedInteger(value: unknown, minimum: number, maximum: number, fallback?: number): number | undefined {
    if (value === undefined || value === null || value === "") return fallback;
    const number = Number(value);
    if (!Number.isFinite(number)) throw new Error("Runtime startup settings must be finite numbers.");
    return Math.max(minimum, Math.min(maximum, Math.floor(number)));
}

function boundedNumber(value: unknown, minimum: number, maximum: number, fallback?: number): number | undefined {
    if (value === undefined || value === null || value === "") return fallback;
    const number = Number(value);
    if (!Number.isFinite(number)) throw new Error("Runtime startup settings must be finite numbers.");
    return Math.max(minimum, Math.min(maximum, number));
}

export function normalizeStartupConfig(input: RuntimeStartupConfig = {}): RuntimeStartupConfig {
    const utilization = input.gpuMemoryUtilization === undefined ? undefined : Number(input.gpuMemoryUtilization);
    if (utilization !== undefined && (!Number.isFinite(utilization) || utilization < 0.1 || utilization > 0.95)) throw new Error("GPU memory utilization must be between 0.1 and 0.95.");
    let gpuSelection: GpuSelection | undefined;
    if (input.gpuSelection) {
        const mode = input.gpuSelection.mode;
        if (!["auto", "single", "group", "all", "cpu"].includes(mode)) throw new Error("Invalid GPU selection mode.");
        const deviceIds = Array.isArray(input.gpuSelection.deviceIds) ? input.gpuSelection.deviceIds.filter((id): id is string => typeof id === "string" && id.length > 0) : [];
        gpuSelection = { mode, deviceIds };
    }
    let tensorSplit: number[] | undefined;
    if (input.tensorSplit !== undefined) {
        if (!Array.isArray(input.tensorSplit) || input.tensorSplit.some((value) => typeof value !== "number" || !Number.isFinite(value) || value <= 0)) {
            throw new Error("Tensor split values must all be finite positive numbers.");
        }
        tensorSplit = [...input.tensorSplit];
    }
    const legacyLayers = input.gpuLayers === undefined ? undefined : boundedInteger(input.gpuLayers, 0, 65_535);
    const requestedLayerMode = input.device === "cpu"
        ? "cpu"
        : input.gpuLayerMode ?? (legacyLayers === undefined ? "auto" : legacyLayers === 0 ? "cpu" : legacyLayers >= 999 ? "max" : "manual");
    if (!["auto", "cpu", "max", "manual"].includes(requestedLayerMode)) throw new Error("Invalid GPU layer mode.");
    if (requestedLayerMode === "manual" && legacyLayers === undefined) throw new Error("Manual GPU layer mode requires a layer count.");
    const flashAttention: FlashAttentionMode = input.flashAttention === "auto" || typeof input.flashAttention === "boolean"
        ? input.flashAttention
        : "auto";
    const rawSplitMode = String(input.splitMode ?? "");
    const splitMode: RuntimeSplitMode | undefined = rawSplitMode === "tensor" || rawSplitMode === "row"
        ? "tensor"
        : rawSplitMode === "layer" ? "layer" : undefined;
    return {
        contextLength: input.contextLength == null ? null : boundedInteger(input.contextLength, 256, 1_048_576),
        idleTimeoutMinutes: boundedInteger(input.idleTimeoutMinutes, 0, 1_440, configuredIdleMinutes),
        device: requestedLayerMode === "cpu" ? "cpu" : ["auto", "gpu"].includes(input.device ?? "auto") ? input.device ?? "auto" : "auto",
        gpuLayerMode: requestedLayerMode,
        gpuLayers: requestedLayerMode === "manual" ? legacyLayers : undefined,
        cpuThreads: boundedInteger(input.cpuThreads, 1, 512),
        cpuBatchThreads: boundedInteger(input.cpuBatchThreads, 1, 512),
        flashAttention,
        batchSize: boundedInteger(input.batchSize, 1, 65_536),
        vramReserveGB: boundedNumber(input.vramReserveGB, 0, 64, 1),
        gpuMemoryUtilization: utilization,
        tensorParallelSize: boundedInteger(input.tensorParallelSize, 1, 16, 1),
        pipelineParallelSize: boundedInteger(input.pipelineParallelSize, 1, 16, 1),
        cpuOffloadGB: boundedNumber(input.cpuOffloadGB, 0, 1_024),
        swapSpaceGB: boundedNumber(input.swapSpaceGB, 0, 1_024),
        gpuSelection,
        tensorSplit,
        splitMode,
        mainGpuId: input.mainGpuId,
    };
}

function isInside(root: string, candidate: string): boolean {
    const relative = path.relative(path.resolve(root), path.resolve(candidate));
    return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

export function validateRuntimeModel(backend: LocalBackendId, value: string, allowedModelsDir: string): string {
    const model = value.trim();
    if (!model || model.length > 1_024 || /[\r\n\0]/.test(model)) throw new Error("Choose a valid runtime model.");
    const localPath = path.isAbsolute(model);
    if (backend === "rocm" && !localPath) throw new Error("ROCm llama-server requires an installed GGUF model.");
    if (localPath) {
        const resolved = path.resolve(model);
        if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) throw new Error("The selected model file does not exist.");
        const trustedRoot = fs.existsSync(allowedModelsDir) ? fs.realpathSync(allowedModelsDir) : path.resolve(allowedModelsDir);
        const trustedModel = fs.realpathSync(resolved);
        if (!isInside(trustedRoot, trustedModel)) throw new Error("The selected model is outside the approved models directory.");
        if (backend === "rocm" && path.extname(trustedModel).toLowerCase() !== ".gguf") throw new Error("ROCm llama-server requires a GGUF model file.");
        return trustedModel;
    }
    if (!/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(model)) throw new Error("Enter a Hugging Face model ID in publisher/model format.");
    return model;
}

// `resolvedGpus` is the already-resolved (stable-id -> current hardware)
// device group this runtime should use, in selection order — empty means
// "no explicit filtering" (auto/CPU), which preserves today's single-GPU/
// CPU behavior exactly (no visibility env vars are set, so the runtime sees
// whatever it always did). Building the env object here (rather than
// mutating process.env) keeps the restriction scoped to this one spawned
// process.
export function buildServerCommand(backend: LocalBackendId, model: string, config: LocalBackendConfig, platform: NodeJS.Platform = process.platform, port = 0, startupInput: RuntimeStartupConfig = {}, resolvedGpus: GpuInfo[] = [], capabilities?: RuntimeCommandCapabilities): { command: string; args: string[]; env: Record<string, string> } {
    if (!port) throw new Error("A dynamically allocated runtime port is required");
    const startup = normalizeStartupConfig(startupInput);
    const vendor = resolvedGpus[0]?.vendor;
    if (resolvedGpus.length > 1) assertVendorHomogeneity(resolvedGpus, backend === "vllm" ? "vLLM" : "ROCm llama-server");
    const env: Record<string, string> = vendor ? buildGpuVisibilityEnv(vendor, resolvedGpus) : {};

    if (backend === "mlx") { const managed = environmentPython("mlx", platform); return { command: config.mlxPythonPath?.trim() || (fs.existsSync(managed) ? managed : "python3"), args: ["-m", "mlx_lm.server", "--model", model, "--port", String(port), "--host", "127.0.0.1"], env: {} }; }
    if (backend === "vllm") {
        if (startup.gpuSelection?.mode === "cpu") throw new Error("vLLM requires a compatible GPU; choose a GPU selection or use a CPU-capable runtime.");
        assertTensorParallelSizeMatches(startup.tensorParallelSize, resolvedGpus.length || (startup.tensorParallelSize ?? 1));
        const args = ["serve", model, "--port", String(port), "--host", "127.0.0.1"];
        if (startup.contextLength) { requireAdvertisedFlag(capabilities, "--max-model-len", "maximum model length"); args.push("--max-model-len", String(startup.contextLength)); }
        if (startup.gpuMemoryUtilization) { requireAdvertisedFlag(capabilities, "--gpu-memory-utilization", "GPU memory utilization"); args.push("--gpu-memory-utilization", String(startup.gpuMemoryUtilization)); }
        if ((startup.tensorParallelSize ?? 1) > 1) { requireAdvertisedFlag(capabilities, "--tensor-parallel-size", "tensor parallelism"); args.push("--tensor-parallel-size", String(startup.tensorParallelSize)); }
        if ((startup.pipelineParallelSize ?? 1) > 1) { requireAdvertisedFlag(capabilities, "--pipeline-parallel-size", "pipeline parallelism"); args.push("--pipeline-parallel-size", String(startup.pipelineParallelSize)); }
        if ((startup.cpuOffloadGB ?? 0) > 0) { requireAdvertisedFlag(capabilities, "--cpu-offload-gb", "CPU offload"); args.push("--cpu-offload-gb", String(startup.cpuOffloadGB)); }
        if ((startup.swapSpaceGB ?? 0) > 0) { requireAdvertisedFlag(capabilities, "--swap-space", "swap space"); args.push("--swap-space", String(startup.swapSpaceGB)); }
        const managed = managedVllmExecutable(platform);
        return !config.vllmCommand?.trim() && !managed && platform === "win32" ? { command: "wsl.exe", args: ["--", "vllm", ...args], env } : { command: config.vllmCommand?.trim() || managed || "vllm", args, env };
    }
    const args = ["-m", model, "--port", String(port), "--host", "127.0.0.1"];
    const layerMode = startup.gpuLayerMode ?? "auto";
    if (layerMode !== "auto") {
        requireAdvertisedFlag(capabilities, "--n-gpu-layers", "GPU layer placement");
        const layerValue = layerMode === "cpu" ? 0 : layerMode === "max" ? -1 : startup.gpuLayers;
        if (layerValue === undefined) throw new Error("Manual GPU layer mode requires a layer count.");
        args.push("--n-gpu-layers", String(layerValue));
    } else if (capabilities?.flags.includes("--fit")) {
        args.push("--fit", "on");
        if (capabilities.flags.includes("--fit-target") && (startup.vramReserveGB ?? 0) > 0) {
            args.push("--fit-target", String(Math.ceil((startup.vramReserveGB ?? 1) * 1024)));
        }
    }
    if (startup.contextLength) { requireAdvertisedFlag(capabilities, "--ctx-size", "context size"); args.push("--ctx-size", String(startup.contextLength)); }
    if (startup.cpuThreads) { requireAdvertisedFlag(capabilities, "--threads", "CPU threads"); args.push("--threads", String(startup.cpuThreads)); }
    if (startup.cpuBatchThreads) { requireAdvertisedFlag(capabilities, "--threads-batch", "batch CPU threads"); args.push("--threads-batch", String(startup.cpuBatchThreads)); }
    if (startup.batchSize) { requireAdvertisedFlag(capabilities, "--batch-size", "batch size"); args.push("--batch-size", String(startup.batchSize)); }
    if (startup.flashAttention !== "auto") { requireAdvertisedFlag(capabilities, "--flash-attn", "Flash Attention"); args.push("--flash-attn", startup.flashAttention ? "on" : "off"); }
    if (resolvedGpus.length > 1) {
        requireAdvertisedFlag(capabilities, "--tensor-split", "multi-GPU split proportions");
        requireAdvertisedFlag(capabilities, "--split-mode", "multi-GPU split mode");
        const split = startup.tensorSplit && startup.tensorSplit.length > 0 ? startup.tensorSplit : generateAutoTensorSplit(resolvedGpus, startup.vramReserveGB);
        validateTensorSplit(split, resolvedGpus.length);
        args.push("--tensor-split", split.join(","));
        args.push("--split-mode", startup.splitMode === "tensor" ? "row" : "layer");
        const mainIndex = resolveMainGpuIndex(resolvedGpus, startup.mainGpuId);
        if (mainIndex !== undefined) { requireAdvertisedFlag(capabilities, "--main-gpu", "primary GPU selection"); args.push("--main-gpu", String(mainIndex)); }
    } else if (resolvedGpus.length === 1 && resolvedGpus[0].index !== undefined) {
        // Visibility filtering remaps the one selected device to runtime
        // index 0, regardless of its original vendor index.
        requireAdvertisedFlag(capabilities, "--main-gpu", "primary GPU selection");
        args.push("--main-gpu", "0");
    }
    return { command: config.rocmServerPath?.trim() || "llama-server", args, env };
}

function pushLog(entry: RunningServer, source: "stdout" | "stderr" | "manager", text: string): void {
    const combined = entry.logRemainder + text; const lines = combined.split(/\r?\n/); entry.logRemainder = lines.pop() ?? "";
    for (const line of lines) { if (!line) continue; entry.logs.push(`${new Date().toISOString()} [${source}] ${line.slice(0, MAX_LOG_LINE_CHARS)}`); }
    if (entry.logs.length > MAX_LOG_LINES) entry.logs.splice(0, entry.logs.length - MAX_LOG_LINES);
}

export function identityMatches(payload: unknown, expectedModel: string): boolean {
    if (!payload || typeof payload !== "object") return false;
    const data = (payload as { data?: unknown }).data;
    if (!Array.isArray(data) || data.length === 0) return false;
    const ids = data.map((item) => String((item as { id?: unknown })?.id ?? "").toLowerCase()).filter(Boolean);
    if (!ids.length) return false;
    const expected = expectedModel.toLowerCase(); const leaf = expected.split(/[\\/]/).pop() ?? expected;
    return ids.some((id) => id === expected || id.includes(leaf) || expected.includes(id));
}

async function healthCheck(baseUrl: string, expectedModel: string): Promise<boolean> {
    try {
        const response = await fetch(`${baseUrl}/v1/models`, { signal: AbortSignal.timeout(2_000) });
        if (!response.ok || !(response.headers.get("content-type") ?? "").includes("json")) return false;
        return identityMatches(await response.json(), expectedModel);
    } catch { return false; }
}

function clearIdleTimer(server: RunningServer): void { if (server.idleTimer) clearTimeout(server.idleTimer); server.idleTimer = null; }
function scheduleIdleStop(backend: LocalBackendId, server: RunningServer): void {
    const idleTimeoutMs = Math.max(0, server.startupConfig.idleTimeoutMinutes ?? configuredIdleMinutes) * 60_000;
    clearIdleTimer(server); if (!idleTimeoutMs || server.activeRequests || server.exited) return;
    server.idleTimer = setTimeout(() => { if (servers.get(backend) === server && !server.activeRequests) void stopServer(backend); }, idleTimeoutMs); server.idleTimer.unref();
}

async function startOrReuseServer(backend: LocalBackendId, model: string, config: LocalBackendConfig, startupInput: RuntimeStartupConfig = {}, resolvedGpus: GpuInfo[] = []): Promise<string> {
    // GPU selection/split are already part of `startupConfig` (normalized
    // above), so the existing reuse-identity check below — comparing the
    // whole normalized config by value — already treats a changed GPU
    // selection like any other startup-option change: a mismatch stops the
    // old process and starts a new one instead of silently reusing a server
    // configured for a different device group.
    const startupConfig = normalizeStartupConfig(startupInput);
    const existing = servers.get(backend);
    if (existing && !existing.exited && existing.model === model && JSON.stringify(existing.startupConfig) === JSON.stringify(startupConfig) && await healthCheck(existing.baseUrl, model)) return existing.baseUrl;
    if (existing) { if (existing.activeRequests) throw new Error(`The ${backend} runtime is serving ${existing.activeRequests} active request(s).`); await stopServer(backend); }
    const capabilities = await probeRuntimeCommandCapabilities(backend, config);
    if (backend !== "mlx" && !capabilities.checked) throw new Error(capabilities.warnings[0] ?? "Runtime capability probing failed.");
    const port = await allocatePort(); const baseUrl = `http://127.0.0.1:${port}`; const { command, args, env } = buildServerCommand(backend, model, config, process.platform, port, startupConfig, resolvedGpus, capabilities);
    let child: ChildProcess;
    try { child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true, detached: process.platform !== "win32", env: Object.keys(env).length > 0 ? { ...process.env, ...env } : undefined }); } catch { throw new Error(describeSpawnFailure(backend)); }
    const resolvedGpuIds = resolvedGpus.map((gpu) => gpu.id).filter((id): id is string => !!id);
    const entry: RunningServer = { process: child, model, baseUrl, port, state: "starting", exited: false, startedAt: Date.now(), activeRequests: 0, idleTimer: null, logs: [], logRemainder: "", startupConfig, lastHealthCheckAt: null, resolvedGpuIds };
    servers.set(backend, entry); pushLog(entry, "manager", `Starting ${command} ${args.join(" ")}`);
    child.stdout?.setEncoding("utf8"); child.stderr?.setEncoding("utf8"); child.stdout?.on("data", (data: string) => pushLog(entry, "stdout", data)); child.stderr?.on("data", (data: string) => pushLog(entry, "stderr", data));
    let spawnError: string | null = null;
    child.on("error", (error: NodeJS.ErrnoException) => { spawnError = error.code === "ENOENT" ? describeSpawnFailure(backend) : error.message; entry.startupError = spawnError; entry.state = "unhealthy"; entry.exited = true; });
    child.on("exit", (code, signal) => { entry.exited = true; entry.state = code === 0 ? "stopped" : "unhealthy"; pushLog(entry, "manager", `Process exited code=${code ?? "null"} signal=${signal ?? "none"}`); if (code) entry.startupError = explainStartupFailure(backend, entry.logs); });
    const deadline = Date.now() + STARTUP_TIMEOUT_MS;
    while (Date.now() < deadline) {
        if (spawnError) throw new Error(spawnError);
        if (entry.exited) { const explanation = entry.startupError ?? explainStartupFailure(backend, entry.logs); stoppedSnapshots.set(backend, { logs: [...entry.logs], startupError: explanation, model }); servers.delete(backend); throw new Error(explanation); }
        entry.lastHealthCheckAt = Date.now();
        if (await healthCheck(baseUrl, model)) { entry.state = "running"; pushLog(entry, "manager", `Identity health check passed on port ${port}`); scheduleIdleStop(backend, entry); return baseUrl; }
        await new Promise((resolve) => setTimeout(resolve, HEALTH_POLL_MS));
    }
    entry.state = "unhealthy"; entry.startupError = `Runtime did not identify itself within ${STARTUP_TIMEOUT_MS / 1000}s. ${explainStartupFailure(backend, entry.logs)}`; await stopServer(backend, true); throw new Error(entry.startupError);
}

export function explainStartupFailure(backend: LocalBackendId, logs: string[]): string {
    const text = logs.slice(-80).join("\n");
    if (/out of memory|cuda.*memory|hip.*memory|cannot allocate/i.test(text)) return `${backend} could not load the model because available RAM or VRAM is insufficient.`;
    if (/no module named|module.*not found/i.test(text)) return `${backend} is missing a Python package. ${installCommand(backend)}.`;
    if (/permission denied|eacces/i.test(text)) return `${backend} could not execute or access the model because of filesystem permissions.`;
    if (/not found|enoent|no such file/i.test(text)) return `${backend} could not find its executable or model. Validate the configured paths.`;
    if (/cuda|driver|rocm|hip/i.test(text)) return `${backend} failed GPU initialization. Verify the driver, runtime version, and device compatibility.`;
    return `${backend} exited before becoming healthy. Review the captured runtime logs for the original error.`;
}

export function classifyRuntimeError(message: string): { category: RuntimeErrorCategory; recoveryAction: string } {
    const text = message.toLowerCase();
    if (/out of memory|cannot allocate|insufficient.*(?:ram|vram)/.test(text)) return { category: "insufficient_memory", recoveryAction: "Choose a smaller quantization or context length, or reduce GPU layers." };
    if (/no module named|module.*not found|package.*mismatch/.test(text)) return { category: "package_mismatch", recoveryAction: "Repair the managed Python environment and recheck its package versions." };
    if (/permission denied|eacces|eperm/.test(text)) return { category: "permission", recoveryAction: "Check model and executable permissions, then retry." };
    if (/enoent|executable.*unavailable|could not find.*executable/.test(text)) return { category: "missing_executable", recoveryAction: "Install or configure the runtime executable in Settings." };
    if (/invalid model|failed to load model|model.*not found/.test(text)) return { category: "invalid_model", recoveryAction: "Choose an installed compatible model and verify that all model files are present." };
    if (/gguf|safetensors|model format/.test(text)) return { category: "model_format", recoveryAction: "Choose a model format supported by this runtime." };
    if (/address.*use|bind|port/.test(text)) return { category: "port_failure", recoveryAction: "Close the process using the port and restart the runtime." };
    if (/health|timed out|identify itself/.test(text)) return { category: "health_timeout", recoveryAction: "Review startup logs, then retry with a smaller model or longer startup allowance." };
    if (/cuda|rocm|hip|metal|gpu initialization/.test(text)) return { category: "gpu_initialization", recoveryAction: "Verify the GPU driver, accelerator runtime, and device compatibility." };
    if (/unsupported|requires .*linux|requires .*mac/.test(text)) return { category: "unsupported_platform", recoveryAction: "Use a compatible operating system and accelerator." };
    return { category: "unknown", recoveryAction: "Review the runtime logs and retry after correcting the first reported error." };
}

export async function ensureServer(backend: LocalBackendId, model: string, config: LocalBackendConfig, startupConfig: RuntimeStartupConfig = {}, resolvedGpus: GpuInfo[] = []): Promise<string> {
    const pending = serverStarts.get(backend); if (pending) { if (pending.model === model) return pending.promise; await pending.promise.catch(() => undefined); return ensureServer(backend, model, config, startupConfig, resolvedGpus); }
    runtimeOperations.set(backend, "starting");
    const promise = withInferenceResourceLock(`start:${backend}:${model}`, () => startOrReuseServer(backend, model, config, startupConfig, resolvedGpus)); serverStarts.set(backend, { model, promise });
    try { return await promise; } finally { if (serverStarts.get(backend)?.promise === promise) serverStarts.delete(backend); if (runtimeOperations.get(backend) === "starting") runtimeOperations.delete(backend); }
}
export async function startServer(backend: LocalBackendId, model: string, config: LocalBackendConfig, startupConfig: RuntimeStartupConfig = {}, resolvedGpus: GpuInfo[] = []): Promise<string> { return ensureServer(backend, model, config, startupConfig, resolvedGpus); }
export async function restartServer(backend: LocalBackendId, model: string, config: LocalBackendConfig, startupConfig: RuntimeStartupConfig = {}, resolvedGpus: GpuInfo[] = []): Promise<string> {
    const current = servers.get(backend);
    if (current?.activeRequests) throw new Error(`The ${backend} runtime is serving ${current.activeRequests} active request(s). Stop or wait for them before restarting.`);
    runtimeOperations.set(backend, "restarting");
    try { await stopServer(backend); return await withInferenceResourceLock(`restart:${backend}:${model}`, () => startOrReuseServer(backend, model, config, startupConfig, resolvedGpus)); }
    finally { runtimeOperations.delete(backend); }
}

export async function acquireServer(backend: LocalBackendId, model: string, config: LocalBackendConfig): Promise<{ baseUrl: string; release(): void }> {
    const current = servers.get(backend); if (current) clearIdleTimer(current); const baseUrl = await ensureServer(backend, model, config); const server = servers.get(backend);
    if (!server || server.exited || server.model !== model) throw new Error(`The ${backend} runtime stopped before the request could start.`);
    server.activeRequests++; let released = false;
    return { baseUrl, release() { if (released) return; released = true; if (servers.get(backend) !== server) return; server.activeRequests = Math.max(0, server.activeRequests - 1); scheduleIdleStop(backend, server); } };
}

export async function stopServer(backend: LocalBackendId, force = false): Promise<StopRuntimeResult> {
    const entry = servers.get(backend); if (!entry) return { stopped: true, activeRequests: 0, forced: force };
    if (entry.activeRequests > 0 && !force) return { stopped: false, activeRequests: entry.activeRequests, forced: false };
    runtimeOperations.set(backend, "stopping"); entry.state = "stopping"; clearIdleTimer(entry); pushLog(entry, "manager", force ? "Force stop requested" : "Graceful stop requested");
    stoppedSnapshots.set(backend, { logs: [...entry.logs], startupError: entry.startupError, model: entry.model });
    const pid = entry.process.pid; entry.process.kill("SIGTERM");
    await new Promise<void>((resolve) => {
        if (entry.exited) { resolve(); return; }
        const timeout = setTimeout(() => { if (pid && !entry.exited) killProcessTree(pid, "SIGKILL"); resolve(); }, 5_000);
        timeout.unref(); entry.process.once("exit", () => { clearTimeout(timeout); resolve(); });
    });
    if (servers.get(backend) === entry) servers.delete(backend);
    runtimeOperations.delete(backend);
    return { stopped: true, activeRequests: entry.activeRequests, forced: force };
}
export function stopAll(): void { serverStarts.clear(); for (const backend of [...servers.keys()]) void stopServer(backend, true); }
export function getRunningBackends(): { backend: LocalBackendId; model: string }[] { return [...servers].filter(([, server]) => !server.exited).map(([backend, server]) => ({ backend, model: server.model })); }

async function gpuProcessMemory(pid: number): Promise<{ device?: string; vramMB: number | null }> {
    const cached = gpuMemoryCache.get(pid); if (cached && cached.expiresAt > Date.now()) return cached.value;
    try {
        const { stdout } = await execFileAsync("nvidia-smi", ["--query-compute-apps=pid,gpu_name,used_memory", "--format=csv,noheader,nounits"], { timeout: 2_000, windowsHide: true });
        for (const line of stdout.split(/\r?\n/)) { const [rawPid, device, memory] = line.split(",").map((item) => item.trim()); if (Number(rawPid) === pid) { const value = { device, vramMB: Number(memory) }; gpuMemoryCache.set(pid, { value, expiresAt: Date.now() + 5_000 }); return value; } }
    } catch { /* unavailable or non-NVIDIA */ }
    const value = { vramMB: null }; gpuMemoryCache.set(pid, { value, expiresAt: Date.now() + 5_000 }); return value;
}

// True kernel/OS-level GPU hot-plug eventing (WM_DEVICECHANGE on Windows,
// udev on Linux, IOKit on macOS) isn't available through Node/Electron
// without a native addon — this is the practical middle ground: compare the
// GPU ids a running process was actually launched against to the
// current detection snapshot on every status poll (piggybacking on the
// existing 5s status-poll cadence, no extra probing of its own) and flag it
// the moment a device the process depends on has disappeared (unplugged
// eGPU, driver crash/reset, WSL device-passthrough change), rather than only
// ever noticing at the next explicit start/restart attempt.
function deviceChangeIssue(server: RunningServer, currentGpus?: GpuInfo[]): { category: "device_changed_after_startup"; recoveryAction: string; issue: string } | null {
    if (!currentGpus || server.resolvedGpuIds.length === 0) return null;
    const currentIds = new Set(currentGpus.map((gpu) => gpu.id).filter((id): id is string => !!id));
    const missing = server.resolvedGpuIds.filter((id) => !currentIds.has(id));
    if (missing.length === 0) return null;
    return {
        category: "device_changed_after_startup",
        recoveryAction: "Restart this runtime to resolve against currently available GPUs, or switch its selection to automatic.",
        issue: `GPU(s) this runtime was started with are no longer detected: ${missing.join(", ")}.`,
    };
}

export async function getRuntimeStatuses(config: LocalBackendConfig, currentGpus?: GpuInfo[]): Promise<LocalRuntimeStatus[]> {
    return Promise.all((["rocm", "mlx", "vllm"] as const).map(async (backend) => {
        const probe = buildRuntimeProbe(backend, config); const server = servers.get(backend); const live = !!server && !server.exited;
        const installed = probe.compatible && (live || await cachedCommandSucceeds(probe.command, probe.args));
        const commandCapabilities = installed ? await probeRuntimeCommandCapabilities(backend, config) : undefined;
        let ramMB: number | null = null; let vramMB: number | null = null; let device: string | undefined;
        if (live && server.process.pid) {
            try { ramMB = (await pidusage(server.process.pid)).memory / 1024 / 1024; } catch { /* exited between reads */ }
            const gpu = await gpuProcessMemory(server.process.pid); vramMB = gpu.vramMB; device = gpu.device;
            if (server.state === "running" || server.state === "unhealthy") {
                server.lastHealthCheckAt = Date.now();
                server.state = await healthCheck(server.baseUrl, server.model) ? "running" : "unhealthy";
            }
        }
        const snapshot = stoppedSnapshots.get(backend); const issues: string[] = [];
        if (!probe.compatible) issues.push(probe.detail); if (probe.compatible && !installed) issues.push(`Runtime executable unavailable: ${probe.command}`);
        if (commandCapabilities) issues.push(...commandCapabilities.warnings);
        const deviceChange = live ? deviceChangeIssue(server, currentGpus) : null;
        if (deviceChange) issues.push(deviceChange.issue);
        const startupError = server?.startupError ?? snapshot?.startupError;
        const classified = deviceChange ?? (startupError ? classifyRuntimeError(startupError) : !probe.compatible ? { category: "unsupported_platform" as const, recoveryAction: "Use a compatible operating system and accelerator." } : !installed ? { category: "missing_executable" as const, recoveryAction: "Install or configure the runtime executable." } : undefined);
        const operation = runtimeOperations.get(backend) ?? null;
        return { backend, compatible: probe.compatible, installed, running: live && server.state === "running", state: operation === "restarting" ? "restarting" : server?.state ?? "stopped", model: server?.model ?? snapshot?.model,
            detail: probe.detail, device, pid: server?.process.pid ?? null, port: server?.port ?? null, startedAt: server ? new Date(server.startedAt).toISOString() : null,
            uptimeSeconds: server ? Math.max(0, (Date.now() - server.startedAt) / 1000) : 0, ramMB: ramMB === null ? null : +ramMB.toFixed(1), vramMB,
            logs: server ? [...server.logs] : snapshot?.logs ?? [], startupError,
            installCommand: installCommand(backend), environmentIssues: issues, activeRequests: server?.activeRequests ?? 0,
            idleTimeoutMinutes: server?.startupConfig.idleTimeoutMinutes ?? configuredIdleMinutes, lastHealthCheckAt: server?.lastHealthCheckAt ? new Date(server.lastHealthCheckAt).toISOString() : null,
            operation, currentConfig: server?.startupConfig, errorCategory: classified?.category, recoveryAction: classified?.recoveryAction, commandCapabilities };
    }));
}

export function clearRuntimeLogs(backend: LocalBackendId): void {
    const server = servers.get(backend); if (server) server.logs = [];
    const snapshot = stoppedSnapshots.get(backend); if (snapshot) stoppedSnapshots.set(backend, { ...snapshot, logs: [] });
}
