import { describe, expect, it } from "vitest";
import { percentile, runCanaryProbe, validateCanaryBaseUrl, type CanaryProbeDependencies, type CanaryProbeOptions } from "./canary-probe.js";

const baseOptions: CanaryProbeOptions = {
    baseUrl: "https://canary.example.test",
    attempts: 3,
    requiredConsecutiveSuccesses: 3,
    intervalMs: 0,
    timeoutMs: 1_000,
    readyP95LimitMs: 100,
    requireMetrics: true,
};

function dependencies(responses: Array<Response | Error>, durations: number[] = []): CanaryProbeDependencies {
    let responseIndex = 0;
    let clock = 0;
    let durationIndex = 0;
    return {
        fetch: (async () => {
            const next = responses[responseIndex++];
            if (next instanceof Error) throw next;
            if (!next) throw new Error("missing fake response");
            return next;
        }) as typeof fetch,
        sleep: async () => undefined,
        now: () => {
            if (clock % 2 === 0) { clock += 1; return 0; }
            clock += 1; return durations[durationIndex++] ?? 10;
        },
        isoNow: () => "2026-08-30T00:00:00.000Z",
    };
}

const health = (status = 200, body = { status: "ok" }) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const metrics = (status = 200, body = "# HELP modelforge_up test\nmodelforge_up 1\n") => new Response(body, { status });

describe("canary promotion probe", () => {
    it("accepts HTTPS and loopback HTTP but rejects credentials and plaintext remote targets", () => {
        expect(validateCanaryBaseUrl("https://api.example.test/").origin).toBe("https://api.example.test");
        expect(validateCanaryBaseUrl("http://localhost:4000").origin).toBe("http://localhost:4000");
        expect(() => validateCanaryBaseUrl("http://api.example.test")).toThrow(/HTTPS/);
        expect(() => validateCanaryBaseUrl("https://user:secret@api.example.test")).toThrow(/credentials/);
    });

    it("calculates nearest-rank percentiles without mutating input", () => {
        const values = [30, 10, 20];
        expect(percentile(values, 0.95)).toBe(30);
        expect(values).toEqual([30, 10, 20]);
        expect(percentile([], 0.95)).toBeNull();
    });

    it("promotes only after consecutive live, ready, and metrics successes within p95", async () => {
        const report = await runCanaryProbe(baseOptions, dependencies([
            health(), health(), metrics(), health(), health(), metrics(), health(), health(), metrics(),
        ], [5, 20, 5, 5, 30, 5, 5, 40, 5]));
        expect(report.summary).toMatchObject({ promoted: true, finalConsecutiveSuccesses: 3, readyP95Ms: 40 });
        expect(report.targetOrigin).toBe("https://canary.example.test");
    });

    it("allows readiness warm-up failures only when the run finishes with enough consecutive successes", async () => {
        const report = await runCanaryProbe({ ...baseOptions, attempts: 4 }, dependencies([
            health(), health(503, { status: "degraded" }), metrics(),
            health(), health(), metrics(), health(), health(), metrics(), health(), health(), metrics(),
        ]));
        expect(report.summary.promoted).toBe(true);
        expect(report.summary.finalConsecutiveSuccesses).toBe(3);
    });

    it("fails promotion on liveness, metrics, final-consecutive, or latency violations", async () => {
        const report = await runCanaryProbe(baseOptions, dependencies([
            health(), health(), metrics(),
            health(500), health(), metrics(500, "no metrics"),
            health(), health(), metrics(),
        ], [5, 10, 5, 5, 10, 5, 5, 150, 5]));
        expect(report.summary.promoted).toBe(false);
        expect(report.summary.reasons.join(" ")).toMatch(/liveness/);
        expect(report.summary.reasons.join(" ")).toMatch(/metrics/);
        expect(report.summary.reasons.join(" ")).toMatch(/only 1 consecutive/);
        expect(report.summary.reasons.join(" ")).toMatch(/p95/);
    });

    it("never includes the metrics bearer token in the machine-readable report", async () => {
        const token = "top-secret-metrics-token";
        const report = await runCanaryProbe({ ...baseOptions, metricsToken: token }, dependencies([
            health(), health(), metrics(), health(), health(), metrics(), health(), health(), metrics(),
        ]));
        expect(JSON.stringify(report)).not.toContain(token);
    });
});
