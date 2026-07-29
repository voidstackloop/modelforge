import { describe, it, expect } from "vitest";
import { classifyGpuVendor, computeGpuTopology, detectModelFormat, parseMigInstancesFromNvidiaSmiL, recommendModels, recommendModelsWithML, resolveAutomaticRuntime, type GpuInfo, type GpuTopology, type SystemSpecs } from "./system-specs";

function baseTopology(overrides: Partial<GpuTopology> = {}): GpuTopology {
    return {
        interconnect: "none", homogeneous: true, deviceCount: 0, aggregateVramGB: null,
        smallestGpuVramGB: null, largestGpuVramGB: null, usableVramGB: null,
        peerToPeerCapable: false, tensorParallelRecommended: false, layerSplitOnly: false,
        ...overrides,
    };
}

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
        largestGpuVramGB: null,
        gpuInterconnect: "none",
        tensorParallelSupported: false,
        gpuTopology: baseTopology(),
        cpuMemoryBandwidthGBps: 50,
        cpuMemoryBandwidthMeasured: false,
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
        expect(result.usableRAMGB).toBeCloseTo(6);
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
        // 48GB aggregate remains visible, but is not treated as one pool.
        // aggregateUsableVramGB is rounded to 1 decimal place (same precision
        // as every other GB figure this function reports), so the raw
        // 21.12 * 2 = 42.24 product displays as 42.2, not 42.24.
        expect(result.usableVRAMGB).toBeCloseTo(42.2, 1);
    });

    it("does not treat aggregate VRAM as one GPU", () => {
        const specs = baseSpecs({
            totalRAMGB: 16, freeRAMGB: 12,
            gpu: { name: "GPU 0", vramGB: 12, vendor: "nvidia" },
            gpus: [{ name: "GPU 0", vramGB: 12, vendor: "nvidia" }, { name: "GPU 1", vramGB: 12, vendor: "nvidia" }],
            totalVramGB: 24, largestGpuVramGB: 12, gpuInterconnect: "pcie", tensorParallelSupported: false,
        });
        const result = recommendModels(specs);
        expect(result.largestUsableGpuGB).toBeCloseTo(10.6, 1);
        expect(result.aggregateUsableVramGB).toBeCloseTo(21.1, 1);
        expect(result.models.find((model) => model.name === "qwen2.5-coder:14b")?.outcome).not.toBe("Runs fully on GPU");
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
        expect(["Runs with partial offload", "CPU-only but usable", "Likely out of memory"]).toContain(large.outcome);
    });

    it("requires tensor parallelism only when per-GPU shards and interconnect support fit", () => {
        const result = recommendModels(baseSpecs({ totalRAMGB: 16, freeRAMGB: 10,
            gpu: { name: "RTX 6000 Ada", vramGB: 48, vendor: "nvidia" },
            gpus: [{ name: "RTX 6000 Ada", vramGB: 48, vendor: "nvidia" }, { name: "RTX 6000 Ada", vramGB: 48, vendor: "nvidia" }],
            totalVramGB: 96, largestGpuVramGB: 48, gpuInterconnect: "nvlink", tensorParallelSupported: true,
        }), { quantization: "Q4_K_M", contextLength: 4096, runtime: "vllm" });
        expect(result.models.find((model) => model.name === "llama3.1:70b")?.outcome).toBe("Requires tensor parallelism");
    });

    it("includes quantization, KV cache, overhead, offload, and measured speed", () => {
        const result = recommendModels(baseSpecs(), { quantization: "Q8_0", contextLength: 32768 }, [{ model: "llama3.2:3b", tokensPerSecond: 17.5 }]);
        const model = result.models.find((item) => item.name === "llama3.2:3b")!;
        expect(model.estimatedKvCacheGB).toBeGreaterThan(0);
        expect(model.runtimeOverheadGB).toBeGreaterThan(0);
        expect(model.estimatedWeightGB).toBeGreaterThan(3);
        expect(model.measuredTokensPerSecond).toBe(17.5);
    });
});

describe("computeGpuTopology", () => {
    it("treats equal-VRAM NVIDIA pairs as homogeneous and tensor-parallel recommended", () => {
        const topology = computeGpuTopology([
            { name: "RTX 4090", vramGB: 24, vendor: "nvidia" },
            { name: "RTX 4090", vramGB: 24, vendor: "nvidia" },
        ], "nvlink");
        expect(topology.homogeneous).toBe(true);
        expect(topology.tensorParallelRecommended).toBe(true);
        expect(topology.layerSplitOnly).toBe(false);
        expect(topology.aggregateVramGB).toBeCloseTo(48, 1);
        expect(topology.smallestGpuVramGB).toBe(24);
    });

    it("treats a large VRAM mismatch as heterogeneous, limited by the smallest card", () => {
        const topology = computeGpuTopology([
            { name: "RTX 4090", vramGB: 24, vendor: "nvidia" },
            { name: "GTX 1660", vramGB: 6, vendor: "nvidia" },
        ], "pcie");
        expect(topology.homogeneous).toBe(false);
        expect(topology.tensorParallelRecommended).toBe(false);
        expect(topology.layerSplitOnly).toBe(true);
        expect(topology.smallestGpuVramGB).toBe(6);
    });

    it("treats AMD XGMI/Infinity Fabric the same as NVIDIA NVLink for peer-to-peer and tensor-parallel eligibility", () => {
        const topology = computeGpuTopology([
            { name: "Instinct MI300X", vramGB: 192, vendor: "amd" },
            { name: "Instinct MI300X", vramGB: 192, vendor: "amd" },
        ], "xgmi");
        expect(topology.peerToPeerCapable).toBe(true);
        expect(topology.tensorParallelRecommended).toBe(true);
    });

    it("never recommends tensor parallelism across mixed NVIDIA+AMD vendors", () => {
        const topology = computeGpuTopology([
            { name: "RTX 4090", vramGB: 24, vendor: "nvidia" },
            { name: "Radeon RX 7900", vramGB: 24, vendor: "amd" },
        ], "unknown");
        expect(topology.homogeneous).toBe(false);
        expect(topology.tensorParallelRecommended).toBe(false);
    });

    it("does not treat aggregate VRAM as one contiguous pool", () => {
        const topology = computeGpuTopology([
            { name: "GPU 0", vramGB: 12, vendor: "nvidia" },
            { name: "GPU 1", vramGB: 12, vendor: "nvidia" },
        ], "pcie");
        // Aggregate is the sum, but usableVramGB is per-device-reserved sum,
        // never equated with a single 24GB-class card's behavior elsewhere.
        expect(topology.aggregateVramGB).toBe(24);
        expect(topology.usableVramGB).toBeLessThan(24);
        expect(topology.largestGpuVramGB).toBe(12);
    });

    it("reports single-GPU topology without recommending any parallel strategy", () => {
        const topology = computeGpuTopology([{ name: "Solo GPU", vramGB: 16, vendor: "nvidia" }], "none");
        expect(topology.deviceCount).toBe(1);
        expect(topology.tensorParallelRecommended).toBe(false);
        expect(topology.layerSplitOnly).toBe(false);
    });

    it("handles zero GPUs (CPU-only) without throwing", () => {
        const topology = computeGpuTopology([], "none");
        expect(topology.deviceCount).toBe(0);
        expect(topology.aggregateVramGB).toBeNull();
        expect(topology.tensorParallelRecommended).toBe(false);
    });
});

describe("parseMigInstancesFromNvidiaSmiL", () => {
    const physicalGpus: GpuInfo[] = [
        { name: "NVIDIA A100-SXM4-40GB", vramGB: 40, vendor: "nvidia", id: "nvidia:GPU-1111", index: 0, busId: "0000:01:00.0", driverVersion: "550.54", displayOnly: true, computeAvailable: false },
        { name: "NVIDIA A100-SXM4-40GB", vramGB: 40, vendor: "nvidia", id: "nvidia:GPU-4444", index: 1 },
    ];

    const sampleOutput = [
        "GPU 0: NVIDIA A100-SXM4-40GB (UUID: GPU-1111)",
        "  MIG 3g.20gb     Device  0: (UUID: MIG-2222)",
        "  MIG 1g.5gb      Device  1: (UUID: MIG-3333)",
        "GPU 1: NVIDIA A100-SXM4-40GB (UUID: GPU-4444)",
    ].join("\n");

    it("enumerates each MIG instance as its own compute-available device with a UUID-based id", () => {
        const instances = parseMigInstancesFromNvidiaSmiL(sampleOutput, physicalGpus);
        expect(instances).toHaveLength(2);
        expect(instances[0].id).toBe("nvidia:MIG-2222");
        expect(instances[0].computeAvailable).toBe(true);
        expect(instances[0].vramGB).toBe(20);
        expect(instances[1].id).toBe("nvidia:MIG-3333");
        expect(instances[1].vramGB).toBe(5);
    });

    it("attributes each instance to its correct parent GPU, not just the first one seen", () => {
        const instances = parseMigInstancesFromNvidiaSmiL(sampleOutput, physicalGpus);
        expect(instances.every((instance) => instance.migInfo?.includes("GPU 0"))).toBe(true);
    });

    it("returns nothing for a GPU with no configured MIG instances", () => {
        const noInstances = "GPU 0: NVIDIA RTX 4090 (UUID: GPU-5555)";
        expect(parseMigInstancesFromNvidiaSmiL(noInstances, physicalGpus)).toEqual([]);
    });

    it("does not throw on malformed or unexpected output", () => {
        expect(() => parseMigInstancesFromNvidiaSmiL("garbage\n\tnot a real line\n", physicalGpus)).not.toThrow();
        expect(parseMigInstancesFromNvidiaSmiL("", physicalGpus)).toEqual([]);
    });
});

describe("detectModelFormat", () => {
    it("identifies GGUF and safetensors files by extension", () => {
        expect(detectModelFormat("llama-3.2-3b.Q4_K_M.gguf")).toBe("gguf");
        expect(detectModelFormat("model-00001-of-00002.safetensors")).toBe("safetensors");
        expect(detectModelFormat("model.safetensors.index.json")).toBe("safetensors");
    });
    it("identifies MLX repos by the mlx-community publisher convention", () => {
        expect(detectModelFormat("mlx-community/Llama-3.2-3B-Instruct-4bit")).toBe("mlx");
        expect(detectModelFormat("some-org/Qwen2.5-7B-mlx-4bit")).toBe("mlx");
    });
    it("falls back to unknown for anything unrecognized", () => {
        expect(detectModelFormat("meta-llama/Llama-3.1-8B-Instruct")).toBe("unknown");
    });
});

describe("resolveAutomaticRuntime", () => {
    const linuxNvidia = { platform: "linux" as const, arch: "x64", gpus: [{ name: "RTX 4090", vramGB: 24, vendor: "nvidia" as const }] };
    const linuxAmd = { platform: "linux" as const, arch: "x64", gpus: [{ name: "Radeon RX 7900", vramGB: 24, vendor: "amd" as const }] };
    const linuxNoGpu = { platform: "linux" as const, arch: "x64", gpus: [] };
    const appleSilicon = { platform: "darwin" as const, arch: "arm64", gpus: [{ name: "Apple M3 Max", vramGB: null, vendor: "apple" as const }] };
    const intelMac = { platform: "darwin" as const, arch: "x64", gpus: [{ name: "Intel Iris", vramGB: null, vendor: "intel" as const }] };

    it("routes GGUF to llama.cpp regardless of vendor", () => {
        expect(resolveAutomaticRuntime("gguf", linuxNvidia)).toBe("llamacpp");
        expect(resolveAutomaticRuntime("gguf", linuxAmd)).toBe("llamacpp");
        expect(resolveAutomaticRuntime("gguf", appleSilicon)).toBe("llamacpp");
        expect(resolveAutomaticRuntime("gguf", linuxNoGpu)).toBe("llamacpp");
    });
    it("routes safetensors to vLLM only on NVIDIA/ROCm hardware", () => {
        expect(resolveAutomaticRuntime("safetensors", linuxNvidia)).toBe("vllm");
        expect(resolveAutomaticRuntime("safetensors", linuxAmd)).toBe("vllm");
        expect(resolveAutomaticRuntime("safetensors", linuxNoGpu)).toBe("transformers");
    });
    it("routes MLX-format models to MLX only on Apple Silicon", () => {
        expect(resolveAutomaticRuntime("mlx", appleSilicon)).toBe("mlx");
        expect(resolveAutomaticRuntime("mlx", intelMac)).toBe("transformers");
        expect(resolveAutomaticRuntime("mlx", linuxNvidia)).toBe("transformers");
    });
    it("routes Ollama-library models to Ollama, or MLX on Apple Silicon", () => {
        expect(resolveAutomaticRuntime("ollama", linuxNvidia)).toBe("ollama");
        expect(resolveAutomaticRuntime("ollama", appleSilicon)).toBe("mlx");
    });
    it("falls back to Transformers for unrecognized formats", () => {
        expect(resolveAutomaticRuntime("unknown", linuxNvidia)).toBe("transformers");
    });
});

describe("recommendModelsWithML", () => {
    // The managed Python worker isn't installed in the test environment (no
    // venv under the mocked userData dir), so every model's ML prediction
    // rejects and recommendModelsWithML must fall back to the pure heuristic
    // result rather than throwing or hanging.
    it("falls back to the heuristic recommendModels() output when the ML worker is unavailable", async () => {
        const specs = baseSpecs({ totalRAMGB: 16 });
        const heuristic = recommendModels(specs);
        const withMl = await recommendModelsWithML(specs);
        expect(withMl.models.map((m) => m.name)).toEqual(heuristic.models.map((m) => m.name));
        expect(withMl.models.map((m) => m.recommendedRuntime)).toEqual(heuristic.models.map((m) => m.recommendedRuntime));
        expect(withMl.best).toBe(heuristic.best);
    }, 15_000);
});
