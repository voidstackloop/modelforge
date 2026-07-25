import * as os from "node:os";
import { execFile } from "node:child_process";

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
    platform: NodeJS.Platform;
    arch: string;
    // Kept for backward compatibility with anything expecting a single GPU —
    // this is just gpus[0]. Prefer `gpus` and `totalVramGB` for anything
    // multi-GPU-aware.
    gpu: GpuInfo | null;
    gpus: GpuInfo[];
    totalVramGB: number | null;
    largestGpuVramGB: number | null;
    gpuInterconnect: "nvlink" | "pcie" | "unified" | "none" | "unknown";
    tensorParallelSupported: boolean;
    cpuMemoryBandwidthGBps: number;
    cpuMemoryBandwidthMeasured: boolean;
}

export interface ModelCatalogEntry {
    name: string;
    label: string;
    minRAMGB: number;
    description: string;
    // Whether this model has reliable tool/function-calling support — the
    // thing that actually matters for Agent mode. A model can be a great
    // general chat model and still be a poor fit for agentic tool use if it
    // frequently drops or mangles tool calls.
    supportsTools: boolean;
}

export interface RecommendedModel extends ModelCatalogEntry {
    fits: boolean;
    runsOnGpu: boolean;
    recommended: boolean;
    outcome: RecommendationOutcome;
    quantization: string;
    estimatedWeightGB: number;
    estimatedKvCacheGB: number;
    runtimeOverheadGB: number;
    totalRequiredGB: number;
    expectedGpuOffloadPercent: number;
    estimatedTokensPerSecond: number;
    measuredTokensPerSecond?: number;
    reason: string;
    recommendedRuntime: "ollama" | "llamacpp" | "vllm" | "mlx";
}

export type RecommendationOutcome = "Runs fully on GPU" | "Runs with partial offload" | "CPU-only but usable" | "Requires tensor parallelism" | "Likely out of memory";
export const QUANTIZATION_BITS = { Q2_K: 2.625, Q3_K_M: 3.5, Q4_K_M: 4.75, Q5_K_M: 5.5, Q6_K: 6.56, Q8_0: 8.5 } as const;
export interface RecommendationOptions { quantization?: keyof typeof QUANTIZATION_BITS; contextLength?: number; runtime?: "automatic" | "ollama" | "llamacpp" | "vllm" | "mlx" }
export interface BenchmarkObservation { model: string; tokensPerSecond: number; promptTokensPerSecond?: number; timeToFirstTokenMs?: number }

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

// Model tags are Ollama library names as of this app's last update — Ollama's
// lineup changes often, so verify a tag still exists (`ollama pull <name>`)
// if a pull ever fails; the search box above also lets you pull any exact
// tag directly regardless of what's curated here.
export const MODEL_CATALOG: ModelCatalogEntry[] = [
    { name: "llama3.2:1b", label: "Llama 3.2 1B", minRAMGB: 2, description: "Fastest option, good for quick replies on low-end hardware.", supportsTools: false },
    { name: "llama3.2:3b", label: "Llama 3.2 3B", minRAMGB: 4, description: "Good balance of speed and quality for everyday chat.", supportsTools: true },
    { name: "qwen3:4b", label: "Qwen3 4B", minRAMGB: 5, description: "Reliable tool-calling in a small footprint — a good Agent mode pick on modest hardware.", supportsTools: true },
    { name: "phi3.5", label: "Phi-3.5 Mini 3.8B", minRAMGB: 5, description: "Strong reasoning for its size, runs well on modest hardware.", supportsTools: false },
    { name: "llama3.1:8b", label: "Llama 3.1 8B", minRAMGB: 8, description: "Meta's flagship mid-size model — great all-rounder with solid tool support.", supportsTools: true },
    { name: "qwen3:8b", label: "Qwen3 8B", minRAMGB: 8, description: "Among the most reliable open models for tool/function calling at this size — recommended for Agent mode.", supportsTools: true },
    { name: "mistral-nemo", label: "Mistral Nemo 12B", minRAMGB: 10, description: "Solid general-purpose model with dependable tool calling.", supportsTools: true },
    { name: "gemma2:9b", label: "Gemma 2 9B", minRAMGB: 10, description: "Google's efficient high-quality model for general chat.", supportsTools: false },
    { name: "qwen2.5-coder:14b", label: "Qwen 2.5 Coder 14B", minRAMGB: 16, description: "Strong coding ability with tool calling — a good Agent mode pick for dev workflows.", supportsTools: true },
    { name: "devstral-small", label: "Devstral Small 24B", minRAMGB: 24, description: "Trained specifically for agentic coding — built for exactly this app's Agent mode.", supportsTools: true },
    { name: "qwen3:30b-a3b", label: "Qwen3 30B-A3B", minRAMGB: 24, description: "Mixture-of-experts model with strong tool-calling reliability at a manageable memory footprint.", supportsTools: true },
    { name: "command-r-plus", label: "Command R+", minRAMGB: 64, description: "Enterprise-grade tool use and retrieval, needs a workstation-class machine.", supportsTools: true },
    { name: "llama3.1:70b", label: "Llama 3.1 70B", minRAMGB: 48, description: "Near top-tier quality, requires a workstation-class PC.", supportsTools: true },
];

export type GpuVendor = "nvidia" | "amd" | "intel" | "apple" | "unknown";

// Classifies a GPU by its marketing name — the only identity most detection
// paths give us (the Windows WMI path and macOS system_profiler report names,
// not vendor IDs). Drives which llama.cpp backend gets recommended: CUDA is
// NVIDIA-only, Metal is Apple-only, and AMD/Intel accelerate via Vulkan
// (node-llama-cpp ships no ROCm/SYCL prebuilds — native ROCm means Ollama).
export function classifyGpuVendor(name: string): GpuVendor {
    if (/nvidia|geforce|\brtx\b|\bgtx\b|quadro|tesla/i.test(name)) return "nvidia";
    if (/\bamd\b|radeon|\brx\s?\d{3,4}\b|vega|firepro|instinct/i.test(name)) return "amd";
    if (/intel|\barc\b|iris|uhd graphics|hd graphics/i.test(name)) return "intel";
    if (/apple/i.test(name)) return "apple";
    return "unknown";
}

// The five backends the app can actually load a model with.
export type ConcreteRuntime = "ollama" | "llamacpp" | "vllm" | "mlx" | "transformers";

// A model's on-disk/distribution format, inferred from a filename or HF repo
// id — this is what "Automatic" branches on, alongside detected hardware.
export type ModelFormat = "gguf" | "safetensors" | "mlx" | "ollama" | "unknown";

// Infers format from a filename or Hugging Face repo id. GGUF and
// safetensors are identified by file extension; MLX has no extension of its
// own (it's a directory of .safetensors plus an mlx-flavored config.json),
// so it's identified by the `mlx-community/` publisher convention that
// mlx-lm's own conversion tooling uses.
export function detectModelFormat(identifier: string): ModelFormat {
    const lower = identifier.toLowerCase();
    if (lower.endsWith(".gguf")) return "gguf";
    if (lower.endsWith(".safetensors") || lower.endsWith(".safetensors.index.json")) return "safetensors";
    if (/(^|\/)mlx-community\//.test(lower) || /-mlx(-|$)/.test(lower)) return "mlx";
    return "unknown";
}

// The policy behind the "Automatic" runtime: given a model's format and this
// machine's hardware, pick the concrete backend to run it with.
//   GGUF                              -> llama.cpp (runs on any vendor, or CPU-only)
//   Safetensors + NVIDIA/AMD (ROCm)   -> vLLM
//   MLX-format model + Apple Silicon  -> MLX
//   Ollama-library model              -> Ollama (MLX on Apple Silicon, which
//                                        has the edge over llama.cpp there)
//   Anything else (safetensors with no supported GPU, MLX format off Apple
//   Silicon, an unrecognized format) -> Transformers, the universal fallback
//   for architectures the other backends can't load.
export function resolveAutomaticRuntime(format: ModelFormat, specs: Pick<SystemSpecs, "platform" | "arch" | "gpus">): ConcreteRuntime {
    const isAppleSilicon = specs.platform === "darwin" && specs.arch === "arm64";
    const hasVllmGpu = specs.gpus.some((gpu) => gpu.vendor === "nvidia" || gpu.vendor === "amd");
    if (format === "ollama") return isAppleSilicon ? "mlx" : "ollama";
    if (format === "gguf") return "llamacpp";
    if (format === "mlx" && isAppleSilicon) return "mlx";
    if (format === "safetensors" && hasVllmGpu) return "vllm";
    return "transformers";
}

function execFileP(cmd: string, args: string[]): Promise<string | null> {
    return new Promise((resolve) => {
        execFile(cmd, args, { timeout: 3000 }, (err, stdout) => {
            if (err) return resolve(null);
            resolve(stdout);
        });
    });
}

// Returns every GPU nvidia-smi/PowerShell/system_profiler reports, not just
// the first one — a single-GPU read silently undercounts available VRAM
// (and therefore which models "fit") on any multi-GPU machine.
async function detectGpus(): Promise<GpuInfo[]> {
    // NVIDIA tooling works the same way on Windows and Linux when drivers are
    // installed, and reports one CSV line per GPU when there's more than one.
    const nvidiaOut = await execFileP("nvidia-smi", [
        "--query-gpu=name,memory.total",
        "--format=csv,noheader,nounits",
    ]);
    if (nvidiaOut) {
        const gpus: GpuInfo[] = [];
        for (const line of nvidiaOut.trim().split("\n")) {
            const [name, memMiB] = line.split(",").map((s) => s.trim());
            if (name && memMiB && !Number.isNaN(Number(memMiB))) {
                gpus.push({ name, vramGB: +(Number(memMiB) / 1024).toFixed(1), vendor: "nvidia" });
            }
        }
        if (gpus.length > 0) return gpus;
    }

    if (os.platform() === "win32") {
        const out = await execFileP("powershell", [
            "-NoProfile",
            "-Command",
            "Get-CimInstance Win32_VideoController | Select-Object Name,AdapterRAM | ConvertTo-Json",
        ]);
        if (out) {
            try {
                const parsed = JSON.parse(out);
                const list = Array.isArray(parsed) ? parsed : [parsed];
                const gpus: GpuInfo[] = [];
                for (const gpu of list) {
                    if (!gpu?.Name) continue;
                    // AdapterRAM is a known-buggy 32-bit field on Windows for GPUs with >4GB VRAM,
                    // so only trust it when it lands in a plausible range.
                    const ramGB = gpu.AdapterRAM ? gpu.AdapterRAM / 1e9 : 0;
                    gpus.push({
                        name: gpu.Name,
                        vramGB: ramGB > 0 && ramGB < 64 ? +ramGB.toFixed(1) : null,
                        vendor: classifyGpuVendor(gpu.Name),
                    });
                }
                if (gpus.length > 0) return gpus;
            } catch {
                // ignore malformed output
            }
        }
    }

    // Linux without NVIDIA drivers (AMD/Intel boxes) previously detected
    // nothing at all — lspci names the display controllers even when no
    // vendor tooling is installed.
    if (os.platform() === "linux") {
        const out = await execFileP("lspci", []);
        if (out) {
            const gpus: GpuInfo[] = [];
            for (const line of out.split("\n")) {
                if (/VGA compatible controller|3D controller|Display controller/i.test(line)) {
                    const name = line.split(":").slice(2).join(":").trim();
                    if (name) gpus.push({ name, vramGB: null, vendor: classifyGpuVendor(name) });
                }
            }
            if (gpus.length > 0) return gpus;
        }
    }

    if (os.platform() === "darwin") {
        const out = await execFileP("system_profiler", ["SPDisplaysDataType"]);
        if (out) {
            const gpus: GpuInfo[] = [];
            // Apple Silicon GPUs share unified memory with the CPU rather than
            // dedicated VRAM, so there's no per-GPU size to report here.
            for (const match of out.matchAll(/Chipset Model:\s*(.+)/g)) {
                gpus.push({ name: match[1].trim(), vramGB: null, vendor: "apple" });
            }
            if (gpus.length > 0) return gpus;
        }
    }

    return [];
}

async function detectGpuInterconnect(gpus: GpuInfo[]): Promise<SystemSpecs["gpuInterconnect"]> {
    if (gpus.length < 2) return gpus.some((gpu) => gpu.vendor === "apple") ? "unified" : "none";
    if (gpus.every((gpu) => gpu.vendor === "apple")) return "unified";
    if (gpus.every((gpu) => gpu.vendor === "nvidia")) {
        const topology = await execFileP("nvidia-smi", ["topo", "-m"]);
        return topology && /NV\d+|NVLink/i.test(topology) ? "nvlink" : "pcie";
    }
    return "unknown";
}

function estimateCpuMemoryBandwidthGBps(cpuModel: string, cores: number, platform: NodeJS.Platform): number {
    if (platform === "darwin" && /Apple M[1-9]/i.test(cpuModel)) return /Ultra/i.test(cpuModel) ? 600 : /Max/i.test(cpuModel) ? 400 : /Pro/i.test(cpuModel) ? 200 : 100;
    if (/EPYC|Xeon.*Max/i.test(cpuModel)) return Math.min(350, Math.max(100, cores * 4));
    if (/Threadripper|Xeon/i.test(cpuModel)) return Math.min(220, Math.max(70, cores * 3));
    return Math.min(120, Math.max(25, cores * 4));
}

export async function getSpecs(): Promise<SystemSpecs> {
    const cpus = os.cpus() || [];
    const gpus = await detectGpus();
    const knownVram = gpus.map((g) => g.vramGB).filter((v): v is number => v !== null);
    const totalVramGB = knownVram.length > 0 ? +knownVram.reduce((a, b) => a + b, 0).toFixed(1) : null;
    const largestGpuVramGB = knownVram.length > 0 ? Math.max(...knownVram) : null;
    const gpuInterconnect = await detectGpuInterconnect(gpus);
    const cpuModel = cpus[0] ? cpus[0].model : "Unknown CPU";

    return {
        totalRAMGB: +(os.totalmem() / 1e9).toFixed(1),
        freeRAMGB: +(os.freemem() / 1e9).toFixed(1),
        cpuModel,
        cpuCores: cpus.length,
        platform: os.platform(),
        arch: os.arch(),
        gpu: gpus[0] ?? null,
        gpus,
        totalVramGB,
        largestGpuVramGB,
        gpuInterconnect,
        tensorParallelSupported: gpus.length > 1 && gpus.every((gpu) => gpu.vendor === "nvidia") && gpuInterconnect !== "unknown",
        cpuMemoryBandwidthGBps: estimateCpuMemoryBandwidthGBps(cpuModel, cpus.length, os.platform()),
        cpuMemoryBandwidthMeasured: false,
    };
}

const PARAMETER_OVERRIDES: Record<string, number> = { "phi3.5": 3.8, "mistral-nemo": 12, "gemma2:9b": 9, "devstral-small": 24, "qwen3:30b-a3b": 30, "command-r-plus": 104 };

function modelParametersB(model: ModelCatalogEntry): number {
    return PARAMETER_OVERRIDES[model.name] ?? Number(model.name.match(/(\d+(?:\.\d+)?)b/i)?.[1] ?? model.minRAMGB);
}
function runtimeOverhead(weightGB: number, runtime: NonNullable<RecommendationOptions["runtime"]>): number {
    const base = runtime === "vllm" ? 1.6 : runtime === "mlx" ? 0.9 : 0.7;
    return base + weightGB * (runtime === "vllm" ? 0.12 : 0.08);
}
function observationFor(model: string, history: BenchmarkObservation[]): BenchmarkObservation | undefined {
    const normalized = model.toLowerCase().split(":")[0];
    return [...history].reverse().find((item) => item.model.toLowerCase().includes(normalized) || normalized.includes(item.model.toLowerCase().split(":")[0]));
}

export function recommendModels(specs: SystemSpecs, options: RecommendationOptions = {}, history: BenchmarkObservation[] = []): ModelRecommendations {
    const quantization = options.quantization ?? "Q4_K_M"; const bits = QUANTIZATION_BITS[quantization];
    const contextLength = Math.max(2_048, Math.min(131_072, options.contextLength ?? 8_192));
    // "automatic" (the default) resolves via resolveAutomaticRuntime, which for
    // this Ollama-library catalog only ever yields "mlx" or "ollama" — hence
    // the narrowing cast.
    const selectedRuntime = options.runtime && options.runtime !== "automatic" ? options.runtime : (resolveAutomaticRuntime("ollama", specs) as "ollama" | "mlx");
    const usableRAMGB = +Math.max(0, Math.min(specs.totalRAMGB * 0.72, specs.freeRAMGB > 2 ? specs.freeRAMGB - 2 : specs.totalRAMGB * 0.55)).toFixed(1);
    const knownGpuMemory = specs.gpus.map((gpu) => gpu.vramGB).filter((value): value is number => value !== null);
    const largestUsableGpuGB = +(Math.max(0, specs.largestGpuVramGB ?? (knownGpuMemory.length ? Math.max(...knownGpuMemory) : 0)) * 0.88).toFixed(1);
    const aggregateUsableVramGB = +(knownGpuMemory.reduce((sum, value) => sum + value * 0.88, 0)).toFixed(1);
    const smallestUsableGpuGB = knownGpuMemory.length ? Math.min(...knownGpuMemory) * 0.88 : 0;

    const models = MODEL_CATALOG.map((model) => {
        const parametersB = modelParametersB(model);
        const estimatedWeightGB = parametersB * bits / 8 * 1.12 + 0.35;
        const estimatedKvCacheGB = Math.max(0.12, 0.17 * Math.sqrt(parametersB / 7)) * contextLength / 1024;
        const overhead = runtimeOverhead(estimatedWeightGB, selectedRuntime);
        const totalRequiredGB = estimatedWeightGB + estimatedKvCacheGB + overhead;
        const gpuBudgetForWeights = Math.max(0, largestUsableGpuGB - estimatedKvCacheGB - overhead);
        const expectedGpuOffloadPercent = Math.max(0, Math.min(100, gpuBudgetForWeights / estimatedWeightGB * 100));
        const cpuRemainingGB = estimatedWeightGB * (1 - expectedGpuOffloadPercent / 100) + Math.min(overhead, 1.2);
        const fullGpu = totalRequiredGB <= largestUsableGpuGB;
        const tensorParallel = !fullGpu && specs.tensorParallelSupported && knownGpuMemory.length > 1 &&
            estimatedWeightGB / knownGpuMemory.length + estimatedKvCacheGB + overhead <= smallestUsableGpuGB && totalRequiredGB <= aggregateUsableVramGB;
        const partial = !fullGpu && !tensorParallel && expectedGpuOffloadPercent >= 5 && cpuRemainingGB <= usableRAMGB;
        const cpuOnly = !fullGpu && !tensorParallel && !partial && totalRequiredGB <= usableRAMGB;
        let outcome: RecommendationOutcome; let reason: string; let recommendedRuntime = selectedRuntime;
        if (fullGpu) { outcome = "Runs fully on GPU"; reason = `Weights, ${contextLength.toLocaleString()}-token KV cache, and runtime overhead fit the largest GPU.`; }
        else if (tensorParallel) { outcome = "Requires tensor parallelism"; recommendedRuntime = "vllm"; reason = `Does not fit one GPU; estimated shards fit ${knownGpuMemory.length} GPUs using ${specs.gpuInterconnect}.`; }
        else if (partial) { outcome = "Runs with partial offload"; recommendedRuntime = "llamacpp"; reason = `${expectedGpuOffloadPercent.toFixed(0)}% GPU offload estimated; remaining weights fit usable system RAM.`; }
        else if (cpuOnly) { outcome = "CPU-only but usable"; recommendedRuntime = "llamacpp"; reason = `Fits usable RAM; speed is constrained by approximately ${specs.cpuMemoryBandwidthGBps} GB/s CPU memory bandwidth.`; }
        else { outcome = "Likely out of memory"; reason = `Needs approximately ${totalRequiredGB.toFixed(1)} GB after KV cache and runtime overhead; neither GPU nor RAM/offload layouts fit safely.`; }
        const cpuTps = specs.cpuMemoryBandwidthGBps / Math.max(estimatedWeightGB, 0.5) * 0.65;
        const gpuTps = 42 * Math.sqrt(7 / Math.max(parametersB, 0.5)) * (4.75 / bits);
        const estimatedTokensPerSecond = outcome === "Likely out of memory" ? 0 : outcome === "Runs fully on GPU" || outcome === "Requires tensor parallelism" ? gpuTps : outcome === "Runs with partial offload" ? cpuTps + (gpuTps - cpuTps) * expectedGpuOffloadPercent / 100 : cpuTps;
        const measured = observationFor(model.name, history);
        return { ...model, fits: outcome !== "Likely out of memory", runsOnGpu: fullGpu, recommended: false, outcome, quantization,
            estimatedWeightGB: +estimatedWeightGB.toFixed(2), estimatedKvCacheGB: +estimatedKvCacheGB.toFixed(2), runtimeOverheadGB: +overhead.toFixed(2),
            totalRequiredGB: +totalRequiredGB.toFixed(2), expectedGpuOffloadPercent: +expectedGpuOffloadPercent.toFixed(0),
            estimatedTokensPerSecond: +estimatedTokensPerSecond.toFixed(1), measuredTokensPerSecond: measured?.tokensPerSecond, reason, recommendedRuntime };
    });
    const best = [...models].filter((model) => model.fits).sort((a, b) => modelParametersB(b) - modelParametersB(a))[0];
    if (best) best.recommended = true;
    return { usableRAMGB, usableVRAMGB: aggregateUsableVramGB, largestUsableGpuGB, aggregateUsableVramGB,
        cpuMemoryBandwidthGBps: specs.cpuMemoryBandwidthGBps, gpuInterconnect: specs.gpuInterconnect, best: best?.name ?? null, models };
}
