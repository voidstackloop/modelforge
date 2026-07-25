import * as path from "node:path";
import { app } from "electron";
import { readJson, writeJson } from "./json-store";
import type { EnergyMonitorSettings, EnergyUsageRecord, TariffUsageSnapshot } from "./energy-types";

function filePath(): string {
    return path.join(app.getPath("userData"), "energy-usage.json");
}

export function listRecords(retentionDays: number): EnergyUsageRecord[] {
    const records = readJson<EnergyUsageRecord[]>(filePath(), []);
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - Math.max(1, retentionDays));
    const cutoffDate = cutoff.toISOString().slice(0, 10);
    return records.filter((record) => record.date >= cutoffDate);
}

function mergeTariffs(existing: TariffUsageSnapshot[], incoming: TariffUsageSnapshot[]): TariffUsageSnapshot[] {
    const merged = new Map<string, TariffUsageSnapshot>();
    for (const item of [...existing, ...incoming]) {
        const key = `${item.name}\u0000${item.pricePerKwh}\u0000${item.currency}`;
        const current = merged.get(key);
        merged.set(key, current
            ? { ...current, energyKwh: current.energyKwh + item.energyKwh, cost: current.cost + item.cost }
            : { ...item });
    }
    return [...merged.values()];
}

export function addRecord(record: EnergyUsageRecord, settings: EnergyMonitorSettings): void {
    const records = listRecords(settings.retentionDays);
    const match = records.find((item) =>
        item.date === record.date
        && item.runtime === record.runtime
        && item.modelId === record.modelId
        && item.measurement === record.measurement
    );
    if (match) {
        match.requestCount += record.requestCount;
        match.promptTokens += record.promptTokens;
        match.completionTokens += record.completionTokens;
        match.activeSeconds += record.activeSeconds;
        match.loadingSeconds += record.loadingSeconds;
        match.energyKwh += record.energyKwh;
        match.cost += record.cost;
        match.carbonGrams += record.carbonGrams;
        match.tariffSnapshots = mergeTariffs(match.tariffSnapshots, record.tariffSnapshots);
    } else {
        records.push(record);
    }
    writeJson(filePath(), records);
}

export function clearRecords(): void {
    writeJson(filePath(), []);
}

