import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import pidusage from "pidusage";
import { killProcessTree } from "./process-tree";
import { monitorProcess } from "./resource-monitor";

vi.mock("pidusage", () => ({ default: vi.fn() }));
vi.mock("./process-tree", () => ({ killProcessTree: vi.fn() }));
const pidusageMock = vi.mocked(pidusage);
const killProcessTreeMock = vi.mocked(killProcessTree);

function isAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}

// pidusage's per-call latency varies a lot by platform (Windows CI runners
// in particular can be slow/jittery, e.g. when it shells out for process
// stats) — polling for the expected outcome instead of sleeping a fixed
// duration avoids flaking on a runner where one polling interval legitimately
// takes longer than the fixed wait this used to use.
async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
    const start = Date.now();
    while (!predicate()) {
        if (Date.now() - start > timeoutMs) throw new Error("timed out waiting for condition");
        await new Promise((resolve) => setTimeout(resolve, 20));
    }
}

describe("monitorProcess", () => {
    let child: ChildProcess | undefined;
    let stop: (() => void) | undefined;

    beforeEach(() => {
        pidusageMock.mockReset();
        killProcessTreeMock.mockReset();
    });

    afterEach(() => {
        stop?.();
        if (child?.pid && isAlive(child.pid)) child.kill();
    });

    it(
        "kills the process and reports why when it exceeds the memory limit",
        async () => {
            child = spawn("node", ["-e", "setTimeout(() => {}, 10000)"], { stdio: "ignore" });
            const pid = child.pid!;
            const reasons: string[] = [];
            pidusageMock.mockResolvedValue({ memory: 2 * 1024 * 1024, cpu: 0 } as never);

            // Any real node process uses well over 1MB RSS, so this fires on the
            // very first poll.
            stop = monitorProcess(pid, { maxMemoryMB: 1 }, (reason) => reasons.push(reason), 50);

            // Windows CI runners can take noticeably longer than Vitest's
            // default 5000ms per-test timeout for pidusage's first sample
            // (it shells out for process stats there) — 5000ms was both this
            // waitFor's internal budget and Vitest's outer one, so a slow
            // first poll hit the outer timeout before waitFor's own, more
            // descriptive error could ever fire. Both are widened here,
            // consistently, so the intended error surfaces instead.
            await waitFor(() => reasons.length > 0);

            expect(reasons).toHaveLength(1);
            expect(reasons[0]).toMatch(/exceeded the 1MB memory limit/);
            expect(killProcessTreeMock).toHaveBeenCalledWith(pid);
        },
        10_000
    );

    it("does nothing when no limits are configured", async () => {
        child = spawn("node", ["-e", "setTimeout(() => {}, 10000)"], { stdio: "ignore" });
        const pid = child.pid!;
        const reasons: string[] = [];
        stop = monitorProcess(pid, {}, (reason) => reasons.push(reason), 50);
        await new Promise((r) => setTimeout(r, 200));

        expect(reasons).toHaveLength(0);
        expect(isAlive(pid)).toBe(true);
    });

    it("stops cleanly without throwing once the watched process has already exited", async () => {
        child = spawn("node", ["-e", "process.exit(0)"], { stdio: "ignore" });
        const pid = child.pid!;
        const reasons: string[] = [];
        pidusageMock.mockRejectedValue(new Error("process exited"));

        stop = monitorProcess(pid, { maxMemoryMB: 100_000 }, (reason) => reasons.push(reason), 50);
        await new Promise((r) => setTimeout(r, 300));

        expect(reasons).toHaveLength(0);
    });

    it("stop() prevents any further callback even if a poll was already in flight", async () => {
        child = spawn("node", ["-e", "setTimeout(() => {}, 10000)"], { stdio: "ignore" });
        const pid = child.pid!;
        const reasons: string[] = [];

        let resolveSample!: (value: never) => void;
        pidusageMock.mockImplementation(() => new Promise((resolve) => { resolveSample = resolve; }) as never);
        stop = monitorProcess(pid, { maxMemoryMB: 1 }, (reason) => reasons.push(reason), 50);
        await waitFor(() => pidusageMock.mock.calls.length > 0);
        stop();
        resolveSample({ memory: 2 * 1024 * 1024, cpu: 0 } as never);
        await new Promise((r) => setTimeout(r, 300));

        expect(reasons).toHaveLength(0);
        expect(isAlive(pid)).toBe(true);
    });
});
