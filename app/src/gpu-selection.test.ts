import { describe, it, expect } from "vitest";
import {
    assertTensorParallelSizeMatches,
    assertVendorHomogeneity,
    buildGpuVisibilityEnv,
    generateAutoTensorSplit,
    GpuSelectionError,
    parseGpuSelectionErrorMessage,
    resolveGpuSelection,
    resolveMainGpuIndex,
    selectAutomaticGpuCohort,
    usableDeviceMemoryGB,
    validateTensorSplit,
    withGpuSelectionErrorEncoding,
} from "./gpu-selection";
import type { GpuInfo } from "./system-specs";

const nvidia0: GpuInfo = { name: "RTX 4090", vramGB: 24, vendor: "nvidia", id: "nvidia:uuid-0", index: 0 };
const nvidia1: GpuInfo = { name: "RTX 4090", vramGB: 24, vendor: "nvidia", id: "nvidia:uuid-1", index: 1 };
const amd0: GpuInfo = { name: "Radeon RX 7900", vramGB: 24, vendor: "amd", id: "amd:unique-0", index: 0 };

describe("resolveGpuSelection", () => {
    it("resolves auto/all to every compute-available device", () => {
        const result = resolveGpuSelection({ mode: "auto", deviceIds: [] }, [nvidia0, nvidia1]);
        expect(result.gpus).toEqual([nvidia0, nvidia1]);
        expect(result.stale).toBe(false);
    });

    it("returns no devices for cpu mode regardless of hardware", () => {
        const result = resolveGpuSelection({ mode: "cpu", deviceIds: [] }, [nvidia0, nvidia1]);
        expect(result.gpus).toEqual([]);
        expect(result.stale).toBe(false);
    });

    it("resolves a single/group selection by stable id, preserving order", () => {
        const result = resolveGpuSelection({ mode: "group", deviceIds: ["nvidia:uuid-1", "nvidia:uuid-0"] }, [nvidia0, nvidia1]);
        expect(result.gpus.map((g) => g.id)).toEqual(["nvidia:uuid-1", "nvidia:uuid-0"]);
        expect(result.stale).toBe(false);
    });

    it("marks the selection stale and reports missing ids instead of substituting another GPU", () => {
        const result = resolveGpuSelection({ mode: "single", deviceIds: ["nvidia:uuid-99"] }, [nvidia0, nvidia1]);
        expect(result.gpus).toEqual([]);
        expect(result.stale).toBe(true);
        expect(result.missingIds).toEqual(["nvidia:uuid-99"]);
    });

    it("resolves the devices that still exist even when one sibling id is missing", () => {
        const result = resolveGpuSelection({ mode: "group", deviceIds: ["nvidia:uuid-0", "nvidia:uuid-missing"] }, [nvidia0, nvidia1]);
        expect(result.gpus).toEqual([nvidia0]);
        expect(result.stale).toBe(true);
        expect(result.missingIds).toEqual(["nvidia:uuid-missing"]);
    });

    it("excludes devices reported as not compute-available under auto/all", () => {
        const displayOnly: GpuInfo = { ...nvidia1, id: "nvidia:uuid-2", displayOnly: true };
        const result = resolveGpuSelection({ mode: "all", deviceIds: [] }, [nvidia0, displayOnly]);
        expect(result.gpus).toEqual([nvidia0]);
    });
});

describe("assertVendorHomogeneity", () => {
    it("allows a single-vendor group", () => {
        expect(() => assertVendorHomogeneity([nvidia0, nvidia1], "vLLM")).not.toThrow();
    });

    it("rejects a mixed NVIDIA+AMD group", () => {
        expect(() => assertVendorHomogeneity([nvidia0, amd0], "vLLM")).toThrow(GpuSelectionError);
    });
});

describe("selectAutomaticGpuCohort", () => {
    it("chooses one vendor cohort in backend preference order", () => {
        expect(selectAutomaticGpuCohort([amd0, nvidia0, nvidia1], ["nvidia", "amd"])).toEqual([nvidia0, nvidia1]);
        expect(selectAutomaticGpuCohort([nvidia0, amd0], ["amd"])).toEqual([amd0]);
    });

    it("excludes display-only and compute-unavailable devices", () => {
        expect(selectAutomaticGpuCohort([{ ...nvidia0, computeAvailable: false }, amd0], ["nvidia", "amd"])).toEqual([amd0]);
    });
});

describe("assertTensorParallelSizeMatches", () => {
    it("passes when the requested size is within the resolved GPU count", () => {
        expect(() => assertTensorParallelSizeMatches(2, 2)).not.toThrow();
        expect(() => assertTensorParallelSizeMatches(undefined, 1)).not.toThrow();
    });

    it("rejects a tensor-parallel size larger than what's actually selected", () => {
        expect(() => assertTensorParallelSizeMatches(4, 2)).toThrow(GpuSelectionError);
    });
});

describe("validateTensorSplit", () => {
    it("accepts a split matching the device count", () => {
        expect(() => validateTensorSplit([0.7, 0.3], 2)).not.toThrow();
    });

    it("rejects a length mismatch", () => {
        expect(() => validateTensorSplit([1], 2)).toThrow(GpuSelectionError);
    });

    it("rejects non-finite or non-positive values", () => {
        expect(() => validateTensorSplit([1, -1], 2)).toThrow(GpuSelectionError);
        expect(() => validateTensorSplit([1, Infinity], 2)).toThrow(GpuSelectionError);
        expect(() => validateTensorSplit([1, NaN], 2)).toThrow(GpuSelectionError);
    });
});

describe("generateAutoTensorSplit", () => {
    it("splits proportionally to each device's own VRAM, not evenly", () => {
        const split = generateAutoTensorSplit([{ ...nvidia0, vramGB: 24 }, { ...nvidia1, vramGB: 8 }]);
        expect(split[0]).toBeGreaterThan(split[1]);
        expect(split[0] + split[1]).toBeCloseTo(1, 2);
    });

    it("falls back to an even split when VRAM is unknown", () => {
        const split = generateAutoTensorSplit([{ ...nvidia0, vramGB: null }, { ...nvidia1, vramGB: null }]);
        expect(split[0]).toBeCloseTo(0.5, 2);
        expect(split[1]).toBeCloseTo(0.5, 2);
    });

    it("uses current free VRAM after a per-device reserve", () => {
        const split = generateAutoTensorSplit([
            { ...nvidia0, vramGB: 24, freeVramGB: 4 },
            { ...nvidia1, vramGB: 16, freeVramGB: 12 },
        ], 1);
        expect(split[0]).toBeLessThan(split[1]);
        expect(usableDeviceMemoryGB({ ...nvidia0, vramGB: 24, freeVramGB: 4 }, 1)).toBeCloseTo(2.08, 2);
    });

    it("refuses to plan a split that includes an exhausted GPU", () => {
        expect(usableDeviceMemoryGB({ ...nvidia0, vramGB: 24, freeVramGB: 1 }, 1)).toBe(0);
        expect(() => generateAutoTensorSplit([
            { ...nvidia0, freeVramGB: 1 },
            { ...nvidia1, freeVramGB: 12 },
        ], 1)).toThrow(GpuSelectionError);
    });
});

describe("buildGpuVisibilityEnv", () => {
    it("builds CUDA_VISIBLE_DEVICES from each device's UUID, not its index", () => {
        // UUID-based selection is required to address MIG instances
        // correctly (they have no standalone index) and is also more robust
        // for ordinary GPUs, so it's preferred whenever `id` carries one.
        expect(buildGpuVisibilityEnv("nvidia", [nvidia1, nvidia0])).toEqual({ CUDA_VISIBLE_DEVICES: "uuid-1,uuid-0" });
    });

    it("falls back to the numeric index when a device has no nvidia: UUID id", () => {
        const noUuid = { name: "GeForce RTX", vramGB: 8, vendor: "nvidia", index: 2 };
        expect(buildGpuVisibilityEnv("nvidia", [noUuid])).toEqual({ CUDA_VISIBLE_DEVICES: "2" });
    });

    it("builds both HIP and ROCR visible-device vars for AMD using indices", () => {
        expect(buildGpuVisibilityEnv("amd", [amd0])).toEqual({ HIP_VISIBLE_DEVICES: "0", ROCR_VISIBLE_DEVICES: "0" });
    });

    it("returns an empty env for no devices or unsupported vendors", () => {
        expect(buildGpuVisibilityEnv("nvidia", [])).toEqual({});
        expect(buildGpuVisibilityEnv("apple", [{ name: "M3", vramGB: null, vendor: "apple", index: 0 }])).toEqual({});
    });
});

describe("GpuSelectionError IPC round-trip", () => {
    it("survives withGpuSelectionErrorEncoding + parseGpuSelectionErrorMessage with category/recoveryAction intact", async () => {
        const thrower = () => Promise.reject(new GpuSelectionError("selected_gpu_missing", "The saved GPU is gone.", "Use automatic selection instead."));
        await expect(withGpuSelectionErrorEncoding(thrower)).rejects.toThrow();
        try {
            await withGpuSelectionErrorEncoding(thrower);
            expect.unreachable();
        } catch (err) {
            const parsed = parseGpuSelectionErrorMessage((err as Error).message);
            expect(parsed).toEqual({
                category: "selected_gpu_missing",
                recoveryAction: "Use automatic selection instead.",
                message: "The saved GPU is gone.",
            });
        }
    });

    it("passes through a non-GpuSelectionError unchanged", async () => {
        const thrower = () => Promise.reject(new Error("some other failure"));
        await expect(withGpuSelectionErrorEncoding(thrower)).rejects.toThrow("some other failure");
    });

    it("still reads as a plain, actionable message for same-process (non-IPC) callers", () => {
        const error = new GpuSelectionError("unsupported_vendor_mixture", "Mixed vendors.", "Pick one vendor.");
        expect(error.message).toBe("Mixed vendors. Pick one vendor.");
    });

    it("parses an encoded error even when Electron prefixes the message", () => {
        const error = new GpuSelectionError("no_compatible_gpu", "No GPU is usable.", "Use CPU mode.");
        expect(parseGpuSelectionErrorMessage(`Error invoking remote method: Error: ${error.toIpcMessage()}`)).toEqual({
            category: "no_compatible_gpu",
            recoveryAction: "Use CPU mode.",
            message: "No GPU is usable.",
        });
    });
});

describe("resolveMainGpuIndex", () => {
    it("finds the array index of the requested stable id", () => {
        expect(resolveMainGpuIndex([nvidia0, nvidia1], "nvidia:uuid-1")).toBe(1);
    });

    it("returns undefined when unset or not found", () => {
        expect(resolveMainGpuIndex([nvidia0, nvidia1], undefined)).toBeUndefined();
        expect(resolveMainGpuIndex([nvidia0, nvidia1], "nvidia:uuid-99")).toBeUndefined();
    });
});
