import { describe, it, expect, vi, beforeEach } from "vitest";
import { execFile } from "node:child_process";

vi.mock("node:child_process", async (importOriginal) => {
    const actual = await importOriginal<typeof import("node:child_process")>();
    return { ...actual, execFile: vi.fn() };
});

const mockedExecFile = vi.mocked(execFile);

function mockNvidiaOutput(csv: string | null): void {
    mockedExecFile.mockImplementation((_cmd, _args, _opts, callback) => {
        const cb = callback as (err: Error | null, stdout: string) => void;
        if (csv === null) cb(new Error("not found"), "");
        else cb(null, csv);
        return {} as ReturnType<typeof execFile>;
    });
}

describe("getGpuTelemetry", () => {
    beforeEach(async () => {
        vi.resetModules();
        mockedExecFile.mockReset();
    });

    it("reports missing telemetry as null, not zero", async () => {
        mockNvidiaOutput(null);
        const { getGpuTelemetry } = await import("./gpu-telemetry");
        const samples = await getGpuTelemetry();
        expect(samples).toEqual([]);
    });

    it("parses per-device utilization/memory/temperature/power from nvidia-smi", async () => {
        mockNvidiaOutput("0, GPU-abc, 42, 4096, 20480, 65, 180.5, 350");
        const { getGpuTelemetry } = await import("./gpu-telemetry");
        const [sample] = await getGpuTelemetry();
        expect(sample.id).toBe("nvidia:GPU-abc");
        expect(sample.utilizationPercent).toBe(42);
        expect(sample.usedVramGB).toBeCloseTo(4, 1);
        expect(sample.temperatureC).toBe(65);
        expect(sample.powerWatts).toBe(180.5);
        expect(sample.powerLimitWatts).toBe(350);
        expect(sample.source).toBe("nvidia-smi");
        expect(sample.confidence).toBe("high");
    });

    it("treats an explicit N/A reading as unavailable rather than 0", async () => {
        mockNvidiaOutput("0, GPU-abc, N/A, 4096, 20480, N/A, N/A");
        const { getGpuTelemetry } = await import("./gpu-telemetry");
        const [sample] = await getGpuTelemetry();
        expect(sample.utilizationPercent).toBeNull();
        expect(sample.temperatureC).toBeNull();
        expect(sample.powerWatts).toBeNull();
    });

    it("caches within the TTL instead of re-spawning nvidia-smi on every call", async () => {
        mockNvidiaOutput("0, GPU-abc, 10, 1024, 1024, 50, 100");
        const { getGpuTelemetry } = await import("./gpu-telemetry");
        await getGpuTelemetry();
        await getGpuTelemetry();
        await getGpuTelemetry();
        // One nvidia-smi call (rocm-smi is skipped on non-Linux only; on
        // Linux CI it may add one more, but nvidia-smi itself must not be
        // invoked more than once across three calls within the TTL).
        const nvidiaCalls = mockedExecFile.mock.calls.filter((call) => call[0] === "nvidia-smi");
        expect(nvidiaCalls.length).toBe(1);
    });

    it("de-duplicates concurrent callers into a single in-flight probe", async () => {
        mockNvidiaOutput("0, GPU-abc, 10, 1024, 1024, 50, 100");
        const { getGpuTelemetry } = await import("./gpu-telemetry");
        const [a, b] = await Promise.all([getGpuTelemetry(), getGpuTelemetry()]);
        expect(a).toEqual(b);
        const nvidiaCalls = mockedExecFile.mock.calls.filter((call) => call[0] === "nvidia-smi");
        expect(nvidiaCalls.length).toBe(1);
    });

    it("skips probing entirely while monitoring is paused", async () => {
        mockNvidiaOutput("0, GPU-abc, 10, 1024, 1024, 50, 100");
        const { getGpuTelemetry, setGpuMonitoringPaused } = await import("./gpu-telemetry");
        setGpuMonitoringPaused(true);
        const samples = await getGpuTelemetry();
        expect(samples).toEqual([]);
        expect(mockedExecFile).not.toHaveBeenCalled();
        setGpuMonitoringPaused(false);
    });
});
