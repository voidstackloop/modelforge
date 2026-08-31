import { describe, it, expect, beforeAll } from "vitest";
import { SignJWT, exportJWK, generateKeyPair, createLocalJWKSet, type JWTVerifyGetKey, type CryptoKey, type JWK } from "jose";
import type { FastifyReply, FastifyRequest } from "fastify";
import { createAuthPreHandler, type TrustedIssuer } from "./auth-plugin.js";

const PRIMARY_ISSUER = "https://idp-a.example-hospital.test/realms/clinical";
const SECONDARY_ISSUER = "https://idp-b.example-hospital.test";
const UNTRUSTED_ISSUER = "https://not-configured-anywhere.test";
const AUDIENCE = "modelforge-iam-server";
const SECONDARY_AUDIENCE = "modelforge-iam-server-b";

/** A bare-bones fake matching only what authPreHandler actually reads/calls
 * on FastifyRequest/FastifyReply — this package has no existing precedent
 * for a real Fastify request/reply in a unit test (every other auth-path
 * test goes through app.inject()), and building one from scratch here would
 * be more machinery than the thing under test warrants. */
function fakeRequest(authorization?: string): FastifyRequest {
    return { headers: { authorization }, auth: undefined } as unknown as FastifyRequest;
}
type FakeReply = FastifyReply & { statusCode?: number; body?: unknown };
function fakeReply(): FakeReply {
    const reply: Partial<FakeReply> = {};
    reply.code = ((statusCode: number) => {
        reply.statusCode = statusCode;
        return reply;
    }) as FakeReply["code"];
    reply.send = ((body: unknown) => {
        reply.body = body;
        return reply;
    }) as FakeReply["send"];
    return reply as FakeReply;
}

describe("createAuthPreHandler (P2 item 3: multiple-IdP compatibility)", () => {
    let primaryKey: CryptoKey;
    let primaryJwks: JWTVerifyGetKey;
    let secondaryKey: CryptoKey;
    let secondaryJwks: JWTVerifyGetKey;

    beforeAll(async () => {
        const primaryPair = await generateKeyPair("RS256");
        primaryKey = primaryPair.privateKey;
        const primaryPublicJwk: JWK = { ...(await exportJWK(primaryPair.publicKey)), kid: "primary-key", alg: "RS256" };
        primaryJwks = createLocalJWKSet({ keys: [primaryPublicJwk] });

        const secondaryPair = await generateKeyPair("RS256");
        secondaryKey = secondaryPair.privateKey;
        const secondaryPublicJwk: JWK = { ...(await exportJWK(secondaryPair.publicKey)), kid: "secondary-key", alg: "RS256" };
        secondaryJwks = createLocalJWKSet({ keys: [secondaryPublicJwk] });
    });

    function signFor(key: CryptoKey, kid: string, issuer: string, audience: string, sub: string) {
        return new SignJWT({ sub })
            .setProtectedHeader({ alg: "RS256", kid })
            .setIssuedAt()
            .setIssuer(issuer)
            .setAudience(audience)
            .setExpirationTime("1h")
            .sign(key);
    }

    it("verifies a token from the sole configured (primary) issuer — the existing single-IdP behavior, unchanged", async () => {
        const handler = createAuthPreHandler({ issuer: PRIMARY_ISSUER, audience: AUDIENCE }, primaryJwks);
        const token = await signFor(primaryKey, "primary-key", PRIMARY_ISSUER, AUDIENCE, "idp|clinician-1");
        const request = fakeRequest(`Bearer ${token}`);
        await handler(request, fakeReply());
        expect(request.auth?.subject).toBe("idp|clinician-1");
        expect(request.auth?.issuer).toBe(PRIMARY_ISSUER);
    });

    it("rejects a second issuer when none is configured — behaves exactly as before this feature existed", async () => {
        const handler = createAuthPreHandler({ issuer: PRIMARY_ISSUER, audience: AUDIENCE }, primaryJwks);
        const token = await signFor(secondaryKey, "secondary-key", SECONDARY_ISSUER, SECONDARY_AUDIENCE, "idp|clinician-2");
        const request = fakeRequest(`Bearer ${token}`);
        const reply = fakeReply();
        await handler(request, reply);
        expect(reply.statusCode).toBe(401);
        expect(request.auth).toBeUndefined();
    });

    describe("with a second trusted issuer configured", () => {
        function buildHandler() {
            const additional: TrustedIssuer[] = [{ issuer: SECONDARY_ISSUER, audience: SECONDARY_AUDIENCE, jwks: secondaryJwks }];
            return createAuthPreHandler({ issuer: PRIMARY_ISSUER, audience: AUDIENCE }, primaryJwks, additional);
        }

        it("verifies a token from the primary issuer", async () => {
            const handler = buildHandler();
            const token = await signFor(primaryKey, "primary-key", PRIMARY_ISSUER, AUDIENCE, "idp|clinician-1");
            const request = fakeRequest(`Bearer ${token}`);
            await handler(request, fakeReply());
            expect(request.auth?.subject).toBe("idp|clinician-1");
            expect(request.auth?.issuer).toBe(PRIMARY_ISSUER);
        });

        it("also verifies a token from the second (additional) issuer, checked against its own audience", async () => {
            const handler = buildHandler();
            const token = await signFor(secondaryKey, "secondary-key", SECONDARY_ISSUER, SECONDARY_AUDIENCE, "idp|clinician-2");
            const request = fakeRequest(`Bearer ${token}`);
            await handler(request, fakeReply());
            expect(request.auth?.subject).toBe("idp|clinician-2");
            expect(request.auth?.issuer).toBe(SECONDARY_ISSUER);
        });

        it("a token signed by the secondary issuer's real key is rejected if it claims the primary issuer's audience", async () => {
            // Proves the audience/issuer pairing is per-issuer, not just
            // "any configured issuer with any configured audience" — the
            // secondary issuer's token must match *its own* audience.
            const handler = buildHandler();
            const token = await signFor(secondaryKey, "secondary-key", SECONDARY_ISSUER, AUDIENCE, "idp|clinician-2");
            const request = fakeRequest(`Bearer ${token}`);
            const reply = fakeReply();
            await handler(request, reply);
            expect(reply.statusCode).toBe(401);
        });

        it("cannot be fooled by an unverified iss claim: a token claiming a trusted issuer's name but signed by neither configured key fails", async () => {
            // The core security property of the whole feature: picking a
            // JWKS by the token's own (unverified) iss claim never
            // substitutes for real signature verification. Forge a token
            // that *claims* iss=PRIMARY_ISSUER but is actually signed by
            // the secondary issuer's key (or any key not in that issuer's
            // trusted JWKS) — jwtVerify must still reject it.
            const handler = buildHandler();
            const token = await signFor(secondaryKey, "secondary-key", PRIMARY_ISSUER, AUDIENCE, "idp|attacker");
            const request = fakeRequest(`Bearer ${token}`);
            const reply = fakeReply();
            await handler(request, reply);
            expect(reply.statusCode).toBe(401);
            expect(request.auth).toBeUndefined();
        });

        it("rejects a token from a genuinely untrusted issuer with the same generic message as any other failure", async () => {
            const handler = buildHandler();
            const token = await signFor(secondaryKey, "secondary-key", UNTRUSTED_ISSUER, SECONDARY_AUDIENCE, "idp|nobody");
            const request = fakeRequest(`Bearer ${token}`);
            const reply = fakeReply();
            await handler(request, reply);
            expect(reply.statusCode).toBe(401);
            expect(reply.body).toEqual({ error: "invalid_bearer_token", message: "Bearer token failed verification." });
        });

        it("rejects a structurally malformed bearer token via the same early path, not a crash", async () => {
            const handler = buildHandler();
            const request = fakeRequest("Bearer not-a-real-jwt-at-all");
            const reply = fakeReply();
            await handler(request, reply);
            expect(reply.statusCode).toBe(401);
        });
    });

    it("missing bearer header is rejected before any issuer lookup happens", async () => {
        const handler = createAuthPreHandler({ issuer: PRIMARY_ISSUER, audience: AUDIENCE }, primaryJwks);
        const reply = fakeReply();
        await handler(fakeRequest(undefined), reply);
        expect(reply.statusCode).toBe(401);
        expect(reply.body).toMatchObject({ error: "missing_bearer_token" });
    });
});
