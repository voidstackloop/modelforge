import { describe, expect, it } from "vitest";
import { getInferenceResourceSchedulerState, withInferenceResourceLock } from "./inference-resource-scheduler";

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
        await Promise.resolve();
        const second = withInferenceResourceLock("second", async () => { events.push("second:start"); });
        await Promise.resolve();
        expect(getInferenceResourceSchedulerState()).toEqual({ activeOperation: "first", queuedOperations: 1 });
        releaseFirst();
        await Promise.all([first, second]);
        expect(events).toEqual(["first:start", "first:end", "second:start"]);
    });
});
