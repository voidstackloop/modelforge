import { describe, expect, it } from "vitest";
import { applyResourceBudgetMode } from "./resource-budget";
import type { HardwareSnapshot } from "./resource-contracts";

function hardware(overrides: Partial<HardwareSnapshot> = {}): HardwareSnapshot {
    return {
        capturedAt: 0,
        cpuThreads: 16,
        availableCpuThreads: 15,
        totalRamMB: 32_000,
        availableRamMB: 28_000,
        gpus: [{ id: "gpu-0", vendor: "nvidia", totalVramMB: 16_000, availableVramMB: 14_000, computeAvailable: true }],
        ...overrides,
    };
}

describe("applyResourceBudgetMode", () => {
    it("balanced reserves the larger of 15% RAM or 2GB, and 1 CPU thread", () => {
        const result = applyResourceBudgetMode(hardware(), { mode: "balanced" });
        // 15% of 32000 = 4800 > 2048 floor, so the reserve is 4800.
        expect(result.availableRamMB).toBe(32_000 - 4_800);
        expect(result.availableCpuThreads).toBe(14);
    });

    it("balanced falls back to the 2GB floor on a small machine where 15% would reserve less", () => {
        const result = applyResourceBudgetMode(hardware({ totalRamMB: 8_000, availableRamMB: 7_000 }), { mode: "balanced" });
        // 15% of 8000 = 1200 < 2048 floor, so the reserve is the 2048 floor:
        // ceiling = totalRamMB - reserve = 5952, which binds below the 7000
        // currently reported as free.
        expect(result.availableRamMB).toBe(8_000 - 2_048);
    });

    it("performance reserves less than balanced — a smaller floor and percentage", () => {
        const balanced = applyResourceBudgetMode(hardware(), { mode: "balanced" });
        const performance = applyResourceBudgetMode(hardware(), { mode: "performance" });
        expect(performance.availableRamMB).toBeGreaterThan(balanced.availableRamMB);
        expect(performance.availableCpuThreads).toBeGreaterThanOrEqual(balanced.availableCpuThreads);
    });

    it("efficient reserves more than balanced — a larger floor, percentage, and CPU reserve", () => {
        const balanced = applyResourceBudgetMode(hardware(), { mode: "balanced" });
        const efficient = applyResourceBudgetMode(hardware(), { mode: "efficient" });
        expect(efficient.availableRamMB).toBeLessThan(balanced.availableRamMB);
        expect(efficient.availableCpuThreads).toBeLessThan(balanced.availableCpuThreads);
    });

    it("never reserves below zero even on a very small or very loaded machine", () => {
        const result = applyResourceBudgetMode(hardware({ totalRamMB: 1_000, availableRamMB: 500 }), { mode: "efficient" });
        expect(result.availableRamMB).toBeGreaterThanOrEqual(0);
        expect(result.availableCpuThreads).toBeGreaterThanOrEqual(1);
    });

    describe("manual mode", () => {
        it("applies the user's RAM/VRAM/CPU ceilings", () => {
            const result = applyResourceBudgetMode(hardware(), { mode: "manual", maxRamMB: 8_000, maxVramMB: 4_000, cpuThreadCeiling: 4 });
            expect(result.availableRamMB).toBe(8_000);
            expect(result.availableCpuThreads).toBe(4);
            expect(result.gpus[0].availableVramMB).toBe(4_000);
        });

        it("a user ceiling can never exceed what is actually available — min(), not a raw override", () => {
            const result = applyResourceBudgetMode(hardware({ availableRamMB: 5_000 }), { mode: "manual", maxRamMB: 20_000 });
            expect(result.availableRamMB).toBe(5_000); // actual availability still wins
        });

        it("still applies a small safety floor even with no explicit ceiling set at all, once currently-free RAM is close to the total", () => {
            // A near-idle small machine, where "currently free" is close
            // enough to "total" that the fixed safety floor is what
            // actually binds, not real-time availability.
            const nearIdle = hardware({ totalRamMB: 8_000, availableRamMB: 7_800 });
            const result = applyResourceBudgetMode(nearIdle, { mode: "manual" });
            // floor = max(512, 8000*0.05=400) = 512 -> ceiling = 7488, which
            // is below the 7800 currently reported as free.
            expect(result.availableRamMB).toBe(8_000 - 512);
            expect(result.availableRamMB).toBeLessThan(nearIdle.availableRamMB);
        });

        it("a mistaken max ceiling larger than the machine's own safety floor is clamped to the floor, not honored literally", () => {
            const result = applyResourceBudgetMode(hardware({ totalRamMB: 8_000, availableRamMB: 8_000 }), { mode: "manual", maxRamMB: 8_000 });
            expect(result.availableRamMB).toBeLessThan(8_000);
        });

        it("leaves GPUs untouched when maxVramMB is not set", () => {
            const result = applyResourceBudgetMode(hardware(), { mode: "manual", maxRamMB: 8_000 });
            expect(result.gpus[0].availableVramMB).toBe(14_000);
        });

        it("never turns a null (unknown) VRAM reading into a fabricated number", () => {
            const result = applyResourceBudgetMode(hardware({ gpus: [{ id: "gpu-0", vendor: "amd", totalVramMB: null, availableVramMB: null, computeAvailable: true }] }), { mode: "manual", maxVramMB: 4_000 });
            expect(result.gpus[0].availableVramMB).toBeNull();
        });
    });
});
