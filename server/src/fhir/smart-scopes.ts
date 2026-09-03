import type { JWTPayload } from "jose";

/**
 * SMART App Launch scope/launch-context handling for the resource-server
 * side (routes/fhir.ts) — the piece of "SMART on FHIR OAuth" this server is
 * actually responsible for, since it delegates real token issuance to the
 * external IdP (see auth/oidc-verifier.ts's top doc comment). A SMART
 * launch conveys two things on the access token this server already
 * verifies: a space-delimited `scope` claim (OAuth2 standard) that may
 * include `patient/*.read`-shaped SMART clinical scopes, and (per SMART's
 * launch context convention, which several IdPs — Cerner/Oracle Health,
 * Epic — put directly on the access token rather than a separate response
 * field) a `patient` claim naming which patient the launch was scoped to.
 *
 * This is deliberately conservative: it only activates when *both* signals
 * are present. A plain OIDC bearer token with no SMART scope (the only kind
 * this API issued before this file existed) is completely unaffected —
 * existing IAM authorization (routes/guards.ts) remains the only gate, same
 * as every other route in this API. See docs/FHIR_INTEGRATION.md's SMART
 * section for what this does not implement (this server does not itself
 * validate a scope against what the IdP was actually authorized to grant —
 * that trust is already placed in the IdP by virtue of accepting its
 * signed token at all, same as every claim on it).
 */
export interface SmartLaunchContext {
    /** The `patient` claim value — every FHIR read this request makes must
     * resolve to this same patient, or be denied. */
    readonly confinedToPatientId: string;
}

const PATIENT_SCOPE_PREFIX = "patient/";

export function resolveSmartLaunchContext(claims: JWTPayload): SmartLaunchContext | undefined {
    const scopeClaim = claims.scope;
    if (typeof scopeClaim !== "string") return undefined;
    const hasPatientScopedGrant = scopeClaim.split(/\s+/).some((scope) => scope.startsWith(PATIENT_SCOPE_PREFIX));
    if (!hasPatientScopedGrant) return undefined;

    const patientClaim = claims.patient;
    if (typeof patientClaim !== "string" || patientClaim.length === 0) return undefined;
    return { confinedToPatientId: patientClaim };
}

/** True if a launch context is active and confines the caller to a
 * *different* patient than `patientId` — the one thing every FHIR read
 * route needs to check after its normal IAM authorization passes. */
export function deniedBySmartLaunchContext(launchContext: SmartLaunchContext | undefined, patientId: string): boolean {
    return launchContext !== undefined && launchContext.confinedToPatientId !== patientId;
}
