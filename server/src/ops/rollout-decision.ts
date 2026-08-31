import { validateCanaryBaseUrl } from "./canary-probe.js";

export interface RolloutDecisionOptions {
    candidateId: string;
    expectedTargetOrigin: string;
    currentTrafficPercent: number;
    nextTrafficPercent: number;
    rollbackTrafficPercent: number;
    maxEvidenceAgeMs: number;
    maxFutureSkewMs: number;
    requireCapacity: boolean;
    requireObservation: boolean;
    canaryReport: unknown;
    capacityReport?: unknown;
    observationReport?: unknown;
}

export interface RolloutDecisionReport {
    schemaVersion: 1;
    candidateId: string;
    evaluatedAt: string;
    expectedTargetOrigin: string;
    action: "promote" | "rollback";
    traffic: {
        fromPercent: number;
        toPercent: number;
        rollbackPercent: number;
    };
    evidence: {
        canaryAccepted: boolean;
        capacityRequired: boolean;
        capacityAccepted: boolean;
        observationRequired: boolean;
        observationAccepted: boolean;
    };
    reasons: string[];
}

export interface RolloutDecisionDependencies {
    now: () => Date;
}

const defaultDependencies: RolloutDecisionDependencies = { now: () => new Date() };

type JsonObject = Record<string, unknown>;

function object(value: unknown): JsonObject | undefined {
    return typeof value === "object" && value !== null && !Array.isArray(value) ? value as JsonObject : undefined;
}

function nested(value: unknown, key: string): JsonObject | undefined {
    return object(object(value)?.[key]);
}

function wholePercent(name: string, value: number): void {
    if (!Number.isInteger(value) || value < 0 || value > 100) throw new Error(`${name} must be a whole number between 0 and 100.`);
}

function validateOptions(options: RolloutDecisionOptions): URL {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/.test(options.candidateId)) {
        throw new Error("candidateId must be a non-secret release identifier containing only safe identifier characters.");
    }
    const target = validateCanaryBaseUrl(options.expectedTargetOrigin);
    wholePercent("currentTrafficPercent", options.currentTrafficPercent);
    wholePercent("nextTrafficPercent", options.nextTrafficPercent);
    wholePercent("rollbackTrafficPercent", options.rollbackTrafficPercent);
    if (options.nextTrafficPercent <= options.currentTrafficPercent) throw new Error("nextTrafficPercent must be greater than currentTrafficPercent.");
    if (options.rollbackTrafficPercent > options.currentTrafficPercent) throw new Error("rollbackTrafficPercent must not exceed currentTrafficPercent.");
    if (!Number.isInteger(options.maxEvidenceAgeMs) || options.maxEvidenceAgeMs < 1_000 || options.maxEvidenceAgeMs > 86_400_000) {
        throw new Error("maxEvidenceAgeMs must be a whole number between 1000 and 86400000.");
    }
    if (!Number.isInteger(options.maxFutureSkewMs) || options.maxFutureSkewMs < 0 || options.maxFutureSkewMs > 300_000) {
        throw new Error("maxFutureSkewMs must be a whole number between 0 and 300000.");
    }
    return target;
}

function evidenceTimeReason(
    label: string,
    completedAt: unknown,
    nowMs: number,
    maxAgeMs: number,
    maxFutureSkewMs: number
): string | undefined {
    if (typeof completedAt !== "string") return `${label} evidence has no valid completion timestamp`;
    const completedMs = Date.parse(completedAt);
    if (!Number.isFinite(completedMs)) return `${label} evidence has no valid completion timestamp`;
    if (completedMs < nowMs - maxAgeMs) return `${label} evidence is stale`;
    if (completedMs > nowMs + maxFutureSkewMs) return `${label} evidence is from the future`;
    return undefined;
}

function reportOrigin(value: unknown): string | undefined {
    if (typeof value !== "string") return undefined;
    try { return new URL(value).origin; }
    catch { return undefined; }
}

function inspectCanary(report: unknown, expectedOrigin: string, nowMs: number, options: RolloutDecisionOptions): string[] {
    const root = object(report);
    const summary = nested(report, "summary");
    if (!root || root.schemaVersion !== 1 || !summary || typeof summary.promoted !== "boolean") return ["canary evidence is malformed"];
    const reasons: string[] = [];
    if (reportOrigin(root.targetOrigin) !== expectedOrigin) reasons.push("canary evidence target does not match the candidate origin");
    const timeReason = evidenceTimeReason("canary", root.completedAt, nowMs, options.maxEvidenceAgeMs, options.maxFutureSkewMs);
    if (timeReason) reasons.push(timeReason);
    if (!summary.promoted) reasons.push("canary promotion gate failed");
    return reasons;
}

function inspectCapacity(report: unknown, expectedOrigin: string, nowMs: number, options: RolloutDecisionOptions): string[] {
    const root = object(report);
    const gate = nested(report, "gate");
    if (!root || root.schemaVersion !== 1 || !gate || typeof gate.passed !== "boolean") return ["capacity evidence is malformed"];
    const reasons: string[] = [];
    if (reportOrigin(root.target) !== expectedOrigin) reasons.push("capacity evidence target does not match the candidate origin");
    const timeReason = evidenceTimeReason("capacity", root.completedAt, nowMs, options.maxEvidenceAgeMs, options.maxFutureSkewMs);
    if (timeReason) reasons.push(timeReason);
    if (!gate.passed) reasons.push("capacity gate failed");
    return reasons;
}

function inspectObservation(report: unknown, expectedOrigin: string, nowMs: number, options: RolloutDecisionOptions): string[] {
    const root = object(report);
    const gate = nested(report, "gate");
    if (!root || root.schemaVersion !== 1 || !gate || typeof gate.passed !== "boolean") return ["observation evidence is malformed"];
    const reasons: string[] = [];
    if (reportOrigin(root.targetOrigin) !== expectedOrigin) reasons.push("observation evidence target does not match the candidate origin");
    const timeReason = evidenceTimeReason("observation", root.completedAt, nowMs, options.maxEvidenceAgeMs, options.maxFutureSkewMs);
    if (timeReason) reasons.push(timeReason);
    if (!gate.passed) reasons.push("post-shift observation gate failed");
    return reasons;
}

export function decideRollout(
    options: RolloutDecisionOptions,
    dependencies: Partial<RolloutDecisionDependencies> = {}
): RolloutDecisionReport {
    const target = validateOptions(options);
    const deps = { ...defaultDependencies, ...dependencies };
    const now = deps.now();
    if (!Number.isFinite(now.getTime())) throw new Error("now must return a valid date.");
    const reasons = inspectCanary(options.canaryReport, target.origin, now.getTime(), options);
    if (options.requireCapacity) reasons.push(...inspectCapacity(options.capacityReport, target.origin, now.getTime(), options));
    if (options.requireObservation) reasons.push(...inspectObservation(options.observationReport, target.origin, now.getTime(), options));
    const action = reasons.length === 0 ? "promote" : "rollback";

    return {
        schemaVersion: 1,
        candidateId: options.candidateId,
        evaluatedAt: now.toISOString(),
        expectedTargetOrigin: target.origin,
        action,
        traffic: {
            fromPercent: options.currentTrafficPercent,
            toPercent: action === "promote" ? options.nextTrafficPercent : options.rollbackTrafficPercent,
            rollbackPercent: options.rollbackTrafficPercent,
        },
        evidence: {
            canaryAccepted: !reasons.some((reason) => reason.startsWith("canary")),
            capacityRequired: options.requireCapacity,
            capacityAccepted: !options.requireCapacity || !reasons.some((reason) => reason.startsWith("capacity")),
            observationRequired: options.requireObservation,
            observationAccepted: !options.requireObservation || !reasons.some((reason) => reason.startsWith("observation") || reason.startsWith("post-shift")),
        },
        reasons,
    };
}
