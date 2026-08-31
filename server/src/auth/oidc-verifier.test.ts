import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
import { SignJWT, exportJWK, generateKeyPair, createLocalJWKSet, type JWTVerifyGetKey, type CryptoKey, type JWK } from "jose";
import { verifyAccessToken, resolveJwks, decodeUnverifiedIssuer, TokenVerificationError } from "./oidc-verifier.js";

const ISSUER = "https://idp.example-hospital.test/realms/clinical";
const AUDIENCE = "modelforge-iam-server";
const KID = "test-signing-key-1";

describe("oidc-verifier", () => {
    let privateKey: CryptoKey;
    let jwks: JWTVerifyGetKey;
    let publicJwk: JWK;

    beforeAll(async () => {
        const pair = await generateKeyPair("RS256");
        privateKey = pair.privateKey;
        publicJwk = await exportJWK(pair.publicKey);
        publicJwk.kid = KID;
        publicJwk.alg = "RS256";
        jwks = createLocalJWKSet({ keys: [publicJwk] });
    });

    function sign(claims: Record<string, unknown>, overrides?: { issuer?: string; audience?: string; expired?: boolean }) {
        let builder = new SignJWT(claims)
            .setProtectedHeader({ alg: "RS256", kid: KID })
            .setIssuedAt()
            .setIssuer(overrides?.issuer ?? ISSUER)
            .setAudience(overrides?.audience ?? AUDIENCE);
        builder = overrides?.expired ? builder.setExpirationTime("-10s") : builder.setExpirationTime("1h");
        return builder.sign(privateKey);
    }

    it("verifies a well-formed token and extracts subject/email/name", async () => {
        const token = await sign({ sub: "idp|clinician-1", email: "clinician@example-hospital.test", name: "Dr. Example" });
        const identity = await verifyAccessToken(token, jwks, { issuer: ISSUER, audience: AUDIENCE });
        expect(identity.subject).toBe("idp|clinician-1");
        expect(identity.email).toBe("clinician@example-hospital.test");
        expect(identity.name).toBe("Dr. Example");
        expect(identity.claims.sub).toBe("idp|clinician-1");
    });

    // `audience` used to be optional here, with a test proving "verifies
    // without an audience check when none is configured" — removed, not
    // replaced: `verifyAccessToken`'s `options.audience` is now required
    // (see this file's and config.ts's doc comments on why — an ID token
    // or another client's access token from the same IdP would otherwise
    // verify as if it were genuine), so that scenario is no longer
    // constructible at all, not just discouraged. "rejects a token with
    // the wrong audience" below already covers a *mismatched* audience,
    // which is the behavior that actually matters now.

    it("rejects a token signed by a different key", async () => {
        const otherPair = await generateKeyPair("RS256");
        const token = await new SignJWT({ sub: "idp|attacker" })
            .setProtectedHeader({ alg: "RS256", kid: KID })
            .setIssuedAt()
            .setIssuer(ISSUER)
            .setAudience(AUDIENCE)
            .setExpirationTime("1h")
            .sign(otherPair.privateKey);

        await expect(verifyAccessToken(token, jwks, { issuer: ISSUER, audience: AUDIENCE })).rejects.toBeInstanceOf(TokenVerificationError);
    });

    it("rejects a token with the wrong issuer", async () => {
        const token = await sign({ sub: "idp|clinician-1" }, { issuer: "https://not-the-real-idp.test" });
        await expect(verifyAccessToken(token, jwks, { issuer: ISSUER, audience: AUDIENCE })).rejects.toBeInstanceOf(TokenVerificationError);
    });

    it("rejects a token with the wrong audience", async () => {
        const token = await sign({ sub: "idp|clinician-1" }, { audience: "some-other-service" });
        await expect(verifyAccessToken(token, jwks, { issuer: ISSUER, audience: AUDIENCE })).rejects.toBeInstanceOf(TokenVerificationError);
    });

    it("rejects an expired token", async () => {
        const token = await sign({ sub: "idp|clinician-1" }, { expired: true });
        await expect(verifyAccessToken(token, jwks, { issuer: ISSUER, audience: AUDIENCE })).rejects.toBeInstanceOf(TokenVerificationError);
    });

    it("rejects a token with no `sub` claim even though the signature is valid", async () => {
        const token = await sign({ email: "no-subject@example-hospital.test" });
        await expect(verifyAccessToken(token, jwks, { issuer: ISSUER, audience: AUDIENCE })).rejects.toBeInstanceOf(TokenVerificationError);
    });

    it("rejects garbage input rather than throwing an unrelated error type", async () => {
        await expect(verifyAccessToken("not-a-jwt", jwks, { issuer: ISSUER, audience: AUDIENCE })).rejects.toBeInstanceOf(TokenVerificationError);
    });

    it("rejects an alg:\"none\" (unsigned) token, even with an otherwise-valid-looking payload", async () => {
        const base64url = (obj: unknown) => Buffer.from(JSON.stringify(obj)).toString("base64url");
        const header = { alg: "none", typ: "JWT" };
        const payload = { sub: "idp|attacker", iss: ISSUER, aud: AUDIENCE, exp: Math.floor(Date.now() / 1000) + 3600 };
        // A "none"-alg JWT's third segment (the signature) is empty by
        // definition — there is nothing to sign.
        const token = `${base64url(header)}.${base64url(payload)}.`;

        await expect(verifyAccessToken(token, jwks, { issuer: ISSUER, audience: AUDIENCE })).rejects.toBeInstanceOf(TokenVerificationError);
    });

    it("rejects an HS256 token signed using the RSA public key's own material as if it were a shared HMAC secret (algorithm confusion)", async () => {
        // The classic confusion attack: an attacker who only knows the
        // server's *public* key (entirely reasonable — it's published at
        // the JWKS endpoint for exactly this key id) signs a token with
        // alg: HS256 using that public key's bytes as the HMAC secret,
        // hoping a verifier that resolves the key by `kid` alone (without
        // checking the resolved key's actual type against the header's
        // claimed algorithm) will "verify" it. jose's JWKS-based key
        // resolution (createLocalJWKSet/createRemoteJWKSet, what
        // verifyAccessToken is always called with in production — see
        // index.ts) categorically refuses to treat any JWKS-sourced key as
        // an HMAC secret regardless of the token's claimed alg — this locks
        // that in as a regression test rather than trusting it by
        // inference alone.
        const fakeHmacSecret = new TextEncoder().encode(JSON.stringify(publicJwk));
        const token = await new SignJWT({ sub: "idp|attacker" })
            .setProtectedHeader({ alg: "HS256", kid: KID })
            .setIssuedAt()
            .setIssuer(ISSUER)
            .setAudience(AUDIENCE)
            .setExpirationTime("1h")
            .sign(fakeHmacSecret);

        await expect(verifyAccessToken(token, jwks, { issuer: ISSUER, audience: AUDIENCE })).rejects.toBeInstanceOf(TokenVerificationError);
    });

    describe("decodeUnverifiedIssuer (P2 item 3: multiple-IdP compatibility)", () => {
        it("reads the iss claim from a real, validly-signed token", async () => {
            const token = await sign({ sub: "idp|clinician-1" });
            expect(decodeUnverifiedIssuer(token)).toBe(ISSUER);
        });

        it("reads iss from a token whose signature would never actually verify — this is deliberately unverified", async () => {
            const token = await sign({ sub: "idp|attacker" }, { issuer: "https://a-completely-untrusted-issuer.test" });
            expect(decodeUnverifiedIssuer(token)).toBe("https://a-completely-untrusted-issuer.test");
        });

        it("returns undefined for structurally malformed input rather than throwing", () => {
            expect(decodeUnverifiedIssuer("not-a-jwt")).toBeUndefined();
            expect(decodeUnverifiedIssuer("only.two")).toBeUndefined();
            expect(decodeUnverifiedIssuer("")).toBeUndefined();
            expect(decodeUnverifiedIssuer("a.b.c.d")).toBeUndefined();
        });

        it("returns undefined when the payload segment isn't valid base64url JSON", () => {
            expect(decodeUnverifiedIssuer("a.not-valid-base64url-json!!!.c")).toBeUndefined();
        });

        it("returns undefined when the (structurally valid) payload has no string iss claim", () => {
            const payload = Buffer.from(JSON.stringify({ sub: "idp|no-issuer" })).toString("base64url");
            expect(decodeUnverifiedIssuer(`header.${payload}.signature`)).toBeUndefined();

            const numericIssuerPayload = Buffer.from(JSON.stringify({ iss: 12345 })).toString("base64url");
            expect(decodeUnverifiedIssuer(`header.${numericIssuerPayload}.signature`)).toBeUndefined();
        });
    });

    describe("resolveJwks — OIDC discovery failure paths", () => {
        afterEach(() => {
            vi.unstubAllGlobals();
        });

        it("skips discovery entirely and never calls fetch when jwksUri is already configured", async () => {
            const fetchSpy = vi.fn();
            vi.stubGlobal("fetch", fetchSpy);

            await resolveJwks({ issuer: ISSUER, jwksUri: "https://idp.example-hospital.test/jwks" });

            expect(fetchSpy).not.toHaveBeenCalled();
        });

        it("rejects with a clear error, not a hang, when the discovery request times out", async () => {
            // Never resolves — resolveJwks's own AbortSignal.timeout is what
            // must end this, not the fetch itself settling. Rejects with an
            // AbortError-shaped failure when the real fetch's request signal
            // fires, which this stub simulates by listening for the abort.
            // A 50ms override (resolveJwks's third, test-only parameter)
            // keeps this deterministic without waiting out the real 10s
            // production default.
            vi.stubGlobal(
                "fetch",
                vi.fn((_url: string, init?: { signal?: AbortSignal }) => {
                    return new Promise((_resolve, reject) => {
                        init?.signal?.addEventListener("abort", () => {
                            const err = new Error("This operation was aborted");
                            err.name = "TimeoutError";
                            reject(err);
                        });
                    });
                })
            );

            await expect(resolveJwks({ issuer: ISSUER }, 50)).rejects.toThrow(/timed out after 50ms/);
        });

        it("rejects with a clear error on a non-2xx discovery response", async () => {
            vi.stubGlobal(
                "fetch",
                vi.fn(async () => new Response("not found", { status: 404, statusText: "Not Found" }))
            );

            await expect(resolveJwks({ issuer: ISSUER })).rejects.toThrow(/HTTP 404/);
        });

        it("rejects with a clear error on a malformed (non-JSON) discovery response", async () => {
            vi.stubGlobal(
                "fetch",
                vi.fn(async () => new Response("this is not json", { status: 200 }))
            );

            await expect(resolveJwks({ issuer: ISSUER })).rejects.toThrow();
        });

        it("rejects with a clear error when the discovery document has no jwks_uri", async () => {
            vi.stubGlobal(
                "fetch",
                vi.fn(async () => new Response(JSON.stringify({ issuer: ISSUER }), { status: 200 }))
            );

            await expect(resolveJwks({ issuer: ISSUER })).rejects.toThrow(/no usable "jwks_uri"/);
        });

        it("resolves successfully from a well-formed discovery document", async () => {
            vi.stubGlobal(
                "fetch",
                vi.fn(async () => new Response(JSON.stringify({ jwks_uri: "https://idp.example-hospital.test/jwks" }), { status: 200 }))
            );

            await expect(resolveJwks({ issuer: ISSUER })).resolves.toBeDefined();
        });
    });
});
