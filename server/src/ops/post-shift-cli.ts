import { observePostShift, type PostShiftObservationOptions } from "./post-shift-observer.js";

function numberEnv(name: string, fallback: number): number {
    const raw = process.env[name];
    if (raw === undefined || raw.trim() === "") return fallback;
    const value = Number(raw);
    if (!Number.isFinite(value)) throw new Error(`${name} must be a number.`);
    return value;
}

function integerEnv(name: string, fallback: number): number {
    const value = numberEnv(name, fallback);
    if (!Number.isInteger(value)) throw new Error(`${name} must be a whole number.`);
    return value;
}

async function main(): Promise<void> {
    const baseUrl = process.env.OBSERVATION_BASE_URL;
    const workloadPath = process.env.OBSERVATION_WORKLOAD_PATH;
    if (!baseUrl) throw new Error("OBSERVATION_BASE_URL is required.");
    if (!workloadPath) throw new Error("OBSERVATION_WORKLOAD_PATH is required.");
    const method = (process.env.OBSERVATION_WORKLOAD_METHOD ?? "GET").toUpperCase();
    if (method !== "GET" && method !== "HEAD") throw new Error("OBSERVATION_WORKLOAD_METHOD must be GET or HEAD.");
    const options: PostShiftObservationOptions = {
        baseUrl,
        workloadPath,
        workloadMethod: method,
        samples: integerEnv("OBSERVATION_SAMPLES", 20),
        intervalMs: integerEnv("OBSERVATION_INTERVAL_MS", 15_000),
        timeoutMs: integerEnv("OBSERVATION_TIMEOUT_MS", 5_000),
        consecutiveFailureLimit: integerEnv("OBSERVATION_CONSECUTIVE_FAILURE_LIMIT", 2),
        minSuccessRate: numberEnv("OBSERVATION_MIN_SUCCESS_RATE", 0.99),
        readyP95LimitMs: integerEnv("OBSERVATION_READY_P95_LIMIT_MS", 1_000),
        workloadP95LimitMs: integerEnv("OBSERVATION_WORKLOAD_P95_LIMIT_MS", 500),
        requireMetrics: process.env.OBSERVATION_REQUIRE_METRICS !== "0",
        workloadToken: process.env.OBSERVATION_WORKLOAD_TOKEN,
        metricsToken: process.env.OBSERVATION_METRICS_TOKEN,
    };
    const report = await observePostShift(options);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (!report.gate.passed) process.exitCode = 1;
}

main().catch((error) => {
    process.stderr.write(`Post-shift observation configuration failed: ${error instanceof Error ? error.message : "unknown error"}\n`);
    process.exitCode = 2;
});
