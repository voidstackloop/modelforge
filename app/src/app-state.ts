import * as path from "node:path";
import * as fs from "node:fs";
import { app, BrowserWindow } from "electron";
import * as settingsStore from "./settings-store";
import type * as localServers from "./local-server-manager";
import type { EnergyMonitorSettings } from "./energy-types";
import type { ProviderId } from "./providers/types";

export const PROVIDER_SECRET_KEYS: Record<Exclude<ProviderId, "llamacpp" | "custom" | "mlx" | "rocm" | "vllm">, string> = {
    openai: "openai_api_key",
    anthropic: "anthropic_api_key",
    gemini: "gemini_api_key",
};

export function customProviderSecretKey(customProviderId: string): string {
    return `custom_${customProviderId}_api_key`;
}

export const activeChatRequests = new Map<string, AbortController>();
export const activeBenchmarkRequests = new Map<string, AbortController>();
export const activeMcpToolRequests = new Map<string, AbortController>();

let isBusy = false;
export function getIsBusy(): boolean {
    return isBusy;
}
export function setIsBusy(value: boolean): void {
    isBusy = value;
}

let forceClose = false;
export function getForceClose(): boolean {
    return forceClose;
}
export function setForceClose(value: boolean): void {
    forceClose = value;
}

// Every ipcMain.handle callback below is only reachable from this app's own
// preload-bridged renderer (contextIsolation is on, nodeIntegration is off),
// so this isn't a hostile-input boundary in the way a public API would be.
// Still, a malformed/undefined argument reaching a store function as `id`
// would throw a raw TypeError several layers deep — validating up front
// turns that into one clear, loggable error instead.
export function requireString(value: unknown, label: string): string {
    if (typeof value !== "string" || !value) {
        throw new Error(`Invalid ${label}: expected a non-empty string`);
    }
    return value;
}

export function getLlamaCppModelsDir(): string {
    const configured = settingsStore.getSettings().llamaCppModelsDir;
    const dir = configured || path.join(app.getPath("userData"), "llamacpp-models");
    fs.mkdirSync(dir, { recursive: true });
    return dir;
}

export function getLocalRuntimeConfig(): localServers.LocalBackendConfig {
    const settings = settingsStore.getSettings();
    return { mlxPythonPath: settings.mlxPythonPath, rocmServerPath: settings.rocmServerPath, vllmCommand: settings.vllmCommand };
}

export function getEnergyMonitorSettings(): EnergyMonitorSettings {
    const settings = settingsStore.getSettings();
    return {
        enabled: settings.energyMonitoringEnabled ?? false,
        electricityPricePerKwh: Math.max(0, settings.electricityPricePerKwh ?? 0.2),
        currency: settings.energyCurrency?.trim() || "USD",
        timeOfUseTariffs: settings.timeOfUseTariffs ?? [],
        manualCpuWatts: settings.manualCpuWatts,
        manualGpuWatts: settings.manualGpuWatts,
        manualSystemIdleWatts: settings.manualSystemIdleWatts,
        includeIdleSystemConsumption: settings.includeIdleSystemConsumption ?? true,
        retentionDays: Math.max(1, settings.energyUsageRetentionDays ?? 365),
        sampleIntervalSeconds: Math.max(1, Math.min(5, settings.energySampleIntervalSeconds ?? 2)),
        gridIntensityGCo2PerKwh: settings.gridIntensityGCo2PerKwh,
    };
}

let mainWindow: BrowserWindow | null = null;
export function getMainWindow(): BrowserWindow | null {
    return mainWindow;
}
export function setMainWindow(win: BrowserWindow | null): void {
    mainWindow = win;
}
