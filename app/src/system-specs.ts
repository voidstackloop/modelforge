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
    gpu: GpuInfo | null;
}

export interface ModelCatalogEntry {
    name: string;
    label: string;
    minRAMGB: number;
    description: string;
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

export const MODEL_CATALOG: ModelCatalogEntry[] = [
    { name: "llama3.2:1b", label: "Llama 3.2 1B", minRAMGB: 2, description: "Fastest option, good for quick replies on low-end hardware." },
    { name: "llama3.2:3b", label: "Llama 3.2 3B", minRAMGB: 4, description: "Good balance of speed and quality for everyday chat." },
    { name: "phi3.5", label: "Phi-3.5 Mini 3.8B", minRAMGB: 5, description: "Strong reasoning for its size, runs well on modest hardware." },
    { name: "mistral:7b", label: "Mistral 7B", minRAMGB: 8, description: "Solid general-purpose model with fast responses." },
    { name: "llama3.1:8b", label: "Llama 3.1 8B", minRAMGB: 8, description: "Meta's flagship mid-size model, great all-rounder." },
    { name: "gemma2:9b", label: "Gemma 2 9B", minRAMGB: 10, description: "Google's efficient high-quality model." },
    { name: "qwen2.5:14b", label: "Qwen 2.5 14B", minRAMGB: 16, description: "Strong coding and multilingual ability." },
    { name: "qwen2.5:32b", label: "Qwen 2.5 32B", minRAMGB: 32, description: "High quality, needs a beefy machine." },
    { name: "llama3.1:70b", label: "Llama 3.1 70B", minRAMGB: 48, description: "Near top-tier quality, requires a workstation-class PC." },
];

function execFileP(cmd: string, args: string[]): Promise<string | null> {
    return new Promise((resolve) => {
        execFile(cmd, args, { timeout: 3000 }, (err, stdout) => {
            if (err) return resolve(null);
            resolve(stdout);
        });
    });
}

async function detectGpu(): Promise<GpuInfo | null> {
    // NVIDIA tooling works the same way on Windows and Linux when drivers are installed.
    const nvidiaOut = await execFileP("nvidia-smi", [
        "--query-gpu=name,memory.total",
        "--format=csv,noheader,nounits",
    ]);
    if (nvidiaOut) {
        const [name, memMiB] = nvidiaOut.split(",").map((s) => s.trim());
        if (name && memMiB && !Number.isNaN(Number(memMiB))) {
            return { name, vramGB: +(Number(memMiB) / 1024).toFixed(1), vendor: "nvidia" };
        }
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
                const gpu = Array.isArray(parsed) ? parsed[0] : parsed;
                // AdapterRAM is a known-buggy 32-bit field on Windows for GPUs with >4GB VRAM,
                // so only trust it when it lands in a plausible range.
                const ramGB = gpu?.AdapterRAM ? gpu.AdapterRAM / 1e9 : 0;
                if (gpu?.Name) {
                    return {
                        name: gpu.Name,
                        vramGB: ramGB > 0 && ramGB < 64 ? +ramGB.toFixed(1) : null,
                        vendor: "unknown",
                    };
                }
            } catch {
                // ignore malformed output
            }
        }
    }

    if (os.platform() === "darwin") {
        const out = await execFileP("system_profiler", ["SPDisplaysDataType"]);
        const nameMatch = out?.match(/Chipset Model:\s*(.+)/);
        if (nameMatch) {
            // Apple Silicon GPUs share unified memory with the CPU rather than dedicated VRAM.
            return { name: nameMatch[1].trim(), vramGB: null, vendor: "apple" };
        }
    }

    return null;
}

export async function getSpecs(): Promise<SystemSpecs> {
    const cpus = os.cpus() || [];
    const gpu = await detectGpu();
    return {
        totalRAMGB: +(os.totalmem() / 1e9).toFixed(1),
        freeRAMGB: +(os.freemem() / 1e9).toFixed(1),
        cpuModel: cpus[0] ? cpus[0].model : "Unknown CPU",
        cpuCores: cpus.length,
        platform: os.platform(),
        arch: os.arch(),
        gpu,
    };
}

export function recommendModels(specs: SystemSpecs): ModelRecommendations {
    // Leave headroom for the OS and the app itself on both RAM and VRAM.
    const usableRAMGB = +(specs.totalRAMGB * 0.7).toFixed(1);
    const usableVRAMGB = specs.gpu?.vramGB ? +(specs.gpu.vramGB * 0.9).toFixed(1) : 0;
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
