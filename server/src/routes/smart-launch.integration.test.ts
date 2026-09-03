import { randomBytes } from "node:crypto";
import { afterEach, describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { SignJWT, exportJWK, generateKeyPair, createLocalJWKSet, type JWTVerifyGetKey, type CryptoKey } from "jose";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../app.js";
import { InMemoryAuditStore } from "../store/audit-store.js";
import { InMemoryCaseStore } from "../store/in-memory-case-store.js";
import { InMemoryIamStore } from "../store/in-memory-iam-store.js";
import { InMemoryIdempotencyStore } from "../store/in-memory-idempotency-store.js";

/**
 * HTTP-level integration tests for routes/smart-launch.ts — mirrors
 * hl7.integration.test.ts's own setup/rationale: unit coverage of the PKCE/
 * discovery/token-exchange logic lives in smart-launch/service.test.ts, so
 * this file is specifically about route wiring, IAM enforcement, the
 * "requires an existing ModelForge session first" design (every route sits
 * behind the same authPreHandler as everything else), and that a completed
 * token's secrets never appear in any response body.
 */
const ISSUER = "https://idp.example-hospital.test/realms/clinical";
const AUDIENCE = "modelforge-iam-server";
const KID = "test-key";
const EHR_ISSUER = "https://ehr.example-hospital.test/fhir";
const REDIRECT_URI = "https://modelforge.example.test/smart/callback";
const ENCRYPTION_KEY = randomBytes(32);

describe("SMART App Launch (client role): end-to-end route security", () => {
    let privateKey: CryptoKey;
    let jwks: JWTVerifyGetKey;
    let app: FastifyInstance;

    beforeAll(async () => {
        const pair = await generateKeyPair("RS256");
        privateKey = pair.privateKey;
        const publicJwk = await exportJWK(pair.publicKey);
        publicJwk.kid = KID;
        publicJwk.alg = "RS256";
        jwks = createLocalJWKSet({ keys: [publicJwk] });
    });

    beforeEach(() => {
        const auditStore = new InMemoryAuditStore();
        app = buildApp({
            store: new InMemoryIamStore(auditStore),
            caseStore: new InMemoryCaseStore(auditStore),
            idempotencyStore: new InMemoryIdempotencyStore(),
            auditStore,
            jwks,
            oidc: { issuer: ISSUER, audience: AUDIENCE },
            smartLaunchEncryptionKey: ENCRYPTION_KEY,
        });
    });

    afterEach(() => vi.unstubAllGlobals());

    async function tokenFor(subject: string, extra?: Record<string, unknown>): Promise<string> {
        return new SignJWT({ sub: subject, ...extra }).setProtectedHeader({ alg: "RS256", kid: KID }).setIssuedAt().setIssuer(ISSUER).setAudience(AUDIENCE).setExpirationTime("1h").sign(privateKey);
    }

    async function createOrg(adminSubject: string): Promise<{ orgId: string; adminToken: string }> {
        const adminToken = await tokenFor(adminSubject, { name: "Dr. Admin" });
        const response = await app.inject({ method: "POST", url: "/organizations", headers: { authorization: `Bearer ${adminToken}` }, payload: { name: "Example Health System" } });
        expect(response.statusCode).toBe(201);
        return { orgId: response.json().organization.id, adminToken };
    }

    async function createUserWithSmartLaunchUse(orgId: string, adminToken: string, externalSubject: string): Promise<string> {
        const policy = await app.inject({
            method: "POST",
            url: `/organizations/${orgId}/policies`,
            headers: { authorization: `Bearer ${adminToken}` },
            payload: { name: "smart-launch-use", document: { version: "2026-01-01", statements: [{ effect: "Allow", actions: ["smartLaunch:use"], resources: ["*"] }] } },
        });
        expect(policy.statusCode).toBe(201);
        const user = await app.inject({
            method: "POST",
            url: `/organizations/${orgId}/users`,
            headers: { authorization: `Bearer ${adminToken}` },
            payload: { externalSubject, displayName: "Dr. Other", policyIds: [policy.json().id] },
        });
        expect(user.statusCode).toBe(201);
        return tokenFor(externalSubject);
    }

    async function addTrustedIssuer(orgId: string, adminToken: string, redirectUris: string[] = [REDIRECT_URI]) {
        const response = await app.inject({
            method: "PUT",
            url: `/organizations/${orgId}/smart/trusted-issuers`,
            headers: { authorization: `Bearer ${adminToken}` },
            payload: { issuer: EHR_ISSUER, clientId: "modelforge-client", redirectUris },
        });
        expect(response.statusCode).toBe(200);
        return response.json();
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

    function stubDiscoveryAndTokenExchange(payload: Record<string, unknown>, status = 200) {
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

    describe("trusted issuer administration", () => {
        it("lets an authorized admin upsert and list a trusted issuer, and reject one lacking smartLaunch:manage", async () => {
            const { orgId, adminToken } = await createOrg("idp|dr-admin");
            const trusted = await addTrustedIssuer(orgId, adminToken);
            expect(trusted).toMatchObject({ issuer: EHR_ISSUER, clientId: "modelforge-client", redirectUris: [REDIRECT_URI] });

            const list = await app.inject({ method: "GET", url: `/organizations/${orgId}/smart/trusted-issuers`, headers: { authorization: `Bearer ${adminToken}` } });
            expect(list.statusCode).toBe(200);
            expect(list.json().trustedIssuers).toHaveLength(1);

            await app.inject({ method: "POST", url: `/organizations/${orgId}/users`, headers: { authorization: `Bearer ${adminToken}` }, payload: { externalSubject: "idp|no-rights", displayName: "No Rights" } });
            const strangerToken = await tokenFor("idp|no-rights");
            const forbidden = await app.inject({ method: "PUT", url: `/organizations/${orgId}/smart/trusted-issuers`, headers: { authorization: `Bearer ${strangerToken}` }, payload: { issuer: EHR_ISSUER, clientId: "x", redirectUris: [REDIRECT_URI] } });
            expect(forbidden.statusCode).toBe(403);

            const listForbidden = await app.inject({ method: "GET", url: `/organizations/${orgId}/smart/trusted-issuers`, headers: { authorization: `Bearer ${strangerToken}` } });
            expect(listForbidden.statusCode).toBe(403);
        });

        it("lets a smartLaunch:use-only caller (no manage rights) read the trusted-issuer list — needed to pick one to launch against — but not write it", async () => {
            const { orgId, adminToken } = await createOrg("idp|dr-admin");
            await addTrustedIssuer(orgId, adminToken);
            const clinicianToken = await createUserWithSmartLaunchUse(orgId, adminToken, "idp|clinician");

            const list = await app.inject({ method: "GET", url: `/organizations/${orgId}/smart/trusted-issuers`, headers: { authorization: `Bearer ${clinicianToken}` } });
            expect(list.statusCode).toBe(200);
            expect(list.json().trustedIssuers).toHaveLength(1);

            const forbiddenWrite = await app.inject({ method: "PUT", url: `/organizations/${orgId}/smart/trusted-issuers`, headers: { authorization: `Bearer ${clinicianToken}` }, payload: { issuer: EHR_ISSUER, clientId: "x", redirectUris: [REDIRECT_URI] } });
            expect(forbiddenWrite.statusCode).toBe(403);
        });

        it("deletes a trusted issuer, 404ing identically on a second delete", async () => {
            const { orgId, adminToken } = await createOrg("idp|dr-admin");
            await addTrustedIssuer(orgId, adminToken);
            const del = await app.inject({ method: "POST", url: `/organizations/${orgId}/smart/trusted-issuers/delete`, headers: { authorization: `Bearer ${adminToken}` }, payload: { issuer: EHR_ISSUER } });
            expect(del.statusCode).toBe(204);
            const delAgain = await app.inject({ method: "POST", url: `/organizations/${orgId}/smart/trusted-issuers/delete`, headers: { authorization: `Bearer ${adminToken}` }, payload: { issuer: EHR_ISSUER } });
            expect(delAgain.statusCode).toBe(404);
        });
    });

    describe("launch flow", () => {
        it("requires the caller to already hold a ModelForge session — no unauthenticated entry point", async () => {
            const { orgId } = await createOrg("idp|dr-admin");
            const response = await app.inject({ method: "POST", url: `/organizations/${orgId}/smart/launch-sessions`, payload: { issuer: EHR_ISSUER, redirectUri: REDIRECT_URI } });
            expect(response.statusCode).toBe(401);
        });

        it("starts a launch session against a trusted issuer and returns an authorization URL with PKCE + state", async () => {
            const { orgId, adminToken } = await createOrg("idp|dr-admin");
            await addTrustedIssuer(orgId, adminToken);
            stubDiscovery();

            const response = await app.inject({
                method: "POST",
                url: `/organizations/${orgId}/smart/launch-sessions`,
                headers: { authorization: `Bearer ${adminToken}` },
                payload: { issuer: EHR_ISSUER, redirectUri: REDIRECT_URI },
            });
            expect(response.statusCode).toBe(201);
            const body = response.json();
            expect(body.session).toMatchObject({ issuer: EHR_ISSUER, status: "pending" });
            const url = new URL(body.authorizationUrl);
            expect(url.searchParams.get("state")).toBe(body.session.id);
            expect(url.searchParams.get("code_challenge_method")).toBe("S256");
        });

        it("rejects a launch against an issuer not on this organization's trusted allowlist with 422", async () => {
            const { orgId, adminToken } = await createOrg("idp|dr-admin");
            const response = await app.inject({
                method: "POST",
                url: `/organizations/${orgId}/smart/launch-sessions`,
                headers: { authorization: `Bearer ${adminToken}` },
                payload: { issuer: EHR_ISSUER, redirectUri: REDIRECT_URI },
            });
            expect(response.statusCode).toBe(422);
            expect(response.json()).toMatchObject({ error: "untrusted_issuer" });
        });

        it("completes the callback, exchanging the code and never returning secrets in the response body", async () => {
            const { orgId, adminToken } = await createOrg("idp|dr-admin");
            await addTrustedIssuer(orgId, adminToken);
            stubDiscovery();
            const start = await app.inject({
                method: "POST",
                url: `/organizations/${orgId}/smart/launch-sessions`,
                headers: { authorization: `Bearer ${adminToken}` },
                payload: { issuer: EHR_ISSUER, redirectUri: REDIRECT_URI },
            });
            const state = start.json().session.id;

            stubDiscoveryAndTokenExchange({ access_token: "real-access-token", refresh_token: "real-refresh-token", expires_in: 3600, patient: "epic-patient-123", scope: "patient/*.read launch" });
            const callback = await app.inject({
                method: "POST",
                url: `/organizations/${orgId}/smart/launch-sessions/${state}/callback`,
                headers: { authorization: `Bearer ${adminToken}` },
                payload: { code: "auth-code-xyz" },
            });
            expect(callback.statusCode).toBe(201);
            const token = callback.json();
            expect(token).toMatchObject({ issuer: EHR_ISSUER, patientId: "epic-patient-123", hasRefreshToken: true });
            expect(JSON.stringify(token)).not.toContain("real-access-token");
            expect(JSON.stringify(token)).not.toContain("real-refresh-token");

            const sessions = await app.inject({ method: "GET", url: `/organizations/${orgId}/smart/sessions`, headers: { authorization: `Bearer ${adminToken}` } });
            expect(sessions.statusCode).toBe(200);
            expect(sessions.json().sessions).toHaveLength(1);
            expect(JSON.stringify(sessions.json())).not.toContain("real-access-token");
        });

        it("refuses to complete a launch for a different user than the one who started it", async () => {
            const { orgId, adminToken } = await createOrg("idp|dr-admin");
            await addTrustedIssuer(orgId, adminToken);
            stubDiscovery();
            const start = await app.inject({
                method: "POST",
                url: `/organizations/${orgId}/smart/launch-sessions`,
                headers: { authorization: `Bearer ${adminToken}` },
                payload: { issuer: EHR_ISSUER, redirectUri: REDIRECT_URI },
            });
            const state = start.json().session.id;

            const otherToken = await createUserWithSmartLaunchUse(orgId, adminToken, "idp|other-clinician");
            const callback = await app.inject({
                method: "POST",
                url: `/organizations/${orgId}/smart/launch-sessions/${state}/callback`,
                headers: { authorization: `Bearer ${otherToken}` },
                payload: { code: "auth-code-xyz" },
            });
            expect(callback.statusCode).toBe(403);
        });

        it("503s the callback when SMART_LAUNCH_ENCRYPTION_KEY is not configured, rather than encrypting with no real key", async () => {
            const auditStore = new InMemoryAuditStore();
            const unkeyedApp = buildApp({
                store: new InMemoryIamStore(auditStore),
                caseStore: new InMemoryCaseStore(auditStore),
                idempotencyStore: new InMemoryIdempotencyStore(),
                auditStore,
                jwks,
                oidc: { issuer: ISSUER, audience: AUDIENCE },
            });
            const adminToken = await tokenFor("idp|dr-admin", { name: "Dr. Admin" });
            const orgResponse = await unkeyedApp.inject({ method: "POST", url: "/organizations", headers: { authorization: `Bearer ${adminToken}` }, payload: { name: "Example Health System" } });
            const orgId = orgResponse.json().organization.id;
            const response = await unkeyedApp.inject({
                method: "POST",
                url: `/organizations/${orgId}/smart/launch-sessions/some-state/callback`,
                headers: { authorization: `Bearer ${adminToken}` },
                payload: { code: "auth-code-xyz" },
            });
            expect(response.statusCode).toBe(503);
        });
    });

    describe("session management", () => {
        it("lets a caller revoke their own session, 404ing identically for one they don't own", async () => {
            const { orgId, adminToken } = await createOrg("idp|dr-admin");
            await addTrustedIssuer(orgId, adminToken);
            stubDiscovery();
            const start = await app.inject({
                method: "POST",
                url: `/organizations/${orgId}/smart/launch-sessions`,
                headers: { authorization: `Bearer ${adminToken}` },
                payload: { issuer: EHR_ISSUER, redirectUri: REDIRECT_URI },
            });
            const state = start.json().session.id;
            stubDiscoveryAndTokenExchange({ access_token: "real-access-token", expires_in: 3600, patient: "epic-patient-123" });
            const callback = await app.inject({
                method: "POST",
                url: `/organizations/${orgId}/smart/launch-sessions/${state}/callback`,
                headers: { authorization: `Bearer ${adminToken}` },
                payload: { code: "auth-code-xyz" },
            });
            const sessionId = callback.json().id;

            const otherToken = await createUserWithSmartLaunchUse(orgId, adminToken, "idp|other-clinician");
            const notOwner = await app.inject({ method: "POST", url: `/organizations/${orgId}/smart/sessions/${sessionId}/revoke`, headers: { authorization: `Bearer ${otherToken}` } });
            expect(notOwner.statusCode).toBe(404);

            const revoke = await app.inject({ method: "POST", url: `/organizations/${orgId}/smart/sessions/${sessionId}/revoke`, headers: { authorization: `Bearer ${adminToken}` } });
            expect(revoke.statusCode).toBe(204);

            const revokeAgain = await app.inject({ method: "POST", url: `/organizations/${orgId}/smart/sessions/${sessionId}/revoke`, headers: { authorization: `Bearer ${adminToken}` } });
            expect(revokeAgain.statusCode).toBe(404);
        });

        it("rejects a caller without smartLaunch:use with 403", async () => {
            const { orgId, adminToken } = await createOrg("idp|dr-admin");
            await app.inject({ method: "POST", url: `/organizations/${orgId}/users`, headers: { authorization: `Bearer ${adminToken}` }, payload: { externalSubject: "idp|no-rights", displayName: "No Rights" } });
            const strangerToken = await tokenFor("idp|no-rights");
            const response = await app.inject({ method: "GET", url: `/organizations/${orgId}/smart/sessions`, headers: { authorization: `Bearer ${strangerToken}` } });
            expect(response.statusCode).toBe(403);
        });
    });
});
