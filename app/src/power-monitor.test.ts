import { describe, expect, it } from "vitest";
import { estimatePower, intervalEnergyKwh, perActivityEnergyKwh } from "./power-monitor";

describe("power estimation", () => {
    it("interpolates between idle and configured maximum wattage", () => {
        const low = estimatePower(0, 0, { manualCpuWatts: 100, manualGpuWatts: 200, manualSystemIdleWatts: 20, includeIdleSystemConsumption: true });
        const high = estimatePower(1, 1, { manualCpuWatts: 100, manualGpuWatts: 200, manualSystemIdleWatts: 20, includeIdleSystemConsumption: true });
        expect(low).toBeGreaterThanOrEqual(20);
        expect(high).toBeCloseTo(320);
        expect(high).toBeGreaterThan(low);
    });
});

describe("shared energy allocation", () => {
    it("does not double-count one machine interval across concurrent requests", () => {
        const total = intervalEnergyKwh(200, 60_000);
        const perRequest = perActivityEnergyKwh(200, 60_000, 2);
        expect(perRequest * 2).toBeCloseTo(total, 12);
    });
});
