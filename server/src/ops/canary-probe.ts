export interface CanaryProbeOptions {
    baseUrl: string;
    attempts: number;
    requiredConsecutiveSuccesses: number;
    intervalMs: number;
    timeoutMs: number;
    readyP95LimitMs: number;
    requireMetrics: boolean;
    metricsToken?: string;
}

export interface ProbeCheck {
    ok: boolean;
    status?: number;
    durationMs: number;
    error?: string;
}

export interface CanaryAttempt {
    attempt: number;
    live: ProbeCheck;
    ready: ProbeCheck;
    metrics?: ProbeCheck;
    promotable: boolean;
}

export interface CanaryProbeReport {
    schemaVersion: 1;
    targetOrigin: string;
    startedAt: string;
    completedAt: string;
    attempts: CanaryAttempt[];
    summary: {
        promoted: boolean;
        finalConsecutiveSuccesses: number;
        requiredConsecutiveSuccesses: number;
        readyP95Ms: number | null;
        readyP95LimitMs: number;
        reasons: string[];
    };
}

export interface CanaryProbeDependencies {
    fetch: typeof fetch;
    sleep: (ms: number) => Promise<void>;
    now: () => number;
    isoNow: () => string;
}

const defaultDependencies: CanaryProbeDependencies = {
    fetch,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: () => performance.now(),
    isoNow: () => new Date().toISOString(),
};

function isLoopback(hostname: string): boolean {
    return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]" || hostname === "::1";
}

/** The probe may carry a metrics bearer token. Reject URL credentials and
 * plaintext remote targets before any request can transmit it. */
export function validateCanaryBaseUrl(value: string): URL {
    let url: URL;
    try { url = new URL(value); }
    catch { throw new Error("CANARY_BASE_URL must be a valid URL."); }
    if (url.username || url.password) throw new Error("CANARY_BASE_URL must not contain credentials.");
    if (url.search || url.hash) throw new Error("CANARY_BASE_URL must not contain a query string or fragment.");
    if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopback(url.hostname))) {
        throw new Error("CANARY_BASE_URL must use HTTPS; HTTP is allowed only for an explicit loopback target.");
    }
    url.pathname = url.pathname.replace(/\/+$/, "");
    return url;
}

export function percentile(values: number[], quantile: number): number | null {
    if (values.length === 0) return null;
    const sorted = [...values].sort((a, b) => a - b);
    const index = Math.max(0, Math.ceil(quantile * sorted.length) - 1);
    return sorted[index];
}

async function probe(
    deps: CanaryProbeDependencies,
    url: string,
    timeoutMs: number,
    expected: "health" | "metrics",
    authorization?: string
): Promise<ProbeCheck> {
    const started = deps.now();
    try {
        const response = await deps.fetch(url, {
            headers: authorization ? { Authorization: authorization } : undefined,
            signal: AbortSignal.timeout(timeoutMs),
        });
        let contentOk = false;
        if (expected === "health") {
            const body = await response.json().catch(() => undefined) as { status?: unknown } | undefined;
            contentOk = body?.status === "ok";
        } else {
            const body = await response.text();
            contentOk = body.includes("# HELP") && body.includes("modelforge_");
        }
        return {
            ok: response.ok && contentOk,
            status: response.status,
            durationMs: Math.max(0, deps.now() - started),
            error: response.ok && contentOk ? undefined : expected === "health" ? "unexpected health response" : "invalid metrics response",
        };
    } catch (error) {
        const message = error instanceof Error && error.name === "TimeoutError" ? "timeout" : "request failed";
        return { ok: false, durationMs: Math.max(0, deps.now() - started), error: message };
    }
}

function assertOptions(options: CanaryProbeOptions): URL {
    const target = validateCanaryBaseUrl(options.baseUrl);
    const integers: Array<[string, number, number, number]> = [
        ["attempts", options.attempts, 1, 100],
        ["requiredConsecutiveSuccesses", options.requiredConsecutiveSuccesses, 1, options.attempts],
        ["intervalMs", options.intervalMs, 0, 300_000],
        ["timeoutMs", options.timeoutMs, 100, 300_000],
        ["readyP95LimitMs", options.readyP95LimitMs, 1, 300_000],
    ];
    for (const [name, value, min, max] of integers) {
        if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${name} must be a whole number between ${min} and ${max}.`);
    }
    return target;
}

export async function runCanaryProbe(
    options: CanaryProbeOptions,
    dependencies: Partial<CanaryProbeDependencies> = {}
): Promise<CanaryProbeReport> {
    const target = assertOptions(options);
    const deps = { ...defaultDependencies, ...dependencies };
    const startedAt = deps.isoNow();
    const attempts: CanaryAttempt[] = [];
    let finalConsecutiveSuccesses = 0;
    const metricsAuthorization = options.metricsToken ? `Bearer ${options.metricsToken}` : undefined;

    for (let index = 0; index < options.attempts; index += 1) {
        const live = await probe(deps, new URL("/health/live", target).toString(), options.timeoutMs, "health");
        const ready = await probe(deps, new URL("/health/ready", target).toString(), options.timeoutMs, "health");
        const metrics = options.requireMetrics
            ? await probe(deps, new URL("/metrics", target).toString(), options.timeoutMs, "metrics", metricsAuthorization)
            : undefined;
        const promotable = live.ok && ready.ok && (metrics?.ok ?? true);
        finalConsecutiveSuccesses = promotable ? finalConsecutiveSuccesses + 1 : 0;
        attempts.push({ attempt: index + 1, live, ready, metrics, promotable });
        if (index + 1 < options.attempts && options.intervalMs > 0) await deps.sleep(options.intervalMs);
    }

    const readyP95Ms = percentile(attempts.filter((attempt) => attempt.ready.ok).map((attempt) => attempt.ready.durationMs), 0.95);
    const reasons: string[] = [];
    if (attempts.some((attempt) => !attempt.live.ok)) reasons.push("one or more liveness checks failed");
    if (options.requireMetrics && attempts.some((attempt) => !attempt.metrics?.ok)) reasons.push("one or more metrics checks failed");
    if (finalConsecutiveSuccesses < options.requiredConsecutiveSuccesses) {
        reasons.push(`only ${finalConsecutiveSuccesses} consecutive successful checks at completion`);
    }
    if (readyP95Ms === null) reasons.push("no successful readiness samples");
    else if (readyP95Ms > options.readyP95LimitMs) reasons.push(`readiness p95 ${readyP95Ms.toFixed(1)}ms exceeds ${options.readyP95LimitMs}ms`);

    return {
        schemaVersion: 1,
        targetOrigin: target.origin,
        startedAt,
        completedAt: deps.isoNow(),
        attempts,
        summary: {
            promoted: reasons.length === 0,
            finalConsecutiveSuccesses,
            requiredConsecutiveSuccesses: options.requiredConsecutiveSuccesses,
            readyP95Ms,
            readyP95LimitMs: options.readyP95LimitMs,
            reasons,
        },
    };
}
