import { describe, expect, it } from "vitest";
import { decideRollout, type RolloutDecisionOptions } from "./rollout-decision.js";

const NOW = new Date("2026-08-30T12:00:00.000Z");
const canary = (promoted = true, overrides: Record<string, unknown> = {}) => ({
    schemaVersion: 1,
    targetOrigin: "https://candidate.example.test",
    completedAt: "2026-08-30T11:59:30.000Z",
    summary: { promoted },
    ...overrides,
});
const capacity = (passed = true, overrides: Record<string, unknown> = {}) => ({
    schemaVersion: 1,
    target: "https://candidate.example.test/organizations/synthetic/cases",
    completedAt: "2026-08-30T11:59:40.000Z",
    gate: { passed },
    ...overrides,
});

const baseOptions: RolloutDecisionOptions = {
    candidateId: "server-2026.08.30-abc123",
    expectedTargetOrigin: "https://candidate.example.test",
    currentTrafficPercent: 10,
    nextTrafficPercent: 25,
    rollbackTrafficPercent: 0,
    maxEvidenceAgeMs: 300_000,
    maxFutureSkewMs: 30_000,
    requireCapacity: true,
    requireObservation: false,
    canaryReport: canary(),
    capacityReport: capacity(),
};

const deps = { now: () => NOW };

describe("rollout decision", () => {
    it("promotes to the next traffic stage only when all required evidence passes", () => {
        const report = decideRollout(baseOptions, deps);
        expect(report).toMatchObject({
            action: "promote",
            traffic: { fromPercent: 10, toPercent: 25, rollbackPercent: 0 },
            evidence: { canaryAccepted: true, capacityRequired: true, capacityAccepted: true },
            reasons: [],
        });
    });

    it("rolls back when either gate fails", () => {
        const report = decideRollout({ ...baseOptions, canaryReport: canary(false), capacityReport: capacity(false) }, deps);
        expect(report.action).toBe("rollback");
        expect(report.traffic.toPercent).toBe(0);
        expect(report.reasons).toEqual(["canary promotion gate failed", "capacity gate failed"]);
    });

    it("fails closed for missing or malformed required evidence", () => {
        const report = decideRollout({ ...baseOptions, canaryReport: undefined, capacityReport: { schemaVersion: 99 } }, deps);
        expect(report.action).toBe("rollback");
        expect(report.reasons).toEqual(["canary evidence is malformed", "capacity evidence is malformed"]);
    });

    it("rejects stale, future, and wrong-target evidence", () => {
        const report = decideRollout({
            ...baseOptions,
            canaryReport: canary(true, { targetOrigin: "https://other.example.test", completedAt: "2026-08-30T11:00:00.000Z" }),
            capacityReport: capacity(true, { completedAt: "2026-08-30T12:01:00.000Z" }),
        }, deps);
        expect(report.action).toBe("rollback");
        expect(report.reasons.join(" ")).toMatch(/canary evidence target/);
        expect(report.reasons.join(" ")).toMatch(/canary evidence is stale/);
        expect(report.reasons.join(" ")).toMatch(/capacity evidence is from the future/);
    });

    it("supports an explicitly canary-only decision", () => {
        const report = decideRollout({ ...baseOptions, requireCapacity: false, capacityReport: undefined }, deps);
        expect(report.action).toBe("promote");
        expect(report.evidence).toMatchObject({ capacityRequired: false, capacityAccepted: true });
    });

    it("requires fresh post-shift observation evidence when advancing a later stage", () => {
        const passingObservation = {
            schemaVersion: 1,
            targetOrigin: "https://candidate.example.test",
            completedAt: "2026-08-30T11:59:50.000Z",
            gate: { passed: true },
        };
        const promoted = decideRollout({ ...baseOptions, requireObservation: true, observationReport: passingObservation }, deps);
        expect(promoted.action).toBe("promote");
        expect(promoted.evidence).toMatchObject({ observationRequired: true, observationAccepted: true });

        const rolledBack = decideRollout({ ...baseOptions, requireObservation: true, observationReport: { ...passingObservation, gate: { passed: false } } }, deps);
        expect(rolledBack.action).toBe("rollback");
        expect(rolledBack.reasons).toContain("post-shift observation gate failed");
    });

    it("normalizes origins and never copies gate payloads or their secrets into output", () => {
        const report = decideRollout({
            ...baseOptions,
            expectedTargetOrigin: "https://candidate.example.test/",
            canaryReport: { ...canary(), secret: "canary-token" },
            capacityReport: { ...capacity(), requestBody: "synthetic-sensitive-body" },
        }, deps);
        expect(report.expectedTargetOrigin).toBe("https://candidate.example.test");
        expect(JSON.stringify(report)).not.toContain("canary-token");
        expect(JSON.stringify(report)).not.toContain("synthetic-sensitive-body");
    });

    it("rejects unsafe stage transitions and candidate identifiers", () => {
        expect(() => decideRollout({ ...baseOptions, nextTrafficPercent: 10 }, deps)).toThrow(/greater/);
        expect(() => decideRollout({ ...baseOptions, rollbackTrafficPercent: 11 }, deps)).toThrow(/must not exceed/);
        expect(() => decideRollout({ ...baseOptions, candidateId: "secret value with spaces" }, deps)).toThrow(/release identifier/);
    });
});
