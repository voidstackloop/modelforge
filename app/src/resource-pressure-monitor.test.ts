import { describe, expect, it } from "vitest";
import { ResourcePressureMonitor } from "./resource-pressure-monitor";

function monitorWithRatios(ratios: number[]): { monitor: ResourcePressureMonitor } {
    let i = 0;
    const monitor = new ResourcePressureMonitor({
        intervalMs: 0, // no real timer — tests drive tick() manually
        // Advances on every call (i.e. every tick()) — the last ratio
        // repeats once the list is exhausted, so a test can tick() more
        // times than it explicitly lists ratios for.
        sample: () => ({ availableRatio: ratios[Math.min(i++, ratios.length - 1)] }),
    });
    return { monitor };
}

describe("ResourcePressureMonitor", () => {
    it("stays normal on a single noisy low sample — escalation requires sustained pressure, not one reading", () => {
        const { monitor } = monitorWithRatios([0.5, 0.02, 0.5]); // one severe dip, immediately recovers
        expect(monitor.tick()).toBe("normal");
        expect(monitor.tick()).toBe("normal"); // only one bad sample so far
        expect(monitor.tick()).toBe("normal"); // recovered before reaching the 3-sample threshold
    });

    it("escalates to warning only after 3 consecutive samples below the warning threshold", () => {
        const { monitor } = monitorWithRatios([0.1, 0.1, 0.1]);
        expect(monitor.tick()).toBe("normal");
        expect(monitor.tick()).toBe("normal");
        expect(monitor.tick()).toBe("warning");
    });

    it("escalates directly from normal to critical after 3 consecutive severely-low samples, without needing to pass through warning first", () => {
        const { monitor } = monitorWithRatios([0.02, 0.02, 0.02]);
        expect(monitor.tick()).toBe("normal");
        expect(monitor.tick()).toBe("normal");
        expect(monitor.tick()).toBe("critical");
    });

    it("de-escalates on a single sample once it crosses the (higher) recovery threshold — recovery is not debounced", () => {
        const { monitor } = monitorWithRatios([0.1, 0.1, 0.1, 0.3]);
        monitor.tick(); monitor.tick();
        expect(monitor.tick()).toBe("warning");
        expect(monitor.tick()).toBe("normal"); // single recovered sample is enough
    });

    it("critical only de-escalates to warning (not straight to normal) when the recovery is partial", () => {
        const { monitor } = monitorWithRatios([0.02, 0.02, 0.02, 0.2]);
        monitor.tick(); monitor.tick();
        expect(monitor.tick()).toBe("critical");
        expect(monitor.tick()).toBe("warning"); // 0.2 clears CRITICAL_EXIT_RATIO (0.15) but not WARNING_EXIT_RATIO (0.25)
    });

    it("critical de-escalates straight to normal when the recovery is complete", () => {
        const { monitor } = monitorWithRatios([0.02, 0.02, 0.02, 0.9]);
        monitor.tick(); monitor.tick();
        expect(monitor.tick()).toBe("critical");
        expect(monitor.tick()).toBe("normal");
    });

    it("notifies onChange listeners only on an actual level transition, never on a same-level tick", () => {
        const { monitor } = monitorWithRatios([0.1, 0.1, 0.1, 0.1, 0.1]);
        const seen: string[] = [];
        monitor.onChange((level) => seen.push(level));
        monitor.tick(); monitor.tick();
        expect(seen).toEqual([]); // still normal, no transition yet
        monitor.tick();
        expect(seen).toEqual(["warning"]);
        monitor.tick(); monitor.tick();
        expect(seen).toEqual(["warning"]); // stayed warning — no duplicate notifications
    });

    it("an unsubscribed listener stops receiving notifications", () => {
        const { monitor } = monitorWithRatios([0.1, 0.1, 0.1]);
        const seen: string[] = [];
        const unsubscribe = monitor.onChange((level) => seen.push(level));
        unsubscribe();
        monitor.tick(); monitor.tick(); monitor.tick();
        expect(seen).toEqual([]);
    });

    it("a listener that throws never breaks sampling for other listeners or future ticks", () => {
        const { monitor } = monitorWithRatios([0.1, 0.1, 0.1, 0.3]);
        const seen: string[] = [];
        monitor.onChange(() => { throw new Error("boom"); });
        monitor.onChange((level) => seen.push(level));
        monitor.tick(); monitor.tick();
        expect(() => monitor.tick()).not.toThrow();
        expect(seen).toEqual(["warning"]);
        monitor.tick();
        expect(seen).toEqual(["warning", "normal"]);
    });

    it("stop() clears the timer and listeners", () => {
        const monitor = new ResourcePressureMonitor({ intervalMs: 0 });
        const listener = () => undefined;
        monitor.onChange(listener);
        expect(() => monitor.stop()).not.toThrow();
    });
});
