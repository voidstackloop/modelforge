import { describe, expect, it } from "vitest";
import type { AiProvider, AiProviderModel, AiProviderTenantSettings } from "@modelforge/contracts";
import { MIN_QUALITY_SAMPLE_SIZE, rankEligibleProviderModels, type RoutingCandidate } from "./model-router.js";

const NOW = "2026-01-01T00:00:00.000Z";

function provider(overrides: Partial<AiProvider> = {}): AiProvider {
    return { id: "provider-1", name: "Local inference", kind: "local", killSwitchEngaged: false, operationalStatus: "active", createdAt: NOW, updatedAt: NOW, ...overrides };
}

function model(overrides: Partial<AiProviderModel> = {}): AiProviderModel {
    return {
        id: "model-1", providerId: "provider-1", modelId: "llama3", modelVersion: "3.1", intendedUse: "general",
        supportedDataTypes: ["text"], maxContextTokens: 8192, hostingRegion: "local", processingLocation: "local",
        phiPermitted: true, retainsPrompts: false, retainsOutputs: false, trainingUseAllowed: false, zeroRetentionSupport: true,
        approvals: { baaSigned: false, dpaSigned: false, contractualApproval: false, securityReviewApproval: false },
        encryptionInTransit: true, encryptionAtRest: true, validationStatus: "validated", safetyStatus: "nominal",
        approvedRoles: [], effectiveAt: NOW, createdAt: NOW, updatedAt: NOW,
        ...overrides,
    };
}

function settings(overrides: Partial<AiProviderTenantSettings> = {}): AiProviderTenantSettings {
    return { id: "settings-1", providerModelId: "model-1", enabled: true, phiAllowed: true, allowedRoles: [], approvedByUserId: "admin-1", approvedAt: NOW, ...overrides };
}

function candidate(overrides: { provider?: Partial<AiProvider>; model?: Partial<AiProviderModel>; settings?: Partial<AiProviderTenantSettings>; quality?: RoutingCandidate["quality"] } = {}): RoutingCandidate {
    const m = model(overrides.model);
    return { provider: provider({ id: m.providerId, ...overrides.provider }), model: m, settings: settings({ providerModelId: m.id, ...overrides.settings }), quality: overrides.quality };
}

describe("rankEligibleProviderModels — eligibility filtering", () => {
    const cases: Array<[string, RoutingCandidate]> = [
        ["a kill-switched provider", candidate({ provider: { killSwitchEngaged: true } })],
        ["a suspended provider", candidate({ provider: { operationalStatus: "suspended" } })],
        ["a tenant-disabled model", candidate({ settings: { enabled: false } })],
        ["a retired model", candidate({ model: { retiredAt: "2020-01-01T00:00:00.000Z" } })],
        ["an unvalidated model", candidate({ model: { validationStatus: "unvalidated" } })],
        ["a deprecated model", candidate({ model: { validationStatus: "deprecated" } })],
        ["a shadow model", candidate({ model: { validationStatus: "shadow" } })],
        ["a safety-disabled model", candidate({ model: { safetyStatus: "disabled" } })],
        ["a safety-restricted model", candidate({ model: { safetyStatus: "restricted" } })],
        ["a model that doesn't support text at all", candidate({ model: { supportedDataTypes: ["image"] } })],
    ];
    it.each(cases)("excludes %s", (_label, one) => {
        expect(rankEligibleProviderModels([one], { requiresPhi: false, callerRoles: [], now: NOW })).toEqual([]);
    });

    it("excludes a model whose catalog phiPermitted is false when the request requires PHI, even if tenant settings allow it", () => {
        const c = candidate({ model: { phiPermitted: false }, settings: { phiAllowed: true } });
        expect(rankEligibleProviderModels([c], { requiresPhi: true, callerRoles: [], now: NOW })).toEqual([]);
    });

    it("excludes a model whose tenant settings disallow PHI, even if the catalog permits it — effective permission is the AND of both", () => {
        const c = candidate({ model: { phiPermitted: true }, settings: { phiAllowed: false } });
        expect(rankEligibleProviderModels([c], { requiresPhi: true, callerRoles: [], now: NOW })).toEqual([]);
    });

    it("does NOT require PHI permission when the request itself carries no identifiers", () => {
        const c = candidate({ model: { phiPermitted: false }, settings: { phiAllowed: false } });
        expect(rankEligibleProviderModels([c], { requiresPhi: false, callerRoles: [], now: NOW })).toHaveLength(1);
    });

    it("excludes a model restricted to specific roles when the caller has none of them, but includes it when the caller does", () => {
        const c = candidate({ settings: { allowedRoles: ["radiology-group"] } });
        expect(rankEligibleProviderModels([c], { requiresPhi: false, callerRoles: ["primary-care-group"], now: NOW })).toEqual([]);
        expect(rankEligibleProviderModels([c], { requiresPhi: false, callerRoles: ["radiology-group"], now: NOW })).toHaveLength(1);
    });

    it("includes a model with no allowedRoles restriction regardless of caller roles", () => {
        const c = candidate({ settings: { allowedRoles: [] } });
        expect(rankEligibleProviderModels([c], { requiresPhi: false, callerRoles: [], now: NOW })).toHaveLength(1);
    });
});

describe("rankEligibleProviderModels — ranking", () => {
    it("ranks a validated model ahead of an equally-eligible canary model", () => {
        const validated = candidate({ model: { id: "m-validated", validationStatus: "validated" }, settings: { providerModelId: "m-validated" } });
        const canary = candidate({ model: { id: "m-canary", validationStatus: "canary" }, settings: { providerModelId: "m-canary" } });
        const ranked = rankEligibleProviderModels([canary, validated], { requiresPhi: false, callerRoles: [], now: NOW });
        expect(ranked.map((r) => r.model.id)).toEqual(["m-validated", "m-canary"]);
    });

    it("ranks local/on-premises hosting ahead of tenant-managed/cloud, all else equal", () => {
        const cloud = candidate({ provider: { id: "p-cloud", kind: "cloud" }, model: { id: "m-cloud", providerId: "p-cloud" }, settings: { providerModelId: "m-cloud" } });
        const local = candidate({ provider: { id: "p-local", kind: "local" }, model: { id: "m-local", providerId: "p-local" }, settings: { providerModelId: "m-local" } });
        const ranked = rankEligibleProviderModels([cloud, local], { requiresPhi: false, callerRoles: [], now: NOW });
        expect(ranked.map((r) => r.model.id)).toEqual(["m-local", "m-cloud"]);
    });

    it("ranks lower combined cost-per-token ahead of higher, among equally-eligible cloud models", () => {
        const expensive = candidate({ provider: { id: "p-cloud", kind: "cloud" }, model: { id: "m-expensive", providerId: "p-cloud", costPerInputTokenUsd: 0.01, costPerOutputTokenUsd: 0.03 }, settings: { providerModelId: "m-expensive" } });
        const cheap = candidate({ provider: { id: "p-cloud", kind: "cloud" }, model: { id: "m-cheap", providerId: "p-cloud", costPerInputTokenUsd: 0.001, costPerOutputTokenUsd: 0.002 }, settings: { providerModelId: "m-cheap" } });
        const ranked = rankEligibleProviderModels([expensive, cheap], { requiresPhi: false, callerRoles: [], now: NOW });
        expect(ranked.map((r) => r.model.id)).toEqual(["m-cheap", "m-expensive"]);
    });

    it("treats missing cost fields as 0 (the common 'this is free because it's ours' local-model case), not as unknown/worst-case", () => {
        const untracked = candidate({ model: { id: "m-untracked" }, settings: { providerModelId: "m-untracked" } }); // no cost fields set
        const pricedCheap = candidate({ model: { id: "m-priced", costPerInputTokenUsd: 0.5, costPerOutputTokenUsd: 0.5 }, settings: { providerModelId: "m-priced" } });
        const ranked = rankEligibleProviderModels([pricedCheap, untracked], { requiresPhi: false, callerRoles: [], now: NOW });
        expect(ranked.map((r) => r.model.id)).toEqual(["m-untracked", "m-priced"]);
    });

    it("breaks a total tie deterministically by model id", () => {
        const b = candidate({ model: { id: "model-b" }, settings: { providerModelId: "model-b" } });
        const a = candidate({ model: { id: "model-a" }, settings: { providerModelId: "model-a" } });
        expect(rankEligibleProviderModels([b, a], { requiresPhi: false, callerRoles: [], now: NOW }).map((r) => r.model.id)).toEqual(["model-a", "model-b"]);
    });

    it("returns an empty array, never throws, when nothing is eligible", () => {
        const c = candidate({ settings: { enabled: false } });
        expect(rankEligibleProviderModels([c], { requiresPhi: false, callerRoles: [], now: NOW })).toEqual([]);
    });
});

describe("rankEligibleProviderModels — quality-aware ranking (production telemetry)", () => {
    function withQuality(id: string, quality: RoutingCandidate["quality"]): RoutingCandidate {
        return { ...candidate({ model: { id }, settings: { providerModelId: id } }), quality };
    }

    it("ranks a model with a good recent acceptance rate ahead of one with a poor rate, both well-sampled", () => {
        const good = withQuality("m-good", { acceptanceRate: 0.95, reviewedCount: MIN_QUALITY_SAMPLE_SIZE });
        const poor = withQuality("m-poor", { acceptanceRate: 0.2, reviewedCount: MIN_QUALITY_SAMPLE_SIZE });
        expect(rankEligibleProviderModels([poor, good], { requiresPhi: false, callerRoles: [] }).map((r) => r.model.id)).toEqual(["m-good", "m-poor"]);
    });

    it("ranks a fair acceptance rate between good and poor", () => {
        const good = withQuality("m-good", { acceptanceRate: 0.95, reviewedCount: MIN_QUALITY_SAMPLE_SIZE });
        const fair = withQuality("m-fair", { acceptanceRate: 0.65, reviewedCount: MIN_QUALITY_SAMPLE_SIZE });
        const poor = withQuality("m-poor", { acceptanceRate: 0.2, reviewedCount: MIN_QUALITY_SAMPLE_SIZE });
        expect(rankEligibleProviderModels([poor, good, fair], { requiresPhi: false, callerRoles: [] }).map((r) => r.model.id)).toEqual(["m-good", "m-fair", "m-poor"]);
    });

    it("treats a poor rate with too little sample data as neutral, never penalizing a newly-approved model for lacking history", () => {
        const untested = withQuality("m-untested", { acceptanceRate: 0.1, reviewedCount: MIN_QUALITY_SAMPLE_SIZE - 1 });
        const good = withQuality("m-good", { acceptanceRate: 0.95, reviewedCount: MIN_QUALITY_SAMPLE_SIZE });
        // Both rank as "tier 0" (neutral/good) — tie-broken by model id, not by the untested one's (statistically meaningless) low raw rate.
        expect(rankEligibleProviderModels([good, untested], { requiresPhi: false, callerRoles: [] }).map((r) => r.model.id)).toEqual(["m-good", "m-untested"]);
    });

    it("treats a candidate with no quality signal at all (undefined) the same as neutral", () => {
        const noSignal = candidate({ model: { id: "m-no-signal" }, settings: { providerModelId: "m-no-signal" } });
        const poor = withQuality("m-poor", { acceptanceRate: 0.1, reviewedCount: MIN_QUALITY_SAMPLE_SIZE });
        expect(rankEligibleProviderModels([poor, noSignal], { requiresPhi: false, callerRoles: [] }).map((r) => r.model.id)).toEqual(["m-no-signal", "m-poor"]);
    });

    it("quality outranks hosting/cost preference — a well-sampled poor local model ranks behind a well-sampled good cloud model", () => {
        const poorLocal = candidate({ model: { id: "m-poor-local" }, settings: { providerModelId: "m-poor-local" }, quality: { acceptanceRate: 0.1, reviewedCount: MIN_QUALITY_SAMPLE_SIZE } });
        const goodCloud = candidate({
            provider: { id: "p-cloud", kind: "cloud" },
            model: { id: "m-good-cloud", providerId: "p-cloud" },
            settings: { providerModelId: "m-good-cloud" },
            quality: { acceptanceRate: 0.95, reviewedCount: MIN_QUALITY_SAMPLE_SIZE },
        });
        const ranked = rankEligibleProviderModels([poorLocal, goodCloud], { requiresPhi: false, callerRoles: [] });
        expect(ranked.map((r) => r.model.id)).toEqual(["m-good-cloud", "m-poor-local"]);
    });

    it("quality never overrides validation status — a well-sampled good canary model still ranks behind a validated one with no data", () => {
        const validatedNoData = candidate({ model: { id: "m-validated", validationStatus: "validated" }, settings: { providerModelId: "m-validated" } });
        const goodCanary = withQuality("m-canary", { acceptanceRate: 1, reviewedCount: MIN_QUALITY_SAMPLE_SIZE });
        const canaryCandidate = { ...goodCanary, model: { ...goodCanary.model, validationStatus: "canary" as const } };
        expect(rankEligibleProviderModels([canaryCandidate, validatedNoData], { requiresPhi: false, callerRoles: [] }).map((r) => r.model.id)).toEqual(["m-validated", "m-canary"]);
    });
});
