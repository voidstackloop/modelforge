import { runCanaryProbe, type CanaryProbeOptions } from "./canary-probe.js";

function integerEnv(name: string, fallback: number): number {
    const raw = process.env[name];
    if (raw === undefined || raw.trim() === "") return fallback;
    const value = Number(raw);
    if (!Number.isInteger(value)) throw new Error(`${name} must be a whole number.`);
    return value;
}

async function main(): Promise<void> {
    const baseUrl = process.env.CANARY_BASE_URL;
    if (!baseUrl) throw new Error("CANARY_BASE_URL is required.");
    const options: CanaryProbeOptions = {
        baseUrl,
        attempts: integerEnv("CANARY_ATTEMPTS", 5),
        requiredConsecutiveSuccesses: integerEnv("CANARY_REQUIRED_CONSECUTIVE", 3),
        intervalMs: integerEnv("CANARY_INTERVAL_MS", 2_000),
        timeoutMs: integerEnv("CANARY_TIMEOUT_MS", 5_000),
        readyP95LimitMs: integerEnv("CANARY_READY_P95_LIMIT_MS", 1_000),
        requireMetrics: process.env.CANARY_REQUIRE_METRICS !== "0",
        metricsToken: process.env.CANARY_METRICS_TOKEN,
    };
    const report = await runCanaryProbe(options);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (!report.summary.promoted) process.exitCode = 1;
}

main().catch((error) => {
    process.stderr.write(`Canary probe configuration failed: ${error instanceof Error ? error.message : "unknown error"}\n`);
    process.exitCode = 2;
});
