import { describe, expect, it } from "vitest";
import { observePostShift, type PostShiftObservationDependencies, type PostShiftObservationOptions } from "./post-shift-observer.js";

const options: PostShiftObservationOptions = {
    baseUrl: "https://candidate.example.test",
    workloadPath: "/organizations/synthetic/cases?limit=1",
    workloadMethod: "GET",
    samples: 3,
    intervalMs: 0,
    timeoutMs: 1_000,
    consecutiveFailureLimit: 2,
    minSuccessRate: 0.66,
    readyP95LimitMs: 100,
    workloadP95LimitMs: 100,
    requireMetrics: true,
    workloadToken: "synthetic-token",
    metricsToken: "metrics-token",
};

const health = (ok = true) => new Response(JSON.stringify({ status: ok ? "ok" : "degraded" }), { status: ok ? 200 : 503 });
const workload = (status = 200) => new Response(null, { status });
const metrics = (ok = true) => new Response(ok ? "# HELP modelforge_up test\nmodelforge_up 1\n" : "invalid", { status: ok ? 200 : 503 });

function deps(responses: Array<Response | Error>, duration = 10): PostShiftObservationDependencies {
    let responseIndex = 0;
    let clock = 0;
    return {
        fetch: (async () => {
            const response = responses[responseIndex++];
            if (response instanceof Error) throw response;
            if (!response) throw new Error("missing fake response");
            return response;
        }) as typeof fetch,
        sleep: async () => undefined,
        now: () => { clock += duration; return clock; },
        isoNow: () => "2026-08-30T12:00:00.000Z",
    };
}

describe("post-shift observer", () => {
    it("passes a healthy authenticated observation window", async () => {
        const requests: RequestInit[] = [];
        const dependencies = deps(Array.from({ length: 3 }, () => [health(), health(), workload(), metrics()]).flat());
        const originalFetch = dependencies.fetch;
        dependencies.fetch = (async (input, init) => { requests.push(init ?? {}); return originalFetch(input, init); }) as typeof fetch;
        const report = await observePostShift(options, dependencies);
        expect(report.gate).toMatchObject({ passed: true, completedSamples: 3, successRate: 1 });
        expect(report.workload).toEqual({ method: "GET", path: "/organizations/synthetic/cases" });
        expect(requests[2]?.headers).toEqual({ Authorization: "Bearer synthetic-token" });
        expect(requests[3]?.headers).toEqual({ Authorization: "Bearer metrics-token" });
    });

    it("fails fast after the configured consecutive regression limit", async () => {
        const report = await observePostShift(options, deps([
            health(), health(false), workload(503), metrics(false),
            health(), health(false), workload(503), metrics(false),
        ]));
        expect(report.gate.passed).toBe(false);
        expect(report.gate.completedSamples).toBe(2);
        expect(report.gate.reasons.join(" ")).toMatch(/consecutive failure limit 2/);
        expect(report.gate.reasons.join(" ")).toMatch(/metrics/);
    });

    it("fails on success-rate and latency regression without leaking transport errors", async () => {
        const report = await observePostShift({ ...options, samples: 2, consecutiveFailureLimit: 2, minSuccessRate: 1, workloadP95LimitMs: 1 }, deps([
            health(), health(), new Error("secret upstream failure"), metrics(),
            health(), health(), workload(), metrics(),
        ], 10));
        expect(report.gate.passed).toBe(false);
        expect(report.gate.reasons.join(" ")).toMatch(/success rate/);
        expect(report.gate.reasons.join(" ")).toMatch(/workload p95/);
        expect(JSON.stringify(report)).not.toContain("secret upstream failure");
    });

    it("never includes tokens or query strings in the report", async () => {
        const report = await observePostShift({ ...options, samples: 1, consecutiveFailureLimit: 1 }, deps([health(), health(), workload(), metrics()]));
        const serialized = JSON.stringify(report);
        expect(serialized).not.toContain("synthetic-token");
        expect(serialized).not.toContain("metrics-token");
        expect(serialized).not.toContain("limit=1");
    });

    it("rejects cross-origin, mutating, and unbounded observation configuration", async () => {
        await expect(observePostShift({ ...options, workloadPath: "//evil.example.test/cases" }, deps([]))).rejects.toThrow(/origin-relative/);
        await expect(observePostShift({ ...options, workloadMethod: "POST" as "GET" }, deps([]))).rejects.toThrow(/GET or HEAD/);
        await expect(observePostShift({ ...options, samples: 601 }, deps([]))).rejects.toThrow(/between 1 and 600/);
    });
});
