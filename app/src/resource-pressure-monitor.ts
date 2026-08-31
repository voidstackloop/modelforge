import * as os from "node:os";
import type { ResourcePressureLevel } from "./resource-contracts";

/**
 * Sustained-RAM-pressure classifier (item 4: "use hysteresis rather than
 * reacting to every telemetry sample"). Two-threshold ("Schmitt trigger")
 * design applied asymmetrically on purpose:
 *
 *  - **Escalating** (normal -> warning -> critical) requires
 *    ENTER_SAMPLE_COUNT consecutive bad samples. One noisy low-memory
 *    reading must never alone start rejecting real work — that would be
 *    "reacting to every telemetry sample," exactly what this exists to
 *    avoid.
 *  - **De-escalating** reacts to a single sample once it crosses a
 *    materially higher recovery threshold than the one that triggered
 *    entry. Being slow to notice recovery only costs some queued
 *    background work a few extra seconds; being slow to notice real
 *    pressure risks the OOM this whole mechanism exists to prevent — the
 *    asymmetry is deliberate, not an oversight.
 *
 * RAM only, not VRAM/CPU: `os.freemem()`/`totalmem()` are cheap, synchronous,
 * and available on every platform Node runs on. GPU utilization/VRAM
 * pressure would need system-specs.ts's heavier nvidia-smi/rocm-smi probes,
 * which are too slow to poll every few seconds — the existing single-
 * exclusive-accelerator admission slot in resource-orchestrator.ts already
 * prevents GPU contention between heavyweight leases directly, which is the
 * higher-value protection for VRAM specifically.
 */
const WARNING_ENTER_RATIO = 0.15;
const WARNING_EXIT_RATIO = 0.25;
const CRITICAL_ENTER_RATIO = 0.08;
const CRITICAL_EXIT_RATIO = 0.15;
const ENTER_SAMPLE_COUNT = 3;
const DEFAULT_SAMPLE_INTERVAL_MS = 5_000;

export interface ResourcePressureSample {
    availableRatio: number;
}

export interface ResourcePressureMonitorOptions {
    sample?: () => ResourcePressureSample;
    intervalMs?: number;
}

export class ResourcePressureMonitor {
    private level: ResourcePressureLevel = "normal";
    private belowWarningCount = 0;
    private belowCriticalCount = 0;
    private timer: NodeJS.Timeout | null = null;
    private readonly listeners = new Set<(level: ResourcePressureLevel) => void>();
    private readonly sample: () => ResourcePressureSample;

    constructor(options: ResourcePressureMonitorOptions = {}) {
        this.sample = options.sample ?? defaultSample;
        const intervalMs = options.intervalMs ?? DEFAULT_SAMPLE_INTERVAL_MS;
        if (intervalMs > 0) {
            this.timer = setInterval(() => this.tick(), intervalMs);
            this.timer.unref();
        }
    }

    getLevel(): ResourcePressureLevel {
        return this.level;
    }

    onChange(listener: (level: ResourcePressureLevel) => void): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    /** Runs one sample-and-classify cycle. Public (not just timer-driven) so
     * tests can drive it deterministically without real timers or real
     * memory pressure. */
    tick(): ResourcePressureLevel {
        const { availableRatio } = this.sample();
        this.belowCriticalCount = availableRatio < CRITICAL_ENTER_RATIO ? this.belowCriticalCount + 1 : 0;
        this.belowWarningCount = availableRatio < WARNING_ENTER_RATIO ? this.belowWarningCount + 1 : 0;

        let next = this.level;
        if (this.level === "critical") {
            if (availableRatio >= CRITICAL_EXIT_RATIO) next = availableRatio >= WARNING_EXIT_RATIO ? "normal" : "warning";
        } else if (this.level === "warning") {
            if (this.belowCriticalCount >= ENTER_SAMPLE_COUNT) next = "critical";
            else if (availableRatio >= WARNING_EXIT_RATIO) next = "normal";
        } else {
            if (this.belowCriticalCount >= ENTER_SAMPLE_COUNT) next = "critical";
            else if (this.belowWarningCount >= ENTER_SAMPLE_COUNT) next = "warning";
        }

        if (next !== this.level) {
            this.level = next;
            this.belowWarningCount = 0;
            this.belowCriticalCount = 0;
            for (const listener of this.listeners) {
                try { listener(this.level); } catch { /* observers cannot break sampling */ }
            }
        }
        return this.level;
    }

    stop(): void {
        if (this.timer) clearInterval(this.timer);
        this.timer = null;
        this.listeners.clear();
    }
}

function defaultSample(): ResourcePressureSample {
    const total = os.totalmem();
    const free = os.freemem();
    return { availableRatio: total > 0 ? free / total : 1 };
}

export const mainResourcePressureMonitor = new ResourcePressureMonitor();
