import type { AiConsent, AiProvider, AiProviderModel, AiProviderTenantSettings } from "@modelforge/contracts";

/**
 * ClinicalAiGateway steps 3-4: "Authorize the user, patient, case,
 * resources, purpose of use, and requested model" / "Validate consent,
 * organizational policy, provider approval, jurisdiction, and retention
 * policy." This module is the data-governance layer specifically — "may
 * this patient's data go to this provider" — deliberately separate from
 * "can this user perform this action," which stays the existing IAM policy
 * engine (routes/guards.ts's requirePermission, action-catalog.ts's new
 * `aiGateway:*` actions). By the time this module runs, the caller has
 * already passed an ordinary `aiGateway:invoke` permission check.
 *
 * Pure and side-effect-free on purpose: every fact it needs (the resolved
 * consent, the provider/model catalog row, the tenant's approval row, the
 * case's own coarse consent flag) is passed in by the caller, which is what
 * makes this testable without a real database, and auditable — the exact
 * inputs this function saw are exactly what a `policySnapshotHash` should
 * be computed over (server/src/ai-gateway/gateway.ts).
 */

export interface GatewayAuthorizationInput {
    purposeOfUse: string;
    consentPurpose: AiConsent["purpose"];
    dataCategories: string[];
    includesIdentifiers: boolean;
    callerRoles: string[];
    /** The patient case's own coarse, pre-existing consent scope
     * (packages/contracts's caseConsentSchema) — "ai-assistance" or
     * "remote-model-use," resolved by the caller from the live case
     * record. This is the cheap first gate; the richer AiConsent below is
     * the one this module actually reasons about in detail. */
    caseHasAiConsentScope: boolean;
    consent: AiConsent | null;
    /** The provider row that owns `providerModel` — carries the
     * organization-wide kill switch and operational status, which are
     * distinct from anything on the model row itself. A provider can be
     * killed or suspended while individual model rows underneath it are
     * still marked "active" at the catalog level; this is deliberately
     * checked here rather than folded into `providerModel` so that engaging
     * a provider's kill switch always blocks every model under it in one
     * place, with no risk of a model-level check being added later that
     * forgets to also look at its parent. */
    provider: AiProvider | null;
    providerModel: AiProviderModel | null;
    tenantSettings: AiProviderTenantSettings | null;
}

export type GatewayAuthorizationDenialReason =
    | "case-consent-scope-missing"
    | "no-active-consent"
    | "consent-data-categories-insufficient"
    | "provider-model-not-found"
    | "provider-model-retired"
    | "provider-kill-switch-engaged"
    | "provider-not-active"
    | "model-safety-restricted"
    | "model-not-validated-for-clinical-use"
    | "provider-not-approved-for-tenant"
    | "role-not-approved"
    | "phi-not-permitted-by-catalog"
    | "phi-not-approved-by-tenant"
    | "phi-blocked-training-use-allowed"
    | "phi-blocked-retention-without-zero-retention-guarantee";

export type GatewayAuthorizationResult =
    | { allowed: true; effectivePhiPermitted: boolean; consent: AiConsent; provider: AiProvider; providerModel: AiProviderModel; tenantSettings: AiProviderTenantSettings }
    | { allowed: false; reason: GatewayAuthorizationDenialReason; message: string };

function deny(reason: GatewayAuthorizationDenialReason, message: string): GatewayAuthorizationResult {
    return { allowed: false, reason, message };
}

export function evaluateGatewayAuthorization(input: GatewayAuthorizationInput): GatewayAuthorizationResult {
    // --- Consent (cheap case-level gate first, then the real record) ---
    if (!input.caseHasAiConsentScope) {
        return deny("case-consent-scope-missing", "This patient case has no active AI-assistance consent scope.");
    }
    if (!input.consent) {
        return deny("no-active-consent", "No active, unexpired consent covers this purpose of use.");
    }
    const missingCategories = input.dataCategories.filter((c) => !input.consent!.dataCategories.includes(c));
    if (missingCategories.length > 0) {
        return deny("consent-data-categories-insufficient", `Consent does not cover: ${missingCategories.join(", ")}.`);
    }

    // --- Provider / model existence and operational state ---
    if (!input.providerModel || !input.provider) {
        return deny("provider-model-not-found", "The requested model is not in the catalog.");
    }
    // The kill switch and provider-level operational status are checked
    // before anything on the model row — item: "Support immediate provider
    // or model shutdown through an administrative kill switch," which must
    // block every model under that provider, not just one catalog row.
    if (input.provider.killSwitchEngaged) {
        return deny("provider-kill-switch-engaged", `This provider has been shut down by an administrator${input.provider.killSwitchReason ? `: ${input.provider.killSwitchReason}` : "."}`);
    }
    if (input.provider.operationalStatus === "suspended" || input.provider.operationalStatus === "retired") {
        return deny("provider-not-active", `This provider's operational status ("${input.provider.operationalStatus}") blocks new requests.`);
    }
    if (input.providerModel.retiredAt) {
        return deny("provider-model-retired", "This model has been retired and can no longer be invoked.");
    }
    if (input.providerModel.safetyStatus === "disabled" || input.providerModel.safetyStatus === "restricted") {
        return deny("model-safety-restricted", `This model's safety status ("${input.providerModel.safetyStatus}") blocks new requests.`);
    }
    if (input.providerModel.validationStatus === "deprecated") {
        return deny("model-not-validated-for-clinical-use", "This model version is deprecated.");
    }

    // --- Per-tenant approval (never widens what the catalog itself allows) ---
    if (!input.tenantSettings || !input.tenantSettings.enabled) {
        return deny("provider-not-approved-for-tenant", "This organization has not approved this model for use.");
    }
    if (input.tenantSettings.allowedRoles.length > 0 && !input.callerRoles.some((role) => input.tenantSettings!.allowedRoles.includes(role))) {
        return deny("role-not-approved", "Your role is not approved to use this model.");
    }

    // --- PHI transmission: default-deny, AND of catalog and tenant, plus
    // hard rails that are never overridable by a tenant setting ---
    const effectivePhiPermitted = input.providerModel.phiPermitted && input.tenantSettings.phiAllowed;
    if (input.includesIdentifiers) {
        if (!input.providerModel.phiPermitted) {
            return deny("phi-not-permitted-by-catalog", "This model's catalog entry does not permit PHI, regardless of any tenant setting.");
        }
        if (!input.tenantSettings.phiAllowed) {
            return deny("phi-not-approved-by-tenant", "This organization has not approved sending PHI to this model.");
        }
        // Hard rail, never overridable: "Disable provider training and
        // provider-side retention by default. If a provider cannot
        // guarantee the configured privacy requirements, prevent PHI
        // transmission." A model whose catalog entry admits it may use
        // submitted data for training can never receive PHI, full stop —
        // no tenant setting can re-enable this.
        if (input.providerModel.trainingUseAllowed) {
            return deny("phi-blocked-training-use-allowed", "This model may use submitted data for training; PHI can never be sent to it.");
        }
        if ((input.providerModel.retainsPrompts || input.providerModel.retainsOutputs) && !input.providerModel.zeroRetentionSupport) {
            return deny("phi-blocked-retention-without-zero-retention-guarantee", "This model retains prompts/outputs without a zero-retention guarantee; PHI cannot be sent to it.");
        }
    }

    return { allowed: true, effectivePhiPermitted, consent: input.consent, provider: input.provider, providerModel: input.providerModel, tenantSettings: input.tenantSettings };
}
