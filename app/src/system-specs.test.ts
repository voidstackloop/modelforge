import { describe, it, expect } from "vitest";
import { classifyGpuVendor, recommendModels, type SystemSpecs } from "./system-specs";

function baseSpecs(overrides: Partial<SystemSpecs> = {}): SystemSpecs {
    return {
        totalRAMGB: 16,
        freeRAMGB: 8,
        cpuModel: "Test CPU",
        cpuCores: 8,
        platform: "linux",
        arch: "x64",
        gpu: null,
        gpus: [],
        totalVramGB: null,
        ...overrides,
    };
}

describe("classifyGpuVendor", () => {
    it("identifies NVIDIA cards by common product names", () => {
        expect(classifyGpuVendor("NVIDIA GeForce RTX 4070")).toBe("nvidia");
        expect(classifyGpuVendor("GTX 1660 Super")).toBe("nvidia");
        expect(classifyGpuVendor("Tesla T4")).toBe("nvidia");
    });

    it("identifies AMD cards", () => {
        expect(classifyGpuVendor("AMD Radeon RX 7900 XTX")).toBe("amd");
        expect(classifyGpuVendor("Radeon Vega 8")).toBe("amd");
        expect(classifyGpuVendor("Advanced Micro Devices, Inc. [AMD/ATI] Navi 31")).toBe("amd");
    });

    it("identifies Intel GPUs including integrated graphics", () => {
        expect(classifyGpuVendor("Intel Arc A770")).toBe("intel");
        expect(classifyGpuVendor("Intel(R) Iris(R) Xe Graphics")).toBe("intel");
        expect(classifyGpuVendor("Intel(R) UHD Graphics 630")).toBe("intel");
    });

    it("identifies Apple GPUs", () => {
        expect(classifyGpuVendor("Apple M3 Pro")).toBe("apple");
    });

    it("returns unknown for unrecognized names", () => {
        expect(classifyGpuVendor("Matrox G200eW")).toBe("unknown");
    });
});

describe("recommendModels", () => {
    it("falls back to RAM-based sizing when there's no GPU", () => {
        const result = recommendModels(baseSpecs({ totalRAMGB: 16 }));
        expect(result.usableVRAMGB).toBe(0);
        expect(result.usableRAMGB).toBeCloseTo(11.2);
    });

    it("sums VRAM across multiple GPUs instead of using only the first one", () => {
        const specs = baseSpecs({
            gpu: { name: "GPU 0", vramGB: 24, vendor: "nvidia" },
            gpus: [
                { name: "GPU 0", vramGB: 24, vendor: "nvidia" },
                { name: "GPU 1", vramGB: 24, vendor: "nvidia" },
            ],
            totalVramGB: 48,
        });
        const result = recommendModels(specs);
        // 48GB total * 0.9 headroom factor
        expect(result.usableVRAMGB).toBeCloseTo(43.2);
    });

    it("uses whichever of RAM or VRAM gives more usable headroom", () => {
        const specs = baseSpecs({
            totalRAMGB: 8,
            gpu: { name: "Big GPU", vramGB: 80, vendor: "nvidia" },
            gpus: [{ name: "Big GPU", vramGB: 80, vendor: "nvidia" }],
            totalVramGB: 80,
        });
        const result = recommendModels(specs);
        expect(result.effectiveGB).toBeCloseTo(result.usableVRAMGB);
        expect(result.usableVRAMGB).toBeGreaterThan(result.usableRAMGB);
    });

    it("marks a model as runsOnGpu only when it fits within usable VRAM", () => {
        const specs = baseSpecs({
            totalRAMGB: 80,
            gpu: { name: "Small GPU", vramGB: 4, vendor: "nvidia" },
            gpus: [{ name: "Small GPU", vramGB: 4, vendor: "nvidia" }],
            totalVramGB: 4,
        });
        const result = recommendModels(specs);
        const tiny = result.models.find((m) => m.name === "llama3.2:1b")!;
        const large = result.models.find((m) => m.name === "llama3.1:70b")!;
        expect(tiny.runsOnGpu).toBe(true);
        expect(large.runsOnGpu).toBe(false);
        // Still fits overall thanks to the large RAM pool, just not on the GPU.
        expect(large.fits).toBe(true);
    });
});
