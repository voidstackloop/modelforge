import { describe, expect, it } from "vitest";
import { evaluateGatewayAuthorization, type GatewayAuthorizationInput } from "./policy.js";
import type { AiConsent, AiProvider, AiProviderModel, AiProviderTenantSettings } from "@modelforge/contracts";

function baseConsent(overrides: Partial<AiConsent> = {}): AiConsent {
    return {
        id: "consent-1", patientCaseId: "case-1", version: 1, purpose: "treatment",
        dataCategories: ["notes", "labs"], status: "active",
        grantedByUserId: "u1", grantedAt: new Date().toISOString(),
        ...overrides,
    };
}

function baseProvider(overrides: Partial<AiProvider> = {}): AiProvider {
    return {
        id: "provider-1", name: "Test Provider", kind: "local",
        killSwitchEngaged: false, operationalStatus: "active",
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
        ...overrides,
    };
}

function baseModel(overrides: Partial<AiProviderModel> = {}): AiProviderModel {
    return {
        id: "model-1", providerId: "provider-1", modelId: "m", modelVersion: "1",
        intendedUse: "summarization", supportedDataTypes: ["text"], maxContextTokens: 8192,
        hostingRegion: "local", processingLocation: "local",
        phiPermitted: false, retainsPrompts: false, retainsOutputs: false, trainingUseAllowed: false, zeroRetentionSupport: false,
        approvals: { baaSigned: false, dpaSigned: false, contractualApproval: false, securityReviewApproval: false },
        encryptionInTransit: true, encryptionAtRest: true,
        validationStatus: "validated", safetyStatus: "nominal", approvedRoles: [],
        effectiveAt: new Date().toISOString(), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
        ...overrides,
    };
}

function baseTenantSettings(overrides: Partial<AiProviderTenantSettings> = {}): AiProviderTenantSettings {
    return { id: "settings-1", providerModelId: "model-1", enabled: true, phiAllowed: false, allowedRoles: [], approvedByUserId: "admin-1", approvedAt: new Date().toISOString(), ...overrides };
}

function baseInput(overrides: Partial<GatewayAuthorizationInput> = {}): GatewayAuthorizationInput {
    return {
        purposeOfUse: "summarization", consentPurpose: "treatment", dataCategories: ["notes"],
        includesIdentifiers: false, callerRoles: ["clinician"], caseHasAiConsentScope: true,
        consent: baseConsent(), provider: baseProvider(), providerModel: baseModel(), tenantSettings: baseTenantSettings(),
        ...overrides,
    };
}

describe("evaluateGatewayAuthorization", () => {
    it("allows a de-identified request against an approved, enabled model", () => {
        const result = evaluateGatewayAuthorization(baseInput());
        expect(result.allowed).toBe(true);
    });

    it("denies when the patient case has no AI-assistance consent scope at all — the cheap first gate", () => {
        const result = evaluateGatewayAuthorization(baseInput({ caseHasAiConsentScope: false }));
        expect(result).toMatchObject({ allowed: false, reason: "case-consent-scope-missing" });
    });

    it("denies when there is no active consent record", () => {
        const result = evaluateGatewayAuthorization(baseInput({ consent: null }));
        expect(result).toMatchObject({ allowed: false, reason: "no-active-consent" });
    });

    it("denies when the consent doesn't cover a requested data category", () => {
        const result = evaluateGatewayAuthorization(baseInput({ dataCategories: ["notes", "imaging"], consent: baseConsent({ dataCategories: ["notes"] }) }));
        expect(result).toMatchObject({ allowed: false, reason: "consent-data-categories-insufficient" });
    });

    it("denies when the model is not found in the catalog", () => {
        const result = evaluateGatewayAuthorization(baseInput({ providerModel: null }));
        expect(result).toMatchObject({ allowed: false, reason: "provider-model-not-found" });
    });

    it("denies when the provider row itself is missing from the catalog", () => {
        const result = evaluateGatewayAuthorization(baseInput({ provider: null }));
        expect(result).toMatchObject({ allowed: false, reason: "provider-model-not-found" });
    });

    it("denies every model under a provider whose kill switch is engaged, even if the model row itself looks healthy", () => {
        const result = evaluateGatewayAuthorization(baseInput({ provider: baseProvider({ killSwitchEngaged: true, killSwitchReason: "Suspected data exfiltration" }) }));
        expect(result).toMatchObject({ allowed: false, reason: "provider-kill-switch-engaged" });
        if (!result.allowed) expect(result.message).toContain("Suspected data exfiltration");
    });

    it("denies when the provider's own operational status is suspended or retired", () => {
        expect(evaluateGatewayAuthorization(baseInput({ provider: baseProvider({ operationalStatus: "suspended" }) }))).toMatchObject({ allowed: false, reason: "provider-not-active" });
        expect(evaluateGatewayAuthorization(baseInput({ provider: baseProvider({ operationalStatus: "retired" }) }))).toMatchObject({ allowed: false, reason: "provider-not-active" });
    });

    it("allows a provider with operational status 'degraded' — a soft signal, not a block", () => {
        const result = evaluateGatewayAuthorization(baseInput({ provider: baseProvider({ operationalStatus: "degraded" }) }));
        expect(result.allowed).toBe(true);
    });

    it("denies a retired model", () => {
        const result = evaluateGatewayAuthorization(baseInput({ providerModel: baseModel({ retiredAt: new Date().toISOString() }) }));
        expect(result).toMatchObject({ allowed: false, reason: "provider-model-retired" });
    });

    it("denies a model with safety status 'disabled' or 'restricted'", () => {
        expect(evaluateGatewayAuthorization(baseInput({ providerModel: baseModel({ safetyStatus: "disabled" }) }))).toMatchObject({ allowed: false, reason: "model-safety-restricted" });
        expect(evaluateGatewayAuthorization(baseInput({ providerModel: baseModel({ safetyStatus: "restricted" }) }))).toMatchObject({ allowed: false, reason: "model-safety-restricted" });
    });

    it("allows safety status 'watch' — a soft signal, not a block", () => {
        const result = evaluateGatewayAuthorization(baseInput({ providerModel: baseModel({ safetyStatus: "watch" }) }));
        expect(result.allowed).toBe(true);
    });

    it("denies a deprecated model", () => {
        const result = evaluateGatewayAuthorization(baseInput({ providerModel: baseModel({ validationStatus: "deprecated" }) }));
        expect(result).toMatchObject({ allowed: false, reason: "model-not-validated-for-clinical-use" });
    });

    it("denies when the tenant has no approval row, or has disabled it", () => {
        expect(evaluateGatewayAuthorization(baseInput({ tenantSettings: null }))).toMatchObject({ allowed: false, reason: "provider-not-approved-for-tenant" });
        expect(evaluateGatewayAuthorization(baseInput({ tenantSettings: baseTenantSettings({ enabled: false }) }))).toMatchObject({ allowed: false, reason: "provider-not-approved-for-tenant" });
    });

    it("denies when the tenant restricts the model to roles the caller doesn't have", () => {
        const result = evaluateGatewayAuthorization(baseInput({ callerRoles: ["nurse"], tenantSettings: baseTenantSettings({ allowedRoles: ["physician"] }) }));
        expect(result).toMatchObject({ allowed: false, reason: "role-not-approved" });
    });

    it("allows when the caller's role is in the tenant's allowedRoles list", () => {
        const result = evaluateGatewayAuthorization(baseInput({ callerRoles: ["physician", "clinician"], tenantSettings: baseTenantSettings({ allowedRoles: ["physician"] }) }));
        expect(result.allowed).toBe(true);
    });

    describe("PHI transmission (item: 'default to denying PHI access')", () => {
        it("de-identified data (includesIdentifiers: false) is allowed even when the model does not permit PHI at all", () => {
            const result = evaluateGatewayAuthorization(baseInput({ includesIdentifiers: false, providerModel: baseModel({ phiPermitted: false }), tenantSettings: baseTenantSettings({ phiAllowed: false }) }));
            expect(result.allowed).toBe(true);
            if (result.allowed) expect(result.effectivePhiPermitted).toBe(false);
        });

        it("denies PHI when the catalog itself does not permit it, even if the tenant thinks it does", () => {
            const result = evaluateGatewayAuthorization(baseInput({ includesIdentifiers: true, providerModel: baseModel({ phiPermitted: false }), tenantSettings: baseTenantSettings({ phiAllowed: true }) }));
            expect(result).toMatchObject({ allowed: false, reason: "phi-not-permitted-by-catalog" });
        });

        it("denies PHI when the catalog permits it but the tenant has not opted in", () => {
            const result = evaluateGatewayAuthorization(baseInput({ includesIdentifiers: true, providerModel: baseModel({ phiPermitted: true }), tenantSettings: baseTenantSettings({ phiAllowed: false }) }));
            expect(result).toMatchObject({ allowed: false, reason: "phi-not-approved-by-tenant" });
        });

        it("allows PHI only when BOTH catalog and tenant permit it, and neither training-use nor unsafe retention apply", () => {
            const result = evaluateGatewayAuthorization(baseInput({
                includesIdentifiers: true,
                providerModel: baseModel({ phiPermitted: true, trainingUseAllowed: false, retainsPrompts: false, retainsOutputs: false }),
                tenantSettings: baseTenantSettings({ phiAllowed: true }),
            }));
            expect(result.allowed).toBe(true);
            if (result.allowed) expect(result.effectivePhiPermitted).toBe(true);
        });

        it("a model that may use submitted data for training NEVER receives PHI, even if the tenant explicitly approved PHI use — a hard, non-overridable rail", () => {
            const result = evaluateGatewayAuthorization(baseInput({
                includesIdentifiers: true,
                providerModel: baseModel({ phiPermitted: true, trainingUseAllowed: true }),
                tenantSettings: baseTenantSettings({ phiAllowed: true }),
            }));
            expect(result).toMatchObject({ allowed: false, reason: "phi-blocked-training-use-allowed" });
        });

        it("a model that retains prompts/outputs without a zero-retention guarantee never receives PHI", () => {
            const result = evaluateGatewayAuthorization(baseInput({
                includesIdentifiers: true,
                providerModel: baseModel({ phiPermitted: true, retainsPrompts: true, zeroRetentionSupport: false }),
                tenantSettings: baseTenantSettings({ phiAllowed: true }),
            }));
            expect(result).toMatchObject({ allowed: false, reason: "phi-blocked-retention-without-zero-retention-guarantee" });
        });

        it("a model that retains prompts BUT has a zero-retention guarantee (e.g. a zero-data-retention API tier) may still receive PHI", () => {
            const result = evaluateGatewayAuthorization(baseInput({
                includesIdentifiers: true,
                providerModel: baseModel({ phiPermitted: true, retainsPrompts: true, zeroRetentionSupport: true, trainingUseAllowed: false }),
                tenantSettings: baseTenantSettings({ phiAllowed: true }),
            }));
            expect(result.allowed).toBe(true);
        });
    });
});
