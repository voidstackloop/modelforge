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
}

export interface ModelRecommendations {
    usableRAMGB: number;
    usableVRAMGB: number;
    effectiveGB: number;
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

export async function getSpecs(): Promise<SystemSpecs> {
    const cpus = os.cpus() || [];
    const gpus = await detectGpus();
    const knownVram = gpus.map((g) => g.vramGB).filter((v): v is number => v !== null);
    const totalVramGB = knownVram.length > 0 ? +knownVram.reduce((a, b) => a + b, 0).toFixed(1) : null;

    return {
        totalRAMGB: +(os.totalmem() / 1e9).toFixed(1),
        freeRAMGB: +(os.freemem() / 1e9).toFixed(1),
        cpuModel: cpus[0] ? cpus[0].model : "Unknown CPU",
        cpuCores: cpus.length,
        platform: os.platform(),
        arch: os.arch(),
        gpu: gpus[0] ?? null,
        gpus,
        totalVramGB,
    };
}

export function recommendModels(specs: SystemSpecs): ModelRecommendations {
    // Leave headroom for the OS and the app itself on both RAM and VRAM.
    const usableRAMGB = +(specs.totalRAMGB * 0.7).toFixed(1);
    const usableVRAMGB = specs.totalVramGB ? +(specs.totalVramGB * 0.9).toFixed(1) : 0;
    const effectiveGB = Math.max(usableRAMGB, usableVRAMGB);

    const fitting = MODEL_CATALOG.filter((m) => m.minRAMGB <= effectiveGB);
    const best = fitting.sort((a, b) => b.minRAMGB - a.minRAMGB)[0];

    return {
        usableRAMGB,
        usableVRAMGB,
        effectiveGB: +effectiveGB.toFixed(1),
        best: best ? best.name : null,
        models: MODEL_CATALOG.map((m) => ({
            ...m,
            fits: m.minRAMGB <= effectiveGB,
            runsOnGpu: usableVRAMGB > 0 && m.minRAMGB <= usableVRAMGB,
            recommended: best ? m.name === best.name : false,
        })),
    };
}
