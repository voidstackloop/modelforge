import { percentile } from "./canary-probe.js";

export interface CapacityRunOptions {
    targetUrl: string;
    method: string;
    concurrency: number;
    durationMs: number;
    maxRequests: number;
    timeoutMs: number;
    minCompletedRequests: number;
    minSuccessRate: number;
    minRequestsPerSecond: number;
    maxP95Ms: number;
    allowRemote: boolean;
    allowWrites: boolean;
    bearerToken?: string;
    body?: string;
    contentType?: string;
}

export interface CapacityRunReport {
    schemaVersion: 1;
    target: string;
    method: string;
    startedAt: string;
    completedAt: string;
    configured: {
        concurrency: number;
        durationMs: number;
        maxRequests: number;
        timeoutMs: number;
    };
    results: {
        completedRequests: number;
        successfulRequests: number;
        failedRequests: number;
        successRate: number;
        elapsedMs: number;
        requestsPerSecond: number;
        latencyMs: { p50: number | null; p95: number | null; p99: number | null };
        statusCounts: Record<string, number>;
        errorCounts: Record<string, number>;
    };
    gate: {
        passed: boolean;
        thresholds: {
            minCompletedRequests: number;
            minSuccessRate: number;
            minRequestsPerSecond: number;
            maxP95Ms: number;
        };
        reasons: string[];
    };
}

export interface CapacityRunDependencies {
    fetch: typeof fetch;
    now: () => number;
    isoNow: () => string;
}

const defaultDependencies: CapacityRunDependencies = {
    fetch,
    now: () => performance.now(),
    isoNow: () => new Date().toISOString(),
};

const READ_METHODS = new Set(["GET", "HEAD"]);
const WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

function isLoopback(hostname: string): boolean {
    return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]" || hostname === "::1";
}

export function validateCapacityTarget(value: string, allowRemote: boolean): URL {
    let url: URL;
    try { url = new URL(value); }
    catch { throw new Error("LOAD_TARGET_URL must be a valid absolute URL."); }
    if (url.username || url.password) throw new Error("LOAD_TARGET_URL must not contain credentials.");
    if (url.hash) throw new Error("LOAD_TARGET_URL must not contain a fragment.");
    const loopback = isLoopback(url.hostname);
    if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
        throw new Error("LOAD_TARGET_URL must use HTTPS; HTTP is allowed only for loopback targets.");
    }
    if (!loopback && !allowRemote) throw new Error("Remote load requires LOAD_ALLOW_REMOTE=1.");
    return url;
}

function wholeNumber(name: string, value: number, min: number, max: number): void {
    if (!Number.isInteger(value) || value < min || value > max) {
        throw new Error(`${name} must be a whole number between ${min} and ${max}.`);
    }
}

function finiteNumber(name: string, value: number, min: number, max: number): void {
    if (!Number.isFinite(value) || value < min || value > max) {
        throw new Error(`${name} must be between ${min} and ${max}.`);
    }
}

function validateOptions(options: CapacityRunOptions): { target: URL; method: string } {
    const target = validateCapacityTarget(options.targetUrl, options.allowRemote);
    const method = options.method.trim().toUpperCase();
    if (!READ_METHODS.has(method) && !WRITE_METHODS.has(method)) {
        throw new Error("method must be GET, HEAD, POST, PUT, PATCH, or DELETE.");
    }
    if (WRITE_METHODS.has(method) && !options.allowWrites) {
        throw new Error("Mutating load requires LOAD_ALLOW_WRITES=1.");
    }
    if (options.body !== undefined && READ_METHODS.has(method)) throw new Error("Request bodies are not allowed for GET or HEAD.");
    wholeNumber("concurrency", options.concurrency, 1, 256);
    wholeNumber("durationMs", options.durationMs, 100, 1_800_000);
    wholeNumber("maxRequests", options.maxRequests, 1, 1_000_000);
    wholeNumber("timeoutMs", options.timeoutMs, 100, 300_000);
    wholeNumber("minCompletedRequests", options.minCompletedRequests, 1, options.maxRequests);
    finiteNumber("minSuccessRate", options.minSuccessRate, 0, 1);
    finiteNumber("minRequestsPerSecond", options.minRequestsPerSecond, 0, 1_000_000);
    finiteNumber("maxP95Ms", options.maxP95Ms, 1, 300_000);
    return { target, method };
}

function increment(counts: Record<string, number>, key: string): void {
    counts[key] = (counts[key] ?? 0) + 1;
}

function errorCategory(error: unknown): string {
    if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) return "timeout";
    return "request_failed";
}

export async function runCapacityTest(
    options: CapacityRunOptions,
    dependencies: Partial<CapacityRunDependencies> = {}
): Promise<CapacityRunReport> {
    const { target, method } = validateOptions(options);
    const deps = { ...defaultDependencies, ...dependencies };
    const startedAt = deps.isoNow();
    const started = deps.now();
    const deadline = started + options.durationMs;
    const latencies: number[] = [];
    const statusCounts: Record<string, number> = {};
    const errorCounts: Record<string, number> = {};
    let issued = 0;
    let successfulRequests = 0;

    const headers: Record<string, string> = {};
    if (options.bearerToken) headers.Authorization = `Bearer ${options.bearerToken}`;
    if (options.body !== undefined) headers["Content-Type"] = options.contentType ?? "application/json";

    async function worker(): Promise<void> {
        while (issued < options.maxRequests && deps.now() < deadline) {
            issued += 1;
            const requestStarted = deps.now();
            try {
                const response = await deps.fetch(target, {
                    method,
                    headers,
                    body: options.body,
                    signal: AbortSignal.timeout(options.timeoutMs),
                });
                latencies.push(Math.max(0, deps.now() - requestStarted));
                increment(statusCounts, String(response.status));
                if (response.ok) successfulRequests += 1;
                else increment(errorCounts, "http_error");
                await response.body?.cancel().catch(() => undefined);
            } catch (error) {
                latencies.push(Math.max(0, deps.now() - requestStarted));
                increment(errorCounts, errorCategory(error));
            }
        }
    }

    await Promise.all(Array.from({ length: options.concurrency }, () => worker()));
    const elapsedMs = Math.max(1, deps.now() - started);
    const completedRequests = latencies.length;
    const failedRequests = completedRequests - successfulRequests;
    const successRate = completedRequests === 0 ? 0 : successfulRequests / completedRequests;
    const requestsPerSecond = completedRequests / (elapsedMs / 1_000);
    const p50 = percentile(latencies, 0.5);
    const p95 = percentile(latencies, 0.95);
    const p99 = percentile(latencies, 0.99);
    const reasons: string[] = [];
    if (completedRequests < options.minCompletedRequests) reasons.push(`${completedRequests} completed requests is below ${options.minCompletedRequests}`);
    if (successRate < options.minSuccessRate) reasons.push(`success rate ${successRate.toFixed(4)} is below ${options.minSuccessRate}`);
    if (requestsPerSecond < options.minRequestsPerSecond) reasons.push(`throughput ${requestsPerSecond.toFixed(2)} req/s is below ${options.minRequestsPerSecond}`);
    if (p95 === null) reasons.push("no latency samples were collected");
    else if (p95 > options.maxP95Ms) reasons.push(`p95 ${p95.toFixed(1)}ms exceeds ${options.maxP95Ms}ms`);

    return {
        schemaVersion: 1,
        target: `${target.origin}${target.pathname}`,
        method,
        startedAt,
        completedAt: deps.isoNow(),
        configured: {
            concurrency: options.concurrency,
            durationMs: options.durationMs,
            maxRequests: options.maxRequests,
            timeoutMs: options.timeoutMs,
        },
        results: {
            completedRequests,
            successfulRequests,
            failedRequests,
            successRate,
            elapsedMs,
            requestsPerSecond,
            latencyMs: { p50, p95, p99 },
            statusCounts,
            errorCounts,
        },
        gate: {
            passed: reasons.length === 0,
            thresholds: {
                minCompletedRequests: options.minCompletedRequests,
                minSuccessRate: options.minSuccessRate,
                minRequestsPerSecond: options.minRequestsPerSecond,
                maxP95Ms: options.maxP95Ms,
            },
            reasons,
        },
    };
}
