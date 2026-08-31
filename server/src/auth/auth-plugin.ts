import type { FastifyReply, FastifyRequest } from "fastify";
import type { JWTVerifyGetKey } from "jose";
import { verifyAccessToken, decodeUnverifiedIssuer, TokenVerificationError, type VerifiedIdentity } from "./oidc-verifier.js";

declare module "fastify" {
    interface FastifyRequest {
        /** Set by the preHandler below once a bearer token verifies —
         * absent (and the request already rejected with 401) otherwise.
         * Every route that reads this must have `authPreHandler` in its
         * route options; see routes/guards.ts's requireOrgUser for the
         * next step (resolving this identity to an org-scoped User). */
        auth?: VerifiedIdentity;
    }
}

export interface TrustedIssuer {
    issuer: string;
    audience: string;
    jwks: JWTVerifyGetKey;
}

const GENERIC_INVALID_TOKEN_RESPONSE = { error: "invalid_bearer_token", message: "Bearer token failed verification." } as const;

/**
 * Builds a Fastify preHandler that verifies the `Authorization: Bearer
 * <token>` header and sets `request.auth`, or ends the request with 401 —
 * attach it via `{ preHandler: authPreHandler }` on every route that needs
 * an authenticated caller. Deliberately not a global onRequest hook: some
 * routes (GET /health) must stay reachable unauthenticated, and requiring
 * auth to be an explicit per-route opt-in makes that visible in each
 * route's own registration rather than needing a separate exemption list to
 * keep in sync.
 *
 * `primary` is the required, always-trusted issuer (OIDC_ISSUER/
 * OIDC_AUDIENCE) — every existing deployment and every test in this package
 * configures exactly this and nothing else. `additionalIssuers` (P2 item 3:
 * multiple-IdP compatibility) is optional and empty by default; when
 * non-empty, an institution can accept tokens from more than one IdP at
 * once (migrating between providers, or federating a legacy on-prem
 * provider alongside a new cloud one) without weakening single-issuer
 * verification for anyone who doesn't need this.
 *
 * Selection uses decodeUnverifiedIssuer to pick which configured issuer's
 * JWKS/audience to attempt real verification against — see that function's
 * own doc comment for why this is safe (the pick is never itself trusted;
 * verifyAccessToken's real jwtVerify call is what actually enforces issuer
 * and signature). A token whose `iss` doesn't match any configured issuer
 * is rejected with the same generic message as any other verification
 * failure — never a distinct error that would let a caller enumerate which
 * issuers this server trusts.
 */
export function createAuthPreHandler(primary: { issuer: string; audience: string }, jwks: JWTVerifyGetKey, additionalIssuers: TrustedIssuer[] = []) {
    const trustedIssuers = new Map<string, { audience: string; jwks: JWTVerifyGetKey }>();
    trustedIssuers.set(primary.issuer, { audience: primary.audience, jwks });
    for (const additional of additionalIssuers) {
        // First (primary) registration for a given issuer string wins —
        // config.ts's loadConfig already rejects a duplicate at startup, so
        // this is defense-in-depth against a caller constructing the map
        // some other way (e.g. a future test), not something normal
        // configuration can ever actually trigger.
        if (!trustedIssuers.has(additional.issuer)) trustedIssuers.set(additional.issuer, { audience: additional.audience, jwks: additional.jwks });
    }

    return async function authPreHandler(request: FastifyRequest, reply: FastifyReply): Promise<void> {
        const header = request.headers.authorization;
        if (!header || !header.startsWith("Bearer ")) {
            await reply.code(401).send({ error: "missing_bearer_token", message: "Authorization: Bearer <token> header is required." });
            return;
        }

        const token = header.slice("Bearer ".length).trim();
        const claimedIssuer = decodeUnverifiedIssuer(token);
        const trusted = claimedIssuer !== undefined ? trustedIssuers.get(claimedIssuer) : undefined;
        if (!trusted) {
            await reply.code(401).send(GENERIC_INVALID_TOKEN_RESPONSE);
            return;
        }

        try {
            request.auth = await verifyAccessToken(token, trusted.jwks, { issuer: claimedIssuer!, audience: trusted.audience });
        } catch (err) {
            const message = err instanceof TokenVerificationError ? err.message : GENERIC_INVALID_TOKEN_RESPONSE.message;
            await reply.code(401).send({ error: "invalid_bearer_token", message });
        }
    };
}
