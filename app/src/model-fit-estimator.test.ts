import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { describe, expect, it, afterEach } from "vitest";
import { estimateModelFit } from "./model-fit-estimator";
import type { SystemSpecs } from "./system-specs";

function baseSpecs(overrides: Partial<SystemSpecs> = {}): SystemSpecs {
    return {
        totalRAMGB: 16, freeRAMGB: 12, cpuModel: "Test CPU", cpuCores: 8, platform: "linux", arch: "x64",
        gpu: null, gpus: [], totalVramGB: null, largestGpuVramGB: null, gpuInterconnect: "none",
        tensorParallelSupported: false,
        gpuTopology: { interconnect: "none", homogeneous: true, deviceCount: 0, aggregateVramGB: 0, smallestGpuVramGB: 0, largestGpuVramGB: 0, usableVramGB: 0, peerToPeerCapable: false, tensorParallelRecommended: false, layerSplitOnly: false },
        cpuMemoryBandwidthGBps: 50, cpuMemoryBandwidthMeasured: false,
        ...overrides,
    };
}

// Creates a real file of an exact size WITHOUT writing that many actual
// bytes to disk (sparse allocation via ftruncate) — needed because
// estimateModelFit stats the real file on disk, not a mocked size.
//
// ext4/APFS treat a plain ftruncate-to-grow on an empty file as a true
// sparse hole (no real blocks allocated). NTFS does not: without first
// flagging the file sparse via `fsutil sparse setflag`, growing it to
// hundreds of GB tries to actually reserve that much real disk space and
// fails with ENOSPC on a CI runner's much smaller disk (observed on a
// Windows release-build runner creating this suite's 500 GB fixture).
function sparseFile(dir: string, name: string, sizeBytes: number): string {
    const filePath = path.join(dir, name);
    fs.closeSync(fs.openSync(filePath, "w"));
    if (process.platform === "win32") execFileSync("fsutil", ["sparse", "setflag", filePath]);
    const fd = fs.openSync(filePath, "r+");
    fs.ftruncateSync(fd, sizeBytes);
    fs.closeSync(fd);
    return filePath;
}

describe("estimateModelFit", () => {
    let dir: string;
    afterEach(() => { if (dir) fs.rmSync(dir, { recursive: true, force: true }); });

    it("verdict 'comfortable' for a small model against a large GPU — vramMB carries the offloaded weight, ramMB covers only KV cache/overhead", async () => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), "model-fit-"));
        const modelPath = sparseFile(dir, "small-model-Q4_K_M.gguf", 500_000_000); // 0.5 GB
        const specs = baseSpecs({ gpus: [{ name: "Big GPU", vramGB: 80, vendor: "nvidia", computeAvailable: true }] });

        const result = await estimateModelFit(modelPath, { specs, contextLength: 4_096 });

        expect(result.verdict).toBe("comfortable");
        expect(result.assessment.outcome).toBe("Runs fully on GPU");
        expect(result.estimatedVramMB).toBeGreaterThan(0);
        expect(result.estimatedRamMB).toBeGreaterThanOrEqual(0);
        // Never invent memory beyond assessGgufFiles' own total.
        expect(result.estimatedRamMB + result.estimatedVramMB).toBeLessThanOrEqual(Math.ceil((result.assessment.totalRequiredGB ?? 0) * 1024) + 1);
    });

    it("verdict 'degraded' for partial GPU offload — some of the estimate lands in VRAM, the rest in RAM", async () => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), "model-fit-"));
        const modelPath = sparseFile(dir, "medium-model-Q4_K_M.gguf", 6_000_000_000); // 6 GB
        const specs = baseSpecs({ totalRAMGB: 32, freeRAMGB: 28, gpus: [{ name: "Small GPU", vramGB: 4, vendor: "nvidia", computeAvailable: true }] });

        const result = await estimateModelFit(modelPath, { specs, contextLength: 4_096 });

        expect(result.verdict).toBe("degraded");
        expect(result.assessment.outcome).toBe("Runs with partial offload");
        expect(result.estimatedVramMB).toBeGreaterThan(0);
        expect(result.estimatedRamMB).toBeGreaterThan(0);
    });

    it("verdict 'cpu-fallback' with zero VRAM requirement when there is no usable GPU at all", async () => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), "model-fit-"));
        const modelPath = sparseFile(dir, "cpu-model-Q4_K_M.gguf", 4_000_000_000); // 4 GB
        const specs = baseSpecs({ totalRAMGB: 32, freeRAMGB: 28, gpus: [] });

        const result = await estimateModelFit(modelPath, { specs, contextLength: 4_096 });

        expect(result.verdict).toBe("cpu-fallback");
        expect(result.estimatedVramMB).toBe(0);
        expect(result.estimatedRamMB).toBeGreaterThan(0);
    });

    it("verdict 'unsafe' when the model cannot fit RAM or VRAM under any configuration", async () => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), "model-fit-"));
        const modelPath = sparseFile(dir, "huge-model-Q4_K_M.gguf", 500_000_000_000); // 500 GB
        const specs = baseSpecs({ totalRAMGB: 16, freeRAMGB: 12, gpus: [{ name: "Small GPU", vramGB: 4, vendor: "nvidia", computeAvailable: true }] });

        const result = await estimateModelFit(modelPath, { specs, contextLength: 4_096 });

        expect(result.verdict).toBe("unsafe");
        expect(result.assessment.outcome).toBe("Likely out of memory");
    });

    it("verdict 'unknown' with a zeroed (never invented) requirement when the file cannot be stat'd", async () => {
        const result = await estimateModelFit("/does/not/exist/model.gguf", { contextLength: 4_096, specs: baseSpecs() });
        expect(result.verdict).toBe("unknown");
        expect(result.assessment.canAssess).toBe(false);
        expect(result.estimatedRamMB).toBe(0);
        expect(result.estimatedVramMB).toBe(0);
    });

    it("calls the real getSpecs() when no specs override is provided (integration smoke test — just checks it doesn't throw)", async () => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), "model-fit-"));
        const modelPath = sparseFile(dir, "real-specs-Q4_K_M.gguf", 1_000_000_000);
        await expect(estimateModelFit(modelPath)).resolves.toMatchObject({ verdict: expect.any(String) });
    });
});
