import { describe, expect, it, vi } from "vitest";

vi.mock("./system-specs", () => ({
    getSpecs: async () => ({
        totalRAMGB: 32,
        freeRAMGB: 24,
        cpuCores: 8,
        gpus: [{
            id: "nvidia:test",
            vendor: "nvidia",
            vramGB: 16,
            freeVramGB: 14,
            computeAvailable: true,
        }],
    }),
}));

import { getInferenceResourceSchedulerState, withInferenceResourceLock, getInferenceResourceTelemetry } from "./inference-resource-scheduler";

describe("inference resource scheduler", () => {
    it("never overlaps memory-intensive operations", async () => {
        const events: string[] = [];
        let releaseFirst!: () => void;
        const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
        const first = withInferenceResourceLock("first", async () => {
            events.push("first:start");
            await firstGate;
            events.push("first:end");
        });
        await vi.waitFor(() => expect(events).toEqual(["first:start"]));
        const second = withInferenceResourceLock("second", async () => { events.push("second:start"); });
        await vi.waitFor(() => expect(getInferenceResourceSchedulerState()).toEqual({ activeOperation: "first", queuedOperations: 1 }));
        releaseFirst();
        await Promise.all([first, second]);
        expect(events).toEqual(["first:start", "first:end", "second:start"]);
    });

    it("item 6/4: an estimated model size (requirementsOverride) reaches the orchestrator's own RAM budget instead of the 0/0 placeholder", async () => {
        await withInferenceResourceLock(
            "sized-load",
            async () => {
                const telemetry = getInferenceResourceTelemetry();
                // 8GB is within this suite's mocked 32GB total / 24GB free
                // RAM (see the getSpecs() mock above) — the lease is granted,
                // and its budget reflects the real number, not 0.
                expect(telemetry.activeLeases[0].budget.ramMB).toBe(8_000);
            },
            { ramMB: 8_000, vramMB: 2_000 }
        );
    });

    it("rejects a model-load whose estimated size genuinely exceeds available RAM, rather than silently admitting it at the old 0/0 placeholder", async () => {
        await expect(
            withInferenceResourceLock("oversized-load", async () => undefined, { ramMB: 999_000 })
        ).rejects.toMatchObject({ status: "rejected-insufficient-resources" });
    });
});
