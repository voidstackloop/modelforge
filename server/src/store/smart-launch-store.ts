import type { SmartLaunchSession, SmartLaunchToken, SmartTrustedIssuer } from "@modelforge/contracts";
import type { TenantContext } from "../tenant-context.js";
import type { AuditActor } from "./audit-store.js";

/**
 * Tenant-scoped repository for SMART App Launch client-role state — mirrors
 * the "one interface per domain" shape every other store in this codebase
 * uses. Two sub-resources, each internal-vs-public split for the same
 * reason: neither the PKCE `codeVerifier` (session) nor the actual
 * encrypted access/refresh token (completed launch) may ever appear in an
 * API response — see smart-launch.ts's own contracts doc comment and
 * routes/smart-launch.ts.
 */

export interface InternalSmartLaunchSession extends SmartLaunchSession {
    codeVerifier: string;
    redirectUri: string;
    launch?: string;
}

export interface InternalSmartLaunchToken extends SmartLaunchToken {
    /** AES-256-GCM envelope, base64 (smart-launch/token-crypto.ts) — never
     * the plaintext token. */
    encryptedAccessToken: string;
    encryptedRefreshToken?: string;
}

export interface CreateLaunchSessionInput {
    issuer: string;
    requestedByUserId: string;
    scope: string;
    codeVerifier: string;
    redirectUri: string;
    launch?: string;
    expiresAt: string;
}

export interface CreateTokenInput {
    issuer: string;
    requestedByUserId: string;
    scope: string;
    patientId?: string;
    encryptedAccessToken: string;
    encryptedRefreshToken?: string;
    expiresAt: string;
}

export interface TenantSmartLaunchRepository {
    readonly context: TenantContext;

    upsertTrustedIssuer(input: Omit<SmartTrustedIssuer, "id" | "createdAt">, actor: AuditActor): Promise<SmartTrustedIssuer>;
    getTrustedIssuer(issuer: string): Promise<SmartTrustedIssuer | null>;
    listTrustedIssuers(): Promise<SmartTrustedIssuer[]>;
    deleteTrustedIssuer(issuer: string, actor: AuditActor): Promise<boolean>;

    /** `state` (RFC 6749's CSRF-protection parameter) doubles as this
     * row's own id — it is already required to be unguessable and unique,
     * the same property a store id needs, and using it directly avoids a
     * separate lookup-by-state index. */
    createLaunchSession(state: string, input: CreateLaunchSessionInput, actor: AuditActor): Promise<InternalSmartLaunchSession>;
    getLaunchSession(state: string): Promise<InternalSmartLaunchSession | null>;
    /** Marks a pending session completed — a session already `completed`
     * or `expired` cannot be completed again (the store itself enforces
     * this, returning null, so a caller can never double-spend one launch
     * attempt into two token exchanges by racing this call). */
    completeLaunchSession(state: string, actor: AuditActor): Promise<InternalSmartLaunchSession | null>;

    createToken(input: CreateTokenInput, actor: AuditActor): Promise<InternalSmartLaunchToken>;
    getToken(id: string): Promise<InternalSmartLaunchToken | null>;
    listTokensForUser(userId: string): Promise<SmartLaunchToken[]>;
    deleteToken(id: string, actor: AuditActor): Promise<boolean>;
}

export interface SmartLaunchStore {
    forTenant(context: TenantContext): TenantSmartLaunchRepository;
}

/** Strips store-internal secret fields before a launch session ever
 * reaches an API response — routes/smart-launch.ts's own safety net,
 * called on every response that carries one, so a future field added to
 * the internal shape can't leak by omission. */
export function publicLaunchSession(session: InternalSmartLaunchSession): SmartLaunchSession {
    const { codeVerifier: _codeVerifier, redirectUri: _redirectUri, launch: _launch, ...rest } = session;
    return rest;
}

export function publicToken(token: InternalSmartLaunchToken): SmartLaunchToken {
    const { encryptedAccessToken: _a, encryptedRefreshToken: _r, ...rest } = token;
    return rest;
}
