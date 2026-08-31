import { readFile } from "node:fs/promises";
import { decideRollout, type RolloutDecisionOptions } from "./rollout-decision.js";

function integerEnv(name: string, fallback: number): number {
    const raw = process.env[name];
    if (raw === undefined || raw.trim() === "") return fallback;
    const value = Number(raw);
    if (!Number.isInteger(value)) throw new Error(`${name} must be a whole number.`);
    return value;
}

async function evidence(path: string): Promise<unknown> {
    try { return JSON.parse(await readFile(path, "utf8")); }
    catch { return undefined; }
}

async function main(): Promise<void> {
    const candidateId = process.env.RELEASE_CANDIDATE_ID;
    const expectedTargetOrigin = process.env.RELEASE_EXPECTED_ORIGIN;
    const canaryPath = process.env.RELEASE_CANARY_REPORT_FILE;
    if (!candidateId) throw new Error("RELEASE_CANDIDATE_ID is required.");
    if (!expectedTargetOrigin) throw new Error("RELEASE_EXPECTED_ORIGIN is required.");
    if (!canaryPath) throw new Error("RELEASE_CANARY_REPORT_FILE is required.");
    const requireCapacity = process.env.RELEASE_REQUIRE_CAPACITY !== "0";
    const capacityPath = process.env.RELEASE_CAPACITY_REPORT_FILE;
    const requireObservation = process.env.RELEASE_REQUIRE_OBSERVATION === "1";
    const observationPath = process.env.RELEASE_OBSERVATION_REPORT_FILE;
    const options: RolloutDecisionOptions = {
        candidateId,
        expectedTargetOrigin,
        currentTrafficPercent: integerEnv("RELEASE_CURRENT_TRAFFIC_PERCENT", 0),
        nextTrafficPercent: integerEnv("RELEASE_NEXT_TRAFFIC_PERCENT", 10),
        rollbackTrafficPercent: integerEnv("RELEASE_ROLLBACK_TRAFFIC_PERCENT", 0),
        maxEvidenceAgeMs: integerEnv("RELEASE_MAX_EVIDENCE_AGE_MS", 900_000),
        maxFutureSkewMs: integerEnv("RELEASE_MAX_FUTURE_SKEW_MS", 60_000),
        requireCapacity,
        requireObservation,
        canaryReport: await evidence(canaryPath),
        capacityReport: capacityPath ? await evidence(capacityPath) : undefined,
        observationReport: observationPath ? await evidence(observationPath) : undefined,
    };
    const report = decideRollout(options);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (report.action === "rollback") process.exitCode = 1;
}

main().catch((error) => {
    process.stderr.write(`Rollout decision configuration failed: ${error instanceof Error ? error.message : "unknown error"}\n`);
    process.exitCode = 2;
});
