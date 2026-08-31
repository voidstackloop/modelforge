import { percentile, validateCanaryBaseUrl, type ProbeCheck } from "./canary-probe.js";

export interface PostShiftObservationOptions {
    baseUrl: string;
    workloadPath: string;
    workloadMethod: "GET" | "HEAD";
    samples: number;
    intervalMs: number;
    timeoutMs: number;
    consecutiveFailureLimit: number;
    minSuccessRate: number;
    readyP95LimitMs: number;
    workloadP95LimitMs: number;
    requireMetrics: boolean;
    workloadToken?: string;
    metricsToken?: string;
}

export interface ObservationSample {
    sample: number;
    live: ProbeCheck;
    ready: ProbeCheck;
    workload: ProbeCheck;
    metrics?: ProbeCheck;
    healthy: boolean;
}

export interface PostShiftObservationReport {
    schemaVersion: 1;
    targetOrigin: string;
    workload: { method: "GET" | "HEAD"; path: string };
    startedAt: string;
    completedAt: string;
    samples: ObservationSample[];
    gate: {
        passed: boolean;
        completedSamples: number;
        configuredSamples: number;
        successRate: number;
        finalConsecutiveFailures: number;
        readyP95Ms: number | null;
        workloadP95Ms: number | null;
        reasons: string[];
    };
}

export interface PostShiftObservationDependencies {
    fetch: typeof fetch;
    sleep: (ms: number) => Promise<void>;
    now: () => number;
    isoNow: () => string;
}

const defaultDependencies: PostShiftObservationDependencies = {
    fetch,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: () => performance.now(),
    isoNow: () => new Date().toISOString(),
};

function wholeNumber(name: string, value: number, min: number, max: number): void {
    if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${name} must be a whole number between ${min} and ${max}.`);
}

function validateOptions(options: PostShiftObservationOptions): { target: URL; workload: URL } {
    const target = validateCanaryBaseUrl(options.baseUrl);
    if (!options.workloadPath.startsWith("/") || options.workloadPath.startsWith("//")) {
        throw new Error("workloadPath must be an origin-relative path.");
    }
    const workload = new URL(options.workloadPath, target);
    if (workload.origin !== target.origin || workload.hash) throw new Error("workloadPath must remain on the candidate origin and contain no fragment.");
    if (options.workloadMethod !== "GET" && options.workloadMethod !== "HEAD") throw new Error("workloadMethod must be GET or HEAD.");
    wholeNumber("samples", options.samples, 1, 600);
    wholeNumber("intervalMs", options.intervalMs, 0, 300_000);
    wholeNumber("timeoutMs", options.timeoutMs, 100, 300_000);
    wholeNumber("consecutiveFailureLimit", options.consecutiveFailureLimit, 1, options.samples);
    if (!Number.isFinite(options.minSuccessRate) || options.minSuccessRate < 0 || options.minSuccessRate > 1) {
        throw new Error("minSuccessRate must be between 0 and 1.");
    }
    wholeNumber("readyP95LimitMs", options.readyP95LimitMs, 1, 300_000);
    wholeNumber("workloadP95LimitMs", options.workloadP95LimitMs, 1, 300_000);
    return { target, workload };
}

async function check(
    deps: PostShiftObservationDependencies,
    url: URL,
    method: "GET" | "HEAD",
    timeoutMs: number,
    expected: "health" | "metrics" | "success",
    token?: string
): Promise<ProbeCheck> {
    const started = deps.now();
    try {
        const response = await deps.fetch(url, {
            method,
            headers: token ? { Authorization: `Bearer ${token}` } : undefined,
            signal: AbortSignal.timeout(timeoutMs),
        });
        let contentOk = response.ok;
        if (expected === "health") {
            const body = await response.json().catch(() => undefined) as { status?: unknown } | undefined;
            contentOk = response.ok && body?.status === "ok";
        } else if (expected === "metrics") {
            const body = await response.text();
            contentOk = response.ok && body.includes("# HELP") && body.includes("modelforge_");
        } else {
            await response.body?.cancel().catch(() => undefined);
        }
        return {
            ok: contentOk,
            status: response.status,
            durationMs: Math.max(0, deps.now() - started),
            error: contentOk ? undefined : expected === "health" ? "unexpected health response" : expected === "metrics" ? "invalid metrics response" : "unexpected workload response",
        };
    } catch (error) {
        const timeout = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
        return { ok: false, durationMs: Math.max(0, deps.now() - started), error: timeout ? "timeout" : "request failed" };
    }
}

export async function observePostShift(
    options: PostShiftObservationOptions,
    dependencies: Partial<PostShiftObservationDependencies> = {}
): Promise<PostShiftObservationReport> {
    const { target, workload } = validateOptions(options);
    const deps = { ...defaultDependencies, ...dependencies };
    const startedAt = deps.isoNow();
    const observations: ObservationSample[] = [];
    let consecutiveFailures = 0;

    for (let index = 0; index < options.samples; index += 1) {
        const live = await check(deps, new URL("/health/live", target), "GET", options.timeoutMs, "health");
        const ready = await check(deps, new URL("/health/ready", target), "GET", options.timeoutMs, "health");
        const observedWorkload = await check(deps, workload, options.workloadMethod, options.timeoutMs, "success", options.workloadToken);
        const metrics = options.requireMetrics
            ? await check(deps, new URL("/metrics", target), "GET", options.timeoutMs, "metrics", options.metricsToken)
            : undefined;
        const healthy = live.ok && ready.ok && observedWorkload.ok && (metrics?.ok ?? true);
        consecutiveFailures = healthy ? 0 : consecutiveFailures + 1;
        observations.push({ sample: index + 1, live, ready, workload: observedWorkload, metrics, healthy });
        if (consecutiveFailures >= options.consecutiveFailureLimit) break;
        if (index + 1 < options.samples && options.intervalMs > 0) await deps.sleep(options.intervalMs);
    }

    const successful = observations.filter((sample) => sample.healthy).length;
    const successRate = observations.length === 0 ? 0 : successful / observations.length;
    const readyP95Ms = percentile(observations.filter((sample) => sample.ready.ok).map((sample) => sample.ready.durationMs), 0.95);
    const workloadP95Ms = percentile(observations.filter((sample) => sample.workload.ok).map((sample) => sample.workload.durationMs), 0.95);
    const reasons: string[] = [];
    if (consecutiveFailures >= options.consecutiveFailureLimit) reasons.push(`consecutive failure limit ${options.consecutiveFailureLimit} reached`);
    if (observations.some((sample) => !sample.live.ok)) reasons.push("one or more liveness checks failed");
    if (options.requireMetrics && observations.some((sample) => !sample.metrics?.ok)) reasons.push("one or more metrics checks failed");
    if (successRate < options.minSuccessRate) reasons.push(`success rate ${successRate.toFixed(4)} is below ${options.minSuccessRate}`);
    if (readyP95Ms === null) reasons.push("no successful readiness samples");
    else if (readyP95Ms > options.readyP95LimitMs) reasons.push(`readiness p95 ${readyP95Ms.toFixed(1)}ms exceeds ${options.readyP95LimitMs}ms`);
    if (workloadP95Ms === null) reasons.push("no successful workload samples");
    else if (workloadP95Ms > options.workloadP95LimitMs) reasons.push(`workload p95 ${workloadP95Ms.toFixed(1)}ms exceeds ${options.workloadP95LimitMs}ms`);

    return {
        schemaVersion: 1,
        targetOrigin: target.origin,
        workload: { method: options.workloadMethod, path: workload.pathname },
        startedAt,
        completedAt: deps.isoNow(),
        samples: observations,
        gate: {
            passed: reasons.length === 0,
            completedSamples: observations.length,
            configuredSamples: options.samples,
            successRate,
            finalConsecutiveFailures: consecutiveFailures,
            readyP95Ms,
            workloadP95Ms,
            reasons,
        },
    };
}
