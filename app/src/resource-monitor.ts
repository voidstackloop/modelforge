import pidusage from "pidusage";
import { killProcessTree } from "./process-tree";

export interface ResourceLimits {
    maxMemoryMB?: number;
    maxCpuPercent?: number;
}

const DEFAULT_POLL_INTERVAL_MS = 2000;

// A safety net against a runaway process (a build loop stuck consuming
// memory, a background dev server that leaks), not a real resource quota
// system: pidusage measures the single tracked pid's own usage, not a full
// process-tree/cgroup total, so a process that does its heavy lifting in a
// child won't be caught by the *measurement* here — though killProcessTree
// below still takes the whole tree down once a breach is detected on the
// pid that is being watched.
//
// Returns a function that stops monitoring — always call it once the
// process being watched has exited on its own, otherwise the interval
// leaks. `intervalMs` is exposed for tests; production code should leave it
// at the default.
export function monitorProcess(
    pid: number,
    limits: ResourceLimits,
    onExceeded: (reason: string) => void,
    intervalMs = DEFAULT_POLL_INTERVAL_MS
): () => void {
    if (!limits.maxMemoryMB && !limits.maxCpuPercent) return () => {};

    let stopped = false;
    const stop = () => {
        if (stopped) return;
        stopped = true;
        clearInterval(timer);
    };

    const timer = setInterval(async () => {
        if (stopped) return;
        // Not pre-declared with an explicit type: `ReturnType<typeof
        // pidusage>` only sees pidusage's *last* overload (the array-of-pids
        // one) since TS's ReturnType utility can't pick from an overload set
        // the way a real call site does — annotating this variable's type
        // that way would silently widen it to the wrong shape. Left to
        // call-site inference instead, which correctly resolves the
        // single-pid `Promise<Stat>` overload.
        let memoryMB: number;
        let cpuPercent: number;
        try {
            const stats = await pidusage(pid);
            memoryMB = stats.memory / (1024 * 1024);
            cpuPercent = stats.cpu;
        } catch {
            // Process already exited — nothing left to monitor.
            stop();
            return;
        }
        if (stopped) return; // stopped while the async pidusage() call was in flight

        if (limits.maxMemoryMB && memoryMB > limits.maxMemoryMB) {
            stop();
            killProcessTree(pid);
            onExceeded(`exceeded the ${limits.maxMemoryMB}MB memory limit (was using ${memoryMB.toFixed(0)}MB)`);
            return;
        }
        if (limits.maxCpuPercent && cpuPercent > limits.maxCpuPercent) {
            stop();
            killProcessTree(pid);
            onExceeded(`exceeded the ${limits.maxCpuPercent}% CPU limit (was using ${cpuPercent.toFixed(0)}%)`);
        }
    }, intervalMs);
    timer.unref?.();

    return stop;
}
