import type { AiProvider, AiProviderModel, AiProviderTenantSettings } from "@modelforge/contracts";

/**
 * Multi-model routing — closes the gap the ClinicalAiGateway audit found:
 * "routing is caller-selected: the request supplies providerModelId
 * explicitly; there's no runtime load-balancing, fallback, or cost/latency-
 * based auto-routing across providers." This module is the pure
 * filter+rank half of that; gateway.ts's submitRequest owns the actual
 * fallback-on-failure loop (trying ranked candidates in order until one
 * succeeds), since only it has the request lifecycle to retry.
 *
 * `rankEligibleProviderModels` never widens what evaluateGatewayAuthorization
 * (policy.ts) itself enforces — it is a pre-filter to avoid wasting an
 * attempt on an obviously-ineligible model, not a replacement for that real
 * authorization check, which gateway.ts still runs per attempt regardless
 * of how a candidate was chosen.
 *
 * Deliberately NOT implemented: true request-time load balancing across
 * concurrent traffic (this only ranks a static snapshot of catalog/settings
 * state per call, with no notion of current load), and latency-based
 * ranking (no latency telemetry is tracked anywhere in this codebase yet).
 *
 * Quality-aware ranking (`QualitySignal` below) DOES factor in
 * eval-harness/production-monitor.ts's real acceptance-rate telemetry — a
 * candidate with a poor recent clinician acceptance rate ranks behind an
 * otherwise-equal one with a good rate, ahead of hosting/cost preference
 * (a safety signal outranks a cost preference), but never ahead of
 * validation status (an unvalidated/deprecated model was already filtered
 * out by `isEligible` regardless of how well it happens to score). A
 * candidate with too little review history to trust (below
 * `MIN_QUALITY_SAMPLE_SIZE`) is treated as neutral, never penalized — a
 * newly-approved model isn't unfairly starved of traffic just for lacking
 * a track record yet.
 */

export interface RoutingCandidate {
    provider: AiProvider;
    model: AiProviderModel;
    settings: AiProviderTenantSettings;
    /** Real production telemetry for this model (gateway.ts's
     * gatherRoutingCandidates populates this from
     * eval-harness/production-monitor.ts's computeProductionQualitySnapshot).
     * Undefined — never fetched, e.g. a caller that doesn't have a
     * TenantAiGatewayRepository handy — is treated exactly like "too
     * little data," never as ineligible. */
    quality?: QualitySignal;
}

export interface QualitySignal {
    /** Fraction of REVIEWED outputs accepted — meaningless (and ignored)
     * below `MIN_QUALITY_SAMPLE_SIZE` reviews, matching production-
     * monitor.ts's own "acceptanceRate is of reviewed outputs only" design. */
    acceptanceRate: number;
    /** How many reviewed outputs `acceptanceRate` is actually computed
     * over — production-monitor.ts's `outputCount - unreviewedCount`, NOT
     * its raw `outputCount` (a model with 500 outputs and 2 reviews has 2
     * data points, not 500). */
    reviewedCount: number;
}

export interface RoutingCriteria {
    /** True when the request's minimized data includes identifiers
     * (gateway.ts's own `includesIdentifiers`) — gates on the same
     * `model.phiPermitted && settings.phiAllowed` AND policy.ts's real
     * evaluateGatewayAuthorization enforces, just pre-filtered here. */
    requiresPhi: boolean;
    callerRoles: string[];
    /** ISO timestamp to evaluate `retiredAt`/expiry-shaped fields against —
     * defaults to `new Date().toISOString()`; overridable only for
     * deterministic tests. */
    now?: string;
}

export interface RankedCandidate extends RoutingCandidate {
    /** Lower ranks first. Exposed for test introspection and logging, not
     * meant to be interpreted as a normalized score across calls. */
    rank: readonly [validationTier: number, qualityTier: number, hostingTier: number, costUsdPerThousandTokens: number, modelId: string];
}

const VALIDATION_TIER: Partial<Record<AiProviderModel["validationStatus"], number>> = { validated: 0, canary: 1 };
const HOSTING_TIER: Record<AiProvider["kind"], number> = { local: 0, "on-premises": 1, "tenant-managed": 2, cloud: 3 };

/** Below this many reviewed outputs, a model's acceptanceRate is treated as
 * statistically unreliable — the same floor eval-harness/production-
 * monitor.ts's own drift detection uses (DEFAULT_DRIFT_THRESHOLDS.
 * minimumOutputCount) for the identical reason: a couple of data points
 * proves nothing about a model's real behavior. */
export const MIN_QUALITY_SAMPLE_SIZE = 20;
const POOR_ACCEPTANCE_THRESHOLD = 0.5;
const FAIR_ACCEPTANCE_THRESHOLD = 0.8;

/** 0 = good or unknown (neutral — never penalize missing data), 1 = fair,
 * 2 = poor. Bucketed rather than a raw float specifically so two models
 * with statistically indistinguishable acceptance rates (e.g. 91% vs 89%)
 * don't get reordered on noise — only a real, sizeable quality difference
 * changes rank. */
function qualityTier(quality: QualitySignal | undefined): number {
    if (!quality || quality.reviewedCount < MIN_QUALITY_SAMPLE_SIZE) return 0;
    if (quality.acceptanceRate >= FAIR_ACCEPTANCE_THRESHOLD) return 0;
    if (quality.acceptanceRate >= POOR_ACCEPTANCE_THRESHOLD) return 1;
    return 2;
}

function isEligible(candidate: RoutingCandidate, criteria: RoutingCriteria, now: string): boolean {
    const { provider, model, settings } = candidate;
    if (provider.killSwitchEngaged) return false;
    if (provider.operationalStatus !== "active") return false;
    if (!settings.enabled) return false;
    if (model.retiredAt && model.retiredAt <= now) return false;
    if (!(model.validationStatus in VALIDATION_TIER)) return false; // excludes unvalidated/deprecated
    if (model.safetyStatus !== "nominal") return false;
    if (!model.supportedDataTypes.includes("text")) return false; // this gateway only ever sends text sections (data-minimization.ts)
    if (criteria.requiresPhi && !(model.phiPermitted && settings.phiAllowed)) return false;
    if (settings.allowedRoles.length > 0 && !criteria.callerRoles.some((role) => settings.allowedRoles.includes(role))) return false;
    return true;
}

/** Cost per 1,000 combined input+output tokens — a single comparable unit
 * across models with different input/output pricing. Missing pricing
 * (typical for a `local`/`on-premises` model, which usually has no
 * per-token billing at all) is treated as 0, not as unknown/worst-case —
 * the common real case is "this is free because it's ours," not "we don't
 * know the price of this cloud model." A cloud model that genuinely hasn't
 * had pricing entered yet will rank ahead of priced peers until an
 * operator fills it in; that is a data-completeness problem for the
 * catalog to fix, not something this function should paper over by
 * guessing a "worst case" price. */
function costPerThousandTokens(model: AiProviderModel): number {
    return ((model.costPerInputTokenUsd ?? 0) + (model.costPerOutputTokenUsd ?? 0)) * 1_000;
}

/**
 * Filters to eligible candidates (see `isEligible`) and ranks them, in
 * order of precedence: validated before canary; a good/unknown recent
 * clinician-acceptance rate before a merely fair one before a poor one
 * (see `qualityTier`); local/on-premises before tenant-managed/cloud
 * (prefer keeping data closest to home, all else equal); lower combined
 * cost first; deterministic model-id tie-break last. Returns an empty
 * array — never throws — when nothing is eligible; the caller decides what
 * that means (gateway.ts reports it as a distinct `no-eligible-provider-
 * model` outcome, never silently falls back to an ineligible model).
 */
export function rankEligibleProviderModels(candidates: RoutingCandidate[], criteria: RoutingCriteria): RankedCandidate[] {
    const now = criteria.now ?? new Date().toISOString();
    return candidates
        .filter((c) => isEligible(c, criteria, now))
        .map((c) => ({ ...c, rank: [VALIDATION_TIER[c.model.validationStatus]!, qualityTier(c.quality), HOSTING_TIER[c.provider.kind], costPerThousandTokens(c.model), c.model.id] as const }))
        .sort((a, b) => a.rank[0] - b.rank[0] || a.rank[1] - b.rank[1] || a.rank[2] - b.rank[2] || a.rank[3] - b.rank[3] || a.rank[4].localeCompare(b.rank[4]));
}
