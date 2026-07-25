export type EnergyRuntime = "llamacpp" | "ollama" | "vllm" | "mlx" | "transformers";
export type EnergyMeasurement = "measured" | "estimated";

export interface TimeOfUseTariff {
    name: string;
    startHour: number;
    endHour: number;
    pricePerKwh: number;
}

export interface EnergyMonitorSettings {
    enabled: boolean;
    electricityPricePerKwh: number;
    currency: string;
    timeOfUseTariffs: TimeOfUseTariff[];
    manualCpuWatts?: number;
    manualGpuWatts?: number;
    manualSystemIdleWatts?: number;
    includeIdleSystemConsumption: boolean;
    retentionDays: number;
    sampleIntervalSeconds: number;
    gridIntensityGCo2PerKwh?: number;
}

export interface TariffUsageSnapshot {
    name: string;
    pricePerKwh: number;
    currency: string;
    energyKwh: number;
    cost: number;
}

export interface EnergyUsageRecord {
    date: string;
    runtime: EnergyRuntime;
    modelId: string;
    requestCount: number;
    promptTokens: number;
    completionTokens: number;
    activeSeconds: number;
    loadingSeconds: number;
    energyKwh: number;
    cost: number;
    measurement: EnergyMeasurement;
    tariffSnapshots: TariffUsageSnapshot[];
    carbonGrams: number;
}

export interface RuntimeActivity {
    id: string;
    runtime: EnergyRuntime;
    modelId: string;
    backend: string;
    device: string;
    processId: number | null;
    startedAt: string;
    finishedAt?: string;
    promptTokens: number;
    completionTokens: number;
    activeSeconds: number;
    loadingSeconds: number;
    cpuUtilization: number;
    gpuUtilization: number | null;
    currentPowerWatts: number;
    energyKwh: number;
    cost: number;
    measurement: EnergyMeasurement;
}

export interface EnergyTotals {
    energyKwh: number;
    cost: number;
    carbonGrams: number;
    requestCount: number;
    promptTokens: number;
    completionTokens: number;
}

export interface EnergyDashboard {
    current: RuntimeActivity[];
    today: EnergyTotals;
    week: EnergyTotals;
    month: EnergyTotals;
    lifetime: EnergyTotals;
    byModel: { key: string; totals: EnergyTotals }[];
    byRuntime: { key: string; totals: EnergyTotals }[];
    measuredPercent: number;
    costPerMillionGeneratedTokens: number;
    currency: string;
    records: EnergyUsageRecord[];
}

