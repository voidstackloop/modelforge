import type { AiOutput } from "@modelforge/contracts";
import type { TenantAiGatewayRepository } from "../store/ai-gateway-store.js";

/**
 * The "online"/production half of the clinical AI evaluation framework —
 * distinct from and complementary to runner.ts's offline golden-dataset
 * harness. runner.ts answers "does a candidate model/prompt pass a fixed
 * synthetic test suite before we let it serve traffic"; this module answers
 * "how is a model actually behaving in production, against real clinician
 * decisions" — no golden answers, no synthetic cases, just aggregated
 * signal already captured by the gateway itself: `AiOutput.abstained` and
 * `AiOutput.reviewStatus` (kept in sync with each output's `AiReview` by
 * the store — see ai-gateway-store.ts's own doc comment on that field).
 *
 * Deliberately NOT built: shadow traffic, canary rollout, or automatic
 * promotion/rollback — those need a request-routing layer this codebase
 * doesn't have (ai-gateway/provider-client.ts's own doc comment on
 * production-shaped-but-untested inference clients is the relevant
 * precedent for why that's a separate, larger piece of work, not bundled
 * in here). This module only observes and reports; it never changes what
 * traffic a model receives. See docs/CLINICAL_AI_EVALUATION.md.
 */

export interface ProductionQualitySnapshot {
    providerModelId: string;
    /** Open lower bound this snapshot's outputs were selected after
     * (exclusive), or undefined for "since the beginning of this tenant's
     * history with this model." */
    windowStart?: string;
    /** Open upper bound (inclusive `<=`), or undefined for "through now." */
    windowEnd?: string;
    outputCount: number;
    /** Of all outputs in the window — not just reviewed ones. A model that
     * abstains constantly is a real operational signal even before any
     * clinician has reviewed anything. */
    abstentionRate: number;
    /** Fraction of outputs that have received ANY clinician decision yet —
     * low values on an old-enough window are themselves a signal (a
     * review backlog, or a workflow nobody is actually using). */
    reviewedRate: number;
    unreviewedCount: number;
    /** The four rates below are of REVIEWED outputs only (denominator is
     * `outputCount - unreviewedCount`), since "what fraction of decided
     * cases were accepted" is the meaningful question — diluting it by
     * not-yet-reviewed outputs would make a simple review backlog look
     * like a quality drop. All four are 0 when nothing has been reviewed
     * yet, never a divide-by-zero NaN. */
    acceptanceRate: number;
    rejectionRate: number;
    correctionRate: number;
    escalationRate: number;
}

function safeRatio(numerator: number, denominator: number): number {
    return denominator === 0 ? 0 : numerator / denominator;
}

function snapshotFrom(providerModelId: string, outputs: AiOutput[], windowStart: string | undefined, windowEnd: string | undefined): ProductionQualitySnapshot {
    const outputCount = outputs.length;
    const abstained = outputs.filter((o) => o.abstained).length;
    const reviewed = outputs.filter((o) => o.reviewStatus !== "unreviewed");
    const decisionCount = (decision: AiOutput["reviewStatus"]) => outputs.filter((o) => o.reviewStatus === decision).length;
    return {
        providerModelId,
        windowStart,
        windowEnd,
        outputCount,
        abstentionRate: safeRatio(abstained, outputCount),
        reviewedRate: safeRatio(reviewed.length, outputCount),
        unreviewedCount: outputCount - reviewed.length,
        acceptanceRate: safeRatio(decisionCount("accepted"), reviewed.length),
        rejectionRate: safeRatio(decisionCount("rejected"), reviewed.length),
        correctionRate: safeRatio(decisionCount("corrected"), reviewed.length),
        escalationRate: safeRatio(decisionCount("escalated"), reviewed.length),
    };
}

/**
 * A single window's snapshot — `since` is an open lower bound
 * (`generatedAt > since`), matching listOutputsForProviderModel's own
 * convention. Undefined means the whole tenant history for this model.
 */
export async function computeProductionQualitySnapshot(repo: TenantAiGatewayRepository, providerModelId: string, since?: string): Promise<ProductionQualitySnapshot> {
    const outputs = await repo.listOutputsForProviderModel(providerModelId, since);
    return snapshotFrom(providerModelId, outputs, since, undefined);
}

export interface DriftThresholds {
    /** A rise in abstentionRate greater than this (current − baseline) alerts. */
    maxAbstentionRateIncrease: number;
    /** A drop in acceptanceRate greater than this (baseline − current) alerts. */
    maxAcceptanceRateDrop: number;
    /** A rise in rejectionRate greater than this alerts. */
    maxRejectionRateIncrease: number;
    /** A rise in escalationRate greater than this alerts — clinicians
     * escalating more often is one of the more safety-relevant signals
     * this can catch. */
    maxEscalationRateIncrease: number;
    /** Neither snapshot's outputCount may fall below this for a comparison
     * to be considered statistically meaningful at all — below it, drift
     * is reported as `insufficientData`, never a false alarm (or false
     * reassurance) from a handful of outputs. */
    minimumOutputCount: number;
}

export const DEFAULT_DRIFT_THRESHOLDS: DriftThresholds = {
    maxAbstentionRateIncrease: 0.15,
    maxAcceptanceRateDrop: 0.15,
    maxRejectionRateIncrease: 0.15,
    maxEscalationRateIncrease: 0.1,
    minimumOutputCount: 20,
};

export interface DriftReport {
    baseline: ProductionQualitySnapshot;
    current: ProductionQualitySnapshot;
    /** True only when both windows clear `minimumOutputCount` — a
     * necessary condition for `drifted` to mean anything. */
    sufficientData: boolean;
    drifted: boolean;
    alerts: string[];
}

/**
 * Compares two disjoint time windows for the same provider model —
 * `baselineSince` is the older window's open lower bound, `splitAt` is
 * where "baseline" ends and "current" begins (baseline: `generatedAt` in
 * `(baselineSince, splitAt]`; current: `generatedAt > splitAt`). One store
 * call (from `baselineSince` onward), partitioned client-side at `splitAt`
 * — avoids needing a second bounded-range store method for what is, so
 * far, this module's only caller of that shape.
 */
export async function detectProductionQualityDrift(
    repo: TenantAiGatewayRepository,
    providerModelId: string,
    baselineSince: string | undefined,
    splitAt: string,
    thresholds: DriftThresholds = DEFAULT_DRIFT_THRESHOLDS
): Promise<DriftReport> {
    const outputs = await repo.listOutputsForProviderModel(providerModelId, baselineSince);
    const baselineOutputs = outputs.filter((o) => o.generatedAt <= splitAt);
    const currentOutputs = outputs.filter((o) => o.generatedAt > splitAt);
    const baseline = snapshotFrom(providerModelId, baselineOutputs, baselineSince, splitAt);
    const current = snapshotFrom(providerModelId, currentOutputs, splitAt, undefined);

    const sufficientData = baseline.outputCount >= thresholds.minimumOutputCount && current.outputCount >= thresholds.minimumOutputCount;
    const alerts: string[] = [];
    if (sufficientData) {
        const abstentionRise = current.abstentionRate - baseline.abstentionRate;
        if (abstentionRise > thresholds.maxAbstentionRateIncrease) alerts.push(`abstention rate rose ${(abstentionRise * 100).toFixed(1)} points (${(baseline.abstentionRate * 100).toFixed(1)}% -> ${(current.abstentionRate * 100).toFixed(1)}%)`);
        const acceptanceDrop = baseline.acceptanceRate - current.acceptanceRate;
        if (acceptanceDrop > thresholds.maxAcceptanceRateDrop) alerts.push(`acceptance rate dropped ${(acceptanceDrop * 100).toFixed(1)} points (${(baseline.acceptanceRate * 100).toFixed(1)}% -> ${(current.acceptanceRate * 100).toFixed(1)}%)`);
        const rejectionRise = current.rejectionRate - baseline.rejectionRate;
        if (rejectionRise > thresholds.maxRejectionRateIncrease) alerts.push(`rejection rate rose ${(rejectionRise * 100).toFixed(1)} points (${(baseline.rejectionRate * 100).toFixed(1)}% -> ${(current.rejectionRate * 100).toFixed(1)}%)`);
        const escalationRise = current.escalationRate - baseline.escalationRate;
        if (escalationRise > thresholds.maxEscalationRateIncrease) alerts.push(`escalation rate rose ${(escalationRise * 100).toFixed(1)} points (${(baseline.escalationRate * 100).toFixed(1)}% -> ${(current.escalationRate * 100).toFixed(1)}%)`);
    }

    return { baseline, current, sufficientData, drifted: sufficientData && alerts.length > 0, alerts };
}
