import { describe, expect, it } from "vitest";
import { runCapacityTest, validateCapacityTarget, type CapacityRunDependencies, type CapacityRunOptions } from "./capacity-runner.js";

const baseOptions: CapacityRunOptions = {
    targetUrl: "http://localhost:4000/health/ready?synthetic=1",
    method: "GET",
    concurrency: 2,
    durationMs: 10_000,
    maxRequests: 4,
    timeoutMs: 1_000,
    minCompletedRequests: 4,
    minSuccessRate: 1,
    minRequestsPerSecond: 1,
    maxP95Ms: 100,
    allowRemote: false,
    allowWrites: false,
};

function dependencies(responses: Array<Response | Error>, latencyMs = 10): CapacityRunDependencies {
    let index = 0;
    let clock = 0;
    return {
        fetch: (async (_input, init) => {
            expect(init?.signal).toBeInstanceOf(AbortSignal);
            const next = responses[index++];
            if (next instanceof Error) throw next;
            if (!next) throw new Error("missing fake response");
            return next;
        }) as typeof fetch,
        now: () => {
            clock += latencyMs;
            return clock;
        },
        isoNow: () => "2026-08-30T00:00:00.000Z",
    };
}

describe("capacity gate", () => {
    it("allows loopback by default and requires explicit opt-in plus HTTPS for remote targets", () => {
        expect(validateCapacityTarget("http://localhost:4000/health", false).origin).toBe("http://localhost:4000");
        expect(() => validateCapacityTarget("https://api.example.test/health", false)).toThrow(/LOAD_ALLOW_REMOTE/);
        expect(validateCapacityTarget("https://api.example.test/health", true).origin).toBe("https://api.example.test");
        expect(() => validateCapacityTarget("http://api.example.test/health", true)).toThrow(/HTTPS/);
        expect(() => validateCapacityTarget("https://user:secret@api.example.test", true)).toThrow(/credentials/);
    });

    it("passes a bounded run and reports percentiles, throughput, and status counts", async () => {
        const report = await runCapacityTest(baseOptions, dependencies([
            new Response(null, { status: 200 }), new Response(null, { status: 204 }),
            new Response(null, { status: 200 }), new Response(null, { status: 200 }),
        ]));
        expect(report.gate.passed).toBe(true);
        expect(report.results).toMatchObject({ completedRequests: 4, successfulRequests: 4, failedRequests: 0 });
        expect(report.results.latencyMs.p95).toBeGreaterThan(0);
        expect(report.results.requestsPerSecond).toBeGreaterThan(1);
        expect(report.results.statusCounts).toEqual({ "200": 3, "204": 1 });
        expect(report.target).toBe("http://localhost:4000/health/ready");
    });

    it("fails on HTTP errors, transport errors, and unmet thresholds", async () => {
        const report = await runCapacityTest({ ...baseOptions, minSuccessRate: 0.9, minRequestsPerSecond: 1_000, maxP95Ms: 1 }, dependencies([
            new Response(null, { status: 200 }), new Response(null, { status: 503 }),
            new Error("secret upstream detail"), new Response(null, { status: 200 }),
        ]));
        expect(report.gate.passed).toBe(false);
        expect(report.results).toMatchObject({ completedRequests: 4, successfulRequests: 2, failedRequests: 2 });
        expect(report.results.errorCounts).toEqual({ http_error: 1, request_failed: 1 });
        expect(report.gate.reasons.join(" ")).toMatch(/success rate/);
        expect(report.gate.reasons.join(" ")).toMatch(/throughput/);
        expect(report.gate.reasons.join(" ")).toMatch(/p95/);
        expect(JSON.stringify(report)).not.toContain("secret upstream detail");
    });

    it("rejects write load without a second opt-in and rejects bodies on reads", async () => {
        await expect(runCapacityTest({ ...baseOptions, method: "POST" }, dependencies([]))).rejects.toThrow(/LOAD_ALLOW_WRITES/);
        await expect(runCapacityTest({ ...baseOptions, body: "{}" }, dependencies([]))).rejects.toThrow(/not allowed/);
    });

    it("sends authentication and a body without including either in its report", async () => {
        const token = "synthetic-secret-token";
        const body = JSON.stringify({ synthetic: "patient-like-but-not-phi" });
        let observed: RequestInit | undefined;
        const deps = dependencies([new Response(null, { status: 201 })]);
        deps.fetch = (async (_input, init) => { observed = init; return new Response(null, { status: 201 }); }) as typeof fetch;
        const report = await runCapacityTest({
            ...baseOptions,
            targetUrl: "https://api.example.test/organizations/synthetic/cases",
            method: "POST",
            concurrency: 1,
            maxRequests: 1,
            minCompletedRequests: 1,
            allowRemote: true,
            allowWrites: true,
            bearerToken: token,
            body,
        }, deps);
        expect(observed?.headers).toMatchObject({ Authorization: `Bearer ${token}`, "Content-Type": "application/json" });
        expect(observed?.body).toBe(body);
        expect(JSON.stringify(report)).not.toContain(token);
        expect(JSON.stringify(report)).not.toContain("patient-like-but-not-phi");
    });

    it("enforces hard upper bounds before issuing requests", async () => {
        await expect(runCapacityTest({ ...baseOptions, concurrency: 257 }, dependencies([]))).rejects.toThrow(/between 1 and 256/);
        await expect(runCapacityTest({ ...baseOptions, durationMs: 1_800_001 }, dependencies([]))).rejects.toThrow(/durationMs/);
        await expect(runCapacityTest({ ...baseOptions, maxRequests: 1_000_001 }, dependencies([]))).rejects.toThrow(/maxRequests/);
    });
});
