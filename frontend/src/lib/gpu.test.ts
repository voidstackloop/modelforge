import { describe, it, expect } from "vitest";
import { recommendGpuBackend, gpuBackendNote, parseGpuSelectionErrorMessage } from "./gpu";

describe("recommendGpuBackend", () => {
    it("recommends CUDA for NVIDIA when CUDA is available", () => {
        expect(recommendGpuBackend(["nvidia"], ["cuda", "vulkan"])).toBe("cuda");
    });

    it("falls back to Vulkan for NVIDIA when CUDA is not available", () => {
        expect(recommendGpuBackend(["nvidia"], ["vulkan"])).toBe("vulkan");
    });

    it("recommends Vulkan for AMD (no ROCm prebuilds exist)", () => {
        expect(recommendGpuBackend(["amd"], ["cuda", "vulkan"])).toBe("vulkan");
    });

    it("recommends Vulkan for Intel", () => {
        expect(recommendGpuBackend(["intel"], ["vulkan"])).toBe("vulkan");
    });

    it("recommends Metal for Apple", () => {
        expect(recommendGpuBackend(["apple"], ["metal"])).toBe("metal");
    });

    it("tries Vulkan for an unidentified GPU rather than dropping to CPU", () => {
        expect(recommendGpuBackend(["unknown"], ["vulkan"])).toBe("vulkan");
    });

    it("recommends CPU when no backend fits", () => {
        expect(recommendGpuBackend([], [])).toBe("cpu");
        expect(recommendGpuBackend(["amd"], [])).toBe("cpu");
    });
});

describe("gpuBackendNote", () => {
    it("explains Vulkan for AMD", () => {
        expect(gpuBackendNote(["amd"])).toBe("amdViaVulkan");
    });

    it("explains Vulkan for Intel", () => {
        expect(gpuBackendNote(["intel"])).toBe("intelViaVulkan");
    });

    it("notes when no GPU was detected", () => {
        expect(gpuBackendNote([])).toBe("noGpuDetected");
    });

    it("returns null for NVIDIA/Apple where the default story needs no caveat", () => {
        expect(gpuBackendNote(["nvidia"])).toBeNull();
        expect(gpuBackendNote(["apple"])).toBeNull();
    });
});

describe("parseGpuSelectionErrorMessage", () => {
    it("decodes a tagged GPU-selection error message back into its structured fields", () => {
        const encoded = ` GPU_SELECTION_ERROR ${JSON.stringify({ category: "selected_gpu_missing", recoveryAction: "Use automatic selection instead.", message: "The saved GPU is gone." })}`;
        expect(parseGpuSelectionErrorMessage(encoded)).toEqual({
            category: "selected_gpu_missing",
            recoveryAction: "Use automatic selection instead.",
            message: "The saved GPU is gone.",
        });
    });

    it("decodes the tag after Electron's remote-method error prefix", () => {
        const encoded = `Error invoking remote method 'localBackends:start': Error:  GPU_SELECTION_ERROR ${JSON.stringify({ category: "no_compatible_gpu", recoveryAction: "Choose CPU mode.", message: "No compatible GPU was found." })}`;
        expect(parseGpuSelectionErrorMessage(encoded)).toEqual({
            category: "no_compatible_gpu",
            recoveryAction: "Choose CPU mode.",
            message: "No compatible GPU was found.",
        });
    });

    it("returns null for an ordinary (untagged) error message", () => {
        expect(parseGpuSelectionErrorMessage("Failed to fetch")).toBeNull();
        expect(parseGpuSelectionErrorMessage("")).toBeNull();
    });

    it("returns null rather than throwing on a tagged-looking but malformed payload", () => {
        expect(parseGpuSelectionErrorMessage(" GPU_SELECTION_ERROR not json")).toBeNull();
        expect(parseGpuSelectionErrorMessage(" GPU_SELECTION_ERROR {\"category\":\"x\"}")).toBeNull();
    });
});
