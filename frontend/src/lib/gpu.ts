import type { LlamaCppGpuBackend } from "@/types/electron";

// Which llama.cpp backend to suggest for the user's hardware, constrained to
// the backends node-llama-cpp actually reports as loadable on this machine.
// CUDA is NVIDIA-only and Metal is Apple-only; AMD and Intel GPUs are served
// by Vulkan, since node-llama-cpp ships no ROCm or SYCL prebuilt binaries —
// AMD users who want native ROCm should run those models through Ollama,
// which supports it directly.
export function recommendGpuBackend(vendors: string[], available: string[]): LlamaCppGpuBackend {
    if (vendors.includes("nvidia") && available.includes("cuda")) return "cuda";
    if (vendors.includes("apple") && available.includes("metal")) return "metal";
    if ((vendors.includes("nvidia") || vendors.includes("amd") || vendors.includes("intel")) && available.includes("vulkan")) {
        return "vulkan";
    }
    // A GPU we couldn't identify is still better served by trying Vulkan than
    // silently falling back to CPU-only inference.
    if (vendors.includes("unknown") && available.includes("vulkan")) return "vulkan";
    return "cpu";
}

export type GpuBackendNote = "amdViaVulkan" | "intelViaVulkan" | "noGpuDetected" | null;

// Which explanatory note (if any) the backend picker should show — returned
// as a symbol rather than display text so the UI can translate it.
export function gpuBackendNote(vendors: string[]): GpuBackendNote {
    if (vendors.includes("amd")) return "amdViaVulkan";
    if (vendors.includes("intel")) return "intelViaVulkan";
    if (vendors.length === 0) return "noGpuDetected";
    return null;
}
