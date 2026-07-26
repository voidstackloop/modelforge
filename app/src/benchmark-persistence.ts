import * as path from "node:path";
import * as fs from "node:fs";
import { app, dialog } from "electron";
import * as systemSpecs from "./system-specs";
import * as localServers from "./local-server-manager";
import * as powerMonitor from "./power-monitor";
import { getLogTail } from "./logger";
import type * as benchmarkRunner from "./benchmark-runner";
import { getMainWindow, getEnergyMonitorSettings, getLocalRuntimeConfig } from "./app-state";

function benchmarkResultPath(): string {
    const dir = path.join(app.getPath("userData"), "benchmarks");
    fs.mkdirSync(dir, { recursive: true });
    return path.join(dir, "latest.json");
}

function benchmarkHistoryPath(): string { return path.join(path.dirname(benchmarkResultPath()), "history.json"); }

export function saveBenchmarkResult(result: benchmarkRunner.BenchmarkResult): void {
    const destination = benchmarkResultPath();
    const temporary = `${destination}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(result, null, 2));
    fs.renameSync(temporary, destination);
    let history: benchmarkRunner.BenchmarkResult[] = [];
    try { history = JSON.parse(fs.readFileSync(benchmarkHistoryPath(), "utf-8")); } catch { /* first benchmark */ }
    history.push(result);
    fs.writeFileSync(benchmarkHistoryPath(), JSON.stringify(history.slice(-100), null, 2));
}

export function getBenchmarkObservations(): systemSpecs.BenchmarkObservation[] {
    try {
        const history = JSON.parse(fs.readFileSync(benchmarkHistoryPath(), "utf-8")) as benchmarkRunner.BenchmarkResult[];
        return history.flatMap((result) => result.primary ? [{ model: result.model, tokensPerSecond: result.primary.tokensPerSecond, promptTokensPerSecond: result.primary.promptTokensPerSecond, timeToFirstTokenMs: result.primary.timeToFirstTokenMs }] : []);
    } catch {
        const latest = getLastBenchmarkResult();
        return latest?.primary ? [{ model: latest.model, tokensPerSecond: latest.primary.tokensPerSecond, promptTokensPerSecond: latest.primary.promptTokensPerSecond, timeToFirstTokenMs: latest.primary.timeToFirstTokenMs }] : [];
    }
}

export function getLastBenchmarkResult(): benchmarkRunner.BenchmarkResult | null {
    try {
        return JSON.parse(fs.readFileSync(benchmarkResultPath(), "utf-8")) as benchmarkRunner.BenchmarkResult;
    } catch {
        return null;
    }
}

export async function exportDiagnosticReport(result: benchmarkRunner.BenchmarkResult): Promise<{ success: boolean }> {
    const specs = await systemSpecs.getSpecs();
    const runtimes = await localServers.getRuntimeStatuses(getLocalRuntimeConfig());
    const report = {
        schemaVersion: 1,
        exportedAt: new Date().toISOString(),
        application: {
            version: app.getVersion(),
            electron: process.versions.electron,
            chrome: process.versions.chrome,
            node: process.versions.node,
            platform: process.platform,
            arch: process.arch,
        },
        system: specs,
        runtimeHealth: runtimes,
        benchmark: result,
        energyUsage: powerMonitor.getDashboard(getEnergyMonitorSettings()),
        recentLogs: getLogTail(),
    };
    const date = new Date().toISOString().replace(/[:.]/g, "-");
    const options = {
        defaultPath: `modelforge-diagnostic-${date}.json`,
        filters: [{ name: "JSON", extensions: ["json"] }],
    };
    const mainWindow = getMainWindow();
    const dialogResult = mainWindow ? await dialog.showSaveDialog(mainWindow, options) : await dialog.showSaveDialog(options);
    if (dialogResult.canceled || !dialogResult.filePath) return { success: false };
    fs.writeFileSync(dialogResult.filePath, JSON.stringify(report, null, 2));
    return { success: true };
}
