import * as crypto from "node:crypto";
import * as http from "node:http";
import { shell } from "electron";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as secretsStore from "./secrets-store";
import { setSharedBackendConfig } from "./shared-backend-config-store";
import {
    connect,
    disconnect,
    discoverOidcEndpoints,
    generatePkcePair,
    getStoredTokens,
    getValidAccessToken,
    isConnected,
} from "./shared-backend-auth";

// The real institutional IdP and system browser are integration boundaries,
// but connect() is exercised with a real ephemeral loopback listener, a
// mocked browser handoff, and cryptographically signed test ID tokens.

// Pokes the same secrets-store key shared-backend-auth.ts uses internally
// (not exported — this is the module's own storage detail, not a public
// API) so getValidAccessToken/isConnected tests can set up stored-token
// state without needing a full connect() flow.
const TOKENS_KEY = "shared_backend_tokens";

function seedTokens(tokens: { accessToken: string; refreshToken?: string; expiresAt: number }): void {
    secretsStore.setSecret(TOKENS_KEY, JSON.stringify(tokens));
}

function mockFetchSequence(responses: Array<{ ok: boolean; status?: number; json?: unknown; text?: string }>) {
    const fn = vi.fn();
    for (const r of responses) {
        fn.mockResolvedValueOnce({
            ok: r.ok,
            status: r.status ?? (r.ok ? 200 : 400),
            statusText: r.ok ? "OK" : "Bad Request",
            json: () => Promise.resolve(r.json),
            text: () => Promise.resolve(r.text ?? ""),
        });
    }
    vi.stubGlobal("fetch", fn);
    return fn;
}

const DISCOVERY_DOC = {
    issuer: "https://idp.example-hospital.test",
    authorization_endpoint: "https://idp.example-hospital.test/oauth/authorize",
    token_endpoint: "https://idp.example-hospital.test/oauth/token",
    jwks_uri: "https://idp.example-hospital.test/.well-known/jwks.json",
    id_token_signing_alg_values_supported: ["RS256"],
};

const ID_TOKEN_KEYS = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const ID_TOKEN_JWK = {
    ...(ID_TOKEN_KEYS.publicKey.export({ format: "jwk" }) as Record<string, unknown>),
    kid: "test-id-token-key",
    use: "sig",
    alg: "RS256",
};

function signIdToken(nonce: string, overrides: Record<string, unknown> = {}): string {
    const now = Math.floor(Date.now() / 1000);
    const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT", kid: "test-id-token-key" })).toString("base64url");
    const payload = Buffer.from(
        JSON.stringify({
            iss: DISCOVERY_DOC.issuer,
            aud: "modelforge-desktop",
            sub: "clinician-123",
            iat: now,
            exp: now + 300,
            nonce,
            ...overrides,
        })
    ).toString("base64url");
    const signingInput = `${header}.${payload}`;
    const signature = crypto.sign("RSA-SHA256", Buffer.from(signingInput), ID_TOKEN_KEYS.privateKey).toString("base64url");
    return `${signingInput}.${signature}`;
}

function getLoopback(url: URL): Promise<number | undefined> {
    return new Promise((resolve, reject) => {
        const request = http.get(url, (response) => {
            response.resume();
            response.on("end", () => resolve(response.statusCode));
        });
        request.on("error", reject);
    });
}

describe("shared-backend-auth", () => {
    beforeEach(() => {
        disconnect();
        setSharedBackendConfig(null);
    });
    afterEach(() => {
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
    });

    describe("generatePkcePair", () => {
        it("derives the challenge as the base64url SHA-256 of the verifier (RFC 7636 S256)", () => {
            const { verifier, challenge } = generatePkcePair();
            const expected = crypto.createHash("sha256").update(verifier).digest("base64url");
            expect(challenge).toBe(expected);
        });

        it("generates a different verifier on every call", () => {
            const a = generatePkcePair();
            const b = generatePkcePair();
            expect(a.verifier).not.toBe(b.verifier);
        });
    });

    describe("discoverOidcEndpoints", () => {
        it("fetches the well-known discovery document and returns both endpoints", async () => {
            const fetchMock = mockFetchSequence([{ ok: true, json: DISCOVERY_DOC }]);
            const result = await discoverOidcEndpoints("https://idp.example-hospital.test");
            expect(result).toEqual(DISCOVERY_DOC);
            expect(fetchMock).toHaveBeenCalledWith(
                "https://idp.example-hospital.test/.well-known/openid-configuration",
                expect.objectContaining({ redirect: "error", signal: expect.any(AbortSignal) })
            );
        });

        it("strips a trailing slash from the issuer before building the discovery URL", async () => {
            const fetchMock = mockFetchSequence([{ ok: true, json: DISCOVERY_DOC }]);
            await discoverOidcEndpoints("https://idp.example-hospital.test/");
            expect(fetchMock).toHaveBeenCalledWith(
                "https://idp.example-hospital.test/.well-known/openid-configuration",
                expect.objectContaining({ redirect: "error", signal: expect.any(AbortSignal) })
            );
        });

        it("throws on a non-ok discovery response", async () => {
            mockFetchSequence([{ ok: false, status: 404 }]);
            await expect(discoverOidcEndpoints("https://idp.example-hospital.test")).rejects.toThrow(/HTTP 404/);
        });

        it("throws when the discovery document is missing required endpoints", async () => {
            mockFetchSequence([{ ok: true, json: { authorization_endpoint: "https://x" } }]);
            await expect(discoverOidcEndpoints("https://idp.example-hospital.test")).rejects.toThrow(/missing/);
        });

        it("rejects issuer substitution and insecure non-loopback endpoints", async () => {
            mockFetchSequence([{ ok: true, json: { ...DISCOVERY_DOC, issuer: "https://attacker.test" } }]);
            await expect(discoverOidcEndpoints(DISCOVERY_DOC.issuer)).rejects.toThrow(/issuer mismatch/);

            mockFetchSequence([{ ok: true, json: { ...DISCOVERY_DOC, token_endpoint: "http://idp.example-hospital.test/token" } }]);
            await expect(discoverOidcEndpoints(DISCOVERY_DOC.issuer)).rejects.toThrow(/token endpoint must be an HTTPS URL/);
        });
    });

    describe("token storage", () => {
        it("isConnected is false with nothing stored, true once tokens exist", () => {
            expect(isConnected()).toBe(false);
            seedTokens({ accessToken: "abc", expiresAt: Date.now() + 100_000 });
            expect(isConnected()).toBe(true);
        });

        it("getStoredTokens round-trips exactly what was stored", () => {
            seedTokens({ accessToken: "abc", refreshToken: "def", expiresAt: 12345 });
            expect(getStoredTokens()).toEqual({ accessToken: "abc", refreshToken: "def", expiresAt: 12345 });
        });

        it("disconnect clears stored tokens", () => {
            seedTokens({ accessToken: "abc", expiresAt: Date.now() + 100_000 });
            disconnect();
            expect(getStoredTokens()).toBeNull();
            expect(isConnected()).toBe(false);
        });
    });

    describe("getValidAccessToken", () => {
        it("returns null when never connected", async () => {
            expect(await getValidAccessToken()).toBeNull();
        });

        it("returns the stored token directly, with no network call, when it isn't near expiry", async () => {
            seedTokens({ accessToken: "still-good", expiresAt: Date.now() + 10 * 60_000 });
            const fetchMock = vi.fn();
            vi.stubGlobal("fetch", fetchMock);
            expect(await getValidAccessToken()).toBe("still-good");
            expect(fetchMock).not.toHaveBeenCalled();
        });

        it("refreshes and persists a new token when the stored one is expired and a refresh token exists", async () => {
            seedTokens({ accessToken: "expired", refreshToken: "refresh-abc", expiresAt: Date.now() - 1000 });
            setSharedBackendConfig({ baseUrl: "https://iam.example-hospital.test", issuer: "https://idp.example-hospital.test", clientId: "modelforge-desktop" });
            mockFetchSequence([
                { ok: true, json: DISCOVERY_DOC },
                { ok: true, json: { access_token: "fresh-token", refresh_token: "refresh-def", expires_in: 3600 } },
            ]);

            const token = await getValidAccessToken();
            expect(token).toBe("fresh-token");

            const stored = getStoredTokens();
            expect(stored?.accessToken).toBe("fresh-token");
            expect(stored?.refreshToken).toBe("refresh-def");
        });

        it("keeps the old refresh token when the refresh response doesn't include a new one", async () => {
            seedTokens({ accessToken: "expired", refreshToken: "refresh-abc", expiresAt: Date.now() - 1000 });
            setSharedBackendConfig({ baseUrl: "https://iam.example-hospital.test", issuer: "https://idp.example-hospital.test", clientId: "modelforge-desktop" });
            mockFetchSequence([{ ok: true, json: DISCOVERY_DOC }, { ok: true, json: { access_token: "fresh-token", expires_in: 3600 } }]);

            await getValidAccessToken();
            expect(getStoredTokens()?.refreshToken).toBe("refresh-abc");
        });

        it("returns null when expired with no refresh token to use", async () => {
            seedTokens({ accessToken: "expired", expiresAt: Date.now() - 1000 });
            expect(await getValidAccessToken()).toBeNull();
        });

        it("returns null when expired and no shared backend is configured to refresh against", async () => {
            seedTokens({ accessToken: "expired", refreshToken: "refresh-abc", expiresAt: Date.now() - 1000 });
            expect(await getValidAccessToken()).toBeNull();
        });

        it("propagates a refresh failure rather than silently returning a stale token", async () => {
            seedTokens({ accessToken: "expired", refreshToken: "refresh-abc", expiresAt: Date.now() - 1000 });
            setSharedBackendConfig({ baseUrl: "https://iam.example-hospital.test", issuer: "https://idp.example-hospital.test", clientId: "modelforge-desktop" });
            mockFetchSequence([{ ok: true, json: DISCOVERY_DOC }, { ok: false, status: 401, text: "invalid_grant" }]);

            await expect(getValidAccessToken()).rejects.toThrow(/Token refresh failed/);
        });
    });

    describe("connect", () => {
        it("throws immediately, before any network call, when no shared backend is configured", async () => {
            const fetchMock = vi.fn();
            vi.stubGlobal("fetch", fetchMock);
            await expect(connect()).rejects.toThrow(/No shared backend is configured/);
            expect(fetchMock).not.toHaveBeenCalled();
        });

        it("binds state, nonce, PKCE, and the code exchange to a random loopback callback", async () => {
            setSharedBackendConfig({
                baseUrl: "https://iam.example-hospital.test",
                issuer: DISCOVERY_DOC.issuer,
                clientId: "modelforge-desktop",
            });

            let authorizationUrl: URL | undefined;
            let idToken = "";
            vi.spyOn(shell, "openExternal").mockImplementation(async (rawUrl) => {
                authorizationUrl = new URL(rawUrl);
                const state = authorizationUrl.searchParams.get("state");
                const nonce = authorizationUrl.searchParams.get("nonce");
                const redirectUri = authorizationUrl.searchParams.get("redirect_uri");
                expect(state).toMatch(/^[A-Za-z0-9_-]{40,}$/);
                expect(nonce).toMatch(/^[A-Za-z0-9_-]{40,}$/);
                expect(nonce).not.toBe(state);
                expect(redirectUri).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/oauth\/callback$/);
                idToken = signIdToken(nonce!);

                const callback = new URL(redirectUri!);
                callback.searchParams.set("code", "authorization-code-123");
                callback.searchParams.set("state", state!);
                expect(await getLoopback(callback)).toBe(200);
            });

            const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
                const url = String(input);
                if (url.endsWith("/.well-known/openid-configuration")) {
                    return { ok: true, status: 200, statusText: "OK", json: async () => DISCOVERY_DOC };
                }
                if (url === DISCOVERY_DOC.token_endpoint) {
                    return {
                        ok: true,
                        status: 200,
                        statusText: "OK",
                        json: async () => ({ access_token: "access-token-123", id_token: idToken, token_type: "Bearer", expires_in: 3600 }),
                    };
                }
                if (url === DISCOVERY_DOC.jwks_uri) {
                    return { ok: true, status: 200, statusText: "OK", json: async () => ({ keys: [ID_TOKEN_JWK] }) };
                }
                throw new Error(`Unexpected fetch: ${url} (${init?.method ?? "GET"})`);
            });
            vi.stubGlobal("fetch", fetchMock);

            await connect();

            expect(getStoredTokens()?.accessToken).toBe("access-token-123");
            const tokenCall = fetchMock.mock.calls.find(([input]) => String(input) === DISCOVERY_DOC.token_endpoint);
            expect(tokenCall).toBeDefined();
            const tokenBody = tokenCall![1]?.body as URLSearchParams;
            expect(tokenBody.get("redirect_uri")).toBe(authorizationUrl!.searchParams.get("redirect_uri"));
            expect(tokenBody.get("code")).toBe("authorization-code-123");
            const expectedChallenge = crypto.createHash("sha256").update(tokenBody.get("code_verifier")!).digest("base64url");
            expect(authorizationUrl!.searchParams.get("code_challenge")).toBe(expectedChallenge);
        });

        it("fails closed on a callback state mismatch before exchanging the code", async () => {
            setSharedBackendConfig({
                baseUrl: "https://iam.example-hospital.test",
                issuer: DISCOVERY_DOC.issuer,
                clientId: "modelforge-desktop",
            });
            const fetchMock = mockFetchSequence([{ ok: true, json: DISCOVERY_DOC }]);
            vi.spyOn(shell, "openExternal").mockImplementation(async (rawUrl) => {
                const authorizationUrl = new URL(rawUrl);
                const callback = new URL(authorizationUrl.searchParams.get("redirect_uri")!);
                callback.searchParams.set("code", "attacker-code");
                callback.searchParams.set("state", "wrong-state");
                expect(await getLoopback(callback)).toBe(400);
            });

            await expect(connect()).rejects.toThrow(/state mismatch/);
            expect(fetchMock).toHaveBeenCalledTimes(1);
            expect(getStoredTokens()).toBeNull();
        });

        it("rejects a signed ID token whose nonce does not match the authorization attempt", async () => {
            setSharedBackendConfig({
                baseUrl: "https://iam.example-hospital.test",
                issuer: DISCOVERY_DOC.issuer,
                clientId: "modelforge-desktop",
            });
            let idToken = "";
            vi.spyOn(shell, "openExternal").mockImplementation(async (rawUrl) => {
                const authorizationUrl = new URL(rawUrl);
                const callback = new URL(authorizationUrl.searchParams.get("redirect_uri")!);
                idToken = signIdToken("different-nonce");
                callback.searchParams.set("code", "authorization-code-123");
                callback.searchParams.set("state", authorizationUrl.searchParams.get("state")!);
                expect(await getLoopback(callback)).toBe(200);
            });
            vi.stubGlobal(
                "fetch",
                vi.fn(async (input: string | URL | Request) => {
                    const url = String(input);
                    if (url.endsWith("/.well-known/openid-configuration")) return { ok: true, status: 200, statusText: "OK", json: async () => DISCOVERY_DOC };
                    if (url === DISCOVERY_DOC.token_endpoint) {
                        return {
                            ok: true,
                            status: 200,
                            statusText: "OK",
                            json: async () => ({ access_token: "access", id_token: idToken, token_type: "Bearer" }),
                        };
                    }
                    if (url === DISCOVERY_DOC.jwks_uri) return { ok: true, status: 200, statusText: "OK", json: async () => ({ keys: [ID_TOKEN_JWK] }) };
                    throw new Error(`Unexpected fetch: ${url}`);
                })
            );

            await expect(connect()).rejects.toThrow(/nonce mismatch/);
            expect(getStoredTokens()).toBeNull();
        });
    });
});
