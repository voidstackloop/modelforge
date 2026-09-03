import { createRemoteJWKSet, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from "jose";

// Generic, issuer-configurable OIDC bearer-token verification — deliberately
// not coupled to any one provider (Cognito, Keycloak, or anything else
// spec-compliant works identically), per docs/ENTERPRISE_MULTIUSER_ARCHITECTURE.md
// §4's decision that the app (and, by extension, this service) is a generic
// OIDC relying party, and docs/ENTERPRISE_READINESS_ASSESSMENT.md §2.1's
// standing decision to delegate authentication entirely to an external IdP
// rather than build any custom login/MFA. This module verifies a token's
// signature, issuer, audience, and expiry; it does not authenticate anyone
// itself and holds no credentials of its own.

// resolveJwks()'s own discovery fetch below has no built-in bound (unlike
// jose's createRemoteJWKSet, whose per-verification JWKS fetches already
// default to a 5s timeoutDuration) — an unreachable/hanging IdP at startup
// would otherwise leave main() (index.ts) awaiting this forever, never
// reaching app.listen() and never rejecting into main().catch() either, so
// the process just hangs with no diagnostic.
const DISCOVERY_TIMEOUT_MS = 10_000;

export class TokenVerificationError extends Error {
    constructor(
        message: string,
        public readonly cause?: unknown
    ) {
        super(message);
        this.name = "TokenVerificationError";
    }
}

export interface VerifiedIdentity {
    /** Verified `iss`, kept with `sub` because subject identifiers are only
     * unique within one issuer. */
    issuer: string;
    /** The OIDC `sub` claim — the only thing this service uses to identify a
     * principal. See domain/types.ts's User.externalSubject. */
    subject: string;
    email?: string;
    name?: string;
    /** The full verified claim set, for anything a future route needs that
     * isn't already pulled out above (e.g. a custom claim an institution's
     * IdP adds). Never trust a claim here that hasn't been through
     * jwtVerify's signature check — this object only exists after that. */
    claims: JWTPayload;
}

/**
 * Verifies a bearer token's signature (against `keySource`), issuer,
 * audience, and expiry (jose checks this by default). Throws
 * TokenVerificationError — never returns a "maybe valid" result — on any
 * failure, including a syntactically valid but unsigned/mis-issued token.
 *
 * `audience` is required, not optional — a validly-signed ID token (or an
 * access token minted for a *different* client of the same IdP) carries
 * the same issuer and a real `sub` claim, so signature+issuer checks alone
 * can't tell it apart from a genuine access token for this API; `aud` is
 * what does (see config.ts's AppConfig.oidc.audience doc comment for the
 * full reasoning and why this doesn't rely on a provider-specific claim
 * like Cognito's `token_use`).
 *
 * `keySource` is a `jose` `JWTVerifyGetKey` — production code passes
 * `resolveJwks()`'s remote JWKS; tests pass `jose.createLocalJWKSet(...)`
 * against a locally generated keypair, so no network call happens in tests.
 * See oidc-verifier.test.ts.
 */
export async function verifyAccessToken(
    token: string,
    keySource: JWTVerifyGetKey,
    options: { issuer: string; audience: string }
): Promise<VerifiedIdentity> {
    let payload: JWTPayload;
    try {
        ({ payload } = await jwtVerify(token, keySource, { issuer: options.issuer, audience: options.audience }));
    } catch (err) {
        throw new TokenVerificationError("Bearer token failed verification (signature, issuer, audience, or expiry).", err);
    }

    if (typeof payload.sub !== "string" || payload.sub.length === 0) {
        throw new TokenVerificationError("Token verified but has no `sub` claim — nothing to identify the principal by.");
    }

    return {
        issuer: payload.iss!,
        subject: payload.sub,
        email: typeof payload.email === "string" ? payload.email : undefined,
        name: typeof payload.name === "string" ? payload.name : undefined,
        claims: payload,
    };
}

/**
 * P2 item 3 (multiple-IdP compatibility): reads the `iss` claim from a JWT
 * WITHOUT verifying its signature — used only to pick which of this
 * server's configured trusted issuers to attempt real verification against
 * when more than one is configured (see createAuthPreHandler in
 * ./auth-plugin.ts). This is never itself a security check: the returned
 * string is untrusted input from an unauthenticated caller until
 * verifyAccessToken's real jwtVerify call independently re-validates the
 * *same* `iss` claim against that specific issuer's actual signing keys.
 * The only thing this function's result controls is which JWKS/audience
 * pair gets tried — an attacker claiming a false `iss` just gets routed to
 * the wrong (or no) keys and fails signature verification the normal way,
 * exactly as if this lookup didn't exist. Returns undefined for anything
 * that isn't a well-formed three-segment JWT with a string `iss` claim,
 * never throws — a malformed token should fail via the same generic
 * "invalid_bearer_token" path as every other verification failure, not a
 * different error from this earlier, unauthenticated parsing step.
 */
export function decodeUnverifiedIssuer(token: string): string | undefined {
    const parts = token.split(".");
    if (parts.length !== 3) return undefined;
    try {
        const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as { iss?: unknown };
        return typeof payload.iss === "string" && payload.iss.length > 0 ? payload.iss : undefined;
    } catch {
        return undefined;
    }
}

/**
 * Resolves a remote JWKS to verify against, given either an explicit JWKS
 * URI (OIDC_JWKS_URI) or an issuer to run OIDC discovery against
 * (`{issuer}/.well-known/openid-configuration`'s `jwks_uri`) — covers both
 * Cognito-style (`https://cognito-idp.{region}.amazonaws.com/{poolId}`) and
 * Keycloak-style (`https://host/realms/{realm}`) issuer URLs, which is why
 * this is plain string concatenation rather than URL-relative resolution
 * (a leading-slash relative URL would discard a Keycloak-style issuer's
 * `/realms/{realm}` path component, resolving against the origin instead).
 * Fetched and cached once per process by `createRemoteJWKSet` internally —
 * not re-fetched on every request.
 */
/**
 * Fetches `{issuer}/.well-known/openid-configuration` — the one piece of
 * discovery-document plumbing resolveJwks() and
 * resolveAuthorizationServerMetadata() (below) both need, factored out so
 * there is exactly one place that owns the URL construction, timeout, and
 * error-message shape for "OIDC discovery failed."
 */
async function fetchOidcDiscoveryDocument(issuer: string, discoveryTimeoutMs: number): Promise<Record<string, unknown>> {
    const base = issuer.endsWith("/") ? issuer.slice(0, -1) : issuer;
    const discoveryUrl = `${base}/.well-known/openid-configuration`;
    let response: Response;
    try {
        response = await fetch(discoveryUrl, { signal: AbortSignal.timeout(discoveryTimeoutMs) });
    } catch (err) {
        const reason = err instanceof Error && err.name === "TimeoutError" ? `timed out after ${discoveryTimeoutMs}ms` : String(err);
        throw new Error(`OIDC discovery failed for issuer "${issuer}" (${discoveryUrl}): ${reason}`);
    }
    if (!response.ok) {
        throw new Error(`OIDC discovery failed for issuer "${issuer}" (${discoveryUrl}): HTTP ${response.status} ${response.statusText}`);
    }
    return (await response.json()) as Record<string, unknown>;
}

export async function resolveJwks(
    config: { issuer: string; jwksUri?: string },
    // Overridable only so oidc-verifier.test.ts can exercise the timeout
    // path in milliseconds instead of the real 10s — production code never
    // passes this.
    discoveryTimeoutMs: number = DISCOVERY_TIMEOUT_MS
): Promise<JWTVerifyGetKey> {
    if (config.jwksUri) return createRemoteJWKSet(new URL(config.jwksUri));

    const discovery = await fetchOidcDiscoveryDocument(config.issuer, discoveryTimeoutMs);
    if (typeof discovery.jwks_uri !== "string" || discovery.jwks_uri.length === 0) {
        throw new Error(`OIDC discovery document for issuer "${config.issuer}" has no usable "jwks_uri".`);
    }
    return createRemoteJWKSet(new URL(discovery.jwks_uri));
}

export interface AuthorizationServerMetadata {
    issuer: string;
    authorizationEndpoint: string;
    tokenEndpoint: string;
}

/**
 * Resolves the external IdP's own `authorization_endpoint`/`token_endpoint`
 * — used only to populate this server's `.well-known/smart-configuration`
 * (server/src/fhir/smart-configuration.ts). This server never issues
 * tokens itself (see this file's own top doc comment); it only ever
 * *republishes* the real authorization server's endpoints so a SMART
 * client knows where to actually send a user to authorize. Resolved once
 * at startup (index.ts), same "fail loudly if unreachable" posture as
 * resolveJwks — an IdP a SMART launch depends on but this process can't
 * reach at boot should be a startup failure, not a 500 on first request.
 */
export async function resolveAuthorizationServerMetadata(
    config: { issuer: string },
    discoveryTimeoutMs: number = DISCOVERY_TIMEOUT_MS
): Promise<AuthorizationServerMetadata> {
    const discovery = await fetchOidcDiscoveryDocument(config.issuer, discoveryTimeoutMs);
    const { authorization_endpoint: authorizationEndpoint, token_endpoint: tokenEndpoint } = discovery;
    if (typeof authorizationEndpoint !== "string" || authorizationEndpoint.length === 0) {
        throw new Error(`OIDC discovery document for issuer "${config.issuer}" has no usable "authorization_endpoint".`);
    }
    if (typeof tokenEndpoint !== "string" || tokenEndpoint.length === 0) {
        throw new Error(`OIDC discovery document for issuer "${config.issuer}" has no usable "token_endpoint".`);
    }
    return { issuer: config.issuer, authorizationEndpoint, tokenEndpoint };
}
