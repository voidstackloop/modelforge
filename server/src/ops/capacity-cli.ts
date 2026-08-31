import { readFile } from "node:fs/promises";
import { runCapacityTest, type CapacityRunOptions } from "./capacity-runner.js";

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
    const targetUrl = process.env.LOAD_TARGET_URL;
    if (!targetUrl) throw new Error("LOAD_TARGET_URL is required.");
    const body = process.env.LOAD_BODY_FILE ? await readFile(process.env.LOAD_BODY_FILE, "utf8") : undefined;
    const options: CapacityRunOptions = {
        targetUrl,
        method: process.env.LOAD_METHOD ?? "GET",
        concurrency: integerEnv("LOAD_CONCURRENCY", 10),
        durationMs: integerEnv("LOAD_DURATION_MS", 30_000),
        maxRequests: integerEnv("LOAD_MAX_REQUESTS", 10_000),
        timeoutMs: integerEnv("LOAD_TIMEOUT_MS", 5_000),
        minCompletedRequests: integerEnv("LOAD_MIN_COMPLETED", 1),
        minSuccessRate: numberEnv("LOAD_MIN_SUCCESS_RATE", 0.99),
        minRequestsPerSecond: numberEnv("LOAD_MIN_RPS", 1),
        maxP95Ms: numberEnv("LOAD_MAX_P95_MS", 500),
        allowRemote: process.env.LOAD_ALLOW_REMOTE === "1",
        allowWrites: process.env.LOAD_ALLOW_WRITES === "1",
        bearerToken: process.env.LOAD_BEARER_TOKEN,
        body,
        contentType: process.env.LOAD_CONTENT_TYPE,
    };
    const report = await runCapacityTest(options);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (!report.gate.passed) process.exitCode = 1;
}

main().catch((error) => {
    process.stderr.write(`Capacity test configuration failed: ${error instanceof Error ? error.message : "unknown error"}\n`);
    process.exitCode = 2;
});
