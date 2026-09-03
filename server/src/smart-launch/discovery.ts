/**
 * SMART App Launch discovery against an EXTERNAL EHR — the client-role
 * counterpart to auth/oidc-verifier.ts's resolveJwks/
 * resolveAuthorizationServerMetadata (which discover THIS server's own
 * trusted OIDC issuer for verifying inbound tokens). This fetches a
 * *different* server's `.well-known/smart-configuration` — the SMART App
 * Launch spec's own discovery document, distinct from plain OIDC discovery
 * (`.well-known/openid-configuration`) — to learn where to send a user to
 * authorize and where to exchange a code for a token.
 */
const DISCOVERY_TIMEOUT_MS = 10_000;

export interface SmartAuthorizationServerMetadata {
    authorizationEndpoint: string;
    tokenEndpoint: string;
}

export class SmartDiscoveryError extends Error {}

/**
 * `fhirBaseUrl` is the `iss` a launch names — SMART's own convention that
 * the FHIR base URL and the identifier used for its `.well-known/smart-
 * configuration` discovery are the same URL. Never called with a caller-
 * supplied URL that hasn't already been checked against this
 * organization's own trusted-issuer allowlist (see routes/smart-launch.ts)
 * — this function itself does no allowlisting, it only speaks HTTP to
 * whatever URL it's given, and letting an unauthenticated/unvalidated URL
 * reach it would be a real SSRF risk.
 */
export async function resolveSmartConfiguration(fhirBaseUrl: string, discoveryTimeoutMs: number = DISCOVERY_TIMEOUT_MS): Promise<SmartAuthorizationServerMetadata> {
    const base = fhirBaseUrl.endsWith("/") ? fhirBaseUrl.slice(0, -1) : fhirBaseUrl;
    const discoveryUrl = `${base}/.well-known/smart-configuration`;
    let response: Response;
    try {
        response = await fetch(discoveryUrl, { signal: AbortSignal.timeout(discoveryTimeoutMs) });
    } catch (err) {
        const reason = err instanceof Error && err.name === "TimeoutError" ? `timed out after ${discoveryTimeoutMs}ms` : String(err);
        throw new SmartDiscoveryError(`SMART discovery failed for "${fhirBaseUrl}" (${discoveryUrl}): ${reason}`);
    }
    if (!response.ok) {
        throw new SmartDiscoveryError(`SMART discovery failed for "${fhirBaseUrl}" (${discoveryUrl}): HTTP ${response.status} ${response.statusText}`);
    }
    let document: Record<string, unknown>;
    try {
        document = (await response.json()) as Record<string, unknown>;
    } catch {
        throw new SmartDiscoveryError(`SMART discovery document at ${discoveryUrl} was not valid JSON.`);
    }
    const { authorization_endpoint: authorizationEndpoint, token_endpoint: tokenEndpoint } = document;
    if (typeof authorizationEndpoint !== "string" || authorizationEndpoint.length === 0) {
        throw new SmartDiscoveryError(`SMART discovery document at ${discoveryUrl} has no usable "authorization_endpoint".`);
    }
    if (typeof tokenEndpoint !== "string" || tokenEndpoint.length === 0) {
        throw new SmartDiscoveryError(`SMART discovery document at ${discoveryUrl} has no usable "token_endpoint".`);
    }
    return { authorizationEndpoint, tokenEndpoint };
}
