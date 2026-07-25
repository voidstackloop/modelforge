import * as fs from "node:fs";
import * as os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import type { ChatChunk, ProviderId } from "./providers/types";
import * as usageStore from "./energy-usage-store";
import type {
    EnergyDashboard,
    EnergyMeasurement,
    EnergyMonitorSettings,
    EnergyRuntime,
    EnergyTotals,
    EnergyUsageRecord,
    RuntimeActivity,
    TariffUsageSnapshot,
} from "./energy-types";

const execFileAsync = promisify(execFile);
const active = new Map<string, InternalActivity>();
let previousCpu = cpuTimes();
let raplPrevious: { energyUj: number; at: number } | null = null;
let samplerTimer: NodeJS.Timeout | null = null;
let samplePromise: Promise<void> | null = null;
let lastSharedSampleAt = Date.now();

interface PowerReading {
    watts: number;
    cpuUtilization: number;
    gpuUtilization: number | null;
    measurement: EnergyMeasurement;
}

interface InternalActivity extends RuntimeActivity {
    firstTokenAt?: number;
    tariffSnapshots: Map<string, TariffUsageSnapshot>;
    gridIntensity: number;
    settings: EnergyMonitorSettings;
}

export interface ActivityHandle {
    onChunk(chunk: ChatChunk): void;
    finish(): Promise<void>;
}

function cpuTimes(): { idle: number; total: number } {
    let idle = 0;
    let total = 0;
    for (const cpu of os.cpus()) {
        idle += cpu.times.idle;
        total += Object.values(cpu.times).reduce((sum, value) => sum + value, 0);
    }
    return { idle, total };
}

export function sampleCpuUtilization(): number {
    const current = cpuTimes();
    const totalDelta = current.total - previousCpu.total;
    const idleDelta = current.idle - previousCpu.idle;
    previousCpu = current;
    return totalDelta <= 0 ? 0 : Math.max(0, Math.min(1, 1 - idleDelta / totalDelta));
}

function runtimeForProvider(provider: ProviderId): EnergyRuntime {
    if (provider === "ollama") return "ollama";
    if (provider === "vllm") return "vllm";
    if (provider === "mlx") return "mlx";
    if (provider === "llamacpp" || provider === "rocm") return "llamacpp";
    return "transformers";
}

function selectedTariff(settings: EnergyMonitorSettings, date: Date): { name: string; pricePerKwh: number } {
    const hour = date.getHours() + date.getMinutes() / 60;
    const match = settings.timeOfUseTariffs.find((tariff) =>
        tariff.startHour <= tariff.endHour
            ? hour >= tariff.startHour && hour < tariff.endHour
            : hour >= tariff.startHour || hour < tariff.endHour
    );
    return match ?? { name: "Standard", pricePerKwh: settings.electricityPricePerKwh };
}

function readRaplEnergy(): number | null {
    if (process.platform !== "linux") return null;
    const roots = ["/sys/class/powercap/intel-rapl:0/energy_uj", "/sys/class/powercap/intel-rapl/intel-rapl:0/energy_uj"];
    for (const candidate of roots) {
        try {
            const value = Number(fs.readFileSync(candidate, "utf-8").trim());
            if (Number.isFinite(value)) return value;
        } catch {
            // Try the next common RAPL location.
        }
    }
    return null;
}

function raplWatts(now: number): number | null {
    const energyUj = readRaplEnergy();
    if (energyUj === null) return null;
    const previous = raplPrevious;
    raplPrevious = { energyUj, at: now };
    if (!previous || energyUj < previous.energyUj || now <= previous.at) return null;
    return ((energyUj - previous.energyUj) / 1e6) / ((now - previous.at) / 1000);
}

async function nvidiaReading(): Promise<{ watts: number; utilization: number } | null> {
    try {
        const { stdout } = await execFileAsync("nvidia-smi", ["--query-gpu=power.draw,utilization.gpu", "--format=csv,noheader,nounits"], { timeout: 2500, windowsHide: true });
        let watts = 0;
        let utilization = 0;
        let count = 0;
        for (const line of stdout.split(/\r?\n/)) {
            const [power, usage] = line.split(",").map((value) => Number(value.trim()));
            if (!Number.isFinite(power)) continue;
            watts += power;
            utilization += Number.isFinite(usage) ? usage / 100 : 0;
            count++;
        }
        return count ? { watts, utilization: utilization / count } : null;
    } catch {
        return null;
    }
}

async function rocmReading(): Promise<{ watts: number; utilization: number } | null> {
    try {
        const { stdout } = await execFileAsync("rocm-smi", ["--showpower", "--showuse", "--json"], { timeout: 2500, windowsHide: true });
        const parsed = JSON.parse(stdout) as Record<string, Record<string, unknown>>;
        let watts = 0;
        let utilization = 0;
        let count = 0;
        for (const card of Object.values(parsed)) {
            const powerEntry = Object.entries(card).find(([key]) => /average.*power|power.*average/i.test(key));
            const useEntry = Object.entries(card).find(([key]) => /gpu.*use/i.test(key));
            if (!powerEntry) continue;
            const power = Number(String(powerEntry[1]).replace(/[^0-9.]/g, ""));
            if (!Number.isFinite(power)) continue;
            watts += power > 1000 ? power / 1e6 : power;
            utilization += Number(String(useEntry?.[1] ?? 0).replace(/[^0-9.]/g, "")) / 100;
            count++;
        }
        return count ? { watts, utilization: utilization / count } : null;
    } catch {
        return null;
    }
}

async function appleReading(): Promise<{ cpuWatts: number; gpuWatts: number } | null> {
    if (process.platform !== "darwin") return null;
    try {
        const { stdout } = await execFileAsync("powermetrics", ["--samplers", "cpu_power,gpu_power", "-i", "500", "-n", "1"], { timeout: 2500, windowsHide: true });
        const cpu = Number(stdout.match(/CPU Power:\s*([0-9.]+)\s*mW/i)?.[1] ?? NaN) / 1000;
        const gpu = Number(stdout.match(/GPU Power:\s*([0-9.]+)\s*mW/i)?.[1] ?? NaN) / 1000;
        return Number.isFinite(cpu) || Number.isFinite(gpu) ? { cpuWatts: Number.isFinite(cpu) ? cpu : 0, gpuWatts: Number.isFinite(gpu) ? gpu : 0 } : null;
    } catch {
        return null;
    }
}

export function estimatePower(
    cpuUtilization: number,
    gpuUtilization: number,
    settings: Pick<EnergyMonitorSettings, "manualCpuWatts" | "manualGpuWatts" | "manualSystemIdleWatts" | "includeIdleSystemConsumption">
): number {
    const idle = settings.includeIdleSystemConsumption ? (settings.manualSystemIdleWatts ?? 25) : 0;
    const cpuMax = settings.manualCpuWatts ?? 65;
    const gpuMax = settings.manualGpuWatts ?? 150;
    const cpuIdle = Math.min(10, cpuMax * 0.2);
    const gpuIdle = Math.min(12, gpuMax * 0.12);
    return idle
        + cpuIdle + cpuUtilization * Math.max(0, cpuMax - cpuIdle)
        + gpuIdle + gpuUtilization * Math.max(0, gpuMax - gpuIdle);
}

async function readPower(settings: EnergyMonitorSettings): Promise<PowerReading> {
    const now = Date.now();
    const cpuUtilization = sampleCpuUtilization();
    const apple = process.platform === "darwin" ? await appleReading() : null;
    const gpu = apple ? null : (await nvidiaReading()) ?? (await rocmReading());
    const cpuWatts = raplWatts(now);
    if (apple) {
        return { watts: apple.cpuWatts + apple.gpuWatts + (settings.includeIdleSystemConsumption ? settings.manualSystemIdleWatts ?? 0 : 0), cpuUtilization, gpuUtilization: null, measurement: "measured" };
    }
    if (cpuWatts !== null && gpu) {
        return { watts: cpuWatts + gpu.watts + (settings.includeIdleSystemConsumption ? settings.manualSystemIdleWatts ?? 0 : 0), cpuUtilization, gpuUtilization: gpu.utilization, measurement: "measured" };
    }
    if (gpu) {
        // Preserve the hardware GPU reading and estimate only the CPU/system
        // portion. The combined result is still labelled Estimated because
        // it contains a modelled component.
        const estimatedCpuAndSystem = estimatePower(cpuUtilization, 0, { ...settings, manualGpuWatts: 0 });
        return { watts: estimatedCpuAndSystem + gpu.watts, cpuUtilization, gpuUtilization: gpu.utilization, measurement: "estimated" };
    }
    if (cpuWatts !== null) {
        return { watts: cpuWatts + (settings.includeIdleSystemConsumption ? settings.manualSystemIdleWatts ?? 0 : 0), cpuUtilization, gpuUtilization: null, measurement: "measured" };
    }
    return { watts: estimatePower(cpuUtilization, 0, settings), cpuUtilization, gpuUtilization: null, measurement: "estimated" };
}

export function intervalEnergyKwh(watts: number, elapsedMs: number): number {
    return watts * (Math.max(0, elapsedMs) / 3_600_000) / 1000;
}

export function perActivityEnergyKwh(watts: number, elapsedMs: number, activityCount: number): number {
    return activityCount > 0 ? intervalEnergyKwh(watts, elapsedMs) / activityCount : 0;
}

async function sampleAll(): Promise<void> {
    if (samplePromise) return samplePromise;
    if (active.size === 0) return;
    samplePromise = (async () => {
        const settings = active.values().next().value?.settings as EnergyMonitorSettings | undefined;
        if (!settings) return;
        const reading = await readPower(settings);
        const now = Date.now();
        const elapsedMs = Math.max(0, now - lastSharedSampleAt);
        lastSharedSampleAt = now;
        const activities = [...active.values()];
        const shareWatts = reading.watts / activities.length;
        const energyKwh = perActivityEnergyKwh(reading.watts, elapsedMs, activities.length);
        for (const activity of activities) {
        const tariff = selectedTariff(activity.settings, new Date(now));
        const cost = energyKwh * tariff.pricePerKwh;
        activity.currentPowerWatts = shareWatts;
        activity.cpuUtilization = reading.cpuUtilization;
        activity.gpuUtilization = reading.gpuUtilization;
        activity.energyKwh += energyKwh;
        activity.cost += cost;
        if (reading.measurement === "estimated") activity.measurement = "estimated";
        const key = `${tariff.name}\u0000${tariff.pricePerKwh}\u0000${activity.settings.currency}`;
        const bucket = activity.tariffSnapshots.get(key) ?? { name: tariff.name, pricePerKwh: tariff.pricePerKwh, currency: activity.settings.currency, energyKwh: 0, cost: 0 };
        bucket.energyKwh += energyKwh;
        bucket.cost += cost;
        activity.tariffSnapshots.set(key, bucket);
        }
    })().finally(() => { samplePromise = null; });
    return samplePromise;
}

function ensureSampler(settings: EnergyMonitorSettings): void {
    if (samplerTimer) return;
    lastSharedSampleAt = Date.now();
    void sampleAll();
    samplerTimer = setInterval(() => void sampleAll(), Math.max(1, Math.min(5, settings.sampleIntervalSeconds)) * 1000);
    samplerTimer.unref();
}

function stopSamplerIfIdle(): void {
    if (active.size !== 0 || !samplerTimer) return;
    clearInterval(samplerTimer);
    samplerTimer = null;
}

export function beginRequest(provider: ProviderId, modelId: string, backend: string, settings: EnergyMonitorSettings, initialPromptTokens = 0): ActivityHandle {
    if (!settings.enabled) return { onChunk: () => undefined, finish: async () => undefined };
    const now = Date.now();
    const activity: InternalActivity = {
        id: randomUUID(), runtime: runtimeForProvider(provider), modelId, backend,
        device: backend, processId: provider === "llamacpp" ? process.pid : null,
        startedAt: new Date(now).toISOString(), promptTokens: initialPromptTokens, completionTokens: 0,
        activeSeconds: 0, loadingSeconds: 0, cpuUtilization: 0, gpuUtilization: null,
        currentPowerWatts: 0, energyKwh: 0, cost: 0, measurement: "measured",
        tariffSnapshots: new Map(), gridIntensity: settings.gridIntensityGCo2PerKwh ?? 0, settings,
    };
    active.set(activity.id, activity);
    ensureSampler(settings);
    return {
        onChunk(chunk) {
            if ((chunk.message?.content ?? "") && !activity.firstTokenAt) activity.firstTokenAt = Date.now();
            activity.promptTokens = chunk.usage?.promptTokens ?? activity.promptTokens;
            activity.completionTokens = chunk.usage?.completionTokens ?? activity.completionTokens;
            if (!chunk.usage?.completionTokens && chunk.message?.content) activity.completionTokens += Math.ceil(chunk.message.content.length / 4);
        },
        async finish() {
            await sampleAll();
            const finished = Date.now();
            activity.finishedAt = new Date(finished).toISOString();
            activity.loadingSeconds = ((activity.firstTokenAt ?? finished) - now) / 1000;
            activity.activeSeconds = activity.firstTokenAt ? (finished - activity.firstTokenAt) / 1000 : 0;
            const record: EnergyUsageRecord = {
                date: activity.startedAt.slice(0, 10), runtime: activity.runtime, modelId: activity.modelId,
                requestCount: 1, promptTokens: activity.promptTokens, completionTokens: activity.completionTokens,
                activeSeconds: activity.activeSeconds, loadingSeconds: activity.loadingSeconds,
                energyKwh: activity.energyKwh, cost: activity.cost, measurement: activity.measurement,
                tariffSnapshots: [...activity.tariffSnapshots.values()], carbonGrams: activity.energyKwh * activity.gridIntensity,
            };
            usageStore.addRecord(record, settings);
            active.delete(activity.id);
            stopSamplerIfIdle();
        },
    };
}

function zeroTotals(): EnergyTotals {
    return { energyKwh: 0, cost: 0, carbonGrams: 0, requestCount: 0, promptTokens: 0, completionTokens: 0 };
}

function add(totals: EnergyTotals, record: EnergyUsageRecord): void {
    totals.energyKwh += record.energyKwh; totals.cost += record.cost; totals.carbonGrams += record.carbonGrams;
    totals.requestCount += record.requestCount; totals.promptTokens += record.promptTokens; totals.completionTokens += record.completionTokens;
}

export function getDashboard(settings: EnergyMonitorSettings): EnergyDashboard {
    const records = usageStore.listRecords(settings.retentionDays);
    const now = new Date();
    const todayKey = now.toISOString().slice(0, 10);
    const weekStart = new Date(now); weekStart.setDate(now.getDate() - 6);
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const today = zeroTotals(), week = zeroTotals(), month = zeroTotals(), lifetime = zeroTotals();
    const models = new Map<string, EnergyTotals>(), runtimes = new Map<string, EnergyTotals>();
    let measuredEnergy = 0;
    for (const record of records) {
        add(lifetime, record);
        if (record.date === todayKey) add(today, record);
        if (record.date >= weekStart.toISOString().slice(0, 10)) add(week, record);
        if (record.date >= monthStart.toISOString().slice(0, 10)) add(month, record);
        const model = models.get(record.modelId) ?? zeroTotals(); add(model, record); models.set(record.modelId, model);
        const runtime = runtimes.get(record.runtime) ?? zeroTotals(); add(runtime, record); runtimes.set(record.runtime, runtime);
        if (record.measurement === "measured") measuredEnergy += record.energyKwh;
    }
    const sorted = (map: Map<string, EnergyTotals>) => [...map].map(([key, totals]) => ({ key, totals })).sort((a, b) => b.totals.cost - a.totals.cost);
    return {
        current: [...active.values()].map(({ tariffSnapshots: _tariffs, settings: _settings, firstTokenAt: _first, gridIntensity: _grid, ...item }) => item),
        today, week, month, lifetime, byModel: sorted(models), byRuntime: sorted(runtimes),
        measuredPercent: lifetime.energyKwh > 0 ? measuredEnergy / lifetime.energyKwh * 100 : 0,
        costPerMillionGeneratedTokens: lifetime.completionTokens > 0 ? lifetime.cost / lifetime.completionTokens * 1_000_000 : 0,
        currency: settings.currency, records,
    };
}

export function stopAll(): void {
    active.clear();
    if (samplerTimer) clearInterval(samplerTimer);
    samplerTimer = null;
}
