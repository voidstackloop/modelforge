import * as http from "node:http";
import * as crypto from "node:crypto";
import { shell } from "electron";
import { createLocalJWKSet, jwtVerify } from "jose";
import * as secretsStore from "./secrets-store";
import { getSharedBackendConfig } from "./shared-backend-config-store";
import { clearOfflineCache } from "./case-offline-cache";
import { logger } from "./logger";

// OIDC Authorization Code + PKCE client for the enterprise-mode shared
// backend (packages/server/, docs/ENTERPRISE_MULTIUSER_ARCHITECTURE.md §4). Reuses
// the *shape* already proven in mcp-oauth.ts — a loopback redirect,
// tokens/verifier stored via secrets-store.ts, namespaced keys — exactly as
// docs/SHARED_BACKEND_DESIGN.md §2 anticipated ("the shared PatientCasesBackend
// should reuse this exact shape rather than build a second OAuth client").
//
// What is genuinely different here, and why this isn't a literal call into
// mcp-oauth.ts: that module drives the official MCP SDK's `auth()`
// orchestrator, which implements MCP-specific protected-resource discovery
// (RFC 9728) and can fall back to dynamic client registration (RFC 7591) —
// neither applies to a generic OIDC identity provider an institution
// already operates (Cognito, Keycloak, ...), where this app is registered
// as a pre-configured public client (PKCE, no client_secret — Electron apps
// can't keep one confidential, per RFC 8252) rather than a self-registering
// one. So this module drives plain OIDC discovery
// (`/.well-known/openid-configuration`) and a hand-rolled Authorization
// Code + PKCE exchange instead of the MCP SDK. Everything storage/browser/
// redirect-shaped is deliberately the same pattern as mcp-oauth.ts.

const LOOPBACK_HOST = "127.0.0.1";
const CALLBACK_PATH = "/oauth/callback";
const OIDC_HTTP_TIMEOUT_MS = 10_000;
const AUTHORIZATION_TIMEOUT_MS = 5 * 60_000;

const TOKENS_KEY = "shared_backend_tokens";
const VERIFIER_KEY = "shared_backend_verifier";
let authorizationInProgress = false;
let cancelActiveAuthorization: ((reason: Error) => void) | null = null;
let authorizationGeneration = 0;

// A stored access token is refreshed proactively once within this many
// milliseconds of its own expiry, rather than waiting for a request to
// fail — avoids a race where a token that's technically still valid when
// checked expires a moment later, mid-request.
const EXPIRY_SKEW_MS = 60_000;

export interface StoredTokens {
    accessToken: string;
    refreshToken?: string;
    idToken?: string;
    /** Epoch milliseconds. */
    expiresAt: number;
}

interface OidcDiscoveryDocument {
    issuer: string;
    authorization_endpoint: string;
    token_endpoint: string;
    jwks_uri: string;
    id_token_signing_alg_values_supported: string[];
}

interface TokenResponse {
    access_token: string;
    refresh_token?: string;
    id_token?: string;
    token_type?: string;
    /** Seconds. */
    expires_in?: number;
}

function normalizeIssuer(issuer: string): string {
    return issuer.endsWith("/") ? issuer.slice(0, -1) : issuer;
}

// Generic "is this safe to trust with a bearer token, or follow a redirect
// to" check — not actually OIDC-specific in what it does, despite living
// here and being used first for OIDC endpoints below. shared-backend-client.ts
// and shared-patient-cases-backend.ts reuse it for the shared backend's own
// `baseUrl`, which is exactly as security-sensitive (it's where this
// process sends the live access token on every case/org request) but isn't
// discovered via OIDC at all — it comes straight from
// shared-backend-config-store.ts, which (unlike the issuer, validated here
// at actual-use time) has no format restriction of its own.
export function isAllowedRemoteUrl(value: string): boolean {
    let url: URL;
    try {
        url = new URL(value);
    } catch {
        return false;
    }
    if (url.username || url.password || url.hash) return false;
    if (url.protocol === "https:") return true;
    return url.protocol === "http:" && (url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]");
}

export function requireAllowedRemoteUrl(value: string, label: string): void {
    if (!isAllowedRemoteUrl(value)) {
        throw new Error(`${label} must be an HTTPS URL (HTTP is allowed only for an explicit loopback development endpoint).`);
    }
}

function oidcFetch(url: string, init: RequestInit = {}): Promise<Response> {
    return fetch(url, {
        ...init,
        redirect: "error",
        signal: AbortSignal.timeout(OIDC_HTTP_TIMEOUT_MS),
    });
}

// Same simplification (and the same reasoning) as app/src/case-encryption.ts's
// counterpart in this codebase's server (packages/server/src/auth/oidc-verifier.ts's
// resolveJwks): plain string concatenation, not URL-relative resolution — a
// leading-slash relative URL would discard a Keycloak-style issuer's
// `/realms/{realm}` path component, resolving against the origin instead.
export async function discoverOidcEndpoints(issuer: string): Promise<OidcDiscoveryDocument> {
    const base = normalizeIssuer(issuer);
    requireAllowedRemoteUrl(base, "OIDC issuer");
    const discoveryUrl = `${base}/.well-known/openid-configuration`;
    const response = await oidcFetch(discoveryUrl);
    if (!response.ok) {
        throw new Error(`OIDC discovery failed for issuer "${issuer}" (${discoveryUrl}): HTTP ${response.status} ${response.statusText}`);
    }
    const discovery = (await response.json()) as Partial<OidcDiscoveryDocument>;
    if (
        !discovery.issuer ||
        !discovery.authorization_endpoint ||
        !discovery.token_endpoint ||
        !discovery.jwks_uri ||
        !Array.isArray(discovery.id_token_signing_alg_values_supported)
    ) {
        throw new Error(
            `OIDC discovery document at ${discoveryUrl} is missing issuer, authorization_endpoint, token_endpoint, jwks_uri, or id_token_signing_alg_values_supported.`
        );
    }
    if (normalizeIssuer(discovery.issuer) !== base) {
        throw new Error(`OIDC discovery issuer mismatch: expected "${base}" but received "${discovery.issuer}".`);
    }
    requireAllowedRemoteUrl(discovery.authorization_endpoint, "OIDC authorization endpoint");
    requireAllowedRemoteUrl(discovery.token_endpoint, "OIDC token endpoint");
    requireAllowedRemoteUrl(discovery.jwks_uri, "OIDC JWKS endpoint");
    return {
        issuer: normalizeIssuer(discovery.issuer),
        authorization_endpoint: discovery.authorization_endpoint,
        token_endpoint: discovery.token_endpoint,
        jwks_uri: discovery.jwks_uri,
        id_token_signing_alg_values_supported: discovery.id_token_signing_alg_values_supported,
    };
}

/** RFC 7636 S256 PKCE pair: a high-entropy verifier, and the base64url-
 * encoded SHA-256 challenge derived from it. The verifier is what's later
 * sent to the token endpoint to prove this client (not an attacker who
 * intercepted the authorization code) initiated the flow. */
export function generatePkcePair(): { verifier: string; challenge: string } {
    const verifier = crypto.randomBytes(32).toString("base64url");
    const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
    return { verifier, challenge };
}

export function getStoredTokens(): StoredTokens | null {
    const raw = secretsStore.getSecret(TOKENS_KEY);
    return raw ? (JSON.parse(raw) as StoredTokens) : null;
}

function saveTokens(tokens: StoredTokens): void {
    secretsStore.setSecret(TOKENS_KEY, JSON.stringify(tokens));
}

export function isConnected(): boolean {
    return getStoredTokens() !== null;
}

/** Clears stored tokens and any in-flight PKCE verifier — does not touch
 * shared-backend-config-store.ts's connection config, so reconnecting after
 * this doesn't require re-entering the issuer/client id (mirrors
 * mcp-oauth.ts's `invalidateCredentials("tokens")` distinction from
 * `"all"`, though this module only ever needs the tokens+verifier scope,
 * never a separately-registered client to invalidate — see this file's own
 * top comment on why there's no client_info key here).
 *
 * Also quarantines the offline case cache/outbox for whichever organization
 * was active (P1 item 5, case-offline-cache.ts) — a known, explicit sign-
 * out is the one departure this app can actually detect and act on today
 * (see that module's own doc comment on why silent revocation detection is
 * out of scope), so it's the point this clears what was cached rather than
 * leaving it readable to whoever uses this device next. Read before
 * clearing tokens even though disconnect() doesn't touch the config itself,
 * so this stays correct if that ever changes. */
export function disconnect(): void {
    const organizationId = getSharedBackendConfig()?.organizationId;
    authorizationGeneration += 1;
    const cancel = cancelActiveAuthorization;
    cancelActiveAuthorization = null;
    cancel?.(new Error("Authorization was cancelled."));
    secretsStore.setSecret(TOKENS_KEY, "");
    secretsStore.setSecret(VERIFIER_KEY, "");
    if (organizationId) clearOfflineCache(organizationId);
}

function tokensFromResponse(json: TokenResponse, fallbackRefreshToken?: string): StoredTokens {
    return {
        accessToken: json.access_token,
        // Some providers don't rotate the refresh token on every refresh
        // (they return the same one, or omit it expecting the client to
        // keep using what it already has) — fall back to what was already
        // stored rather than losing the ability to refresh again.
        refreshToken: json.refresh_token ?? fallbackRefreshToken,
        idToken: json.id_token,
        expiresAt: Date.now() + (json.expires_in ?? 3600) * 1000,
    };
}

async function exchangeCodeForTokens(tokenEndpoint: string, clientId: string, redirectUri: string, code: string, verifier: string): Promise<TokenResponse> {
    const body = new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri,
        client_id: clientId,
        code_verifier: verifier,
    });
    const response = await oidcFetch(tokenEndpoint, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body,
    });
    if (!response.ok) {
        throw new Error(`Token exchange failed: HTTP ${response.status}.`);
    }
    const json = (await response.json()) as TokenResponse;
    if (!json.access_token || json.token_type?.toLowerCase() !== "bearer") {
        throw new Error("Token exchange response did not contain a usable bearer access token.");
    }
    return json;
}

async function refreshAccessToken(tokenEndpoint: string, clientId: string, refreshToken: string): Promise<StoredTokens> {
    const body = new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: clientId });
    const response = await oidcFetch(tokenEndpoint, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body,
    });
    if (!response.ok) {
        throw new Error(`Token refresh failed: HTTP ${response.status}.`);
    }
    return tokensFromResponse((await response.json()) as TokenResponse, refreshToken);
}

const SAFE_ID_TOKEN_ALGORITHMS = ["RS256", "RS384", "RS512", "PS256", "PS384", "PS512", "ES256", "ES384", "ES512", "EdDSA"];

function constantTimeEqual(left: string, right: string): boolean {
    const leftBuffer = Buffer.from(left);
    const rightBuffer = Buffer.from(right);
    return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

async function verifyAuthorizationIdToken(
    tokenResponse: TokenResponse,
    discovery: OidcDiscoveryDocument,
    clientId: string,
    expectedNonce: string
): Promise<void> {
    if (!tokenResponse.id_token) {
        throw new Error("OIDC token response did not contain the required ID token.");
    }
    const algorithms = discovery.id_token_signing_alg_values_supported.filter((algorithm) => SAFE_ID_TOKEN_ALGORITHMS.includes(algorithm));
    if (algorithms.length === 0) {
        throw new Error("OIDC provider does not advertise a supported asymmetric ID-token signing algorithm.");
    }

    const jwksResponse = await oidcFetch(discovery.jwks_uri);
    if (!jwksResponse.ok) {
        throw new Error(`OIDC JWKS request failed: HTTP ${jwksResponse.status} ${jwksResponse.statusText}`);
    }
    const jwks = (await jwksResponse.json()) as Parameters<typeof createLocalJWKSet>[0];
    const { payload } = await jwtVerify(tokenResponse.id_token, createLocalJWKSet(jwks), {
        issuer: discovery.issuer,
        audience: clientId,
        algorithms,
    });
    if (typeof payload.sub !== "string" || payload.sub.length === 0) {
        throw new Error("OIDC ID token is missing its subject claim.");
    }
    if (typeof payload.nonce !== "string" || !constantTimeEqual(payload.nonce, expectedNonce)) {
        throw new Error("OIDC ID token nonce mismatch.");
    }
    if (Array.isArray(payload.aud) && payload.aud.length > 1 && payload.azp !== clientId) {
        throw new Error("OIDC ID token authorized-party claim does not match this client.");
    }
}

/**
 * Returns a currently-valid access token for other main-process modules
 * (never the renderer — see docs/ARCHITECTURE.md's "the renderer never
 * talks to [a remote service] directly" principle, which applies here
 * exactly as it does to every provider adapter) to attach as
 * `Authorization: Bearer <token>` on calls to the shared backend.
 * Transparently refreshes an expiring token when a refresh token is
 * available. Returns `null` if never connected, or if the stored token is
 * expired with no refresh token to use — the caller (the future HTTP
 * PatientCasesBackend implementation, per docs/SHARED_BACKEND_DESIGN.md §3)
 * must treat `null` the same way it treats any other unreachable-backend
 * condition (SharedBackendUnavailableError-shaped: never silently collapse
 * to "no data").
 */
export async function getValidAccessToken(): Promise<string | null> {
    const stored = getStoredTokens();
    if (!stored) return null;
    if (Date.now() < stored.expiresAt - EXPIRY_SKEW_MS) return stored.accessToken;
    if (!stored.refreshToken) return null;

    const config = getSharedBackendConfig();
    if (!config) return null;

    const { token_endpoint: tokenEndpoint } = await discoverOidcEndpoints(config.issuer);
    const refreshed = await refreshAccessToken(tokenEndpoint, config.clientId, stored.refreshToken);
    saveTokens(refreshed);
    return refreshed.accessToken;
}

interface RedirectAttempt {
    redirectUri: string;
    code: Promise<string>;
    cancel: (reason: Error) => void;
}

function sendCallbackPage(res: http.ServerResponse, status: number, message: string): void {
    res.writeHead(status, {
        "Content-Type": "text/html; charset=utf-8",
        "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'",
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "no-store",
    });
    res.end(`<html><body>${message}</body></html>`);
}

// Starts on port 0 so the OS chooses an unused high port for this one
// authorization attempt. Only the exact callback path and state created for
// the attempt can complete it; unrelated loopback requests receive 404 and
// leave the listener waiting for the legitimate provider response.
async function startRedirectAttempt(expectedState: string): Promise<RedirectAttempt> {
    let resolveCode!: (code: string) => void;
    let rejectCode!: (error: Error) => void;
    const code = new Promise<string>((resolve, reject) => {
        resolveCode = resolve;
        rejectCode = reject;
    });
    // A callback can reject while shell.openExternal() is still resolving.
    // Attach a handler immediately so Node does not report a transient
    // unhandled rejection; callers still await the original rejecting promise.
    void code.catch(() => undefined);
    let settled = false;
    let timeout: NodeJS.Timeout | null = null;

    const server = http.createServer((req, res) => {
        const url = new URL(req.url ?? "/", `http://${LOOPBACK_HOST}`);
        if (req.method !== "GET" || url.pathname !== CALLBACK_PATH) {
            sendCallbackPage(res, 404, "Not found.");
            return;
        }

        const returnedState = url.searchParams.get("state");
        if (!returnedState || !constantTimeEqual(returnedState, expectedState)) {
            sendCallbackPage(res, 400, "Authorization response was rejected. You can close this tab and return to ModelForge Medical.");
            finish(new Error("OIDC authorization state mismatch."));
            return;
        }

        const error = url.searchParams.get("error");
        const returnedCode = url.searchParams.get("code");
        if (error) {
            sendCallbackPage(res, 400, "Authorization failed. You can close this tab and return to ModelForge Medical.");
            const safeError = /^[A-Za-z0-9_.-]{1,64}$/.test(error) ? error : "unknown_error";
            finish(new Error(`Authorization was denied or failed: ${safeError}`));
        } else if (!returnedCode) {
            sendCallbackPage(res, 400, "Authorization response was incomplete. You can close this tab and return to ModelForge Medical.");
            finish(new Error("No authorization code was returned."));
        } else {
            sendCallbackPage(res, 200, "Authorization complete — you can close this tab and return to ModelForge Medical.");
            finish(undefined, returnedCode);
        }
    });

    function finish(error?: Error, returnedCode?: string): void {
        if (settled) return;
        settled = true;
        if (timeout) clearTimeout(timeout);
        server.close();
        if (error) rejectCode(error);
        else resolveCode(returnedCode!);
    }

    await new Promise<void>((resolve, reject) => {
        const onError = (error: Error) => reject(new Error(`Could not start the local OAuth redirect listener: ${error.message}`));
        server.once("error", onError);
        server.listen(0, LOOPBACK_HOST, () => {
            server.off("error", onError);
            resolve();
        });
    });
    server.on("error", (error) => finish(new Error(`Local OAuth redirect listener failed: ${error.message}`)));

    const address = server.address();
    if (!address || typeof address === "string") {
        const error = new Error("Could not determine the local OAuth redirect listener address.");
        finish(error);
        await code.catch(() => undefined);
        throw error;
    }
    timeout = setTimeout(
        () => finish(new Error("Timed out waiting for authorization — no response after 5 minutes.")),
        AUTHORIZATION_TIMEOUT_MS
    );
    timeout.unref();
    server.unref();

    return {
        redirectUri: `http://${LOOPBACK_HOST}:${address.port}${CALLBACK_PATH}`,
        code,
        cancel: (reason) => finish(reason),
    };
}

/**
 * Runs the full Authorization Code + PKCE flow against the configured
 * shared backend's OIDC issuer: discovers the authorization/token
 * endpoints, opens the system browser to the authorization URL, catches
 * the loopback redirect, and exchanges the code for tokens. Resolves once
 * tokens are saved. Throws (never silently no-ops) if no shared backend is
 * configured yet — see shared-backend-config-store.ts.
 *
 * The test suite drives this boundary with a real ephemeral loopback listener,
 * a mocked system browser, and signed test ID tokens. A real institutional
 * provider remains an integration-test responsibility.
 */
export async function connect(): Promise<void> {
    if (authorizationInProgress) throw new Error("A shared-backend authorization attempt is already in progress.");
    authorizationInProgress = true;
    const generation = ++authorizationGeneration;
    let redirectAttempt: RedirectAttempt | null = null;
    const requireActiveAttempt = (): void => {
        if (generation !== authorizationGeneration) throw new Error("Authorization was cancelled.");
    };
    try {
        const config = getSharedBackendConfig();
        if (!config) throw new Error("No shared backend is configured — set one up in Settings first.");

        const discovery = await discoverOidcEndpoints(config.issuer);
        requireActiveAttempt();
        const { verifier, challenge } = generatePkcePair();
        const state = crypto.randomBytes(32).toString("base64url");
        const nonce = crypto.randomBytes(32).toString("base64url");
        secretsStore.setSecret(VERIFIER_KEY, verifier);

        redirectAttempt = await startRedirectAttempt(state);
        cancelActiveAuthorization = redirectAttempt.cancel;
        requireActiveAttempt();
        const authorizationUrl = new URL(discovery.authorization_endpoint);
        authorizationUrl.searchParams.set("response_type", "code");
        authorizationUrl.searchParams.set("client_id", config.clientId);
        authorizationUrl.searchParams.set("redirect_uri", redirectAttempt.redirectUri);
        authorizationUrl.searchParams.set("code_challenge", challenge);
        authorizationUrl.searchParams.set("code_challenge_method", "S256");
        authorizationUrl.searchParams.set("scope", "openid profile email");
        authorizationUrl.searchParams.set("state", state);
        authorizationUrl.searchParams.set("nonce", nonce);
        if (config.audience) authorizationUrl.searchParams.set("audience", config.audience);

        try {
            await shell.openExternal(authorizationUrl.toString());
            requireActiveAttempt();
        } catch (error) {
            redirectAttempt.cancel(new Error("Could not open the system browser for authorization."));
            await redirectAttempt.code.catch(() => undefined);
            throw error;
        }

        const authorizationCode = await redirectAttempt.code;
        requireActiveAttempt();
        const tokenResponse = await exchangeCodeForTokens(
            discovery.token_endpoint,
            config.clientId,
            redirectAttempt.redirectUri,
            authorizationCode,
            verifier
        );
        requireActiveAttempt();
        await verifyAuthorizationIdToken(tokenResponse, discovery, config.clientId, nonce);
        requireActiveAttempt();
        saveTokens(tokensFromResponse(tokenResponse));
        logger.info("shared-backend-auth: connected successfully.");
    } finally {
        redirectAttempt?.cancel(new Error("Authorization attempt ended."));
        cancelActiveAuthorization = null;
        authorizationInProgress = false;
        secretsStore.setSecret(VERIFIER_KEY, "");
    }
}
