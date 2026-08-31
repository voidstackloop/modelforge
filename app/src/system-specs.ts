import * as os from "node:os";
import { execFile } from "node:child_process";
import { ManagedPythonWorker } from "./python-runtime-manager";

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
    // Stable application-level identifier for this physical device — for
    // NVIDIA this is `nvidia:<uuid>` (survives reboots/driver updates/index
    // reshuffles); for AMD it's `amd:<rocm unique id>` when rocm-smi exposes
    // one. Detection paths that only get a device *name* (Windows WMI, macOS
    // system_profiler, lspci) fall back to a best-effort
    // `vendor:slug(name):ordinal` id via `deriveGpuId()` below — that fallback
    // is NOT guaranteed stable across a reorder, and callers that persist a
    // selection should treat it as best-effort on those platforms.
    id?: string;
    // Index in the vendor's own runtime device enumeration — i.e. exactly
    // what CUDA_VISIBLE_DEVICES/HIP_VISIBLE_DEVICES expect, NOT a position in
    // the cross-vendor `gpus[]` array. Two GPUs from different vendors can
    // legitimately both have index 0.
    index?: number;
    busId?: string | null;
    driverVersion?: string | null;
    // Compute capability (NVIDIA, e.g. "8.9") or closest architecture label
    // available for other vendors.
    architecture?: string | null;
    usedVramGB?: number | null;
    freeVramGB?: number | null;
    isIntegrated?: boolean;
    // Whether this device can actually run compute workloads right now (as
    // opposed to being present but display-only/driver-unavailable).
    computeAvailable?: boolean;
    displayOnly?: boolean;
    // Present for MIG-related entries: a physical GPU with MIG enabled
    // (compute-unavailable itself) explains that its instances are listed
    // separately; a MIG instance describes its own profile/parent.
    migInfo?: string | null;
    capabilities?: GpuCapabilities;
    // Human-readable reason this device can't safely participate in a
    // selection (unsupported mixture, driver issue, etc), or null if fine.
    compatibilityIssue?: string | null;
    lastProbedAt?: number;
}

// Aggregate view over the whole detected GPU set — deliberately does NOT
// treat aggregate VRAM as if it were one bigger GPU: `tensorParallelRecommended`
// only turns on for a homogeneous, well-connected group, and `usableVramGB` is
// the sum of each device's *own* usable share (post-reserve), not one pool.
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
    platform: NodeJS.Platform;
    arch: string;
    // Kept for backward compatibility with anything expecting a single GPU —
    // this is just gpus[0]. Prefer `gpus` and `totalVramGB` for anything
    // multi-GPU-aware.
    gpu: GpuInfo | null;
    gpus: GpuInfo[];
    totalVramGB: number | null;
    largestGpuVramGB: number | null;
    gpuInterconnect: "nvlink" | "xgmi" | "pcie" | "unified" | "none" | "unknown";
    tensorParallelSupported: boolean;
    // Richer topology view — same underlying data as the fields above, kept
    // alongside them (rather than replacing) so existing single-GPU-era
    // call sites don't need to change.
    gpuTopology: GpuTopology;
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
    // Rough general-quality figure on the same 0-100ish scale as the
    // hardware-recommender ML model's training data (Open LLM Leaderboard's
    // "Average" column) — sent to the ML worker instead of a hardcoded
    // constant, and used by goal-aware selection (RecommendationOptions.goal).
    qualityScore: number;
    // Mixture-of-experts models need extra expert-memory accounting the ML
    // model doesn't get from leaderboard metadata alone.
    isMoe: boolean;
    // The model's real (non-Ollama-tag) name, e.g. "Llama-3.2-1B-Instruct" —
    // used to search Hugging Face for a real GGUF quantization when the
    // recommended runtime isn't Ollama (docs/LOCAL_INFERENCE_HARDENING_PLAN.md
    // §2.3). Deliberately a search query, not a hardcoded exact repo/file
    // path: this catalog's `name` field is an Ollama tag with no llama.cpp
    // equivalent, and guessing a specific GGUF repo/filename that might have
    // been renamed or removed since this catalog was last verified would risk
    // a silently wrong or broken download — a live search against a real,
    // well-known model name can't go stale in that way.
    huggingFaceSearchQuery: string;
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
    recommendedRuntime: "llamacpp" | "vllm" | "mlx";
}

export type RecommendationOutcome = "Runs fully on GPU" | "Runs with partial offload" | "CPU-only but usable" | "Requires tensor parallelism" | "Likely out of memory";
export const QUANTIZATION_BITS = { Q2_K: 2.625, Q3_K_M: 3.5, Q4_K_M: 4.75, Q5_K_M: 5.5, Q6_K: 6.56, Q8_0: 8.5 } as const;
// What "best" should optimize for — plugged into pickBest()'s utility score
// instead of the old "largest model that fits" rule.
export type RecommendationGoal = "quality" | "speed" | "memory" | "energy" | "agent" | "balanced";
export interface RecommendationOptions { quantization?: keyof typeof QUANTIZATION_BITS; contextLength?: number; runtime?: "automatic" | "llamacpp" | "vllm" | "mlx"; goal?: RecommendationGoal }
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
    outcome: RecommendationOutcome | "Unknown size";
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

// `name` values here are legacy Ollama library tags, kept only as stable
// internal identifiers/lookup keys (observationFor, PARAMETER_OVERRIDES) —
// Ollama itself is removed, so `huggingFaceSearchQuery` (not `name`) is what
// Settings.tsx actually uses to help a user find and download one of these
// recommendations for llama.cpp; see that field's own doc comment.
// qualityScore provenance: 9 of these 13 are the official-repo "Average ⬆️"
// figure from ml/hardware-recommender/data/raw/open_llm_leaderboard.parquet
// (IFEval/BBH/MATH/GPQA/MUSR/MMLU-PRO average — same metric the ML model's
// quality_score training feature uses), looked up by exact fullname match
// (meta-llama/Llama-3.2-1B-Instruct, meta-llama/Llama-3.2-3B-Instruct,
// microsoft/Phi-3.5-mini-instruct, meta-llama/Llama-3.1-8B-Instruct,
// mistralai/Mistral-Nemo-Instruct-2407, google/gemma-2-9b-it,
// Qwen/Qwen2.5-Coder-14B-Instruct, CohereForAI/c4ai-command-r-plus-08-2024,
// meta-llama/Llama-3.1-70B-Instruct). The other 4 (qwen3:4b, qwen3:8b,
// qwen3:30b-a3b, devstral-small) postdate that leaderboard snapshot — those
// four are still estimates (interpolated against same-family/size peers),
// flagged individually below.
export const MODEL_CATALOG: ModelCatalogEntry[] = [
    { name: "llama3.2:1b", label: "Llama 3.2 1B", minRAMGB: 2, description: "Fastest option, good for quick replies on low-end hardware.", supportsTools: false, qualityScore: 14.4, isMoe: false, huggingFaceSearchQuery: "Llama-3.2-1B-Instruct GGUF" },
    { name: "llama3.2:3b", label: "Llama 3.2 3B", minRAMGB: 4, description: "Good balance of speed and quality for everyday chat.", supportsTools: true, qualityScore: 24.2, isMoe: false, huggingFaceSearchQuery: "Llama-3.2-3B-Instruct GGUF" },
    // Estimate — Qwen3 postdates the bundled leaderboard snapshot; placed
    // above llama3.2:3b's and below llama3.1:8b's real scores per Qwen3's
    // reported same-size-class gains over Qwen2.5/Llama3.2.
    { name: "qwen3:4b", label: "Qwen3 4B", minRAMGB: 5, description: "Reliable tool-calling in a small footprint — a good Agent mode pick on modest hardware.", supportsTools: true, qualityScore: 28, isMoe: false, huggingFaceSearchQuery: "Qwen3-4B GGUF" },
    { name: "phi3.5", label: "Phi-3.5 Mini 3.8B", minRAMGB: 5, description: "Strong reasoning for its size, runs well on modest hardware.", supportsTools: false, qualityScore: 28.2, isMoe: false, huggingFaceSearchQuery: "Phi-3.5-mini-instruct GGUF" },
    { name: "llama3.1:8b", label: "Llama 3.1 8B", minRAMGB: 8, description: "Meta's flagship mid-size model — great all-rounder with solid tool support.", supportsTools: true, qualityScore: 23.8, isMoe: false, huggingFaceSearchQuery: "Llama-3.1-8B-Instruct GGUF" },
    // Estimate — same caveat as qwen3:4b; placed above qwen2.5-coder:14b's
    // general-purpose score per Qwen3-8B's reported reasoning/IFEval gains.
    { name: "qwen3:8b", label: "Qwen3 8B", minRAMGB: 8, description: "Among the most reliable open models for tool/function calling at this size — recommended for Agent mode.", supportsTools: true, qualityScore: 33, isMoe: false, huggingFaceSearchQuery: "Qwen3-8B GGUF" },
    { name: "mistral-nemo", label: "Mistral Nemo 12B", minRAMGB: 10, description: "Solid general-purpose model with dependable tool calling.", supportsTools: true, qualityScore: 24.7, isMoe: false, huggingFaceSearchQuery: "Mistral-Nemo-Instruct-2407 GGUF" },
    { name: "gemma2:9b", label: "Gemma 2 9B", minRAMGB: 10, description: "Google's efficient high-quality model for general chat.", supportsTools: false, qualityScore: 32.1, isMoe: false, huggingFaceSearchQuery: "gemma-2-9b-it GGUF" },
    { name: "qwen2.5-coder:14b", label: "Qwen 2.5 Coder 14B", minRAMGB: 16, description: "Strong coding ability with tool calling — a good Agent mode pick for dev workflows.", supportsTools: true, qualityScore: 32.1, isMoe: false, huggingFaceSearchQuery: "Qwen2.5-Coder-14B-Instruct GGUF" },
    // Estimate — a 24B Mistral-family fine-tune postdating the snapshot;
    // placed near qwen2.5-coder:14b/command-r-plus given its larger size.
    // Search query omits the release-date suffix (e.g. "-2505") deliberately —
    // unlike the other entries here, the exact current version tag isn't
    // something this pass could verify, and a real search still surfaces
    // whichever version(s) exist under the stable "Devstral-Small" name.
    { name: "devstral-small", label: "Devstral Small 24B", minRAMGB: 24, description: "Trained specifically for agentic coding — built for exactly this app's Agent mode.", supportsTools: true, qualityScore: 34, isMoe: false, huggingFaceSearchQuery: "Devstral-Small GGUF" },
    // Estimate — same caveat as qwen3:4b/8b; placed near llama3.1:70b given
    // Qwen3-30B-A3B's reported reasoning benchmarks despite its small active
    // parameter count.
    { name: "qwen3:30b-a3b", label: "Qwen3 30B-A3B", minRAMGB: 24, description: "Mixture-of-experts model with strong tool-calling reliability at a manageable memory footprint.", supportsTools: true, qualityScore: 40, isMoe: true, huggingFaceSearchQuery: "Qwen3-30B-A3B GGUF" },
    { name: "command-r-plus", label: "Command R+", minRAMGB: 64, description: "Enterprise-grade tool use and retrieval, needs a workstation-class machine.", supportsTools: true, qualityScore: 33.6, isMoe: false, huggingFaceSearchQuery: "c4ai-command-r-plus-08-2024 GGUF" },
    { name: "llama3.1:70b", label: "Llama 3.1 70B", minRAMGB: 48, description: "Near top-tier quality, requires a workstation-class PC.", supportsTools: true, qualityScore: 43.4, isMoe: false, huggingFaceSearchQuery: "Llama-3.1-70B-Instruct GGUF" },
];

export type GpuVendor = "nvidia" | "amd" | "intel" | "apple" | "unknown";

// Classifies a GPU by its marketing name — the only identity most detection
// paths give us (the Windows WMI path and macOS system_profiler report names,
// not vendor IDs). Drives which llama.cpp backend gets recommended: CUDA is
// NVIDIA-only, Metal is Apple-only, and AMD/Intel accelerate via Vulkan
// (node-llama-cpp ships no ROCm/SYCL prebuilds — native ROCm goes through
// this app's own dedicated `rocm` local-server backend instead).
export function classifyGpuVendor(name: string): GpuVendor {
    if (/nvidia|geforce|\brtx\b|\bgtx\b|quadro|tesla/i.test(name)) return "nvidia";
    if (/\bamd\b|radeon|\brx\s?\d{3,4}\b|vega|firepro|instinct/i.test(name)) return "amd";
    if (/intel|\barc\b|iris|uhd graphics|hd graphics/i.test(name)) return "intel";
    if (/apple/i.test(name)) return "apple";
    return "unknown";
}

// The four backends the app can actually load a model with (Ollama removed —
// docs/LOCAL_INFERENCE_HARDENING_PLAN.md).
export type ConcreteRuntime = "llamacpp" | "vllm" | "mlx" | "transformers";

// A model's on-disk/distribution format, inferred from a filename or HF repo
// id — this is what "Automatic" branches on, alongside detected hardware.
// "ollama" was removed from this union along with Ollama itself — nothing in
// detectModelFormat() below ever produced it as a real detection outcome even
// before that (it was only ever passed in as a hardcoded literal by
// recommendModels()'s own curated-catalog fallback, now fixed directly there).
export type ModelFormat = "gguf" | "safetensors" | "mlx" | "unknown";

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
//   Anything else (safetensors with no supported GPU, MLX format off Apple
//   Silicon, an unrecognized format) -> Transformers, the universal fallback
//   for architectures the other backends can't load.
export function resolveAutomaticRuntime(format: ModelFormat, specs: Pick<SystemSpecs, "platform" | "arch" | "gpus">): ConcreteRuntime {
    const isAppleSilicon = specs.platform === "darwin" && specs.arch === "arm64";
    const hasVllmGpu = specs.gpus.some((gpu) => gpu.vendor === "nvidia" || gpu.vendor === "amd");
    if (format === "gguf") return "llamacpp";
    if (format === "mlx" && isAppleSilicon) return "mlx";
    if (format === "safetensors" && hasVllmGpu) return "vllm";
    return "transformers";
}

// Whether this machine should prefer MLX (its own dedicated backend, with a
// real edge over llama.cpp on Apple Silicon specifically) over llama.cpp as
// the *default* local runtime when nothing else pins a specific format or
// backend — used by recommendModels()'s curated-catalog fallback below,
// which has no real model file to run detectModelFormat() against at all
// (its entries are bare names, not files or repo ids).
function prefersAppleSiliconMlx(specs: Pick<SystemSpecs, "platform" | "arch">): boolean {
    return specs.platform === "darwin" && specs.arch === "arm64";
}

function execFileP(cmd: string, args: string[]): Promise<string | null> {
    return new Promise((resolve) => {
        execFile(cmd, args, { timeout: 3000, maxBuffer: 512 * 1024, windowsHide: true }, (err, stdout) => {
            if (err) return resolve(null);
            resolve(stdout);
        });
    });
}

// Best-effort stable-ish id for devices whose detection path only gives us a
// name (Windows WMI, lspci, system_profiler) — NOT a hardware UUID, so it
// will not survive a device reorder, but it's deterministic for a given
// vendor+name+ordinal combination within one probe.
function slugify(value: string): string {
    return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
}
function deriveGpuId(vendor: string, name: string, ordinal: number): string {
    return `${vendor}:${slugify(name)}:${ordinal}`;
}

// Returns every GPU nvidia-smi/rocm-smi/PowerShell/system_profiler reports,
// not just the first one — a single-GPU read silently undercounts available
// VRAM (and therefore which models "fit") on any multi-GPU machine.
//
// NVIDIA and AMD are probed independently and merged (rather than the old
// first-match-wins order) so a mixed NVIDIA+AMD box reports both vendors
// instead of only the one the first successful tool happened to see.
async function detectGpus(): Promise<GpuInfo[]> {
    const [nvidiaGpus, amdGpus] = await Promise.all([detectNvidiaGpus(), detectAmdGpusRocm()]);
    const merged = [...nvidiaGpus, ...amdGpus];
    if (merged.length > 0) return merged;

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
                let ordinal = 0;
                for (const gpu of list) {
                    if (!gpu?.Name) continue;
                    // AdapterRAM is a known-buggy 32-bit field on Windows for GPUs with >4GB VRAM,
                    // so only trust it when it lands in a plausible range.
                    const ramGB = gpu.AdapterRAM ? gpu.AdapterRAM / 1e9 : 0;
                    const vendor = classifyGpuVendor(gpu.Name);
                    gpus.push({
                        name: gpu.Name,
                        vramGB: ramGB > 0 && ramGB < 64 ? +ramGB.toFixed(1) : null,
                        vendor,
                        id: deriveGpuId(vendor, gpu.Name, ordinal),
                        index: ordinal,
                        isIntegrated: /intel|iris|uhd graphics|hd graphics/i.test(gpu.Name),
                        computeAvailable: true,
                        lastProbedAt: Date.now(),
                    });
                    ordinal++;
                }
                if (gpus.length > 0) return gpus;
            } catch {
                // ignore malformed output
            }
        }
    }

    // Linux without NVIDIA/ROCm tooling (Intel boxes, or vendor tools not
    // installed) previously detected nothing at all — lspci names the
    // display controllers even when no vendor tooling is installed.
    if (os.platform() === "linux") {
        const out = await execFileP("lspci", []);
        if (out) {
            const gpus: GpuInfo[] = [];
            let ordinal = 0;
            for (const line of out.split("\n")) {
                if (/VGA compatible controller|3D controller|Display controller/i.test(line)) {
                    const name = line.split(":").slice(2).join(":").trim();
                    if (name) {
                        const vendor = classifyGpuVendor(name);
                        gpus.push({
                            name, vramGB: null, vendor,
                            id: deriveGpuId(vendor, name, ordinal),
                            index: ordinal,
                            isIntegrated: /intel/i.test(name),
                            computeAvailable: true,
                            lastProbedAt: Date.now(),
                        });
                        ordinal++;
                    }
                }
            }
            if (gpus.length > 0) return gpus;
        }
    }

    if (os.platform() === "darwin") {
        const out = await execFileP("system_profiler", ["SPDisplaysDataType"]);
        if (out) {
            const gpus: GpuInfo[] = [];
            let ordinal = 0;
            // Apple Silicon GPUs share unified memory with the CPU rather than
            // dedicated VRAM, so there's no per-GPU size to report here.
            for (const match of out.matchAll(/Chipset Model:\s*(.+)/g)) {
                const name = match[1].trim();
                gpus.push({
                    name, vramGB: null, vendor: "apple",
                    id: deriveGpuId("apple", name, ordinal),
                    index: ordinal,
                    computeAvailable: true,
                    capabilities: { cuda: false, rocm: false, metal: true, vulkan: false, directml: false },
                    lastProbedAt: Date.now(),
                });
                ordinal++;
            }
            if (gpus.length > 0) return gpus;
        }
    }

    return [];
}

async function detectNvidiaGpus(): Promise<GpuInfo[]> {
    // NVIDIA tooling works the same way on Windows and Linux when drivers are
    // installed, and reports one CSV line per GPU when there's more than one.
    // `index` and `uuid` give us the runtime-visible ordinal and a genuinely
    // stable device id respectively — both absent from the old name-only query.
    const out = await execFileP("nvidia-smi", [
        "--query-gpu=index,name,memory.total,memory.used,memory.free,uuid,pci.bus_id,driver_version,compute_cap,mig.mode.current",
        "--format=csv,noheader,nounits",
    ]);
    if (!out) return [];
    const gpus: GpuInfo[] = [];
    let anyMigEnabled = false;
    for (const line of out.trim().split("\n")) {
        const parts = line.split(",").map((s) => s.trim());
        const [indexStr, name, totalMiB, usedMiB, freeMiB, uuid, busId, driverVersion, computeCap, migMode] = parts;
        if (!name || Number.isNaN(Number(totalMiB))) continue;
        // A physical GPU with MIG mode enabled isn't itself a usable compute
        // device — only its individual MIG instances are (enumerated below
        // via `nvidia-smi -L` and appended in its place). A GPU that has MIG
        // enabled but zero instances configured still shows up here as
        // compute-unavailable, rather than silently vanishing.
        const migEnabled = /enabled/i.test(migMode ?? "");
        if (migEnabled) anyMigEnabled = true;
        gpus.push({
            name,
            vramGB: +(Number(totalMiB) / 1024).toFixed(1),
            vendor: "nvidia",
            id: uuid ? `nvidia:${uuid}` : deriveGpuId("nvidia", name, Number(indexStr) || 0),
            index: Number(indexStr) || 0,
            busId: busId || null,
            driverVersion: driverVersion || null,
            architecture: computeCap || null,
            usedVramGB: !Number.isNaN(Number(usedMiB)) ? +(Number(usedMiB) / 1024).toFixed(1) : null,
            freeVramGB: !Number.isNaN(Number(freeMiB)) ? +(Number(freeMiB) / 1024).toFixed(1) : null,
            isIntegrated: false,
            computeAvailable: !migEnabled,
            displayOnly: migEnabled,
            migInfo: migEnabled ? "MIG enabled — see individual MIG instances" : null,
            capabilities: { cuda: !migEnabled, rocm: false, metal: false, vulkan: !migEnabled, directml: false },
            lastProbedAt: Date.now(),
        });
    }
    if (anyMigEnabled) {
        const migInstances = await detectNvidiaMigInstances(gpus);
        gpus.push(...migInstances);
    }
    return gpus;
}

// MIG instances have no standalone runtime index the way physical GPUs do —
// `nvidia-smi -L` is the only listing that enumerates them (with their own
// UUID, which is what CUDA_VISIBLE_DEVICES actually needs to select one).
async function detectNvidiaMigInstances(physicalGpus: GpuInfo[]): Promise<GpuInfo[]> {
    const out = await execFileP("nvidia-smi", ["-L"]);
    if (!out) return [];
    return parseMigInstancesFromNvidiaSmiL(out, physicalGpus);
}

// Extracted as a pure function so the parsing logic (the part that's
// actually easy to get subtly wrong) is unit-testable without shelling out.
// Example `nvidia-smi -L` output:
//   GPU 0: NVIDIA A100-SXM4-40GB (UUID: GPU-1111...)
//     MIG 3g.20gb     Device  0: (UUID: MIG-2222...)
//     MIG 1g.5gb      Device  1: (UUID: MIG-3333...)
//   GPU 1: NVIDIA A100-SXM4-40GB (UUID: GPU-4444...)
export function parseMigInstancesFromNvidiaSmiL(output: string, physicalGpus: GpuInfo[]): GpuInfo[] {
    const gpuLine = /^GPU\s+(\d+):\s*(.+?)\s*\(UUID:\s*(GPU-[0-9a-fA-F-]+)\)/;
    const migLine = /^\s*MIG\s+(\d+g\.\d+gb)\s+Device\s+(\d+):\s*\(UUID:\s*(MIG-[0-9a-fA-F-]+)\)/i;
    const instances: GpuInfo[] = [];
    let currentParentIndex: number | null = null;
    let currentParentUuid: string | null = null;
    for (const rawLine of output.split(/\r?\n/)) {
        const gpuMatch = rawLine.match(gpuLine);
        if (gpuMatch) {
            currentParentIndex = Number(gpuMatch[1]);
            currentParentUuid = gpuMatch[3];
            continue;
        }
        const migMatch = rawLine.match(migLine);
        if (migMatch && currentParentIndex !== null) {
            const [, profile, deviceIndexStr, uuid] = migMatch;
            // Profile format is "<compute-slices>g.<memory>gb", e.g. "3g.20gb".
            const vramGB = Number(profile.split(".")[1]?.replace(/gb$/i, ""));
            const parent = physicalGpus.find((gpu) => gpu.index === currentParentIndex && gpu.id === `nvidia:${currentParentUuid}`);
            instances.push({
                name: `MIG ${profile} (GPU ${currentParentIndex}${parent ? ` ${parent.name}` : ""})`,
                vramGB: Number.isFinite(vramGB) ? vramGB : null,
                vendor: "nvidia",
                id: `nvidia:${uuid}`,
                index: Number(deviceIndexStr),
                busId: parent?.busId ?? null,
                driverVersion: parent?.driverVersion ?? null,
                architecture: parent?.architecture ?? null,
                usedVramGB: null,
                freeVramGB: null,
                isIntegrated: false,
                computeAvailable: true,
                migInfo: `MIG ${profile} instance of GPU ${currentParentIndex}`,
                capabilities: { cuda: true, rocm: false, metal: false, vulkan: false, directml: false },
                lastProbedAt: Date.now(),
            });
        }
    }
    return instances;
}

// rocm-smi is Linux-only in practice (no supported Windows build in typical
// consumer/driver installs) — AMD GPUs on Windows fall through to the WMI
// path below, which reports name+VRAM only.
async function detectAmdGpusRocm(): Promise<GpuInfo[]> {
    if (os.platform() !== "linux") return [];
    const out = await execFileP("rocm-smi", [
        "--showid", "--showproductname", "--showuniqueid", "--showmeminfo", "vram", "--showdriverversion", "--json",
    ]);
    if (!out) return [];
    try {
        const parsed = JSON.parse(out) as Record<string, Record<string, string>>;
        const gpus: GpuInfo[] = [];
        let ordinal = 0;
        for (const key of Object.keys(parsed)) {
            if (!/^card\d+$/i.test(key)) continue;
            const card = parsed[key];
            const name = card["Card series"] || card["Card model"] || `AMD GPU ${ordinal}`;
            const totalBytes = Number(card["VRAM Total Memory (B)"]);
            const usedBytes = Number(card["VRAM Total Used Memory (B)"]);
            const vramGB = Number.isFinite(totalBytes) && totalBytes > 0 ? +(totalBytes / 1e9).toFixed(1) : null;
            const usedVramGB = Number.isFinite(usedBytes) && usedBytes >= 0 ? +(usedBytes / 1e9).toFixed(1) : null;
            const uniqueId = card["Unique ID"];
            gpus.push({
                name, vramGB, vendor: "amd",
                id: uniqueId ? `amd:${uniqueId}` : deriveGpuId("amd", name, ordinal),
                index: ordinal,
                driverVersion: card["Driver version"] ?? null,
                usedVramGB,
                freeVramGB: vramGB !== null && usedVramGB !== null ? +Math.max(0, vramGB - usedVramGB).toFixed(1) : null,
                isIntegrated: false,
                computeAvailable: true,
                capabilities: { cuda: false, rocm: true, metal: false, vulkan: true, directml: false },
                lastProbedAt: Date.now(),
            });
            ordinal++;
        }
        return gpus;
    } catch {
        // rocm-smi not installed, or output shape differs across versions —
        // treat exactly like "tool unavailable" rather than failing detection.
        return [];
    }
}

async function detectGpuInterconnect(gpus: GpuInfo[]): Promise<SystemSpecs["gpuInterconnect"]> {
    if (gpus.length < 2) return gpus.some((gpu) => gpu.vendor === "apple") ? "unified" : "none";
    if (gpus.every((gpu) => gpu.vendor === "apple")) return "unified";
    if (gpus.every((gpu) => gpu.vendor === "nvidia")) {
        const topology = await execFileP("nvidia-smi", ["topo", "-m"]);
        return topology && /NV\d+|NVLink/i.test(topology) ? "nvlink" : "pcie";
    }
    if (gpus.every((gpu) => gpu.vendor === "amd")) {
        // `rocm-smi --showtopo` prints a "Link Type between two GPUs" matrix
        // (and, on older rocm-smi versions, a separate "Weight"/"Hops"
        // section instead) whose cells read "XGMI" for AMD's NVLink-analog
        // fabric or "PCIE" otherwise. Best-effort: any XGMI cell anywhere in
        // the output means at least that pair is fabric-connected.
        const topology = await execFileP("rocm-smi", ["--showtopo"]);
        return topology && /XGMI/i.test(topology) ? "xgmi" : "pcie";
    }
    return "unknown";
}

// GPU-only probe cache — mirrors the pattern already used for runtime health
// probes in local-server-manager.ts's `probeCache`. Detection shells out to
// nvidia-smi/rocm-smi/etc, which is too slow and noisy to run on every
// `getSpecs()` call (e.g. once per catalog model during ML prediction).
const GPU_PROBE_TTL_MS = 30_000;
let gpuProbeCache: { gpus: GpuInfo[]; timestamp: number } | null = null;

async function detectGpusCached(): Promise<GpuInfo[]> {
    const now = Date.now();
    if (gpuProbeCache && now - gpuProbeCache.timestamp < GPU_PROBE_TTL_MS) return gpuProbeCache.gpus;
    const gpus = await detectGpus();
    gpuProbeCache = { gpus, timestamp: now };
    return gpus;
}

// Explicit cache-invalidation entry point for manual refresh, device-change
// signals, and app-resume — callers that need up-to-date topology right now
// (rather than waiting out the TTL) call this before `getSpecs()`.
export function refreshGpuTopology(): void {
    gpuProbeCache = null;
}

const GPU_USABLE_FRACTION = 0.88;
const MIN_HOMOGENEOUS_VRAM_RATIO = 0.85;

export function computeGpuTopology(gpus: GpuInfo[], interconnect: SystemSpecs["gpuInterconnect"]): GpuTopology {
    const knownVram = gpus.map((g) => g.vramGB).filter((v): v is number => v !== null);
    const aggregateVramGB = knownVram.length > 0 ? +knownVram.reduce((a, b) => a + b, 0).toFixed(1) : null;
    const smallestGpuVramGB = knownVram.length > 0 ? Math.min(...knownVram) : null;
    const largestGpuVramGB = knownVram.length > 0 ? Math.max(...knownVram) : null;
    const usableVramGB = knownVram.length > 0 ? +(knownVram.reduce((sum, v) => sum + v * GPU_USABLE_FRACTION, 0)).toFixed(1) : null;
    // "Homogeneous" requires same vendor and roughly-matched VRAM — a 24GB +
    // 8GB pair of same-vendor cards is still heterogeneous for parallelism
    // purposes because the 8GB card becomes the limiting shard size.
    const sameVendor = gpus.length > 0 && gpus.every((g) => g.vendor === gpus[0].vendor);
    const vramBalanced = smallestGpuVramGB !== null && largestGpuVramGB !== null && largestGpuVramGB > 0
        ? smallestGpuVramGB / largestGpuVramGB >= MIN_HOMOGENEOUS_VRAM_RATIO
        : true;
    const homogeneous = sameVendor && vramBalanced;
    // NVLink (NVIDIA) and XGMI/Infinity Fabric (AMD) are both direct
    // GPU-to-GPU fabrics — treated the same way here rather than only ever
    // recognizing NVIDIA's.
    const peerToPeerCapable = interconnect === "nvlink" || interconnect === "xgmi";
    const multiGpu = gpus.length > 1;
    const tensorParallelRecommended = multiGpu && homogeneous && (interconnect === "nvlink" || interconnect === "xgmi" || interconnect === "pcie")
        && (gpus[0]?.vendor === "nvidia" || gpus[0]?.vendor === "amd");
    const layerSplitOnly = multiGpu && !tensorParallelRecommended;
    return {
        interconnect, homogeneous, deviceCount: gpus.length, aggregateVramGB, smallestGpuVramGB, largestGpuVramGB,
        usableVramGB, peerToPeerCapable, tensorParallelRecommended, layerSplitOnly,
    };
}

function estimateCpuMemoryBandwidthGBps(cpuModel: string, cores: number, platform: NodeJS.Platform): number {
    if (platform === "darwin" && /Apple M[1-9]/i.test(cpuModel)) return /Ultra/i.test(cpuModel) ? 600 : /Max/i.test(cpuModel) ? 400 : /Pro/i.test(cpuModel) ? 200 : 100;
    if (/EPYC|Xeon.*Max/i.test(cpuModel)) return Math.min(350, Math.max(100, cores * 4));
    if (/Threadripper|Xeon/i.test(cpuModel)) return Math.min(220, Math.max(70, cores * 3));
    return Math.min(120, Math.max(25, cores * 4));
}

export async function getSpecs(): Promise<SystemSpecs> {
    const cpus = os.cpus() || [];
    const gpus = await detectGpusCached();
    const knownVram = gpus.map((g) => g.vramGB).filter((v): v is number => v !== null);
    const totalVramGB = knownVram.length > 0 ? +knownVram.reduce((a, b) => a + b, 0).toFixed(1) : null;
    const largestGpuVramGB = knownVram.length > 0 ? Math.max(...knownVram) : null;
    const gpuInterconnect = await detectGpuInterconnect(gpus);
    const gpuTopology = computeGpuTopology(gpus, gpuInterconnect);
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
        gpuTopology,
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

// GGUF filenames use a wider set of quantization labels than the curated
// catalog's simple `quantization` field. These effective bit widths are intentionally approximate:
// the actual file size remains the source of truth for memory fitting, while
// the bit width lets us infer parameter count for KV-cache and speed estimates.
const GGUF_QUANTIZATION_BITS: Record<string, number> = {
    IQ1_S: 1.56, IQ1_M: 1.75, IQ2_XXS: 2.06, IQ2_XS: 2.31, IQ2_S: 2.5, IQ2_M: 2.7,
    Q2_K: 2.625, Q3_K_S: 3.44, Q3_K_M: 3.5, Q3_K_L: 3.69,
    IQ3_XXS: 3.06, IQ3_XS: 3.3, IQ3_S: 3.5, IQ3_M: 3.7,
    Q4_0: 4.5, Q4_1: 5, Q4_K_S: 4.58, Q4_K_M: 4.75, IQ4_XS: 4.25, IQ4_NL: 4.5,
    Q5_0: 5.5, Q5_1: 6, Q5_K_S: 5.4, Q5_K_M: 5.5,
    Q6_K: 6.56, Q8_0: 8.5, F16: 16, BF16: 16, F32: 32,
};

export function detectGgufQuantization(filename: string): { label: string; bits: number } {
    const upper = filename.toUpperCase();
    const labels = Object.keys(GGUF_QUANTIZATION_BITS).sort((a, b) => b.length - a.length);
    const label = labels.find((candidate) => new RegExp(`(?:^|[-_.])${candidate}(?=[-_.]|$)`).test(upper));
    if (label) return { label, bits: GGUF_QUANTIZATION_BITS[label] };
    // Preserve newer community labels (for example UD-Q4_K_XL) even before
    // this table learns their precise bpw, rather than discarding them.
    const community = upper.match(/(?:^|[-_.])((?:UD-)?(?:IQ|Q|TQ)\d(?:_[A-Z0-9]+)+)(?=[-.]|$)/)?.[1];
    if (community) {
        const nominalBits = Number(community.match(/(?:IQ|Q|TQ)(\d)/)?.[1] ?? 4);
        return { label: community, bits: nominalBits === 1 ? 1.75 : nominalBits === 2 ? 2.625 : nominalBits === 3 ? 3.5 : nominalBits === 4 ? 4.75 : nominalBits + 0.5 };
    }
    return { label: "GGUF", bits: 4.75 };
}

// Evaluates arbitrary Hugging Face GGUF files against the same conservative
// hardware budgets used by the catalog recommender. Unlike catalog entries,
// the downloaded file's real byte size drives weight-memory accounting.
export function assessGgufFiles(specs: SystemSpecs, inputs: GgufAssessmentInput[], contextLength = 8_192): GgufAssessment[] {
    const safeContext = Math.max(2_048, Math.min(131_072, contextLength));
    const usableRAMGB = Math.max(0, Math.min(specs.totalRAMGB * 0.72, specs.freeRAMGB > 2 ? specs.freeRAMGB - 2 : specs.totalRAMGB * 0.55));
    const knownGpuMemory = specs.gpus.map((gpu) => gpu.vramGB).filter((value): value is number => value !== null);
    const unifiedMemory = specs.gpuInterconnect === "unified" || specs.gpus.some((gpu) => gpu.vendor === "apple");
    const largestUsableGpuGB = unifiedMemory ? usableRAMGB : Math.max(0, specs.largestGpuVramGB ?? (knownGpuMemory.length ? Math.max(...knownGpuMemory) : 0)) * 0.88;
    const aggregateUsableVramGB = unifiedMemory ? usableRAMGB : knownGpuMemory.reduce((sum, value) => sum + value * 0.88, 0);
    const smallestUsableGpuGB = knownGpuMemory.length ? Math.min(...knownGpuMemory) * 0.88 : 0;

    return inputs.map((input) => {
        const quantization = detectGgufQuantization(input.filename);
        if (input.sizeBytes === null || !Number.isFinite(input.sizeBytes) || input.sizeBytes <= 0) {
            return {
                modelId: input.modelId, filename: input.filename, canAssess: false, fits: null, outcome: "Unknown size" as const,
                quantization: quantization.label, estimatedParametersB: null, estimatedWeightGB: null, estimatedKvCacheGB: null,
                runtimeOverheadGB: null, totalRequiredGB: null, expectedGpuOffloadPercent: null, estimatedTokensPerSecond: null,
                recommendedRuntime: "llamacpp" as const, reason: "Hugging Face did not report a file size, so memory fit and speed cannot be estimated safely.",
            };
        }

        const estimatedWeightGB = input.sizeBytes / 1e9;
        // GGUF metadata and tensor alignment add a small amount beyond pure
        // quantized weights, hence the conservative 3% correction.
        const estimatedParametersB = Math.max(0.1, estimatedWeightGB * 8 / quantization.bits / 1.03);
        const estimatedKvCacheGB = Math.max(0.12, 0.17 * Math.sqrt(estimatedParametersB / 7)) * safeContext / 1024;
        const overhead = runtimeOverhead(estimatedWeightGB, "llamacpp");
        const totalRequiredGB = estimatedWeightGB + estimatedKvCacheGB + overhead;
        const gpuBudgetForWeights = Math.max(0, largestUsableGpuGB - estimatedKvCacheGB - overhead);
        const expectedGpuOffloadPercent = Math.max(0, Math.min(100, gpuBudgetForWeights / estimatedWeightGB * 100));
        const cpuRemainingGB = estimatedWeightGB * (1 - expectedGpuOffloadPercent / 100) + Math.min(overhead, 1.2);
        const fullGpu = totalRequiredGB <= largestUsableGpuGB && (unifiedMemory || knownGpuMemory.length > 0);
        const tensorParallel = !fullGpu && !unifiedMemory && specs.tensorParallelSupported && knownGpuMemory.length > 1
            && estimatedWeightGB / knownGpuMemory.length + estimatedKvCacheGB + overhead <= smallestUsableGpuGB
            && totalRequiredGB <= aggregateUsableVramGB;
        const partial = !fullGpu && !tensorParallel && expectedGpuOffloadPercent >= 5 && cpuRemainingGB <= usableRAMGB;
        const cpuOnly = !fullGpu && !tensorParallel && !partial && totalRequiredGB <= usableRAMGB;

        let outcome: RecommendationOutcome;
        let reason: string;
        if (fullGpu) {
            outcome = "Runs fully on GPU";
            reason = unifiedMemory
                ? `Fits the ${usableRAMGB.toFixed(1)} GB usable unified-memory budget at ${safeContext.toLocaleString()} context.`
                : `Fits the largest GPU's safe memory budget at ${safeContext.toLocaleString()} context.`;
        } else if (tensorParallel) {
            outcome = "Requires tensor parallelism";
            reason = `Estimated shards fit ${knownGpuMemory.length} GPUs, but llama.cpp must distribute the model across them.`;
        } else if (partial) {
            outcome = "Runs with partial offload";
            reason = `About ${expectedGpuOffloadPercent.toFixed(0)}% GPU offload; the remaining weights fit usable system RAM.`;
        } else if (cpuOnly) {
            outcome = "CPU-only but usable";
            reason = `Fits usable RAM, but generation will be limited by roughly ${specs.cpuMemoryBandwidthGBps} GB/s CPU memory bandwidth.`;
        } else {
            outcome = "Likely out of memory";
            reason = `Needs about ${totalRequiredGB.toFixed(1)} GB including KV cache and runtime overhead; safe RAM/VRAM budgets are insufficient.`;
        }

        const cpuTps = specs.cpuMemoryBandwidthGBps / Math.max(estimatedWeightGB, 0.5) * 0.65;
        const gpuTps = 42 * Math.sqrt(7 / Math.max(estimatedParametersB, 0.5)) * (4.75 / quantization.bits);
        const estimatedTokensPerSecond = outcome === "Likely out of memory" ? 0
            : fullGpu || tensorParallel ? gpuTps
                : partial ? cpuTps + (gpuTps - cpuTps) * expectedGpuOffloadPercent / 100
                    : cpuTps;

        return {
            modelId: input.modelId, filename: input.filename, canAssess: true, fits: outcome !== "Likely out of memory", outcome,
            quantization: quantization.label, estimatedParametersB: +estimatedParametersB.toFixed(1), estimatedWeightGB: +estimatedWeightGB.toFixed(2),
            estimatedKvCacheGB: +estimatedKvCacheGB.toFixed(2), runtimeOverheadGB: +overhead.toFixed(2), totalRequiredGB: +totalRequiredGB.toFixed(2),
            expectedGpuOffloadPercent: +expectedGpuOffloadPercent.toFixed(0), estimatedTokensPerSecond: +estimatedTokensPerSecond.toFixed(1),
            recommendedRuntime: "llamacpp", reason,
        };
    });
}

// Relative weight each goal puts on {quality, speed, memory-efficiency, agent
// tool-support} — the four axes normalized to 0-1 across the fitting
// candidates in pickBest(). "energy" has no direct measurement on
// RecommendedModel, so it's approximated as a speed/memory blend (a smaller,
// faster model draws less power per token than a large slow one).
const GOAL_WEIGHTS: Record<RecommendationGoal, { quality: number; speed: number; memory: number; agent: number }> = {
    quality: { quality: 1, speed: 0, memory: 0, agent: 0 },
    speed: { quality: 0, speed: 1, memory: 0, agent: 0 },
    memory: { quality: 0, speed: 0, memory: 1, agent: 0 },
    energy: { quality: 0, speed: 0.5, memory: 0.5, agent: 0 },
    agent: { quality: 0.4, speed: 0, memory: 0, agent: 1 },
    balanced: { quality: 0.3, speed: 0.3, memory: 0.2, agent: 0.2 },
};

function normalize(values: number[]): (value: number) => number {
    const min = Math.min(...values); const max = Math.max(...values); const span = max - min;
    return (value) => (span > 1e-9 ? (value - min) / span : 1);
}

// Replaces "largest model that fits" with a utility score over what the
// caller actually asked to optimize for (RecommendationOptions.goal).
function pickBest<T extends RecommendedModel>(models: T[], goal: RecommendationGoal = "balanced"): T | undefined {
    const fitting = models.filter((model) => model.fits);
    if (fitting.length === 0) return undefined;
    const weights = GOAL_WEIGHTS[goal] ?? GOAL_WEIGHTS.balanced;
    const normQuality = normalize(fitting.map((model) => model.qualityScore));
    const normSpeed = normalize(fitting.map((model) => model.estimatedTokensPerSecond));
    const normMemory = normalize(fitting.map((model) => 1 / Math.max(model.estimatedWeightGB, 0.1)));
    let best = fitting[0]; let bestScore = -Infinity;
    for (const model of fitting) {
        const score = weights.quality * normQuality(model.qualityScore)
            + weights.speed * normSpeed(model.estimatedTokensPerSecond)
            + weights.memory * normMemory(1 / Math.max(model.estimatedWeightGB, 0.1))
            + weights.agent * (model.supportsTools ? 1 : 0);
        if (score > bestScore) { bestScore = score; best = model; }
    }
    return best;
}

export function recommendModels(specs: SystemSpecs, options: RecommendationOptions = {}, history: BenchmarkObservation[] = []): ModelRecommendations {
    const quantization = options.quantization ?? "Q4_K_M"; const bits = QUANTIZATION_BITS[quantization];
    const contextLength = Math.max(2_048, Math.min(131_072, options.contextLength ?? 8_192));
    // "automatic" (the default) picks MLX on Apple Silicon (a real, deliberate
    // edge over llama.cpp there) or llama.cpp everywhere else — this curated
    // catalog has no real model file/repo id to run resolveAutomaticRuntime's
    // actual format detection against (its entries are bare names), so it
    // can't use that function directly the way a real download does. Passing
    // an explicit runtime (system-handlers.ts already does this from
    // settings.preferredRuntime) bypasses this entirely.
    const selectedRuntime = options.runtime && options.runtime !== "automatic" ? options.runtime : (prefersAppleSiliconMlx(specs) ? "mlx" : "llamacpp");
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
    const best = pickBest(models, options.goal);
    if (best) best.recommended = true;
    return { usableRAMGB, usableVRAMGB: aggregateUsableVramGB, largestUsableGpuGB, aggregateUsableVramGB,
        cpuMemoryBandwidthGBps: specs.cpuMemoryBandwidthGBps, gpuInterconnect: specs.gpuInterconnect, best: best?.name ?? null, models };
}

function mlPlatform(platform: NodeJS.Platform): "windows" | "linux" | "macos" {
    return platform === "win32" ? "windows" : platform === "darwin" ? "macos" : "linux";
}

// Mirrors the vendor -> backend convention used elsewhere in this app
// (frontend/src/lib/gpu.ts's recommendGpuBackend): AMD goes through ROCm on
// Linux (native driver support) but Vulkan on Windows (no ROCm llama.cpp
// prebuilds there), Intel always through Vulkan.
function mlGpuBackend(specs: SystemSpecs): "none" | "cuda" | "rocm" | "metal" | "vulkan" | "directml" {
    const vendors = new Set(specs.gpus.map((gpu) => gpu.vendor));
    if (vendors.has("apple")) return "metal";
    if (vendors.has("nvidia")) return "cuda";
    if (vendors.has("amd")) return specs.platform === "linux" ? "rocm" : "vulkan";
    if (vendors.has("intel")) return "vulkan";
    return "none";
}

const ML_RUNTIME_MAP: Record<string, RecommendedModel["recommendedRuntime"]> = {
    "llama.cpp-cpu": "llamacpp", "llama.cpp-cuda": "llamacpp", "llama.cpp-rocm": "llamacpp",
    "llama.cpp-metal": "llamacpp", "llama.cpp-vulkan": "llamacpp", mlx: "mlx", vllm: "vllm",
};

const ML_OUTCOME_MAP: Record<string, RecommendationOutcome> = {
    "Runs comfortably": "Runs fully on GPU",
    "May require partial GPU offload": "Runs with partial offload",
    "CPU only": "CPU-only but usable",
    "Insufficient memory": "Likely out of memory",
};

interface MlRecommendation {
    quantization: string;
    fit: string;
    runtime: string;
    estimatedContextTokens: number;
    estimatedTokensPerSecond: number;
    estimatedPeakVramGB?: number;
    estimatedPeakRamGB?: number;
    confidence?: number;
    lowConfidenceReason?: string | null;
    // Deterministic (non-learned) multi-GPU classification — see
    // classify_gpu_strategy in recommender_worker.py/physics.py. Only
    // present when the request carried a per-device VRAM list; null when the
    // worker didn't compute one (e.g. single-GPU/CPU requests).
    gpuStrategy?: string | null;
}

const GPU_STRATEGY_LABELS: Record<string, string> = {
    "fits-one-gpu": "fits on one GPU",
    "fits-layer-split": "fits by splitting layers across GPUs",
    "fits-tensor-parallel": "fits with tensor parallelism",
    "cpu-offload-only": "fits only with CPU offload",
    insufficient: "does not fit safely",
};

let recommenderWorker: ManagedPythonWorker | null = null;
function getRecommenderWorker(): ManagedPythonWorker {
    if (!recommenderWorker) recommenderWorker = new ManagedPythonWorker("hardware-recommender");
    return recommenderWorker;
}

// Below this, a prediction is treated the same as "worker unavailable" and
// the heuristic result is kept instead — the model itself is telling us it
// has little training support for this hardware combination (see
// ml/hardware-recommender/recommender/physics.py's prediction_confidence).
const MIN_ML_CONFIDENCE = 0.4;

async function predictWithML(model: ModelCatalogEntry, specs: SystemSpecs, effectiveRamGB: number): Promise<MlRecommendation | null> {
    try {
        const knownGpuMemory = specs.gpus.map((gpu) => gpu.vramGB).filter((value): value is number => value !== null);
        const result = (await getRecommenderWorker().request("recommend", {
            model_params_b: modelParametersB(model),
            quality_score: model.qualityScore,
            is_moe: model.isMoe,
            ram_gb: effectiveRamGB,
            vram_gb: specs.largestGpuVramGB ?? 0,
            gpu_count: knownGpuMemory.length,
            aggregate_vram_gb: knownGpuMemory.reduce((sum, value) => sum + value, 0),
            // Per-device list (not just the aggregate above) — lets the
            // worker's deterministic classify_gpu_strategy distinguish
            // single-GPU/layer-split/tensor-parallel/CPU-offload instead of
            // treating the aggregate as one contiguous pool.
            per_device_vram_gb: knownGpuMemory.length > 0 ? knownGpuMemory : undefined,
            cpu_cores: specs.cpuCores,
            platform: mlPlatform(specs.platform),
            gpu_backend: mlGpuBackend(specs),
        })) as MlRecommendation;
        if (result.confidence !== undefined && result.confidence < MIN_ML_CONFIDENCE) return null;
        return result;
    } catch {
        // Worker not installed, or install unhealthy/drifted — caller keeps
        // the heuristic result for this model rather than failing the whole
        // recommendation request over one optional dependency.
        return null;
    }
}

// Enhances recommendModels()'s heuristic output with predictions from the
// trained hardware-recommender model (ml/hardware-recommender/) wherever the
// managed Python worker is available, falling back to the pure heuristic per
// model otherwise — the ML worker being absent (not yet installed) or briefly
// unhealthy never blocks a recommendation from being returned.
export async function recommendModelsWithML(specs: SystemSpecs, options: RecommendationOptions = {}, history: BenchmarkObservation[] = []): Promise<ModelRecommendations> {
    const baseline = recommendModels(specs, options, history);
    const predictions = await Promise.all(baseline.models.map((model) => predictWithML(model, specs, baseline.usableRAMGB)));

    const models = baseline.models.map((model, index) => {
        const prediction = predictions[index];
        if (!prediction) return model;
        const recommendedRuntime = ML_RUNTIME_MAP[prediction.runtime] ?? model.recommendedRuntime;
        const outcome = ML_OUTCOME_MAP[prediction.fit] ?? model.outcome;
        const confidenceNote = prediction.lowConfidenceReason ? ` (${prediction.lowConfidenceReason})` : "";
        const gpuStrategyNote = prediction.gpuStrategy ? ` ${GPU_STRATEGY_LABELS[prediction.gpuStrategy] ?? prediction.gpuStrategy}.` : "";
        return {
            ...model,
            recommendedRuntime,
            outcome,
            quantization: prediction.quantization,
            fits: outcome !== "Likely out of memory",
            estimatedTokensPerSecond: prediction.estimatedTokensPerSecond,
            reason: `ML-predicted: ${prediction.fit.toLowerCase()} at ${prediction.quantization}, ~${prediction.estimatedContextTokens.toLocaleString()}-token context.${gpuStrategyNote}${confidenceNote}`,
        };
    });
    const best = pickBest(models, options.goal);
    for (const model of models) model.recommended = best ? model.name === best.name : false;
    return { ...baseline, models, best: best?.name ?? null };
}
