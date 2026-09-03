import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InMemorySmartLaunchStore } from "../store/in-memory-smart-launch-store.js";
import type { TenantContext } from "../tenant-context.js";
import { decryptToken } from "./token-crypto.js";
import { completeLaunchCallback, createLaunchSession, SmartLaunchCallbackError, SmartLaunchError } from "./service.js";

const actor = () => ({ externalSubject: "idp|clinician", userId: "user-1", organizationId: "org-1" });

function tenantContext(): TenantContext {
    return { organizationId: "org-1", schemaName: "tenant_" + "0".repeat(32), issuer: "test", subject: "test" };
}

const ISSUER = "https://ehr.example-hospital.test/fhir";
const REDIRECT_URI = "https://modelforge.example.test/smart/callback";
const KEY = randomBytes(32);

async function setupTrustedIssuer(overrides: { redirectUris?: string[] } = {}) {
    const store = new InMemorySmartLaunchStore();
    const repo = store.forTenant(tenantContext());
    await repo.upsertTrustedIssuer({ issuer: ISSUER, clientId: "modelforge-client", redirectUris: overrides.redirectUris ?? [REDIRECT_URI], addedByUserId: "admin-1" }, actor());
    return repo;
}

function stubDiscovery() {
    vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string) => {
            if (url.endsWith("/.well-known/smart-configuration")) {
                return new Response(JSON.stringify({ authorization_endpoint: "https://ehr.example-hospital.test/auth", token_endpoint: "https://ehr.example-hospital.test/token" }), { status: 200 });
            }
            throw new Error(`unexpected fetch to ${url}`);
        })
    );
}

describe("createLaunchSession", () => {
    afterEach(() => vi.unstubAllGlobals());

    it("builds a correct authorization URL with PKCE, state, and default scopes", async () => {
        const repo = await setupTrustedIssuer();
        stubDiscovery();
        const { session, authorizationUrl } = await createLaunchSession({ repo, requestedByUserId: "user-1", issuer: ISSUER, redirectUri: REDIRECT_URI, actor: actor() });

        expect(session.status).toBe("pending");
        expect(session.issuer).toBe(ISSUER);
        const url = new URL(authorizationUrl);
        expect(url.origin + url.pathname).toBe("https://ehr.example-hospital.test/auth");
        expect(url.searchParams.get("response_type")).toBe("code");
        expect(url.searchParams.get("client_id")).toBe("modelforge-client");
        expect(url.searchParams.get("redirect_uri")).toBe(REDIRECT_URI);
        expect(url.searchParams.get("state")).toBe(session.id);
        expect(url.searchParams.get("aud")).toBe(ISSUER);
        expect(url.searchParams.get("code_challenge_method")).toBe("S256");
        expect(url.searchParams.get("code_challenge")).toBeTruthy();
        expect(url.searchParams.get("scope")).toBe("launch patient/*.read openid fhirUser");
    });

    it("includes the launch param only when an EHR launch token is supplied", async () => {
        const repo = await setupTrustedIssuer();
        stubDiscovery();
        const withLaunch = await createLaunchSession({ repo, requestedByUserId: "user-1", issuer: ISSUER, redirectUri: REDIRECT_URI, launch: "abc123", actor: actor() });
        expect(new URL(withLaunch.authorizationUrl).searchParams.get("launch")).toBe("abc123");

        const withoutLaunch = await createLaunchSession({ repo, requestedByUserId: "user-1", issuer: ISSUER, redirectUri: REDIRECT_URI, actor: actor() });
        expect(new URL(withoutLaunch.authorizationUrl).searchParams.has("launch")).toBe(false);
    });

    it("rejects an issuer that isn't in this organization's trusted allowlist", async () => {
        const store = new InMemorySmartLaunchStore();
        const repo = store.forTenant(tenantContext());
        const failure = await createLaunchSession({ repo, requestedByUserId: "user-1", issuer: "https://untrusted.test/fhir", redirectUri: REDIRECT_URI, actor: actor() }).catch((e) => e);
        expect(failure).toBeInstanceOf(SmartLaunchError);
        expect(failure).toMatchObject({ code: "untrusted_issuer" });
    });

    it("rejects a redirectUri that isn't on the trusted issuer's own allowlist — the open-redirect/code-theft guard", async () => {
        const repo = await setupTrustedIssuer();
        await expect(createLaunchSession({ repo, requestedByUserId: "user-1", issuer: ISSUER, redirectUri: "https://attacker.test/steal", actor: actor() }))
            .rejects.toMatchObject({ code: "invalid_redirect_uri" });
    });

    it("wraps a discovery failure as SmartLaunchError with code discovery_failed", async () => {
        const repo = await setupTrustedIssuer();
        vi.stubGlobal("fetch", vi.fn(async () => new Response("not found", { status: 404 })));
        await expect(createLaunchSession({ repo, requestedByUserId: "user-1", issuer: ISSUER, redirectUri: REDIRECT_URI, actor: actor() }))
            .rejects.toMatchObject({ code: "discovery_failed" });
    });

    it("respects an explicit scopes list instead of the default", async () => {
        const repo = await setupTrustedIssuer();
        stubDiscovery();
        const { authorizationUrl } = await createLaunchSession({ repo, requestedByUserId: "user-1", issuer: ISSUER, redirectUri: REDIRECT_URI, scopes: ["patient/Observation.read"], actor: actor() });
        expect(new URL(authorizationUrl).searchParams.get("scope")).toBe("patient/Observation.read");
    });
});

describe("completeLaunchCallback", () => {
    afterEach(() => vi.unstubAllGlobals());

    async function launch(repo: Awaited<ReturnType<typeof setupTrustedIssuer>>) {
        stubDiscovery();
        const { session } = await createLaunchSession({ repo, requestedByUserId: "user-1", issuer: ISSUER, redirectUri: REDIRECT_URI, actor: actor() });
        return session;
    }

    function stubTokenExchange(payload: Record<string, unknown>, status = 200) {
        vi.stubGlobal(
            "fetch",
            vi.fn(async (url: string, init?: { method?: string }) => {
                if (url.endsWith("/.well-known/smart-configuration")) {
                    return new Response(JSON.stringify({ authorization_endpoint: "https://ehr.example-hospital.test/auth", token_endpoint: "https://ehr.example-hospital.test/token" }), { status: 200 });
                }
                if (url === "https://ehr.example-hospital.test/token" && init?.method === "POST") {
                    return new Response(JSON.stringify(payload), { status });
                }
                throw new Error(`unexpected fetch to ${url}`);
            })
        );
    }

    it("exchanges the code, encrypts and stores the token, and marks the session completed", async () => {
        const repo = await setupTrustedIssuer();
        const session = await launch(repo);
        stubTokenExchange({ access_token: "real-access-token", refresh_token: "real-refresh-token", expires_in: 3600, patient: "epic-patient-123", scope: "patient/*.read launch" });

        const token = await completeLaunchCallback({ repo, state: session.id, code: "auth-code-xyz", callerId: "user-1", encryptionKey: KEY, actor: actor() });
        expect(token).toMatchObject({ issuer: ISSUER, patientId: "epic-patient-123", hasRefreshToken: true, scope: "patient/*.read launch" });
        expect(token).not.toHaveProperty("encryptedAccessToken");

        const stored = await repo.getToken(token.id);
        expect(decryptToken(stored!.encryptedAccessToken, KEY)).toBe("real-access-token");
        expect(decryptToken(stored!.encryptedRefreshToken!, KEY)).toBe("real-refresh-token");

        const completedSession = await repo.getLaunchSession(session.id);
        expect(completedSession?.status).toBe("completed");
    });

    it("rejects a state with no matching session", async () => {
        const repo = await setupTrustedIssuer();
        await expect(completeLaunchCallback({ repo, state: "does-not-exist", code: "x", callerId: "user-1", encryptionKey: KEY, actor: actor() }))
            .rejects.toMatchObject({ code: "session_not_found" });
    });

    it("refuses to complete a session for a DIFFERENT user than the one who created it", async () => {
        const repo = await setupTrustedIssuer();
        const session = await launch(repo);
        await expect(completeLaunchCallback({ repo, state: session.id, code: "x", callerId: "someone-else", encryptionKey: KEY, actor: actor() }))
            .rejects.toMatchObject({ code: "forbidden" });
    });

    it("refuses to complete the same session twice (single-use state)", async () => {
        const repo = await setupTrustedIssuer();
        const session = await launch(repo);
        stubTokenExchange({ access_token: "token-1", expires_in: 3600 });
        await completeLaunchCallback({ repo, state: session.id, code: "code-1", callerId: "user-1", encryptionKey: KEY, actor: actor() });

        await expect(completeLaunchCallback({ repo, state: session.id, code: "code-2", callerId: "user-1", encryptionKey: KEY, actor: actor() }))
            .rejects.toMatchObject({ code: "session_not_pending" });
    });

    it("rejects an expired session", async () => {
        const repo = await setupTrustedIssuer();
        stubDiscovery();
        const past = new Date("2020-01-01T00:00:00Z");
        const session = await createLaunchSession({ repo, requestedByUserId: "user-1", issuer: ISSUER, redirectUri: REDIRECT_URI, actor: actor(), now: past }).then((r) => r.session);
        await expect(completeLaunchCallback({ repo, state: session.id, code: "x", callerId: "user-1", encryptionKey: KEY, actor: actor(), now: new Date() }))
            .rejects.toMatchObject({ code: "session_expired" });
    });

    it("wraps a non-2xx token endpoint response as token_exchange_failed, never leaking the raw response body", async () => {
        const repo = await setupTrustedIssuer();
        const session = await launch(repo);
        stubTokenExchange({ error: "invalid_grant", error_description: "internal-secret-detail" }, 400);
        const failure = await completeLaunchCallback({ repo, state: session.id, code: "x", callerId: "user-1", encryptionKey: KEY, actor: actor() }).catch((e) => e);
        expect(failure).toBeInstanceOf(SmartLaunchCallbackError);
        expect(failure.message).not.toContain("internal-secret-detail");
    });

    it("rejects a token response with no access_token", async () => {
        const repo = await setupTrustedIssuer();
        const session = await launch(repo);
        stubTokenExchange({ token_type: "Bearer" });
        await expect(completeLaunchCallback({ repo, state: session.id, code: "x", callerId: "user-1", encryptionKey: KEY, actor: actor() }))
            .rejects.toMatchObject({ code: "token_exchange_failed" });
    });
});
