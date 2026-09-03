import type { SmartLaunchSession, SmartLaunchToken } from "@modelforge/contracts";
import type { AuditActor } from "../store/audit-store.js";
import { publicLaunchSession, publicToken, type TenantSmartLaunchRepository } from "../store/smart-launch-store.js";
import { resolveSmartConfiguration } from "./discovery.js";
import { generatePkcePair, generateState } from "./pkce.js";
import { encryptToken } from "./token-crypto.js";

/**
 * The actual SMART App Launch client-role flow — createLaunchSession
 * (redirect a user to an EHR to authorize) and completeLaunchCallback
 * (exchange the resulting code for a token). Reused as-is by
 * routes/smart-launch.ts; kept here, not inline in the route, so the
 * security-critical parts (state/PKCE generation, redirect_uri
 * allowlisting, the token exchange itself) have their own dedicated,
 * directly-testable surface independent of HTTP/IAM plumbing.
 *
 * See packages/contracts/src/smart-launch.ts's own doc comment for the
 * standing design decision this whole flow sits inside: a launch always
 * requires an already-authenticated ModelForge caller (`actor`/
 * `requestedByUserId` below always come from an already-verified bearer
 * token — this module trusts them, never re-derives them), and every
 * token this flow produces is encrypted at rest and never returned to a
 * caller in its own request/response cycle.
 */

const DEFAULT_SCOPES = ["launch", "patient/*.read", "openid", "fhirUser"];
const SESSION_TTL_MS = 10 * 60 * 1_000; // 10 minutes — an authorization_code's own real-world lifetime is usually similar or shorter; this just bounds how long a stale, never-completed launch attempt lingers.
const TOKEN_EXCHANGE_TIMEOUT_MS = 10_000;
const DEFAULT_TOKEN_LIFETIME_S = 3_600;

export type SmartLaunchErrorCode = "untrusted_issuer" | "invalid_redirect_uri" | "discovery_failed";
export class SmartLaunchError extends Error {
    constructor(
        message: string,
        public readonly code: SmartLaunchErrorCode
    ) {
        super(message);
        this.name = "SmartLaunchError";
    }
}

export type SmartLaunchCallbackErrorCode = "session_not_found" | "session_expired" | "session_not_pending" | "forbidden" | "token_exchange_failed";
export class SmartLaunchCallbackError extends Error {
    constructor(
        message: string,
        public readonly code: SmartLaunchCallbackErrorCode
    ) {
        super(message);
        this.name = "SmartLaunchCallbackError";
    }
}

export interface CreateLaunchSessionOptions {
    repo: TenantSmartLaunchRepository;
    requestedByUserId: string;
    issuer: string;
    redirectUri: string;
    scopes?: string[];
    launch?: string;
    actor: AuditActor;
    now?: Date;
}

export async function createLaunchSession(options: CreateLaunchSessionOptions): Promise<{ session: SmartLaunchSession; authorizationUrl: string }> {
    const trusted = await options.repo.getTrustedIssuer(options.issuer);
    if (!trusted) throw new SmartLaunchError(`"${options.issuer}" is not a trusted issuer for this organization.`, "untrusted_issuer");
    // Exact match against the admin-configured allowlist — never a prefix
    // or pattern match. A caller-controlled redirect_uri that doesn't
    // match verbatim is exactly the open-redirect/code-theft shape this
    // check exists to close off.
    if (!trusted.redirectUris.includes(options.redirectUri)) {
        throw new SmartLaunchError(`"${options.redirectUri}" is not an allowed redirect URI for this issuer.`, "invalid_redirect_uri");
    }

    let metadata;
    try {
        metadata = await resolveSmartConfiguration(options.issuer);
    } catch (err) {
        throw new SmartLaunchError(`SMART discovery failed for "${options.issuer}": ${err instanceof Error ? err.message : String(err)}`, "discovery_failed");
    }

    const { codeVerifier, codeChallenge } = generatePkcePair();
    const state = generateState();
    const scope = (options.scopes && options.scopes.length > 0 ? options.scopes : DEFAULT_SCOPES).join(" ");
    const now = options.now ?? new Date();
    const expiresAt = new Date(now.getTime() + SESSION_TTL_MS).toISOString();

    const internal = await options.repo.createLaunchSession(
        state,
        { issuer: options.issuer, requestedByUserId: options.requestedByUserId, scope, codeVerifier, redirectUri: options.redirectUri, launch: options.launch, expiresAt },
        options.actor
    );

    const authorizationUrl = new URL(metadata.authorizationEndpoint);
    authorizationUrl.searchParams.set("response_type", "code");
    authorizationUrl.searchParams.set("client_id", trusted.clientId);
    authorizationUrl.searchParams.set("redirect_uri", options.redirectUri);
    authorizationUrl.searchParams.set("scope", scope);
    authorizationUrl.searchParams.set("state", state);
    authorizationUrl.searchParams.set("aud", options.issuer);
    authorizationUrl.searchParams.set("code_challenge", codeChallenge);
    authorizationUrl.searchParams.set("code_challenge_method", "S256");
    if (options.launch) authorizationUrl.searchParams.set("launch", options.launch);

    return { session: publicLaunchSession(internal), authorizationUrl: authorizationUrl.toString() };
}

export interface CompleteLaunchCallbackOptions {
    repo: TenantSmartLaunchRepository;
    state: string;
    code: string;
    callerId: string;
    encryptionKey: Buffer;
    actor: AuditActor;
    now?: Date;
}

export async function completeLaunchCallback(options: CompleteLaunchCallbackOptions): Promise<SmartLaunchToken> {
    const session = await options.repo.getLaunchSession(options.state);
    if (!session) throw new SmartLaunchCallbackError("No pending launch session for this state.", "session_not_found");
    // A different ModelForge user attempting to complete someone else's
    // pending launch — this can only happen if `state` leaked somewhere
    // (e.g. a shared browser); refusing it outright is the correct
    // response, not merging or transferring ownership.
    if (session.requestedByUserId !== options.callerId) throw new SmartLaunchCallbackError("This launch session belongs to a different user.", "forbidden");
    if (session.status !== "pending") throw new SmartLaunchCallbackError(`This launch session is already "${session.status}".`, "session_not_pending");
    const now = options.now ?? new Date();
    if (session.expiresAt <= now.toISOString()) throw new SmartLaunchCallbackError("This launch session has expired.", "session_expired");

    const trusted = await options.repo.getTrustedIssuer(session.issuer);
    if (!trusted) throw new SmartLaunchCallbackError("The trusted issuer configuration for this session no longer exists.", "session_not_found");
    let metadata;
    try {
        metadata = await resolveSmartConfiguration(session.issuer);
    } catch (err) {
        throw new SmartLaunchCallbackError(`SMART discovery failed during token exchange: ${err instanceof Error ? err.message : String(err)}`, "token_exchange_failed");
    }

    const body = new URLSearchParams({
        grant_type: "authorization_code",
        code: options.code,
        redirect_uri: session.redirectUri,
        client_id: trusted.clientId,
        code_verifier: session.codeVerifier,
    });
    let response: Response;
    try {
        response = await fetch(metadata.tokenEndpoint, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: body.toString(), signal: AbortSignal.timeout(TOKEN_EXCHANGE_TIMEOUT_MS) });
    } catch (err) {
        throw new SmartLaunchCallbackError(`Token exchange request failed: ${err instanceof Error ? err.message : String(err)}`, "token_exchange_failed");
    }
    if (!response.ok) {
        // Never echo the response body verbatim — an EHR's error response
        // could (rarely, but possibly) itself carry sensitive detail, and
        // this codebase's own convention is a fixed, safe error shape.
        throw new SmartLaunchCallbackError(`Token exchange failed: HTTP ${response.status}`, "token_exchange_failed");
    }
    let payload: Record<string, unknown>;
    try {
        payload = (await response.json()) as Record<string, unknown>;
    } catch {
        throw new SmartLaunchCallbackError("Token endpoint did not return valid JSON.", "token_exchange_failed");
    }

    const accessToken = payload.access_token;
    if (typeof accessToken !== "string" || accessToken.length === 0) {
        throw new SmartLaunchCallbackError("Token response had no access_token.", "token_exchange_failed");
    }
    const refreshToken = typeof payload.refresh_token === "string" && payload.refresh_token.length > 0 ? payload.refresh_token : undefined;
    const expiresInSeconds = typeof payload.expires_in === "number" && payload.expires_in > 0 ? payload.expires_in : DEFAULT_TOKEN_LIFETIME_S;
    const patientId = typeof payload.patient === "string" && payload.patient.length > 0 ? payload.patient : undefined;
    const scope = typeof payload.scope === "string" && payload.scope.length > 0 ? payload.scope : session.scope;

    const token = await options.repo.createToken(
        {
            issuer: session.issuer,
            requestedByUserId: session.requestedByUserId,
            scope,
            patientId,
            encryptedAccessToken: encryptToken(accessToken, options.encryptionKey),
            encryptedRefreshToken: refreshToken ? encryptToken(refreshToken, options.encryptionKey) : undefined,
            expiresAt: new Date(now.getTime() + expiresInSeconds * 1_000).toISOString(),
        },
        options.actor
    );

    // Single-use: mark the session completed only after a successful
    // exchange (so a transient network failure during exchange doesn't
    // burn the one-time state, letting a legitimate retry with a fresh
    // `code` — the EHR's own authorization server invalidates `code`
    // after one use regardless — still succeed against the same session).
    // completeLaunchSession itself refuses a non-"pending" session, so a
    // racing double-submit can never produce two tokens sharing one
    // session's ownership check; the (harmless, rare) residual case is a
    // genuine concurrent double-submit each independently exchanging a
    // still-valid code before the other's write lands, which is bounded
    // by the EHR's own code-is-single-use enforcement, not this store's.
    await options.repo.completeLaunchSession(options.state, options.actor);

    return publicToken(token);
}
