import { describe, it, expect, afterEach } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { monitorProcess } from "./resource-monitor";

function isAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}

describe("monitorProcess", () => {
    let child: ChildProcess | undefined;
    let stop: (() => void) | undefined;

    afterEach(() => {
        stop?.();
        if (child?.pid && isAlive(child.pid)) child.kill();
    });

    it("kills the process and reports why when it exceeds the memory limit", async () => {
        child = spawn("node", ["-e", "setTimeout(() => {}, 10000)"], { stdio: "ignore" });
        const pid = child.pid!;
        const reasons: string[] = [];

        // Any real node process uses well over 1MB RSS, so this fires on the
        // very first poll.
        stop = monitorProcess(pid, { maxMemoryMB: 1 }, (reason) => reasons.push(reason), 50);

        await new Promise((r) => setTimeout(r, 500));

        expect(reasons).toHaveLength(1);
        expect(reasons[0]).toMatch(/exceeded the 1MB memory limit/);
        expect(isAlive(pid)).toBe(false);
    });

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

        stop = monitorProcess(pid, { maxMemoryMB: 100_000 }, (reason) => reasons.push(reason), 50);
        await new Promise((r) => setTimeout(r, 300));

        expect(reasons).toHaveLength(0);
    });

    it("stop() prevents any further callback even if a poll was already in flight", async () => {
        child = spawn("node", ["-e", "setTimeout(() => {}, 10000)"], { stdio: "ignore" });
        const pid = child.pid!;
        const reasons: string[] = [];

        stop = monitorProcess(pid, { maxMemoryMB: 1 }, (reason) => reasons.push(reason), 50);
        stop();
        await new Promise((r) => setTimeout(r, 300));

        expect(reasons).toHaveLength(0);
        expect(isAlive(pid)).toBe(true);
    });
});
