import { describe, it, expect } from "vitest";
import { recommendGpuBackend, gpuBackendNote } from "./gpu";

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
