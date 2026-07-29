// One shared, cached, per-device telemetry sampler — the single place that
// shells out to nvidia-smi/rocm-smi for *live* utilization/memory/temp/power
// numbers, so the Runtime Manager UI, IPC polling, and any future consumer
// all read from the same cache instead of each spawning their own probe on
// every poll tick.
import { execFile } from "node:child_process";
import * as os from "node:os";

export interface GpuTelemetrySample {
    id: string;
    index: number;
    vendor: string;
    utilizationPercent: number | null;
    usedVramGB: number | null;
    freeVramGB: number | null;
    temperatureC: number | null;
    powerWatts: number | null;
    powerLimitWatts: number | null;
    source: "nvidia-smi" | "rocm-smi";
    confidence: "high" | "medium" | "low";
    lastUpdatedAt: number;
}

const TELEMETRY_TTL_MS = 3_000;
let cache: { samples: GpuTelemetrySample[]; timestamp: number } | null = null;
let inFlight: Promise<GpuTelemetrySample[]> | null = null;
let paused = false;

// Called on window hide/minimize and app suspend/resume — avoids polling
// GPU tools while nobody can see the numbers. Does not clear the existing
// cache, so a UI that re-renders right after unpausing still has something
// to show until the next real sample.
export function setGpuMonitoringPaused(value: boolean): void {
    paused = value;
}

function execFileP(cmd: string, args: string[]): Promise<string | null> {
    return new Promise((resolve) => {
        execFile(cmd, args, { timeout: 3_000, maxBuffer: 256 * 1024, windowsHide: true }, (err, stdout) => {
            if (err) return resolve(null);
            resolve(stdout);
        });
    });
}

function toNumberOrNull(value: string | undefined): number | null {
    if (value === undefined) return null;
    const trimmed = value.trim();
    if (!trimmed || /n\/a|not supported/i.test(trimmed)) return null;
    const num = Number(trimmed);
    return Number.isFinite(num) ? num : null;
}

async function collectNvidiaTelemetry(): Promise<GpuTelemetrySample[]> {
    const out = await execFileP("nvidia-smi", [
        "--query-gpu=index,uuid,utilization.gpu,memory.used,memory.free,temperature.gpu,power.draw,power.limit",
        "--format=csv,noheader,nounits",
    ]);
    if (!out) return [];
    const now = Date.now();
    const samples: GpuTelemetrySample[] = [];
    for (const line of out.trim().split("\n")) {
        const [indexStr, uuid, util, usedMiB, freeMiB, tempC, powerW, powerLimitW] = line.split(",").map((s) => s.trim());
        if (!uuid) continue;
        samples.push({
            id: `nvidia:${uuid}`,
            index: Number(indexStr) || 0,
            vendor: "nvidia",
            utilizationPercent: toNumberOrNull(util),
            usedVramGB: usedMiB !== undefined ? (toNumberOrNull(usedMiB) === null ? null : +(Number(usedMiB) / 1024).toFixed(2)) : null,
            freeVramGB: freeMiB !== undefined ? (toNumberOrNull(freeMiB) === null ? null : +(Number(freeMiB) / 1024).toFixed(2)) : null,
            temperatureC: toNumberOrNull(tempC),
            powerWatts: toNumberOrNull(powerW),
            powerLimitWatts: toNumberOrNull(powerLimitW),
            source: "nvidia-smi",
            confidence: "high",
            lastUpdatedAt: now,
        });
    }
    return samples;
}

async function collectAmdTelemetry(): Promise<GpuTelemetrySample[]> {
    if (os.platform() !== "linux") return [];
    const out = await execFileP("rocm-smi", [
        "--showuniqueid", "--showuse", "--showmeminfo", "vram", "--showtemp", "--showpower", "--json",
    ]);
    if (!out) return [];
    try {
        const parsed = JSON.parse(out) as Record<string, Record<string, string>>;
        const now = Date.now();
        const samples: GpuTelemetrySample[] = [];
        let ordinal = 0;
        for (const key of Object.keys(parsed)) {
            if (!/^card\d+$/i.test(key)) continue;
            const card = parsed[key];
            const uniqueId = card["Unique ID"];
            const usedBytes = toNumberOrNull(card["VRAM Total Used Memory (B)"]);
            const totalBytes = toNumberOrNull(card["VRAM Total Memory (B)"]);
            const freeBytes = usedBytes !== null && totalBytes !== null ? Math.max(0, totalBytes - usedBytes) : null;
            samples.push({
                id: uniqueId ? `amd:${uniqueId}` : `amd:ordinal:${ordinal}`,
                index: ordinal,
                vendor: "amd",
                utilizationPercent: toNumberOrNull(card["GPU use (%)"]),
                usedVramGB: usedBytes !== null ? +(usedBytes / 1e9).toFixed(2) : null,
                freeVramGB: freeBytes !== null ? +(freeBytes / 1e9).toFixed(2) : null,
                temperatureC: toNumberOrNull(card["Temperature (Sensor edge) (C)"]),
                powerWatts: toNumberOrNull(card["Average Graphics Package Power (W)"]),
                powerLimitWatts: toNumberOrNull(card["Max Graphics Package Power (W)"]),
                source: "rocm-smi",
                confidence: uniqueId ? "high" : "medium",
                lastUpdatedAt: now,
            });
            ordinal++;
        }
        return samples;
    } catch {
        return [];
    }
}

async function collectGpuTelemetry(): Promise<GpuTelemetrySample[]> {
    const [nvidia, amd] = await Promise.all([collectNvidiaTelemetry(), collectAmdTelemetry()]);
    return [...nvidia, ...amd];
}

// Cached + de-duplicated: concurrent callers within the TTL window share one
// in-flight probe rather than each spawning nvidia-smi/rocm-smi themselves,
// and no probe runs at all while `paused`. Telemetry that couldn't be read
// is reported as `null` fields, never coerced to 0 — a missing reading is
// not the same as "0% utilization" or "0 watts".
export async function getGpuTelemetry(): Promise<GpuTelemetrySample[]> {
    const now = Date.now();
    if (cache && now - cache.timestamp < TELEMETRY_TTL_MS) return cache.samples;
    if (paused) return cache?.samples ?? [];
    if (inFlight) return inFlight;
    inFlight = collectGpuTelemetry()
        .then((samples) => {
            cache = { samples, timestamp: Date.now() };
            return samples;
        })
        .finally(() => {
            inFlight = null;
        });
    return inFlight;
}

export function invalidateGpuTelemetryCache(): void {
    cache = null;
}
