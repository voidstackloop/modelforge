import { randomUUID } from "node:crypto";
import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { SignJWT, exportJWK, generateKeyPair, createLocalJWKSet, type JWTVerifyGetKey, type CryptoKey } from "jose";
import type { FastifyInstance } from "fastify";
import { buildApp } from "./app.js";
import { InMemoryAuditStore } from "./store/audit-store.js";
import { InMemoryCaseStore } from "./store/in-memory-case-store.js";
import { InMemoryIamStore } from "./store/in-memory-iam-store.js";
import { InMemoryIdempotencyStore } from "./store/in-memory-idempotency-store.js";
import { InMemoryPrincipalStore } from "./store/in-memory-principal-store.js";
import { StoreTenantDirectory } from "./tenant-context.js";
import { patientCaseFixture } from "./test/patient-case-fixture.js";

const ISSUER = "https://idp.example-hospital.test/realms/clinical";
const AUDIENCE = "modelforge-iam-server";
const KID = "test-key";

describe("modelforge-medical-iam-server: end-to-end", () => {
    let privateKey: CryptoKey;
    let jwks: JWTVerifyGetKey;
    let app: FastifyInstance;
    let store: InMemoryIamStore;
    let auditStore: InMemoryAuditStore;

    beforeAll(async () => {
        const pair = await generateKeyPair("RS256");
        privateKey = pair.privateKey;
        const publicJwk = await exportJWK(pair.publicKey);
        publicJwk.kid = KID;
        publicJwk.alg = "RS256";
        jwks = createLocalJWKSet({ keys: [publicJwk] });
    });

    beforeEach(() => {
        // One shared InMemoryAuditStore for `store`/`caseStore`/the audit
        // route itself — same reason index.ts's real wiring shares one
        // instance (see that file's own comment): GET .../audit needs to
        // see mutations from both IamStore and CaseStore in one place.
        auditStore = new InMemoryAuditStore();
        store = new InMemoryIamStore(auditStore);
        app = buildApp({
            store,
            caseStore: new InMemoryCaseStore(auditStore),
            idempotencyStore: new InMemoryIdempotencyStore(),
            auditStore,
            jwks,
            oidc: { issuer: ISSUER, audience: AUDIENCE },
        });
    });

    async function tokenFor(subject: string, extra?: Record<string, unknown>): Promise<string> {
        return new SignJWT({ sub: subject, ...extra })
            .setProtectedHeader({ alg: "RS256", kid: KID })
            .setIssuedAt()
            .setIssuer(ISSUER)
            .setAudience(AUDIENCE)
            .setExpirationTime("1h")
            .sign(privateKey);
    }

    it("GET /health requires no authentication", async () => {
        const response = await app.inject({ method: "GET", url: "/health" });
        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual({ status: "ok" });
    });

    it("sets baseline security headers on every response (helmet)", async () => {
        const response = await app.inject({ method: "GET", url: "/health" });
        expect(response.headers["x-content-type-options"]).toBe("nosniff");
        // CSP is deliberately off — this service never serves HTML, see
        // app.ts's registration comment.
        expect(response.headers["content-security-policy"]).toBeUndefined();
    });

    it("rejects a malformed JSON body with 400, not the generic 500 (Fastify's own parse error carries its own statusCode)", async () => {
        const token = await tokenFor("idp|dr-admin");
        const response = await app.inject({
            method: "POST",
            url: "/organizations",
            headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
            payload: "{ not valid json",
        });
        expect(response.statusCode).toBe(400);
        expect(response.json().error).toBe("request_error");
    });

    it("rejects a malformed (non-UUID) organizationId with 400, not a store error", async () => {
        const token = await tokenFor("idp|dr-admin");
        const response = await app.inject({
            method: "GET",
            url: "/organizations/not-a-uuid",
            headers: { authorization: `Bearer ${token}` },
        });
        expect(response.statusCode).toBe(400);
        expect(response.json().error).toBe("invalid_request");
    });

    describe("GET /health with a healthCheck configured", () => {
        it("reports ok when the check passes", async () => {
            const healthyApp = buildApp({
                store,
                caseStore: new InMemoryCaseStore(), idempotencyStore: new InMemoryIdempotencyStore(), auditStore: new InMemoryAuditStore(),
                jwks,
                oidc: { issuer: ISSUER, audience: AUDIENCE },
                healthCheck: async () => true,
            });
            const response = await healthyApp.inject({ method: "GET", url: "/health" });
            expect(response.statusCode).toBe(200);
            expect(response.json()).toEqual({ status: "ok" });
        });

        it("reports 503 degraded when the check fails, rather than throwing", async () => {
            const degradedApp = buildApp({
                store,
                caseStore: new InMemoryCaseStore(), idempotencyStore: new InMemoryIdempotencyStore(), auditStore: new InMemoryAuditStore(),
                jwks,
                oidc: { issuer: ISSUER, audience: AUDIENCE },
                healthCheck: async () => false,
            });
            const response = await degradedApp.inject({ method: "GET", url: "/health" });
            expect(response.statusCode).toBe(503);
            expect(response.json()).toEqual({ status: "degraded" });
        });
    });

    describe("GET /health/live and /health/ready (split liveness/readiness contracts)", () => {
        it("/health/live never depends on healthCheck — always ok, even when the backing check would fail", async () => {
            const degradedApp = buildApp({
                store,
                caseStore: new InMemoryCaseStore(), idempotencyStore: new InMemoryIdempotencyStore(), auditStore: new InMemoryAuditStore(),
                jwks,
                oidc: { issuer: ISSUER, audience: AUDIENCE },
                healthCheck: async () => false,
            });
            const response = await degradedApp.inject({ method: "GET", url: "/health/live" });
            expect(response.statusCode).toBe(200);
            expect(response.json()).toEqual({ status: "ok" });
        });

        it("/health/ready mirrors the original /health contract: ok when the check passes, 503 degraded when it fails", async () => {
            const degradedApp = buildApp({
                store,
                caseStore: new InMemoryCaseStore(), idempotencyStore: new InMemoryIdempotencyStore(), auditStore: new InMemoryAuditStore(),
                jwks,
                oidc: { issuer: ISSUER, audience: AUDIENCE },
                healthCheck: async () => false,
            });
            const ready = await degradedApp.inject({ method: "GET", url: "/health/ready" });
            expect(ready.statusCode).toBe(503);
            expect(ready.json()).toEqual({ status: "degraded" });

            const healthyApp = buildApp({
                store,
                caseStore: new InMemoryCaseStore(), idempotencyStore: new InMemoryIdempotencyStore(), auditStore: new InMemoryAuditStore(),
                jwks,
                oidc: { issuer: ISSUER, audience: AUDIENCE },
                healthCheck: async () => true,
            });
            const okResponse = await healthyApp.inject({ method: "GET", url: "/health/ready" });
            expect(okResponse.statusCode).toBe(200);
        });

        it("/health/ready with no healthCheck configured (in-memory store) reports ok, same as /health", async () => {
            const response = await app.inject({ method: "GET", url: "/health/ready" });
            expect(response.statusCode).toBe(200);
            expect(response.json()).toEqual({ status: "ok" });
        });
    });

    describe("GET /metrics (metrics.ts — PHI-free Prometheus exposition)", () => {
        it("requires no authentication by default and returns Prometheus exposition text", async () => {
            const response = await app.inject({ method: "GET", url: "/metrics" });
            expect(response.statusCode).toBe(200);
            expect(response.headers["content-type"]).toContain("text/plain");
            // Default process metrics (prom-client's collectDefaultMetrics) —
            // proves the registry is wired up even with zero API traffic yet.
            expect(response.body).toContain("process_cpu_user_seconds_total");
            expect(response.body).toContain("# HELP modelforge_http_request_duration_seconds");
            expect(response.body).toContain("# HELP modelforge_authz_decision_duration_seconds");
            expect(response.body).toContain("# HELP modelforge_audit_write_total");
        });

        it("never records itself in http_request_duration_seconds (would otherwise skew p95/p99 with scrape polling)", async () => {
            await app.inject({ method: "GET", url: "/metrics" });
            await app.inject({ method: "GET", url: "/metrics" });
            const response = await app.inject({ method: "GET", url: "/metrics" });
            expect(response.body).not.toMatch(/modelforge_http_request_duration_seconds_count\{[^}]*route="\/metrics"/);
        });

        it("never records /health, /health/live, or /health/ready in http_request_duration_seconds either", async () => {
            await app.inject({ method: "GET", url: "/health" });
            await app.inject({ method: "GET", url: "/health/live" });
            await app.inject({ method: "GET", url: "/health/ready" });
            const response = await app.inject({ method: "GET", url: "/metrics" });
            expect(response.body).not.toMatch(/modelforge_http_request_duration_seconds_count\{[^}]*route="\/health/);
        });

        describe("with METRICS_TOKEN configured (BuildAppOptions.metricsToken)", () => {
            it("rejects a missing or wrong bearer token with 401, and accepts the correct one", async () => {
                const gatedApp = buildApp({
                    store,
                    caseStore: new InMemoryCaseStore(), idempotencyStore: new InMemoryIdempotencyStore(), auditStore: new InMemoryAuditStore(),
                    jwks,
                    oidc: { issuer: ISSUER, audience: AUDIENCE },
                    metricsToken: "secret-scrape-token",
                });

                const noAuth = await gatedApp.inject({ method: "GET", url: "/metrics" });
                expect(noAuth.statusCode).toBe(401);

                const wrongAuth = await gatedApp.inject({
                    method: "GET",
                    url: "/metrics",
                    headers: { authorization: "Bearer wrong-token" },
                });
                expect(wrongAuth.statusCode).toBe(401);

                const rightAuth = await gatedApp.inject({
                    method: "GET",
                    url: "/metrics",
                    headers: { authorization: "Bearer secret-scrape-token" },
                });
                expect(rightAuth.statusCode).toBe(200);
            });
        });

        it("reports cache-stat gauges when BuildAppOptions.cacheStats is supplied, and always registers the metric even without it", async () => {
            // Checked first, against the default `app` (built with no
            // `cacheStats` option, this describe block's outer beforeEach):
            // the metric must still be registered (so a scraper never sees
            // "unknown metric" purely because caching happens to be
            // disabled) even though nothing has ever `.set()` a value for
            // it yet. Deliberately not asserting "no series at all" here —
            // metrics.ts's registry is one process-wide singleton (see its
            // own doc comment on why), so a *value* set by some other app
            // instance sharing this registry is legitimately still visible;
            // that's real, documented behavior (exactly how the one real
            // process in index.ts uses it — one app, one registry), not
            // something a per-app-instance test should assert against.
            const withoutStats = await app.inject({ method: "GET", url: "/metrics" });
            expect(withoutStats.body).toContain("# HELP modelforge_authorization_cache_stat");

            const withStatsApp = buildApp({
                store,
                caseStore: new InMemoryCaseStore(), idempotencyStore: new InMemoryIdempotencyStore(), auditStore: new InMemoryAuditStore(),
                jwks,
                oidc: { issuer: ISSUER, audience: AUDIENCE },
                cacheStats: async () => ({
                    users: {
                        hits: 3, misses: 1, size: 2, loads: 1, coalesced: 0, loadTimeMsTotal: 12,
                        evictions: 0, expirations: 0, invalidations: 0, redisErrors: 0, degraded: false,
                    },
                }),
            });
            const response = await withStatsApp.inject({ method: "GET", url: "/metrics" });
            expect(response.body).toMatch(/modelforge_authorization_cache_stat\{cache="users",stat="hits"\} 3/);
            expect(response.body).toMatch(/modelforge_authorization_cache_degraded\{cache="users"\} 0/);
        });
    });

    describe("rate limiting (@fastify/rate-limit, opt-in via BuildAppOptions.rateLimit)", () => {
        it("is off by default — many requests to the same endpoint never trip a limit", async () => {
            // Every other test in this file relies on this: it makes many
            // app.inject() calls per test against an app built with no
            // rateLimit option.
            for (let i = 0; i < 10; i++) {
                const response = await app.inject({ method: "GET", url: "/health" });
                expect(response.statusCode).toBe(200);
            }
        });

        it("returns 429 once the configured limit is exceeded", async () => {
            const limitedApp = buildApp({
                store,
                caseStore: new InMemoryCaseStore(), idempotencyStore: new InMemoryIdempotencyStore(), auditStore: new InMemoryAuditStore(),
                jwks,
                oidc: { issuer: ISSUER, audience: AUDIENCE },
                rateLimit: { max: 2, windowMs: 60_000 },
            });
            const token = await tokenFor("idp|dr-admin");
            const request = () => limitedApp.inject({ method: "GET", url: "/me", headers: { authorization: `Bearer ${token}` } });

            expect((await request()).statusCode).toBe(200);
            expect((await request()).statusCode).toBe(200);
            const limited = await request();
            expect(limited.statusCode).toBe(429); // not 500 — see the error handler's statusCode passthrough
        });

        it("exempts every health contract from the limit so probes are never throttled", async () => {
            const limitedApp = buildApp({
                store,
                caseStore: new InMemoryCaseStore(), idempotencyStore: new InMemoryIdempotencyStore(), auditStore: new InMemoryAuditStore(),
                jwks,
                oidc: { issuer: ISSUER, audience: AUDIENCE },
                rateLimit: { max: 2, windowMs: 60_000 },
            });
            for (const url of ["/health", "/health/live", "/health/ready?probe=orchestrator"]) {
                for (let i = 0; i < 5; i++) {
                    const response = await limitedApp.inject({ method: "GET", url });
                    expect(response.statusCode).toBe(200);
                }
            }
        });

        describe("trustProxy", () => {
            it("without trustProxy (the default), X-Forwarded-For is ignored — requests share one bucket regardless of the header", async () => {
                const limitedApp = buildApp({
                    store,
                    caseStore: new InMemoryCaseStore(), idempotencyStore: new InMemoryIdempotencyStore(), auditStore: new InMemoryAuditStore(),
                    jwks,
                    oidc: { issuer: ISSUER, audience: AUDIENCE },
                    rateLimit: { max: 1, windowMs: 60_000 },
                });
                const token = await tokenFor("idp|dr-admin");
                const request = (forwardedFor: string) =>
                    limitedApp.inject({
                        method: "GET",
                        url: "/me",
                        headers: { authorization: `Bearer ${token}`, "x-forwarded-for": forwardedFor },
                    });

                expect((await request("1.1.1.1")).statusCode).toBe(200);
                // A *different* claimed client IP still lands in the same
                // bucket — the header is untrusted noise without trustProxy.
                expect((await request("2.2.2.2")).statusCode).toBe(429);
            });

            it("with trustProxy enabled, distinct X-Forwarded-For values get independent rate-limit buckets", async () => {
                const trustingApp = buildApp({
                    store,
                    caseStore: new InMemoryCaseStore(), idempotencyStore: new InMemoryIdempotencyStore(), auditStore: new InMemoryAuditStore(),
                    jwks,
                    oidc: { issuer: ISSUER, audience: AUDIENCE },
                    rateLimit: { max: 1, windowMs: 60_000 },
                    trustProxy: true,
                });
                const token = await tokenFor("idp|dr-admin");
                const request = (forwardedFor: string) =>
                    trustingApp.inject({
                        method: "GET",
                        url: "/me",
                        headers: { authorization: `Bearer ${token}`, "x-forwarded-for": forwardedFor },
                    });

                expect((await request("3.3.3.3")).statusCode).toBe(200);
                expect((await request("3.3.3.3")).statusCode).toBe(429); // same claimed IP, second request in-window
                expect((await request("4.4.4.4")).statusCode).toBe(200); // different claimed IP — its own, unused bucket
            });
        });
    });

    it("rejects a protected route with no Authorization header", async () => {
        const response = await app.inject({ method: "GET", url: "/me" });
        expect(response.statusCode).toBe(401);
        expect(response.json().error).toBe("missing_bearer_token");
    });

    it("rejects a protected route with a garbage bearer token", async () => {
        const response = await app.inject({ method: "GET", url: "/me", headers: { authorization: "Bearer not-a-real-token" } });
        expect(response.statusCode).toBe(401);
        expect(response.json().error).toBe("invalid_bearer_token");
    });

    it("POST /organizations bootstraps an organization and makes the caller its admin", async () => {
        const token = await tokenFor("idp|dr-admin", { email: "admin@example-hospital.test", name: "Dr. Admin" });

        const response = await app.inject({
            method: "POST",
            url: "/organizations",
            headers: { authorization: `Bearer ${token}` },
            payload: { name: "Example Health System" },
        });

        expect(response.statusCode).toBe(201);
        const body = response.json();
        expect(body.organization.name).toBe("Example Health System");
        expect(body.user.displayName).toBe("Dr. Admin");
        expect(body.user.organizationId).toBe(body.organization.id);
    });

    it("POST /organizations rejects a body with no name", async () => {
        const token = await tokenFor("idp|dr-admin");
        const response = await app.inject({
            method: "POST",
            url: "/organizations",
            headers: { authorization: `Bearer ${token}` },
            payload: {},
        });
        expect(response.statusCode).toBe(400);
        expect(response.json().error).toBe("invalid_request");
    });

    describe("bootstrap failure recovery (compensating cleanup — routes/organizations.ts)", () => {
        // A failure at any step after createOrganization must not leave a
        // half-formed, permanently-unusable organization behind — POST
        // /organizations is the only way to become admin of a new org, so
        // an orphaned one (no admin policy/user/membership) can never be
        // completed by any other route. Each case injects a failure into a
        // different downstream step to prove the same cleanup fires
        // regardless of *where* bootstrap breaks, not just for one
        // hand-picked failure point.
        type TestDeps = { store: InMemoryIamStore; principalStore: InMemoryPrincipalStore; tenantDirectory: StoreTenantDirectory };
        // A minimal structural type capturing only what these tests call on
        // a spy — sidesteps vitest's MockInstance<T> being invariant in its
        // wrapped function's parameter types, which otherwise makes an
        // array of spies over methods with different signatures a type
        // error despite every element being a perfectly real spy.
        type Rejectable = { mockRejectedValueOnce: (value: unknown) => void };

        const injectionPoints: [string, (deps: TestDeps) => Rejectable][] = [
            ["tenantDirectory.provision", (deps) => vi.spyOn(deps.tenantDirectory, "provision")],
            ["store.createPolicy", (deps) => vi.spyOn(deps.store, "createPolicy")],
            ["principalStore.upsertIdentity", (deps) => vi.spyOn(deps.principalStore, "upsertIdentity")],
            ["store.createUser", (deps) => vi.spyOn(deps.store, "createUser")],
            ["principalStore.ensureMembership", (deps) => vi.spyOn(deps.principalStore, "ensureMembership")],
        ];

        it.each(injectionPoints)(
            "a failure in %s deletes the orphaned organization rather than leaving it half-formed",
            async (_label, spyOn) => {
                const localAuditStore = new InMemoryAuditStore();
                const localStore = new InMemoryIamStore(localAuditStore);
                const principalStore = new InMemoryPrincipalStore(localAuditStore);
                const tenantDirectory = new StoreTenantDirectory(localStore);
                const deleteSpy = vi.spyOn(localStore, "deleteOrganization");
                spyOn({ store: localStore, principalStore, tenantDirectory }).mockRejectedValueOnce(new Error("simulated failure"));

                const localApp = buildApp({
                    store: localStore,
                    caseStore: new InMemoryCaseStore(localAuditStore),
                    idempotencyStore: new InMemoryIdempotencyStore(),
                    auditStore: localAuditStore,
                    principalStore,
                    tenantDirectory,
                    jwks,
                    oidc: { issuer: ISSUER, audience: AUDIENCE },
                });

                const token = await tokenFor("idp|doomed-bootstrap");
                const response = await localApp.inject({
                    method: "POST",
                    url: "/organizations",
                    headers: { authorization: `Bearer ${token}` },
                    payload: { name: "Doomed Org" },
                });

                expect(response.statusCode).toBe(500); // the real error propagates, not swallowed by cleanup
                expect(deleteSpy).toHaveBeenCalledTimes(1);
                const deletedId = deleteSpy.mock.calls[0][0];
                expect(await localStore.getOrganization(deletedId)).toBeNull(); // genuinely gone, not just "attempted"
            }
        );

        it("a cleanup failure never masks the original bootstrap error", async () => {
            const localAuditStore = new InMemoryAuditStore();
            const localStore = new InMemoryIamStore(localAuditStore);
            vi.spyOn(localStore, "deleteOrganization").mockRejectedValueOnce(new Error("cleanup itself also failed"));
            const principalStore = new InMemoryPrincipalStore(localAuditStore);
            vi.spyOn(principalStore, "ensureMembership").mockRejectedValueOnce(new Error("original bootstrap failure"));

            const localApp = buildApp({
                store: localStore,
                caseStore: new InMemoryCaseStore(localAuditStore),
                idempotencyStore: new InMemoryIdempotencyStore(),
                auditStore: localAuditStore,
                principalStore,
                jwks,
                oidc: { issuer: ISSUER, audience: AUDIENCE },
            });

            const token = await tokenFor("idp|double-failure");
            const response = await localApp.inject({
                method: "POST",
                url: "/organizations",
                headers: { authorization: `Bearer ${token}` },
                payload: { name: "Doubly Doomed Org" },
            });
            expect(response.statusCode).toBe(500); // still surfaces as the original bootstrap failure, not a 200/hang
        });

        it("a successful bootstrap never calls deleteOrganization", async () => {
            const localAuditStore = new InMemoryAuditStore();
            const localStore = new InMemoryIamStore(localAuditStore);
            const deleteSpy = vi.spyOn(localStore, "deleteOrganization");
            const localApp = buildApp({
                store: localStore,
                caseStore: new InMemoryCaseStore(localAuditStore),
                idempotencyStore: new InMemoryIdempotencyStore(),
                auditStore: localAuditStore,
                jwks,
                oidc: { issuer: ISSUER, audience: AUDIENCE },
            });
            const token = await tokenFor("idp|clean-bootstrap");
            const response = await localApp.inject({
                method: "POST",
                url: "/organizations",
                headers: { authorization: `Bearer ${token}` },
                payload: { name: "Healthy Org" },
            });
            expect(response.statusCode).toBe(201);
            expect(deleteSpy).not.toHaveBeenCalled();
        });
    });

    describe("with a bootstrapped organization", () => {
        let orgId: string;
        let adminToken: string;

        beforeEach(async () => {
            adminToken = await tokenFor("idp|dr-admin", { name: "Dr. Admin" });
            const response = await app.inject({
                method: "POST",
                url: "/organizations",
                headers: { authorization: `Bearer ${adminToken}` },
                payload: { name: "Example Health System" },
            });
            orgId = response.json().organization.id;
        });

        it("the admin can read the organization; an outsider with a valid token but no account cannot", async () => {
            const adminRead = await app.inject({
                method: "GET",
                url: `/organizations/${orgId}`,
                headers: { authorization: `Bearer ${adminToken}` },
            });
            expect(adminRead.statusCode).toBe(200);

            const outsiderToken = await tokenFor("idp|outsider");
            const outsiderRead = await app.inject({
                method: "GET",
                url: `/organizations/${orgId}`,
                headers: { authorization: `Bearer ${outsiderToken}` },
            });
            expect(outsiderRead.statusCode).toBe(403);
        });

        it("real request traffic shows up in GET /metrics's http_request_duration_seconds and authz_decision_duration_seconds", async () => {
            // GET .../users unconditionally calls requirePermission (routes/
            // users.ts: "iam:listUsers") before doing anything else, unlike
            // GET /organizations/:organizationId (deliberately ungated, see
            // that route's own comment) — needed here specifically so this
            // request is guaranteed to produce an authz_decision_duration_seconds
            // sample, not just an http_request_duration_seconds one.
            const allowed = await app.inject({
                method: "GET",
                url: `/organizations/${orgId}/users`,
                headers: { authorization: `Bearer ${adminToken}` },
            });
            expect(allowed.statusCode).toBe(200);

            const metrics = await app.inject({ method: "GET", url: "/metrics" });
            // Route *pattern*, not the resolved URL — proves the ':organizationId'
            // path parameter is never itself a label value (see metrics.ts's
            // PHI-safety doc comment: an unbounded/tenant-identifying label
            // would defeat the whole point of this metric).
            expect(metrics.body).toMatch(
                /modelforge_http_request_duration_seconds_count\{method="GET",route="\/organizations\/:organizationId\/users",status_code="200"\} \d+/
            );
            expect(metrics.body).toMatch(/modelforge_authz_decision_duration_seconds_count\{effect="allow"\} \d+/);
        });

        it("GET /me lists the caller's organization membership and effective policy names", async () => {
            const response = await app.inject({ method: "GET", url: "/me", headers: { authorization: `Bearer ${adminToken}` } });
            const body = response.json();
            expect(body.memberships).toHaveLength(1);
            expect(body.memberships[0].organization.id).toBe(orgId);
            expect(body.memberships[0].effectivePolicyNames).toContain("OrganizationAdmin");
        });

        it("the admin can create a new user with zero default permissions, and that user starts unable to list users", async () => {
            const createResponse = await app.inject({
                method: "POST",
                url: `/organizations/${orgId}/users`,
                headers: { authorization: `Bearer ${adminToken}` },
                payload: { externalSubject: "idp|clinician-1", displayName: "Dr. Clinician" },
            });
            expect(createResponse.statusCode).toBe(201);
            expect(createResponse.json().policyIds).toEqual([]);

            const clinicianToken = await tokenFor("idp|clinician-1");
            const listAsClinicianResponse = await app.inject({
                method: "GET",
                url: `/organizations/${orgId}/users`,
                headers: { authorization: `Bearer ${clinicianToken}` },
            });
            expect(listAsClinicianResponse.statusCode).toBe(403);
        });

        it("granting a policy via a group takes effect on /authz/check, and only for the actions it covers", async () => {
            await app.inject({
                method: "POST",
                url: `/organizations/${orgId}/users`,
                headers: { authorization: `Bearer ${adminToken}` },
                payload: { externalSubject: "idp|clinician-1", displayName: "Dr. Clinician" },
            });
            const usersList = await app.inject({
                method: "GET",
                url: `/organizations/${orgId}/users`,
                headers: { authorization: `Bearer ${adminToken}` },
            });
            const clinicianUserId = usersList.json().find((u: { externalSubject: string }) => u.externalSubject === "idp|clinician-1").id;

            const policyResponse = await app.inject({
                method: "POST",
                url: `/organizations/${orgId}/policies`,
                headers: { authorization: `Bearer ${adminToken}` },
                payload: {
                    name: "CaseViewers",
                    document: {
                        version: "2026-01-01",
                        statements: [{ effect: "Allow", actions: ["patientCase:view"], resources: ["*"] }],
                    },
                },
            });
            const policyId = policyResponse.json().id;

            const groupResponse = await app.inject({
                method: "POST",
                url: `/organizations/${orgId}/groups`,
                headers: { authorization: `Bearer ${adminToken}` },
                payload: { name: "Clinicians", policyIds: [policyId] },
            });
            const groupId = groupResponse.json().id;

            await app.inject({
                method: "PATCH",
                url: `/organizations/${orgId}/users/${clinicianUserId}`,
                headers: { authorization: `Bearer ${adminToken}` },
                payload: { groupIds: [groupId] },
            });

            const clinicianToken = await tokenFor("idp|clinician-1");
            const allowedCheck = await app.inject({
                method: "POST",
                url: `/organizations/${orgId}/authz/check`,
                headers: { authorization: `Bearer ${clinicianToken}` },
                payload: { action: "patientCase:view", resource: `organization:${orgId}/patientCase:case-1` },
            });
            expect(allowedCheck.json().effect).toBe("Allow");

            const deniedCheck = await app.inject({
                method: "POST",
                url: `/organizations/${orgId}/authz/check`,
                headers: { authorization: `Bearer ${clinicianToken}` },
                payload: { action: "patientCase:delete", resource: `organization:${orgId}/patientCase:case-1` },
            });
            expect(deniedCheck.json().effect).toBe("Deny");
        });

        it("/authz/check rejects a resource naming a different organization, even for a caller holding a resources: [\"*\"] policy", async () => {
            // A resources: ["*"] policy is entirely legal within one's own
            // org (the previous test exercises exactly that) — the point
            // here is that it must never let this endpoint answer for a
            // DIFFERENT organization's resource string.
            const policyResponse = await app.inject({
                method: "POST",
                url: `/organizations/${orgId}/policies`,
                headers: { authorization: `Bearer ${adminToken}` },
                payload: {
                    name: "WildcardViewers",
                    document: { version: "2026-01-01", statements: [{ effect: "Allow", actions: ["*"], resources: ["*"] }] },
                },
            });
            await app.inject({
                method: "POST",
                url: `/organizations/${orgId}/users`,
                headers: { authorization: `Bearer ${adminToken}` },
                payload: { externalSubject: "idp|wildcard-user", displayName: "Wildcard User", policyIds: [policyResponse.json().id] },
            });

            const otherOrgToken = await tokenFor("idp|other-org-admin-authz", { name: "Other Org Admin" });
            const otherOrg = await app.inject({
                method: "POST",
                url: "/organizations",
                headers: { authorization: `Bearer ${otherOrgToken}` },
                payload: { name: "A Different Hospital" },
            });
            const otherOrgId = otherOrg.json().organization.id;

            const wildcardUserToken = await tokenFor("idp|wildcard-user");
            const crossOrgCheck = await app.inject({
                method: "POST",
                url: `/organizations/${orgId}/authz/check`,
                headers: { authorization: `Bearer ${wildcardUserToken}` },
                payload: { action: "patientCase:view", resource: `organization:${otherOrgId}/patientCase:case-1` },
            });
            expect(crossOrgCheck.statusCode).toBe(400);

            // The same caller, same wildcard policy, asking about their own
            // org's resource, still works exactly as before.
            const ownOrgCheck = await app.inject({
                method: "POST",
                url: `/organizations/${orgId}/authz/check`,
                headers: { authorization: `Bearer ${wildcardUserToken}` },
                payload: { action: "patientCase:view", resource: `organization:${orgId}/patientCase:case-1` },
            });
            expect(ownOrgCheck.json().effect).toBe("Allow");
        });

        describe("separation of duties: manageUsers/manageGroups alone cannot attach a policy", () => {
            async function userManagerOnlyToken(): Promise<string> {
                // A policy granting iam:manageUsers/iam:manageGroups but
                // deliberately *not* iam:managePolicies — the "HR-style"
                // user administrator this system's own fine-grained policy
                // model is supposed to make possible.
                const policyResponse = await app.inject({
                    method: "POST",
                    url: `/organizations/${orgId}/policies`,
                    headers: { authorization: `Bearer ${adminToken}` },
                    payload: {
                        name: "UserManagerOnly",
                        document: {
                            version: "2026-01-01",
                            statements: [
                                {
                                    effect: "Allow",
                                    actions: ["iam:manageUsers", "iam:manageGroups", "iam:listUsers", "iam:listPolicies"],
                                    resources: [`organization:${orgId}`],
                                },
                            ],
                        },
                    },
                });
                const token = await tokenFor("idp|user-manager");
                await app.inject({
                    method: "POST",
                    url: `/organizations/${orgId}/users`,
                    headers: { authorization: `Bearer ${adminToken}` },
                    payload: { externalSubject: "idp|user-manager", displayName: "User Manager", policyIds: [policyResponse.json().id] },
                });
                return token;
            }

            it("cannot create a user with policyIds attached", async () => {
                const managerToken = await userManagerOnlyToken();
                const response = await app.inject({
                    method: "POST",
                    url: `/organizations/${orgId}/users`,
                    headers: { authorization: `Bearer ${managerToken}` },
                    // A syntactically valid (but nonexistent) UUID — this
                    // test is proving the iam:managePolicies gate fires
                    // before the store is ever consulted, not exercising
                    // the .uuid() format check itself (see case-store.test.ts
                    // and the "not-a-uuid" tests below for that).
                    payload: { externalSubject: "idp|target", displayName: "Target", policyIds: ["00000000-0000-0000-0000-000000000000"] },
                });
                expect(response.statusCode).toBe(403);
            });

            it("can still create a user with no policyIds/groupIds (ordinary user administration keeps working)", async () => {
                const managerToken = await userManagerOnlyToken();
                const response = await app.inject({
                    method: "POST",
                    url: `/organizations/${orgId}/users`,
                    headers: { authorization: `Bearer ${managerToken}` },
                    payload: { externalSubject: "idp|target", displayName: "Target" },
                });
                expect(response.statusCode).toBe(201);
            });

            it("cannot attach a policyId to an existing user via PATCH, including self-granting the builtin admin policy", async () => {
                const managerToken = await userManagerOnlyToken();
                const policiesList = await app.inject({
                    method: "GET",
                    url: `/organizations/${orgId}/policies`,
                    headers: { authorization: `Bearer ${managerToken}` },
                });
                const adminPolicyId = policiesList.json().find((p: { builtin: boolean }) => p.builtin).id;
                const usersList = await app.inject({
                    method: "GET",
                    url: `/organizations/${orgId}/users`,
                    headers: { authorization: `Bearer ${managerToken}` },
                });
                const selfUserId = usersList.json().find((u: { externalSubject: string }) => u.externalSubject === "idp|user-manager").id;

                const escalate = await app.inject({
                    method: "PATCH",
                    url: `/organizations/${orgId}/users/${selfUserId}`,
                    headers: { authorization: `Bearer ${managerToken}` },
                    payload: { policyIds: [adminPolicyId] },
                });
                expect(escalate.statusCode).toBe(403);
            });

            it("can still assign an existing groupId to a user via PATCH (ordinary group-membership administration keeps working)", async () => {
                const managerToken = await userManagerOnlyToken();
                const groupResponse = await app.inject({
                    method: "POST",
                    url: `/organizations/${orgId}/groups`,
                    headers: { authorization: `Bearer ${adminToken}` },
                    payload: { name: "Clinicians" },
                });
                const usersList = await app.inject({
                    method: "GET",
                    url: `/organizations/${orgId}/users`,
                    headers: { authorization: `Bearer ${managerToken}` },
                });
                const selfUserId = usersList.json().find((u: { externalSubject: string }) => u.externalSubject === "idp|user-manager").id;

                const response = await app.inject({
                    method: "PATCH",
                    url: `/organizations/${orgId}/users/${selfUserId}`,
                    headers: { authorization: `Bearer ${managerToken}` },
                    payload: { groupIds: [groupResponse.json().id] },
                });
                expect(response.statusCode).toBe(200);
            });

            it("cannot create a group with policyIds attached", async () => {
                const managerToken = await userManagerOnlyToken();
                const response = await app.inject({
                    method: "POST",
                    url: `/organizations/${orgId}/groups`,
                    headers: { authorization: `Bearer ${managerToken}` },
                    payload: { name: "SelfMadeAdmins", policyIds: ["00000000-0000-0000-0000-000000000000"] },
                });
                expect(response.statusCode).toBe(403);
            });

            it("cannot attach a policyId to an existing group via PATCH", async () => {
                const managerToken = await userManagerOnlyToken();
                const groupResponse = await app.inject({
                    method: "POST",
                    url: `/organizations/${orgId}/groups`,
                    headers: { authorization: `Bearer ${adminToken}` },
                    payload: { name: "Clinicians" },
                });

                const response = await app.inject({
                    method: "PATCH",
                    url: `/organizations/${orgId}/groups/${groupResponse.json().id}`,
                    headers: { authorization: `Bearer ${managerToken}` },
                    payload: { policyIds: ["00000000-0000-0000-0000-000000000000"] },
                });
                expect(response.statusCode).toBe(403);
            });
        });

        describe("permission boundaries (domain/policy-evaluator.ts's evaluateWithBoundary, routes/guards.ts)", () => {
            it("a boundary caps an otherwise-unrestricted user to what the boundary itself allows", async () => {
                const wideOpenPolicy = await app.inject({
                    method: "POST",
                    url: `/organizations/${orgId}/policies`,
                    headers: { authorization: `Bearer ${adminToken}` },
                    payload: { name: "WideOpen", document: { version: "2026-01-01", statements: [{ effect: "Allow", actions: ["*"], resources: ["*"] }] } },
                });
                const boundaryPolicy = await app.inject({
                    method: "POST",
                    url: `/organizations/${orgId}/policies`,
                    headers: { authorization: `Bearer ${adminToken}` },
                    payload: {
                        name: "ViewOnlyBoundary",
                        document: { version: "2026-01-01", statements: [{ effect: "Allow", actions: ["patientCase:view"], resources: ["*"] }] },
                    },
                });
                await app.inject({
                    method: "POST",
                    url: `/organizations/${orgId}/users`,
                    headers: { authorization: `Bearer ${adminToken}` },
                    payload: {
                        externalSubject: "idp|bounded-admin",
                        displayName: "Bounded Admin",
                        policyIds: [wideOpenPolicy.json().id],
                        permissionBoundaryPolicyId: boundaryPolicy.json().id,
                    },
                });

                const boundedToken = await tokenFor("idp|bounded-admin");
                const allowedCheck = await app.inject({
                    method: "POST",
                    url: `/organizations/${orgId}/authz/check`,
                    headers: { authorization: `Bearer ${boundedToken}` },
                    payload: { action: "patientCase:view", resource: `organization:${orgId}/patientCase:case-1` },
                });
                expect(allowedCheck.json().effect).toBe("Allow");

                // The wide-open policy alone would allow this — the
                // boundary is what actually caps it.
                const cappedCheck = await app.inject({
                    method: "POST",
                    url: `/organizations/${orgId}/authz/check`,
                    headers: { authorization: `Bearer ${boundedToken}` },
                    payload: { action: "patientCase:delete", resource: `organization:${orgId}/patientCase:case-1` },
                });
                expect(cappedCheck.json().effect).toBe("Deny");
            });

            it("setting a permissionBoundaryPolicyId is gated behind iam:managePolicies, same as policyIds", async () => {
                const managerPolicy = await app.inject({
                    method: "POST",
                    url: `/organizations/${orgId}/policies`,
                    headers: { authorization: `Bearer ${adminToken}` },
                    payload: {
                        name: "UserManagerOnlyForBoundaryTest",
                        document: {
                            version: "2026-01-01",
                            statements: [{ effect: "Allow", actions: ["iam:manageUsers"], resources: [`organization:${orgId}`] }],
                        },
                    },
                });
                await app.inject({
                    method: "POST",
                    url: `/organizations/${orgId}/users`,
                    headers: { authorization: `Bearer ${adminToken}` },
                    payload: { externalSubject: "idp|manager-2", displayName: "Manager", policyIds: [managerPolicy.json().id] },
                });
                const managerToken = await tokenFor("idp|manager-2");

                const response = await app.inject({
                    method: "POST",
                    url: `/organizations/${orgId}/users`,
                    headers: { authorization: `Bearer ${managerToken}` },
                    payload: {
                        externalSubject: "idp|target-2",
                        displayName: "Target",
                        permissionBoundaryPolicyId: "00000000-0000-0000-0000-000000000000",
                    },
                });
                expect(response.statusCode).toBe(403);
            });

            it("a boundary that references a since-deleted policy fails closed (denies everything), not open", async () => {
                const wideOpenPolicy = await app.inject({
                    method: "POST",
                    url: `/organizations/${orgId}/policies`,
                    headers: { authorization: `Bearer ${adminToken}` },
                    payload: {
                        name: "WideOpenForDanglingTest",
                        document: { version: "2026-01-01", statements: [{ effect: "Allow", actions: ["*"], resources: ["*"] }] },
                    },
                });
                const boundaryPolicy = await app.inject({
                    method: "POST",
                    url: `/organizations/${orgId}/policies`,
                    headers: { authorization: `Bearer ${adminToken}` },
                    payload: {
                        name: "DoomedBoundary",
                        document: { version: "2026-01-01", statements: [{ effect: "Allow", actions: ["patientCase:view"], resources: ["*"] }] },
                    },
                });
                await app.inject({
                    method: "POST",
                    url: `/organizations/${orgId}/users`,
                    headers: { authorization: `Bearer ${adminToken}` },
                    payload: {
                        externalSubject: "idp|dangling-boundary-user",
                        displayName: "Dangling Boundary User",
                        policyIds: [wideOpenPolicy.json().id],
                        permissionBoundaryPolicyId: boundaryPolicy.json().id,
                    },
                });

                await app.inject({
                    method: "DELETE",
                    url: `/organizations/${orgId}/policies/${boundaryPolicy.json().id}`,
                    headers: { authorization: `Bearer ${adminToken}` },
                });

                const affectedToken = await tokenFor("idp|dangling-boundary-user");
                // Even the action the boundary WOULD have allowed while it
                // existed is now denied — a missing boundary must never be
                // treated as "no boundary" (unrestricted).
                const check = await app.inject({
                    method: "POST",
                    url: `/organizations/${orgId}/authz/check`,
                    headers: { authorization: `Bearer ${affectedToken}` },
                    payload: { action: "patientCase:view", resource: `organization:${orgId}/patientCase:case-1` },
                });
                expect(check.json().effect).toBe("Deny");
            });
        });

        it("PATCH on a user id that belongs to a different organization is 404, not a cross-org edit", async () => {
            const otherOrgToken = await tokenFor("idp|other-admin", { name: "Other Admin" });
            const otherOrgResponse = await app.inject({
                method: "POST",
                url: "/organizations",
                headers: { authorization: `Bearer ${otherOrgToken}` },
                payload: { name: "A Different Hospital" },
            });
            const otherOrgAdminUserId = otherOrgResponse.json().user.id;

            const crossOrgPatch = await app.inject({
                method: "PATCH",
                url: `/organizations/${orgId}/users/${otherOrgAdminUserId}`,
                headers: { authorization: `Bearer ${adminToken}` },
                payload: { status: "suspended" },
            });
            expect(crossOrgPatch.statusCode).toBe(404);
        });

        it("PATCH a user with a policyId from a different organization is 400, not a silent cross-tenant grant", async () => {
            const otherOrgToken = await tokenFor("idp|other-admin-2", { name: "Other Admin 2" });
            const otherOrg = await app.inject({
                method: "POST",
                url: "/organizations",
                headers: { authorization: `Bearer ${otherOrgToken}` },
                payload: { name: "A Different Hospital" },
            });
            const otherOrgId = otherOrg.json().organization.id;
            const foreignPoliciesList = await app.inject({
                method: "GET",
                url: `/organizations/${otherOrgId}/policies`,
                headers: { authorization: `Bearer ${otherOrgToken}` },
            });
            // The other org's own builtin OrganizationAdmin policy — the
            // most damaging possible policy to smuggle across a tenant
            // boundary, since a successful attach would grant full admin
            // over the *other* organization.
            const foreignAdminPolicyId = foreignPoliciesList.json().find((p: { builtin: boolean }) => p.builtin).id;

            const created = await app.inject({
                method: "POST",
                url: `/organizations/${orgId}/users`,
                headers: { authorization: `Bearer ${adminToken}` },
                payload: { externalSubject: "idp|clinician-cross-org", displayName: "Dr. Clinician" },
            });
            const userId = created.json().id;

            const crossOrgAttach = await app.inject({
                method: "PATCH",
                url: `/organizations/${orgId}/users/${userId}`,
                headers: { authorization: `Bearer ${adminToken}` },
                payload: { policyIds: [foreignAdminPolicyId] },
            });
            expect(crossOrgAttach.statusCode).toBe(400);

            const reloaded = await app.inject({
                method: "GET",
                url: `/organizations/${orgId}/users`,
                headers: { authorization: `Bearer ${adminToken}` },
            });
            const clinician = reloaded.json().find((u: { id: string }) => u.id === userId);
            expect(clinician.policyIds).toEqual([]); // the attach never took effect
        });

        it("a malformed (non-UUID) policyId/groupId is rejected 400 at the boundary, on both create and update, for users and groups", async () => {
            const createUserWithBadPolicy = await app.inject({
                method: "POST",
                url: `/organizations/${orgId}/users`,
                headers: { authorization: `Bearer ${adminToken}` },
                payload: { externalSubject: "idp|bad-policy", displayName: "X", policyIds: ["not-a-uuid"] },
            });
            expect(createUserWithBadPolicy.statusCode).toBe(400);
            expect(createUserWithBadPolicy.json().error).toBe("invalid_request");

            const createUserWithBadGroup = await app.inject({
                method: "POST",
                url: `/organizations/${orgId}/users`,
                headers: { authorization: `Bearer ${adminToken}` },
                payload: { externalSubject: "idp|bad-group", displayName: "X", groupIds: ["not-a-uuid"] },
            });
            expect(createUserWithBadGroup.statusCode).toBe(400);

            const existingUser = await app.inject({
                method: "POST",
                url: `/organizations/${orgId}/users`,
                headers: { authorization: `Bearer ${adminToken}` },
                payload: { externalSubject: "idp|update-bad-policy", displayName: "X" },
            });
            const updateUserWithBadPolicy = await app.inject({
                method: "PATCH",
                url: `/organizations/${orgId}/users/${existingUser.json().id}`,
                headers: { authorization: `Bearer ${adminToken}` },
                payload: { policyIds: ["not-a-uuid"] },
            });
            expect(updateUserWithBadPolicy.statusCode).toBe(400);

            const createGroupWithBadPolicy = await app.inject({
                method: "POST",
                url: `/organizations/${orgId}/groups`,
                headers: { authorization: `Bearer ${adminToken}` },
                payload: { name: "G", policyIds: ["not-a-uuid"] },
            });
            expect(createGroupWithBadPolicy.statusCode).toBe(400);

            const existingGroup = await app.inject({
                method: "POST",
                url: `/organizations/${orgId}/groups`,
                headers: { authorization: `Bearer ${adminToken}` },
                payload: { name: "G2" },
            });
            const updateGroupWithBadPolicy = await app.inject({
                method: "PATCH",
                url: `/organizations/${orgId}/groups/${existingGroup.json().id}`,
                headers: { authorization: `Bearer ${adminToken}` },
                payload: { policyIds: ["not-a-uuid"] },
            });
            expect(updateGroupWithBadPolicy.statusCode).toBe(400);
        });

        it("the builtin OrganizationAdmin policy cannot be deleted", async () => {
            const policiesResponse = await app.inject({
                method: "GET",
                url: `/organizations/${orgId}/policies`,
                headers: { authorization: `Bearer ${adminToken}` },
            });
            const adminPolicyId = policiesResponse.json().find((p: { builtin: boolean }) => p.builtin).id;

            const deleteResponse = await app.inject({
                method: "DELETE",
                url: `/organizations/${orgId}/policies/${adminPolicyId}`,
                headers: { authorization: `Bearer ${adminToken}` },
            });
            expect(deleteResponse.statusCode).toBe(400);
            expect(deleteResponse.json().error).toBe("builtin_policy");
        });

        it("an authenticated identity with no account in this org gets Deny from /authz/check, not an error", async () => {
            const outsiderToken = await tokenFor("idp|outsider");
            const response = await app.inject({
                method: "POST",
                url: `/organizations/${orgId}/authz/check`,
                headers: { authorization: `Bearer ${outsiderToken}` },
                payload: { action: "patientCase:view", resource: `organization:${orgId}/patientCase:case-1` },
            });
            // requireOrgUser throws 403 for /authz/check too (see authz.ts's
            // doc comment: only account holders get to *ask* the question) —
            // asserting that explicitly here rather than assuming.
            expect(response.statusCode).toBe(403);
        });

        describe("patient cases (docs/SHARED_BACKEND_DESIGN.md §3, authz-gated per routes/cases.ts)", () => {
            function caseBody(id: string, extra?: Record<string, unknown>) {
                return patientCaseFixture(id, extra);
            }

            it("the org admin (broad * policy) can create, read, update, and delete a case", async () => {
                const created = await app.inject({
                    method: "POST",
                    url: `/organizations/${orgId}/cases`,
                    headers: { authorization: `Bearer ${adminToken}` },
                    payload: caseBody("case-1"),
                });
                expect(created.statusCode).toBe(201);
                const version = created.json().version;
                expect(version).toBeTruthy();

                const listed = await app.inject({
                    method: "GET",
                    url: `/organizations/${orgId}/cases`,
                    headers: { authorization: `Bearer ${adminToken}` },
                });
                expect(listed.json().cases.map((c: { id: string }) => c.id)).toContain("case-1");

                const updated = await app.inject({
                    method: "PUT",
                    url: `/organizations/${orgId}/cases/case-1`,
                    headers: { authorization: `Bearer ${adminToken}`, "if-match": version },
                    payload: caseBody("case-1", { title: "Renamed" }),
                });
                expect(updated.statusCode).toBe(200);
                expect(updated.json().title).toBe("Renamed");
                expect(updated.json().version).not.toBe(version);

                const deleted = await app.inject({
                    method: "DELETE",
                    url: `/organizations/${orgId}/cases/case-1`,
                    headers: { authorization: `Bearer ${adminToken}`, "if-match": updated.json().version },
                });
                expect(deleted.statusCode).toBe(204);
            });

            it("a user with no patientCase policy cannot create and sees a nondisclosing empty collection", async () => {
                await app.inject({
                    method: "POST",
                    url: `/organizations/${orgId}/users`,
                    headers: { authorization: `Bearer ${adminToken}` },
                    payload: { externalSubject: "idp|no-access", displayName: "No Access" },
                });
                const token = await tokenFor("idp|no-access");

                const create = await app.inject({
                    method: "POST",
                    url: `/organizations/${orgId}/cases`,
                    headers: { authorization: `Bearer ${token}` },
                    payload: caseBody("case-2"),
                });
                expect(create.statusCode).toBe(403);

                const list = await app.inject({ method: "GET", url: `/organizations/${orgId}/cases`, headers: { authorization: `Bearer ${token}` } });
                expect(list.statusCode).toBe(200);
                expect(list.json().cases).toEqual([]);
            });

            it("a view-only policy can read cases but not create/edit/delete them", async () => {
                const policy = await app.inject({
                    method: "POST",
                    url: `/organizations/${orgId}/policies`,
                    headers: { authorization: `Bearer ${adminToken}` },
                    payload: {
                        name: "CaseViewers",
                        document: { version: "2026-01-01", statements: [{ effect: "Allow", actions: ["patientCase:view"], resources: ["*"] }] },
                    },
                });
                await app.inject({
                    method: "POST",
                    url: `/organizations/${orgId}/users`,
                    headers: { authorization: `Bearer ${adminToken}` },
                    payload: { externalSubject: "idp|viewer", displayName: "Viewer", policyIds: [policy.json().id] },
                });
                const created = await app.inject({
                    method: "POST",
                    url: `/organizations/${orgId}/cases`,
                    headers: { authorization: `Bearer ${adminToken}` },
                    payload: caseBody("case-3"),
                });

                const viewerToken = await tokenFor("idp|viewer");
                const list = await app.inject({
                    method: "GET",
                    url: `/organizations/${orgId}/cases`,
                    headers: { authorization: `Bearer ${viewerToken}` },
                });
                expect(list.statusCode).toBe(200);
                expect(list.json().cases.map((c: { id: string }) => c.id)).toContain("case-3");

                const editAttempt = await app.inject({
                    method: "PUT",
                    url: `/organizations/${orgId}/cases/case-3`,
                    headers: { authorization: `Bearer ${viewerToken}`, "if-match": created.json().version },
                    payload: caseBody("case-3", { title: "Should be blocked" }),
                });
                // Object routes deliberately collapse authorization denial
                // into the same response as a nonexistent id.
                expect(editAttempt.statusCode).toBe(404);
            });

            it("PUT with a stale If-Match is rejected 412 with the current version, and never applies the write", async () => {
                const created = await app.inject({
                    method: "POST",
                    url: `/organizations/${orgId}/cases`,
                    headers: { authorization: `Bearer ${adminToken}` },
                    payload: caseBody("case-4"),
                });
                await app.inject({
                    method: "PUT",
                    url: `/organizations/${orgId}/cases/case-4`,
                    headers: { authorization: `Bearer ${adminToken}`, "if-match": created.json().version },
                    payload: caseBody("case-4", { title: "First edit" }),
                });

                // Reuses the *original* (now-stale) version — simulates a
                // second writer who loaded the case before the first edit.
                const staleEdit = await app.inject({
                    method: "PUT",
                    url: `/organizations/${orgId}/cases/case-4`,
                    headers: { authorization: `Bearer ${adminToken}`, "if-match": created.json().version },
                    payload: caseBody("case-4", { title: "Conflicting edit" }),
                });
                expect(staleEdit.statusCode).toBe(412);
                expect(staleEdit.json().current.title).toBe("First edit");
            });

            describe("Idempotency-Key (routes/idempotency.ts)", () => {
                it("a repeated Idempotency-Key with an identical body on POST replays the original 201, instead of a 409 already_exists conflict", async () => {
                    // The exact same payload object/value sent twice — a
                    // fresh caseBody() call per request would carry a new
                    // updatedAt timestamp each time, which is a genuinely
                    // *different* request body and should (correctly) not
                    // replay; this test is specifically about a true retry
                    // resending byte-identical content.
                    const payload = caseBody("case-idem-post");

                    const first = await app.inject({
                        method: "POST",
                        url: `/organizations/${orgId}/cases`,
                        headers: { authorization: `Bearer ${adminToken}`, "idempotency-key": "post-key-1" },
                        payload,
                    });
                    expect(first.statusCode).toBe(201);

                    const retry = await app.inject({
                        method: "POST",
                        url: `/organizations/${orgId}/cases`,
                        headers: { authorization: `Bearer ${adminToken}`, "idempotency-key": "post-key-1" },
                        payload,
                    });
                    expect(retry.statusCode).toBe(201);
                    expect(retry.json()).toEqual(first.json());
                });

                it("a repeated Idempotency-Key with an identical body on PUT replays the original success, even once the client's If-Match has gone stale", async () => {
                    const created = await app.inject({
                        method: "POST",
                        url: `/organizations/${orgId}/cases`,
                        headers: { authorization: `Bearer ${adminToken}` },
                        payload: caseBody("case-idem-put"),
                    });
                    const editPayload = caseBody("case-idem-put", { title: "Edited once" });

                    const firstEdit = await app.inject({
                        method: "PUT",
                        url: `/organizations/${orgId}/cases/case-idem-put`,
                        headers: { authorization: `Bearer ${adminToken}`, "if-match": created.json().version, "idempotency-key": "put-key-1" },
                        payload: editPayload,
                    });
                    expect(firstEdit.statusCode).toBe(200);

                    // Same key, same body, but the If-Match the client still
                    // has is now stale (the first edit already moved the
                    // version forward) — simulates the first response never
                    // reaching the client (timeout/dropped connection) and
                    // the client retrying with what it last knew. Without
                    // the Idempotency-Key this would be a spurious 412 (see
                    // the "stale If-Match" test above) even though the edit
                    // itself already succeeded.
                    const retryEdit = await app.inject({
                        method: "PUT",
                        url: `/organizations/${orgId}/cases/case-idem-put`,
                        headers: { authorization: `Bearer ${adminToken}`, "if-match": created.json().version, "idempotency-key": "put-key-1" },
                        payload: editPayload,
                    });
                    expect(retryEdit.statusCode).toBe(200);
                    expect(retryEdit.json()).toEqual(firstEdit.json());
                });

                it("reusing an Idempotency-Key with a different body is rejected 409, and never re-runs the write", async () => {
                    const created = await app.inject({
                        method: "POST",
                        url: `/organizations/${orgId}/cases`,
                        headers: { authorization: `Bearer ${adminToken}` },
                        payload: caseBody("case-idem-conflict"),
                    });

                    const firstEdit = await app.inject({
                        method: "PUT",
                        url: `/organizations/${orgId}/cases/case-idem-conflict`,
                        headers: { authorization: `Bearer ${adminToken}`, "if-match": created.json().version, "idempotency-key": "reuse-key-1" },
                        payload: caseBody("case-idem-conflict", { title: "First title" }),
                    });
                    expect(firstEdit.statusCode).toBe(200);

                    const reusedWithDifferentBody = await app.inject({
                        method: "PUT",
                        url: `/organizations/${orgId}/cases/case-idem-conflict`,
                        headers: { authorization: `Bearer ${adminToken}`, "if-match": created.json().version, "idempotency-key": "reuse-key-1" },
                        payload: caseBody("case-idem-conflict", { title: "Different title" }),
                    });
                    expect(reusedWithDifferentBody.statusCode).toBe(409);
                    expect(reusedWithDifferentBody.json().error).toBe("idempotency_key_reused");

                    // Confirms the second call above never reached writeOne:
                    // the stored case still has the first edit's title, not
                    // a second write, and not the conflict-current title
                    // either.
                    const current = await app.inject({
                        method: "GET",
                        url: `/organizations/${orgId}/cases`,
                        headers: { authorization: `Bearer ${adminToken}` },
                    });
                    const stored = current.json().cases.find((c: { id: string }) => c.id === "case-idem-conflict");
                    expect(stored.title).toBe("First title");
                });

                it("omitting Idempotency-Key behaves exactly as before — no caching, no replay", async () => {
                    const first = await app.inject({
                        method: "POST",
                        url: `/organizations/${orgId}/cases`,
                        headers: { authorization: `Bearer ${adminToken}` },
                        payload: caseBody("case-no-idem-key"),
                    });
                    expect(first.statusCode).toBe(201);

                    // A genuine retry with no key present hits writeOne
                    // again and correctly gets the pre-existing
                    // already_exists conflict, not a replayed 201 — proving
                    // the idempotency machinery only engages when a caller
                    // opts in.
                    const retry = await app.inject({
                        method: "POST",
                        url: `/organizations/${orgId}/cases`,
                        headers: { authorization: `Bearer ${adminToken}` },
                        payload: caseBody("case-no-idem-key"),
                    });
                    expect(retry.statusCode).toBe(409);
                    expect(retry.json().error).toBe("already_exists");
                });
            });

            it("a case created in one organization is invisible to another organization", async () => {
                await app.inject({
                    method: "POST",
                    url: `/organizations/${orgId}/cases`,
                    headers: { authorization: `Bearer ${adminToken}` },
                    payload: caseBody("case-isolated"),
                });

                const otherOrgToken = await tokenFor("idp|other-org-admin", { name: "Other Org Admin" });
                const otherOrg = await app.inject({
                    method: "POST",
                    url: "/organizations",
                    headers: { authorization: `Bearer ${otherOrgToken}` },
                    payload: { name: "A Different Hospital" },
                });
                const otherOrgId = otherOrg.json().organization.id;

                const list = await app.inject({
                    method: "GET",
                    url: `/organizations/${otherOrgId}/cases`,
                    headers: { authorization: `Bearer ${otherOrgToken}` },
                });
                expect(list.json().cases.map((c: { id: string }) => c.id)).not.toContain("case-isolated");
            });

            it("GET .../cases?since={cursor} returns only cases created after that cursor", async () => {
                const first = await app.inject({
                    method: "POST",
                    url: `/organizations/${orgId}/cases`,
                    headers: { authorization: `Bearer ${adminToken}` },
                    payload: caseBody("case-since-1"),
                });
                const cursorAfterFirst = first.json().version;

                const second = await app.inject({
                    method: "POST",
                    url: `/organizations/${orgId}/cases`,
                    headers: { authorization: `Bearer ${adminToken}` },
                    payload: caseBody("case-since-2"),
                });
                expect(second.statusCode).toBe(201);

                const sinceFirst = await app.inject({
                    method: "GET",
                    url: `/organizations/${orgId}/cases?since=${cursorAfterFirst}`,
                    headers: { authorization: `Bearer ${adminToken}` },
                });
                const idsSinceFirst = sinceFirst.json().cases.map((c: { id: string }) => c.id);
                expect(idsSinceFirst).toContain("case-since-2");
                expect(idsSinceFirst).not.toContain("case-since-1"); // created before the cursor — must not be re-sent

                const noCursor = await app.inject({
                    method: "GET",
                    url: `/organizations/${orgId}/cases`,
                    headers: { authorization: `Bearer ${adminToken}` },
                });
                const idsNoCursor = noCursor.json().cases.map((c: { id: string }) => c.id);
                expect(idsNoCursor).toEqual(expect.arrayContaining(["case-since-1", "case-since-2"])); // omitting since still returns everything
            });

            it("GET .../cases?since={malformed} fails open to returning everything, rather than erroring", async () => {
                await app.inject({
                    method: "POST",
                    url: `/organizations/${orgId}/cases`,
                    headers: { authorization: `Bearer ${adminToken}` },
                    payload: caseBody("case-malformed-cursor"),
                });

                const response = await app.inject({
                    method: "GET",
                    url: `/organizations/${orgId}/cases?since=not-a-number`,
                    headers: { authorization: `Bearer ${adminToken}` },
                });
                expect(response.statusCode).toBe(200);
                expect(response.json().cases.map((c: { id: string }) => c.id)).toContain("case-malformed-cursor");
            });

            it("rejects incomplete and manipulated clinical payloads at the server boundary", async () => {
                const response = await app.inject({
                    method: "POST",
                    url: `/organizations/${orgId}/cases`,
                    headers: { authorization: `Bearer ${adminToken}` },
                    payload: { id: "opaque-envelope-no-longer-accepted", title: "Missing clinical fields", updatedAt: new Date().toISOString() },
                });
                expect(response.statusCode).toBe(400);
                expect(response.json().error).toBe("invalid_request");
            });

            it("returns transactional delete tombstones after the caller's cursor", async () => {
                const created = await app.inject({ method: "POST", url: `/organizations/${orgId}/cases`, headers: { authorization: `Bearer ${adminToken}` }, payload: caseBody("case-tombstone") });
                const snapshot = await app.inject({ method: "GET", url: `/organizations/${orgId}/cases`, headers: { authorization: `Bearer ${adminToken}` } });
                const cursor = snapshot.json().cursor;
                await app.inject({ method: "DELETE", url: `/organizations/${orgId}/cases/case-tombstone`, headers: { authorization: `Bearer ${adminToken}`, "if-match": created.json().version } });
                const incremental = await app.inject({ method: "GET", url: `/organizations/${orgId}/cases?since=${cursor}`, headers: { authorization: `Bearer ${adminToken}` } });
                expect(incremental.json().changes).toEqual([expect.objectContaining({ kind: "delete", caseId: "case-tombstone" })]);
                expect(incremental.json().deletedIds).toEqual(["case-tombstone"]);
            });

            it("filters a collection by server-derived ownership and makes denied ids indistinguishable from missing ids", async () => {
                const policy = await app.inject({
                    method: "POST", url: `/organizations/${orgId}/policies`, headers: { authorization: `Bearer ${adminToken}` },
                    payload: { name: "OwnCases", document: { version: "2026-01-01", statements: [
                        { effect: "Allow", actions: ["patientCase:create"], resources: ["*"] },
                        { effect: "Allow", actions: ["patientCase:view"], resources: ["*"], condition: { StringEquals: { "resource:isOwner": "true" } } },
                    ] } },
                });
                await app.inject({ method: "POST", url: `/organizations/${orgId}/users`, headers: { authorization: `Bearer ${adminToken}` }, payload: { externalSubject: "idp|owner-filter", displayName: "Owner Filter", policyIds: [policy.json().id] } });
                const ownerToken = await tokenFor("idp|owner-filter");
                await app.inject({ method: "POST", url: `/organizations/${orgId}/cases`, headers: { authorization: `Bearer ${ownerToken}` }, payload: caseBody("owned-case") });
                await app.inject({ method: "POST", url: `/organizations/${orgId}/cases`, headers: { authorization: `Bearer ${adminToken}` }, payload: caseBody("foreign-case") });
                const list = await app.inject({ method: "GET", url: `/organizations/${orgId}/cases`, headers: { authorization: `Bearer ${ownerToken}` } });
                expect(list.json().cases.map((item: { id: string }) => item.id)).toEqual(["owned-case"]);
                const denied = await app.inject({ method: "GET", url: `/organizations/${orgId}/cases/foreign-case`, headers: { authorization: `Bearer ${ownerToken}` } });
                const absent = await app.inject({ method: "GET", url: `/organizations/${orgId}/cases/does-not-exist`, headers: { authorization: `Bearer ${ownerToken}` } });
                expect({ status: denied.statusCode, body: denied.json() }).toEqual({ status: absent.statusCode, body: absent.json() });
            });
        });

        describe("IAM v2 invitations and service principals", () => {
            it("accepts an invitation into a first-class membership with no implicit grants", async () => {
                const invitationResponse = await app.inject({ method: "POST", url: `/organizations/${orgId}/invitations`, headers: { authorization: `Bearer ${adminToken}` }, payload: { email: "invitee@example.test" } });
                expect(invitationResponse.statusCode).toBe(201);
                const { invitation, token } = invitationResponse.json();
                expect(invitation).not.toHaveProperty("tokenHash");
                const inviteeToken = await tokenFor("idp|invitee", { email: "invitee@example.test" });
                const accepted = await app.inject({ method: "POST", url: `/organizations/${orgId}/invitations/${invitation.id}/accept`, headers: { authorization: `Bearer ${inviteeToken}` }, payload: { token } });
                expect(accepted.statusCode).toBe(200);
                const me = await app.inject({ method: "GET", url: "/me", headers: { authorization: `Bearer ${inviteeToken}` } });
                expect(me.json().memberships[0]).toMatchObject({ organization: { id: orgId }, user: { status: "active" }, effectivePolicyNames: [] });
            });

            it("authenticates a non-human principal against its own policy set", async () => {
                const policy = await app.inject({ method: "POST", url: `/organizations/${orgId}/policies`, headers: { authorization: `Bearer ${adminToken}` }, payload: { name: "WorkerRead", document: { version: "2026-01-01", statements: [{ effect: "Allow", actions: ["patientCase:view"], resources: ["*"] }] } } });
                const created = await app.inject({ method: "POST", url: `/organizations/${orgId}/service-principals`, headers: { authorization: `Bearer ${adminToken}` }, payload: { issuer: ISSUER, externalSubject: "service|sync-worker", displayName: "Sync worker", policyIds: [policy.json().id] } });
                expect(created.statusCode).toBe(201);
                const serviceToken = await tokenFor("service|sync-worker", { client_id: "sync-worker" });
                const check = await app.inject({ method: "POST", url: `/organizations/${orgId}/authz/check`, headers: { authorization: `Bearer ${serviceToken}` }, payload: { action: "patientCase:view", resource: `organization:${orgId}/patientCase:any` } });
                expect(check.json().effect).toBe("Allow");
            });

            describe("invitation-acceptance failure recovery (compensating cleanup — routes/invitations.ts)", () => {
                // acceptInvitation runs first (it's also what verifies the
                // token), so a failure in either step after it must not
                // leave the invitation permanently spent with nobody able
                // to retry the same link — the compensating action reverts
                // it back to 'pending'.
                it.each([
                    ["principalStore.upsertIdentity", (deps: { principalStore: InMemoryPrincipalStore }) => vi.spyOn(deps.principalStore, "upsertIdentity")],
                    ["store.createUser", (deps: { store: InMemoryIamStore }) => vi.spyOn(deps.store, "createUser")],
                    ["principalStore.ensureMembership", (deps: { principalStore: InMemoryPrincipalStore }) => vi.spyOn(deps.principalStore, "ensureMembership")],
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                ] as [string, (deps: any) => { mockRejectedValueOnce: (value: unknown) => void }][])(
                    "a failure in %s reverts the invitation back to pending rather than permanently consuming it",
                    async (_label, spyOn) => {
                        const localAuditStore = new InMemoryAuditStore();
                        const localStore = new InMemoryIamStore(localAuditStore);
                        const principalStore = new InMemoryPrincipalStore(localAuditStore);
                        const localApp = buildApp({
                            store: localStore,
                            caseStore: new InMemoryCaseStore(localAuditStore),
                            idempotencyStore: new InMemoryIdempotencyStore(),
                            auditStore: localAuditStore,
                            principalStore,
                            jwks,
                            oidc: { issuer: ISSUER, audience: AUDIENCE },
                        });

                        const localAdminToken = await tokenFor("idp|invitation-recovery-admin", { name: "Admin" });
                        const org = await localApp.inject({ method: "POST", url: "/organizations", headers: { authorization: `Bearer ${localAdminToken}` }, payload: { name: "Recovery Org" } });
                        const localOrgId = org.json().organization.id;
                        const invitationResponse = await localApp.inject({
                            method: "POST",
                            url: `/organizations/${localOrgId}/invitations`,
                            headers: { authorization: `Bearer ${localAdminToken}` },
                            payload: { email: "invitee@example.test" },
                        });
                        const { invitation, token } = invitationResponse.json();

                        spyOn({ store: localStore, principalStore }).mockRejectedValueOnce(new Error("simulated failure"));
                        const inviteeToken = await tokenFor("idp|recovery-invitee", { email: "invitee@example.test" });
                        const firstAttempt = await localApp.inject({
                            method: "POST",
                            url: `/organizations/${localOrgId}/invitations/${invitation.id}/accept`,
                            headers: { authorization: `Bearer ${inviteeToken}` },
                            payload: { token },
                        });
                        expect(firstAttempt.statusCode).toBe(500); // the real error propagates, not swallowed by cleanup

                        // The same token still works on retry — proves the
                        // invitation was reverted to 'pending', not left
                        // permanently 'accepted' with no account behind it.
                        const retry = await localApp.inject({
                            method: "POST",
                            url: `/organizations/${localOrgId}/invitations/${invitation.id}/accept`,
                            headers: { authorization: `Bearer ${inviteeToken}` },
                            payload: { token },
                        });
                        expect(retry.statusCode).toBe(200);
                        expect(retry.json().user.externalSubject).toBe("idp|recovery-invitee");
                    }
                );

                it("a successful acceptance never calls revertAcceptedInvitation", async () => {
                    const localAuditStore = new InMemoryAuditStore();
                    const localStore = new InMemoryIamStore(localAuditStore);
                    const principalStore = new InMemoryPrincipalStore(localAuditStore);
                    const revertSpy = vi.spyOn(principalStore, "revertAcceptedInvitation");
                    const localApp = buildApp({
                        store: localStore,
                        caseStore: new InMemoryCaseStore(localAuditStore),
                        idempotencyStore: new InMemoryIdempotencyStore(),
                        auditStore: localAuditStore,
                        principalStore,
                        jwks,
                        oidc: { issuer: ISSUER, audience: AUDIENCE },
                    });
                    const localAdminToken = await tokenFor("idp|clean-invitation-admin", { name: "Admin" });
                    const org = await localApp.inject({ method: "POST", url: "/organizations", headers: { authorization: `Bearer ${localAdminToken}` }, payload: { name: "Clean Org" } });
                    const localOrgId = org.json().organization.id;
                    const invitationResponse = await localApp.inject({
                        method: "POST",
                        url: `/organizations/${localOrgId}/invitations`,
                        headers: { authorization: `Bearer ${localAdminToken}` },
                        payload: { email: "clean-invitee@example.test" },
                    });
                    const { invitation, token } = invitationResponse.json();
                    const inviteeToken = await tokenFor("idp|clean-invitee", { email: "clean-invitee@example.test" });
                    const accepted = await localApp.inject({
                        method: "POST",
                        url: `/organizations/${localOrgId}/invitations/${invitation.id}/accept`,
                        headers: { authorization: `Bearer ${inviteeToken}` },
                        payload: { token },
                    });
                    expect(accepted.statusCode).toBe(200);
                    expect(revertSpy).not.toHaveBeenCalled();
                });
            });
        });

        it("stages, validates, activates, and rolls back a non-destructive local-case migration", async () => {
            const started = await app.inject({ method: "POST", url: `/organizations/${orgId}/case-migrations`, headers: { authorization: `Bearer ${adminToken}` }, payload: { sourceFingerprint: "integration-source", totalItems: 1 } });
            expect(started.statusCode).toBe(201);
            const migrationId = started.json().id;
            await app.inject({ method: "PUT", url: `/organizations/${orgId}/case-migrations/${migrationId}/batches`, headers: { authorization: `Bearer ${adminToken}` }, payload: { items: [{ itemKey: "item-1", patientCase: patientCaseFixture("migrated-case") }] } });
            const preview = await app.inject({ method: "POST", url: `/organizations/${orgId}/case-migrations/${migrationId}/validate`, headers: { authorization: `Bearer ${adminToken}` } });
            expect(preview.json()).toMatchObject({ valid: 1, invalid: 0, collisions: 0 });
            const activated = await app.inject({ method: "POST", url: `/organizations/${orgId}/case-migrations/${migrationId}/activate`, headers: { authorization: `Bearer ${adminToken}` } });
            expect(activated.json().status).toBe("active");
            const visible = await app.inject({ method: "GET", url: `/organizations/${orgId}/cases`, headers: { authorization: `Bearer ${adminToken}` } });
            const cursor = visible.json().cursor;
            expect(visible.json().cases.map((item: { id: string }) => item.id)).toContain("migrated-case");
            const rolledBack = await app.inject({ method: "POST", url: `/organizations/${orgId}/case-migrations/${migrationId}/rollback`, headers: { authorization: `Bearer ${adminToken}` } });
            expect(rolledBack.json().status).toBe("rolled-back");
            const changes = await app.inject({ method: "GET", url: `/organizations/${orgId}/cases?since=${cursor}`, headers: { authorization: `Bearer ${adminToken}` } });
            expect(changes.json().changes).toEqual([expect.objectContaining({ kind: "delete", caseId: "migrated-case" })]);
        });

        describe("GET /organizations/:id/audit (store/audit-store.ts)", () => {
            it("records IAM and case mutations from the same request lifecycle into one chronological trail", async () => {
                // orgId/adminToken's own creation (POST /organizations)
                // already wrote an organization.create row before this
                // test body even runs.
                await app.inject({
                    method: "POST",
                    url: `/organizations/${orgId}/policies`,
                    headers: { authorization: `Bearer ${adminToken}` },
                    payload: { name: "AuditTestPolicy", document: { version: "2026-01-01", statements: [{ effect: "Allow", actions: ["*"], resources: ["*"] }] } },
                });
                await app.inject({
                    method: "POST",
                    url: `/organizations/${orgId}/cases`,
                    headers: { authorization: `Bearer ${adminToken}` },
                    payload: patientCaseFixture("case-audit-1", { title: "Audit test case" }),
                });

                const response = await app.inject({
                    method: "GET",
                    url: `/organizations/${orgId}/audit`,
                    headers: { authorization: `Bearer ${adminToken}` },
                });
                expect(response.statusCode).toBe(200);
                const actions = response.json().map((e: { action: string }) => e.action);
                expect(actions).toContain("organization.create");
                expect(actions).toContain("policy.create");
                expect(actions).toContain("patientCase.create");
            });

            it("is scoped per organization — one organization's audit trail never includes another's", async () => {
                await app.inject({
                    method: "POST",
                    url: `/organizations/${orgId}/cases`,
                    headers: { authorization: `Bearer ${adminToken}` },
                    payload: patientCaseFixture("case-audit-isolated", { title: "Audit isolation test case" }),
                });

                const otherOrgToken = await tokenFor("idp|other-org-admin-audit", { name: "Other Org Admin" });
                const otherOrg = await app.inject({
                    method: "POST",
                    url: "/organizations",
                    headers: { authorization: `Bearer ${otherOrgToken}` },
                    payload: { name: "A Different Hospital" },
                });
                const otherOrgId = otherOrg.json().organization.id;

                const response = await app.inject({
                    method: "GET",
                    url: `/organizations/${otherOrgId}/audit`,
                    headers: { authorization: `Bearer ${otherOrgToken}` },
                });
                const targetIds = response.json().map((e: { targetId: string }) => e.targetId);
                expect(targetIds).not.toContain("case-audit-isolated");
            });

            it("a caller with no permissions is denied, not silently shown an empty list", async () => {
                await app.inject({
                    method: "POST",
                    url: `/organizations/${orgId}/users`,
                    headers: { authorization: `Bearer ${adminToken}` },
                    payload: { externalSubject: "idp|no-audit-access", displayName: "No Access" },
                });
                const token = await tokenFor("idp|no-audit-access");

                const response = await app.inject({
                    method: "GET",
                    url: `/organizations/${orgId}/audit`,
                    headers: { authorization: `Bearer ${token}` },
                });
                expect(response.statusCode).toBe(403);
            });
        });

        describe("immutable audit search, export, and legal hold (P1: immutable audit ingestion, search, export, and legal hold)", () => {
            let readOnlyToken: string;

            beforeEach(async () => {
                const readOnlyPolicy = await app.inject({
                    method: "POST",
                    url: `/organizations/${orgId}/policies`,
                    headers: { authorization: `Bearer ${adminToken}` },
                    payload: {
                        name: "AuditReadOnly",
                        document: { version: "2026-01-01", statements: [{ effect: "Allow", actions: ["audit:read"], resources: ["*"] }] },
                    },
                });
                await app.inject({
                    method: "POST",
                    url: `/organizations/${orgId}/users`,
                    headers: { authorization: `Bearer ${adminToken}` },
                    payload: { externalSubject: "idp|audit-read-only", displayName: "Audit Reader", policyIds: [readOnlyPolicy.json().id] },
                });
                readOnlyToken = await tokenFor("idp|audit-read-only");
            });

            it("search params filter the audit trail server-side", async () => {
                await app.inject({
                    method: "POST",
                    url: `/organizations/${orgId}/policies`,
                    headers: { authorization: `Bearer ${adminToken}` },
                    payload: { name: "SearchFilterPolicy", document: { version: "2026-01-01", statements: [{ effect: "Allow", actions: ["*"], resources: ["*"] }] } },
                });

                const filtered = await app.inject({
                    method: "GET",
                    url: `/organizations/${orgId}/audit?action=policy.create`,
                    headers: { authorization: `Bearer ${adminToken}` },
                });
                expect(filtered.statusCode).toBe(200);
                const actions = filtered.json().map((e: { action: string }) => e.action);
                expect(actions.every((a: string) => a === "policy.create")).toBe(true);
                expect(actions).toContain("policy.create");
            });

            it("cursor pagination returns successive, non-overlapping pages", async () => {
                for (let i = 0; i < 3; i++) {
                    await app.inject({
                        method: "POST",
                        url: `/organizations/${orgId}/policies`,
                        headers: { authorization: `Bearer ${adminToken}` },
                        payload: { name: `PagePolicy${i}`, document: { version: "2026-01-01", statements: [{ effect: "Allow", actions: ["*"], resources: ["*"] }] } },
                    });
                }
                const firstPage = await app.inject({
                    method: "GET",
                    url: `/organizations/${orgId}/audit?action=policy.create&limit=2`,
                    headers: { authorization: `Bearer ${adminToken}` },
                });
                expect(firstPage.json()).toHaveLength(2);
                const cursor = firstPage.json()[1].sequence;

                const secondPage = await app.inject({
                    method: "GET",
                    url: `/organizations/${orgId}/audit?action=policy.create&cursor=${cursor}&limit=2`,
                    headers: { authorization: `Bearer ${adminToken}` },
                });
                const firstPageIds = new Set(firstPage.json().map((e: { id: string }) => e.id));
                for (const entry of secondPage.json()) expect(firstPageIds.has(entry.id)).toBe(false);
            });

            it("export returns a CSV with the expected columns, respects filters, and is tenant-safe", async () => {
                await app.inject({
                    method: "POST",
                    url: `/organizations/${orgId}/cases`,
                    headers: { authorization: `Bearer ${adminToken}` },
                    payload: patientCaseFixture("case-export-test", { title: "Export test case" }),
                });

                const otherOrgToken = await tokenFor("idp|other-org-admin-audit-export", { name: "Other Org Admin" });
                const otherOrg = await app.inject({
                    method: "POST",
                    url: "/organizations",
                    headers: { authorization: `Bearer ${otherOrgToken}` },
                    payload: { name: "A Different Exporting Hospital" },
                });
                const otherOrgId = otherOrg.json().organization.id;

                const exportResponse = await app.inject({
                    method: "GET",
                    url: `/organizations/${orgId}/audit/export?targetType=patientCase`,
                    headers: { authorization: `Bearer ${adminToken}` },
                });
                expect(exportResponse.statusCode).toBe(200);
                expect(exportResponse.headers["content-type"]).toContain("text/csv");
                expect(exportResponse.headers["content-disposition"]).toContain("attachment");
                const lines = exportResponse.body.trim().split("\r\n");
                expect(lines[0].split(",")).toEqual([
                    "sequence", "createdAt", "organizationId", "actorUserId", "actorExternalSubject",
                    "action", "targetType", "targetId", "details", "entryHash", "prevHash",
                ]);
                expect(exportResponse.body).toContain("case-export-test");
                expect(exportResponse.body).not.toContain(otherOrgId);

                const otherExport = await app.inject({
                    method: "GET",
                    url: `/organizations/${otherOrgId}/audit/export`,
                    headers: { authorization: `Bearer ${otherOrgToken}` },
                });
                expect(otherExport.body).not.toContain("case-export-test");
            });

            it("verify-chain reports the trail as valid after ordinary operations", async () => {
                await app.inject({
                    method: "POST",
                    url: `/organizations/${orgId}/policies`,
                    headers: { authorization: `Bearer ${adminToken}` },
                    payload: { name: "VerifyChainPolicy", document: { version: "2026-01-01", statements: [{ effect: "Allow", actions: ["*"], resources: ["*"] }] } },
                });
                const response = await app.inject({
                    method: "GET",
                    url: `/organizations/${orgId}/audit/verify-chain`,
                    headers: { authorization: `Bearer ${adminToken}` },
                });
                expect(response.statusCode).toBe(200);
                expect(response.json().valid).toBe(true);
            });

            it("legal hold: place → active, release → released with reason, and a read-only caller cannot manage either", async () => {
                const deniedPlace = await app.inject({
                    method: "POST",
                    url: `/organizations/${orgId}/audit/legal-holds`,
                    headers: { authorization: `Bearer ${readOnlyToken}` },
                    payload: { reason: "Litigation hold attempt" },
                });
                expect(deniedPlace.statusCode).toBe(403);

                const place = await app.inject({
                    method: "POST",
                    url: `/organizations/${orgId}/audit/legal-holds`,
                    headers: { authorization: `Bearer ${adminToken}` },
                    payload: { reason: "Pending litigation — do not purge." },
                });
                expect(place.statusCode).toBe(201);
                expect(place.json().status).toBe("active");
                const holdId = place.json().id;

                const listAsReadOnly = await app.inject({
                    method: "GET",
                    url: `/organizations/${orgId}/audit/legal-holds`,
                    headers: { authorization: `Bearer ${readOnlyToken}` },
                });
                expect(listAsReadOnly.statusCode).toBe(200);
                expect(listAsReadOnly.json().map((h: { id: string }) => h.id)).toContain(holdId);

                const deniedRelease = await app.inject({
                    method: "POST",
                    url: `/organizations/${orgId}/audit/legal-holds/${holdId}/release`,
                    headers: { authorization: `Bearer ${readOnlyToken}` },
                    payload: {},
                });
                expect(deniedRelease.statusCode).toBe(403);

                const release = await app.inject({
                    method: "POST",
                    url: `/organizations/${orgId}/audit/legal-holds/${holdId}/release`,
                    headers: { authorization: `Bearer ${adminToken}` },
                    payload: { releaseReason: "Litigation resolved." },
                });
                expect(release.statusCode).toBe(200);
                expect(release.json().status).toBe("released");
                expect(release.json().releaseReason).toBe("Litigation resolved.");

                const alreadyReleased = await app.inject({
                    method: "POST",
                    url: `/organizations/${orgId}/audit/legal-holds/${holdId}/release`,
                    headers: { authorization: `Bearer ${adminToken}` },
                    payload: {},
                });
                expect(alreadyReleased.statusCode).toBe(400);
                expect(alreadyReleased.json().error).toBe("not_active");

                const audit = await app.inject({ method: "GET", url: `/organizations/${orgId}/audit`, headers: { authorization: `Bearer ${adminToken}` } });
                const actions = (audit.json() as { action: string }[]).map((e) => e.action);
                expect(actions).toEqual(expect.arrayContaining(["auditLegalHold.place", "auditLegalHold.release"]));
            });

            it("releasing or looking up an unknown hold id is 404, not a crash", async () => {
                const response = await app.inject({
                    method: "POST",
                    url: `/organizations/${orgId}/audit/legal-holds/${randomUUID()}/release`,
                    headers: { authorization: `Bearer ${adminToken}` },
                    payload: {},
                });
                expect(response.statusCode).toBe(404);
            });

            describe("SIEM export feed (P2 item 2: SIEM export and institutional alert mapping)", () => {
                let siemToken: string;

                beforeEach(async () => {
                    const siemPolicy = await app.inject({
                        method: "POST",
                        url: `/organizations/${orgId}/policies`,
                        headers: { authorization: `Bearer ${adminToken}` },
                        payload: {
                            name: "SiemExportOnly",
                            document: { version: "2026-01-01", statements: [{ effect: "Allow", actions: ["audit:exportSiem"], resources: ["*"] }] },
                        },
                    });
                    await app.inject({
                        method: "POST",
                        url: `/organizations/${orgId}/users`,
                        headers: { authorization: `Bearer ${adminToken}` },
                        payload: { externalSubject: "idp|siem-connector", displayName: "SIEM Connector", policyIds: [siemPolicy.json().id] },
                    });
                    siemToken = await tokenFor("idp|siem-connector");
                });

                it("holding audit:read alone is not enough — exportSiem is its own, separate grant", async () => {
                    const response = await app.inject({
                        method: "GET",
                        url: `/organizations/${orgId}/audit/siem-export`,
                        headers: { authorization: `Bearer ${readOnlyToken}` },
                    });
                    expect(response.statusCode).toBe(403);
                });

                it("returns severity-annotated events in ascending sequence order, with a cursor to resume from", async () => {
                    await app.inject({
                        method: "POST",
                        url: `/organizations/${orgId}/policies`,
                        headers: { authorization: `Bearer ${adminToken}` },
                        payload: { name: "SiemFeedTestPolicy", document: { version: "2026-01-01", statements: [{ effect: "Allow", actions: ["*"], resources: ["*"] }] } },
                    });
                    const policyId = (
                        await app.inject({ method: "GET", url: `/organizations/${orgId}/policies`, headers: { authorization: `Bearer ${adminToken}` } })
                    ).json().find((p: { name: string }) => p.name === "SiemFeedTestPolicy").id;
                    await app.inject({
                        method: "DELETE",
                        url: `/organizations/${orgId}/policies/${policyId}`,
                        headers: { authorization: `Bearer ${adminToken}` },
                    });

                    const response = await app.inject({
                        method: "GET",
                        url: `/organizations/${orgId}/audit/siem-export`,
                        headers: { authorization: `Bearer ${siemToken}` },
                    });
                    expect(response.statusCode).toBe(200);
                    const body = response.json();
                    expect(Array.isArray(body.events)).toBe(true);
                    expect(body.events.length).toBeGreaterThan(0);

                    const sequences = body.events.map((e: { sequence: string }) => BigInt(e.sequence));
                    const sorted = [...sequences].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
                    expect(sequences).toEqual(sorted);

                    const deleteEvent = body.events.find((e: { action: string }) => e.action === "policy.delete");
                    expect(deleteEvent).toBeTruthy();
                    expect(deleteEvent.severity).toBe("warning");
                    expect(body.nextSince).toBe(body.events[body.events.length - 1].sequence);
                });

                it("a since cursor returns only events strictly after it, with no overlap across two pages", async () => {
                    for (let i = 0; i < 3; i++) {
                        await app.inject({
                            method: "POST",
                            url: `/organizations/${orgId}/policies`,
                            headers: { authorization: `Bearer ${adminToken}` },
                            payload: { name: `SiemCursorPolicy${i}`, document: { version: "2026-01-01", statements: [{ effect: "Allow", actions: ["*"], resources: ["*"] }] } },
                        });
                    }
                    const firstPage = await app.inject({
                        method: "GET",
                        url: `/organizations/${orgId}/audit/siem-export?limit=2`,
                        headers: { authorization: `Bearer ${siemToken}` },
                    });
                    const firstBody = firstPage.json();
                    expect(firstBody.events).toHaveLength(2);

                    const secondPage = await app.inject({
                        method: "GET",
                        url: `/organizations/${orgId}/audit/siem-export?since=${firstBody.nextSince}`,
                        headers: { authorization: `Bearer ${siemToken}` },
                    });
                    const secondBody = secondPage.json();
                    const firstPageIds = new Set(firstBody.events.map((e: { id: string }) => e.id));
                    for (const event of secondBody.events) expect(firstPageIds.has(event.id)).toBe(false);
                });

                it("polling with the latest known sequence returns no new events, not an error", async () => {
                    const first = await app.inject({
                        method: "GET",
                        url: `/organizations/${orgId}/audit/siem-export`,
                        headers: { authorization: `Bearer ${siemToken}` },
                    });
                    const caughtUpCursor = first.json().nextSince;

                    const second = await app.inject({
                        method: "GET",
                        url: `/organizations/${orgId}/audit/siem-export?since=${caughtUpCursor}`,
                        headers: { authorization: `Bearer ${siemToken}` },
                    });
                    expect(second.statusCode).toBe(200);
                    expect(second.json().events).toEqual([]);
                    expect(second.json().nextSince).toBe(caughtUpCursor);
                });

                it("never returns another organization's audit events", async () => {
                    const otherOrgToken = await tokenFor("idp|other-org-admin-siem-export", { name: "Other Org For SIEM Isolation" });
                    const otherOrg = await app.inject({
                        method: "POST",
                        url: "/organizations",
                        headers: { authorization: `Bearer ${otherOrgToken}` },
                        payload: { name: "A Different Hospital Entirely" },
                    });
                    const otherOrgId = otherOrg.json().organization.id;

                    const response = await app.inject({
                        method: "GET",
                        url: `/organizations/${orgId}/audit/siem-export`,
                        headers: { authorization: `Bearer ${siemToken}` },
                    });
                    const body = response.json();
                    expect(body.events.every((e: { organizationId: string }) => e.organizationId === orgId)).toBe(true);
                    expect(JSON.stringify(body)).not.toContain(otherOrgId);
                });
            });
        });

        describe("tenant backup export and dual-control restore (P1: enterprise backup, PITR, and tenant-scoped restore)", () => {
            let proposerToken: string;
            let approverToken: string;

            function emptyArtifact(orgId: string) {
                return { organizationId: orgId, exportedAt: new Date().toISOString(), tables: {} };
            }

            beforeEach(async () => {
                const proposerPolicy = await app.inject({
                    method: "POST",
                    url: `/organizations/${orgId}/policies`,
                    headers: { authorization: `Bearer ${adminToken}` },
                    payload: { name: "CanProposeRestore", document: { version: "2026-01-01", statements: [{ effect: "Allow", actions: ["tenantBackup:proposeRestore"], resources: ["*"] }] } },
                });
                await app.inject({
                    method: "POST",
                    url: `/organizations/${orgId}/users`,
                    headers: { authorization: `Bearer ${adminToken}` },
                    payload: { externalSubject: "idp|backup-proposer", displayName: "Backup Proposer", policyIds: [proposerPolicy.json().id] },
                });
                proposerToken = await tokenFor("idp|backup-proposer");

                const approverPolicy = await app.inject({
                    method: "POST",
                    url: `/organizations/${orgId}/policies`,
                    headers: { authorization: `Bearer ${adminToken}` },
                    payload: { name: "CanApproveRestore", document: { version: "2026-01-01", statements: [{ effect: "Allow", actions: ["tenantBackup:approveRestore"], resources: ["*"] }] } },
                });
                await app.inject({
                    method: "POST",
                    url: `/organizations/${orgId}/users`,
                    headers: { authorization: `Bearer ${adminToken}` },
                    payload: { externalSubject: "idp|backup-approver", displayName: "Backup Approver", policyIds: [approverPolicy.json().id] },
                });
                approverToken = await tokenFor("idp|backup-approver");
            });

            it("export requires tenantBackup:export and returns an artifact recording this organization", async () => {
                const denied = await app.inject({
                    method: "GET",
                    url: `/organizations/${orgId}/backup/export`,
                    headers: { authorization: `Bearer ${proposerToken}` },
                });
                expect(denied.statusCode).toBe(403);

                const response = await app.inject({ method: "GET", url: `/organizations/${orgId}/backup/export`, headers: { authorization: `Bearer ${adminToken}` } });
                expect(response.statusCode).toBe(200);
                expect(response.json().organizationId).toBe(orgId);
                expect(response.headers["content-disposition"]).toContain("attachment");
            });

            it("propose -> self-approve rejected -> a different approver completes it", async () => {
                const propose = await app.inject({
                    method: "POST",
                    url: `/organizations/${orgId}/backup/restore-requests`,
                    headers: { authorization: `Bearer ${adminToken}` },
                    payload: { artifact: emptyArtifact(orgId) },
                });
                expect(propose.statusCode).toBe(201);
                expect(propose.json().status).toBe("pending");
                const requestId = propose.json().id;

                const selfApprove = await app.inject({
                    method: "POST",
                    url: `/organizations/${orgId}/backup/restore-requests/${requestId}/approve`,
                    headers: { authorization: `Bearer ${adminToken}` },
                });
                expect(selfApprove.statusCode).toBe(400);
                expect(selfApprove.json().error).toBe("self_approval");

                const approve = await app.inject({
                    method: "POST",
                    url: `/organizations/${orgId}/backup/restore-requests/${requestId}/approve`,
                    headers: { authorization: `Bearer ${approverToken}` },
                });
                expect(approve.statusCode).toBe(200);
                expect(approve.json().status).toBe("completed");

                const alreadyDecided = await app.inject({
                    method: "POST",
                    url: `/organizations/${orgId}/backup/restore-requests/${requestId}/approve`,
                    headers: { authorization: `Bearer ${approverToken}` },
                });
                expect(alreadyDecided.statusCode).toBe(400);
                expect(alreadyDecided.json().error).toBe("not_pending");
            });

            it("rejects a restore artifact whose recorded organizationId does not match the target organization", async () => {
                const response = await app.inject({
                    method: "POST",
                    url: `/organizations/${orgId}/backup/restore-requests`,
                    headers: { authorization: `Bearer ${adminToken}` },
                    payload: { artifact: emptyArtifact(randomUUID()) },
                });
                expect(response.statusCode).toBe(400);
                expect(response.json().error).toBe("organization_mismatch");
            });

            it("rejecting a pending request is allowed even by its own proposer, and never executes it", async () => {
                const propose = await app.inject({
                    method: "POST",
                    url: `/organizations/${orgId}/backup/restore-requests`,
                    headers: { authorization: `Bearer ${adminToken}` },
                    payload: { artifact: emptyArtifact(orgId) },
                });
                const requestId = propose.json().id;

                const reject = await app.inject({
                    method: "POST",
                    url: `/organizations/${orgId}/backup/restore-requests/${requestId}/reject`,
                    headers: { authorization: `Bearer ${adminToken}` },
                    payload: { reason: "Changed my mind." },
                });
                expect(reject.statusCode).toBe(200);
                expect(reject.json().status).toBe("rejected");
            });

            it("a caller with only propose (not approve) permission can propose and list, but not approve or reject", async () => {
                const propose = await app.inject({
                    method: "POST",
                    url: `/organizations/${orgId}/backup/restore-requests`,
                    headers: { authorization: `Bearer ${proposerToken}` },
                    payload: { artifact: emptyArtifact(orgId) },
                });
                expect(propose.statusCode).toBe(201);
                const requestId = propose.json().id;

                const list = await app.inject({
                    method: "GET",
                    url: `/organizations/${orgId}/backup/restore-requests`,
                    headers: { authorization: `Bearer ${proposerToken}` },
                });
                expect(list.statusCode).toBe(200);
                expect(list.json().map((r: { id: string }) => r.id)).toContain(requestId);

                const deniedApprove = await app.inject({
                    method: "POST",
                    url: `/organizations/${orgId}/backup/restore-requests/${requestId}/approve`,
                    headers: { authorization: `Bearer ${proposerToken}` },
                });
                expect(deniedApprove.statusCode).toBe(403);
            });

            it("records an audit entry for every propose/approve/reject action", async () => {
                const propose = await app.inject({
                    method: "POST",
                    url: `/organizations/${orgId}/backup/restore-requests`,
                    headers: { authorization: `Bearer ${adminToken}` },
                    payload: { artifact: emptyArtifact(orgId) },
                });
                await app.inject({
                    method: "POST",
                    url: `/organizations/${orgId}/backup/restore-requests/${propose.json().id}/approve`,
                    headers: { authorization: `Bearer ${approverToken}` },
                });

                const audit = await app.inject({ method: "GET", url: `/organizations/${orgId}/audit`, headers: { authorization: `Bearer ${adminToken}` } });
                const actions = (audit.json() as { action: string }[]).map((e) => e.action);
                expect(actions).toEqual(expect.arrayContaining(["tenantBackup.proposeRestore", "tenantBackup.approveRestore"]));
            });
        });

        describe("shared chat sessions (P1: remaining shared clinical domains)", () => {
            function sessionFixture(id: string, overrides?: Record<string, unknown>) {
                const now = new Date().toISOString();
                return { id, title: "Untitled chat", model: "gpt-4o", messages: [{ role: "user", content: "Hello" }], createdAt: now, updatedAt: now, ...overrides };
            }

            it("the owner can create, view, edit, and delete their own session; a stranger sees a nondisclosing empty list and 404", async () => {
                const created = await app.inject({
                    method: "POST",
                    url: `/organizations/${orgId}/sessions`,
                    headers: { authorization: `Bearer ${adminToken}` },
                    payload: sessionFixture("session-1"),
                });
                expect(created.statusCode).toBe(201);

                const stranger = await app.inject({
                    method: "POST",
                    url: `/organizations/${orgId}/users`,
                    headers: { authorization: `Bearer ${adminToken}` },
                    payload: { externalSubject: "idp|session-stranger", displayName: "Stranger" },
                });
                void stranger;
                const strangerToken = await tokenFor("idp|session-stranger");

                const deniedGet = await app.inject({
                    method: "GET",
                    url: `/organizations/${orgId}/sessions/session-1`,
                    headers: { authorization: `Bearer ${strangerToken}` },
                });
                expect(deniedGet.statusCode).toBe(404);

                const list = await app.inject({ method: "GET", url: `/organizations/${orgId}/sessions`, headers: { authorization: `Bearer ${strangerToken}` } });
                expect(list.statusCode).toBe(200);
                expect(list.json().changes).toEqual([]);

                const ownGet = await app.inject({ method: "GET", url: `/organizations/${orgId}/sessions/session-1`, headers: { authorization: `Bearer ${adminToken}` } });
                expect(ownGet.statusCode).toBe(200);

                const edited = await app.inject({
                    method: "PUT",
                    url: `/organizations/${orgId}/sessions/session-1`,
                    headers: { authorization: `Bearer ${adminToken}`, "if-match": created.json().version },
                    payload: sessionFixture("session-1", { title: "Renamed chat" }),
                });
                expect(edited.statusCode).toBe(200);
                expect(edited.json().title).toBe("Renamed chat");

                const deleted = await app.inject({
                    method: "DELETE",
                    url: `/organizations/${orgId}/sessions/session-1`,
                    headers: { authorization: `Bearer ${adminToken}`, "if-match": edited.json().version },
                });
                expect(deleted.statusCode).toBe(204);
            });

            it("adding someone to assignedUserIds grants them view, and requires chatSession:manageAccess to change", async () => {
                const viewOnlyPolicy = await app.inject({
                    method: "POST",
                    url: `/organizations/${orgId}/policies`,
                    headers: { authorization: `Bearer ${adminToken}` },
                    payload: { name: "SessionViewOnly", document: { version: "2026-01-01", statements: [
                        { effect: "Allow", actions: ["chatSession:view", "chatSession:edit"], resources: ["*"], condition: { StringEquals: { "resource:isAssigned": "true" } } },
                    ] } },
                });
                const teammate = await app.inject({
                    method: "POST",
                    url: `/organizations/${orgId}/users`,
                    headers: { authorization: `Bearer ${adminToken}` },
                    payload: { externalSubject: "idp|session-teammate", displayName: "Teammate", policyIds: [viewOnlyPolicy.json().id] },
                });
                const teammateToken = await tokenFor("idp|session-teammate");

                const created = await app.inject({
                    method: "POST",
                    url: `/organizations/${orgId}/sessions`,
                    headers: { authorization: `Bearer ${adminToken}` },
                    payload: sessionFixture("session-shared"),
                });

                const deniedBeforeShare = await app.inject({
                    method: "GET",
                    url: `/organizations/${orgId}/sessions/session-shared`,
                    headers: { authorization: `Bearer ${teammateToken}` },
                });
                expect(deniedBeforeShare.statusCode).toBe(404);

                // adminToken holds "*", so it legitimately reaches
                // chatSession:manageAccess — same pattern as every other
                // self-review/manageAccess test this session.
                const shared = await app.inject({
                    method: "PUT",
                    url: `/organizations/${orgId}/sessions/session-shared`,
                    headers: { authorization: `Bearer ${adminToken}`, "if-match": created.json().version },
                    payload: sessionFixture("session-shared", { assignedUserIds: [teammate.json().id] }),
                });
                expect(shared.statusCode).toBe(200);

                const allowedAfterShare = await app.inject({
                    method: "GET",
                    url: `/organizations/${orgId}/sessions/session-shared`,
                    headers: { authorization: `Bearer ${teammateToken}` },
                });
                expect(allowedAfterShare.statusCode).toBe(200);

                // The now-assignee holds chatSession:edit (so the initial
                // per-route check passes) but not chatSession:manageAccess,
                // so changing assignedUserIds specifically is a 403 —
                // distinct from the nondisclosing 404 used when the caller
                // cannot even reach the resource.
                const deniedReassign = await app.inject({
                    method: "PUT",
                    url: `/organizations/${orgId}/sessions/session-shared`,
                    headers: { authorization: `Bearer ${teammateToken}`, "if-match": shared.json().version },
                    payload: sessionFixture("session-shared", { assignedUserIds: [] }),
                });
                expect(deniedReassign.statusCode).toBe(403);

                // But an ordinary edit (no assignedUserIds change) succeeds
                // with the same edit-only grant.
                const ordinaryEdit = await app.inject({
                    method: "PUT",
                    url: `/organizations/${orgId}/sessions/session-shared`,
                    headers: { authorization: `Bearer ${teammateToken}`, "if-match": shared.json().version },
                    payload: sessionFixture("session-shared", { title: "Edited by teammate", assignedUserIds: [teammate.json().id] }),
                });
                expect(ordinaryEdit.statusCode).toBe(200);
            });

            it("never syncs params/agentWorkspace/projectId — sharedChatSessionSchema rejects unknown fields", async () => {
                const response = await app.inject({
                    method: "POST",
                    url: `/organizations/${orgId}/sessions`,
                    headers: { authorization: `Bearer ${adminToken}` },
                    payload: sessionFixture("session-strict", { params: { gpuLayers: 20 }, agentWorkspace: "/home/x", projectId: "p1" }),
                });
                expect(response.statusCode).toBe(400);
            });

            it("a since cursor returns only newer entries, and a session in one organization is invisible to another", async () => {
                await app.inject({ method: "POST", url: `/organizations/${orgId}/sessions`, headers: { authorization: `Bearer ${adminToken}` }, payload: sessionFixture("session-a") });
                const firstFeed = await app.inject({ method: "GET", url: `/organizations/${orgId}/sessions`, headers: { authorization: `Bearer ${adminToken}` } });
                const cursor = firstFeed.json().cursor;

                await app.inject({ method: "POST", url: `/organizations/${orgId}/sessions`, headers: { authorization: `Bearer ${adminToken}` }, payload: sessionFixture("session-b") });
                const secondFeed = await app.inject({
                    method: "GET",
                    url: `/organizations/${orgId}/sessions?since=${cursor}`,
                    headers: { authorization: `Bearer ${adminToken}` },
                });
                expect(secondFeed.json().changes.map((c: { sessionId: string }) => c.sessionId)).toEqual(["session-b"]);

                const otherOrgToken = await tokenFor("idp|other-org-admin-sessions", { name: "Other Org Admin" });
                const otherOrg = await app.inject({ method: "POST", url: "/organizations", headers: { authorization: `Bearer ${otherOrgToken}` }, payload: { name: "A Different Hospital" } });
                const otherOrgId = otherOrg.json().organization.id;
                const otherOrgFeed = await app.inject({ method: "GET", url: `/organizations/${otherOrgId}/sessions`, headers: { authorization: `Bearer ${otherOrgToken}` } });
                expect(otherOrgFeed.json().changes).toEqual([]);
            });

            it("records an audit entry for create/update/delete", async () => {
                const created = await app.inject({ method: "POST", url: `/organizations/${orgId}/sessions`, headers: { authorization: `Bearer ${adminToken}` }, payload: sessionFixture("session-audit") });
                await app.inject({
                    method: "DELETE",
                    url: `/organizations/${orgId}/sessions/session-audit`,
                    headers: { authorization: `Bearer ${adminToken}`, "if-match": created.json().version },
                });
                const audit = await app.inject({ method: "GET", url: `/organizations/${orgId}/audit`, headers: { authorization: `Bearer ${adminToken}` } });
                const actions = (audit.json() as { action: string }[]).map((e) => e.action);
                expect(actions).toEqual(expect.arrayContaining(["chatSession.create", "chatSession.delete"]));
            });
        });

        describe("break-glass and access reviews (P1: approvals/access-reviews/break-glass)", () => {
            let emergencyPolicyId: string;
            let reviewerToken: string;
            let clinicianToken: string;
            let adminUserId: string;

            beforeEach(async () => {
                const me = await app.inject({ method: "GET", url: "/me", headers: { authorization: `Bearer ${adminToken}` } });
                adminUserId = me.json().memberships[0].user.id;

                // A distinctive, narrow emergency policy — grants exactly
                // one action, so "did break-glass actually unlock this" is
                // unambiguous rather than incidentally already-allowed.
                const emergencyPolicy = await app.inject({
                    method: "POST",
                    url: `/organizations/${orgId}/policies`,
                    headers: { authorization: `Bearer ${adminToken}` },
                    payload: {
                        name: "EmergencyAccess",
                        document: { version: "2026-01-01", statements: [{ effect: "Allow", actions: ["patientCase:view"], resources: ["*"] }] },
                    },
                });
                emergencyPolicyId = emergencyPolicy.json().id;
                await app.inject({
                    method: "PUT",
                    url: `/organizations/${orgId}/break-glass/policy`,
                    headers: { authorization: `Bearer ${adminToken}` },
                    payload: { policyId: emergencyPolicyId },
                });

                // A "compliance officer" who can review/decide but is never
                // the one invoking break-glass or being reviewed in these
                // tests — stands in as the "different reviewer" the
                // self-review tests need.
                const reviewerPolicy = await app.inject({
                    method: "POST",
                    url: `/organizations/${orgId}/policies`,
                    headers: { authorization: `Bearer ${adminToken}` },
                    payload: {
                        name: "ComplianceOfficer",
                        document: {
                            version: "2026-01-01",
                            statements: [
                                { effect: "Allow", actions: ["breakGlass:review", "breakGlass:list", "accessReview:decide", "accessReview:list"], resources: ["*"] },
                            ],
                        },
                    },
                });
                await app.inject({
                    method: "POST",
                    url: `/organizations/${orgId}/users`,
                    headers: { authorization: `Bearer ${adminToken}` },
                    payload: { externalSubject: "idp|reviewer", displayName: "Compliance Officer", policyIds: [reviewerPolicy.json().id] },
                });
                reviewerToken = await tokenFor("idp|reviewer");

                // A plain clinician who can invoke break-glass but starts
                // with no other permissions — proves the mechanism grants
                // access it wouldn't otherwise have, not just "the admin
                // already had it."
                const clinicianPolicy = await app.inject({
                    method: "POST",
                    url: `/organizations/${orgId}/policies`,
                    headers: { authorization: `Bearer ${adminToken}` },
                    payload: {
                        name: "CanInvokeBreakGlass",
                        document: { version: "2026-01-01", statements: [{ effect: "Allow", actions: ["breakGlass:invoke"], resources: ["*"] }] },
                    },
                });
                await app.inject({
                    method: "POST",
                    url: `/organizations/${orgId}/users`,
                    headers: { authorization: `Bearer ${adminToken}` },
                    payload: { externalSubject: "idp|clinician-bg", displayName: "Dr. Clinician", policyIds: [clinicianPolicy.json().id] },
                });
                clinicianToken = await tokenFor("idp|clinician-bg");
            });

            it("rejects invocation when the organization has not configured an emergency policy", async () => {
                const freshOrgAdmin = await tokenFor("idp|fresh-org-admin");
                const freshOrg = await app.inject({
                    method: "POST",
                    url: "/organizations",
                    headers: { authorization: `Bearer ${freshOrgAdmin}` },
                    payload: { name: "No Emergency Policy Yet" },
                });
                const freshOrgId = freshOrg.json().organization.id;
                const response = await app.inject({
                    method: "POST",
                    url: `/organizations/${freshOrgId}/break-glass/invoke`,
                    headers: { authorization: `Bearer ${freshOrgAdmin}` },
                    payload: { justification: "Patient in critical condition, need immediate chart access." },
                });
                expect(response.statusCode).toBe(409);
                expect(response.json().error).toBe("no_break_glass_policy_configured");
            });

            it("rejects invocation from a caller without breakGlass:invoke", async () => {
                await app.inject({
                    method: "POST",
                    url: `/organizations/${orgId}/users`,
                    headers: { authorization: `Bearer ${adminToken}` },
                    payload: { externalSubject: "idp|no-break-glass", displayName: "No Permission" },
                });
                const token = await tokenFor("idp|no-break-glass");
                const response = await app.inject({
                    method: "POST",
                    url: `/organizations/${orgId}/break-glass/invoke`,
                    headers: { authorization: `Bearer ${token}` },
                    payload: { justification: "Trying anyway, ten characters." },
                });
                expect(response.statusCode).toBe(403);
            });

            it("the core mechanism: an invoked grant unlocks the emergency policy's actions, and stops working once expired", async () => {
                const deniedBefore = await app.inject({
                    method: "POST",
                    url: `/organizations/${orgId}/authz/check`,
                    headers: { authorization: `Bearer ${clinicianToken}` },
                    payload: { action: "patientCase:view", resource: `organization:${orgId}/patientCase:case-1` },
                });
                expect(deniedBefore.json().effect).toBe("Deny");

                const invoke = await app.inject({
                    method: "POST",
                    url: `/organizations/${orgId}/break-glass/invoke`,
                    headers: { authorization: `Bearer ${clinicianToken}` },
                    payload: { justification: "Patient in critical condition, need immediate chart access." },
                });
                expect(invoke.statusCode).toBe(201);
                expect(invoke.json().status).toBe("active");
                expect(invoke.json().emergencyPolicyId).toBe(emergencyPolicyId);

                const allowedAfter = await app.inject({
                    method: "POST",
                    url: `/organizations/${orgId}/authz/check`,
                    headers: { authorization: `Bearer ${clinicianToken}` },
                    payload: { action: "patientCase:view", resource: `organization:${orgId}/patientCase:case-1` },
                });
                expect(allowedAfter.json().effect).toBe("Allow");

                // Still bounded by a permission boundary, and an explicit
                // Deny still wins over the emergency policy — both fall out
                // of appending it to the policy list rather than exempting
                // it from evaluation (routes/guards.ts).
                const boundaryPolicy = await app.inject({
                    method: "POST",
                    url: `/organizations/${orgId}/policies`,
                    headers: { authorization: `Bearer ${adminToken}` },
                    // A real catalog action unrelated to patientCase:* — any
                    // one works to prove the boundary intersection below;
                    // this used to be a made-up "notPatientCase:*" string,
                    // which domain/action-catalog.ts's unknown-action check
                    // (P0 item 10) now correctly rejects at the HTTP
                    // boundary as unrecognized.
                    payload: { name: "NoPatientCaseBoundary", document: { version: "2026-01-01", statements: [{ effect: "Allow", actions: ["audit:read"], resources: ["*"] }] } },
                });
                const clinicianUsers = await app.inject({ method: "GET", url: `/organizations/${orgId}/users`, headers: { authorization: `Bearer ${adminToken}` } });
                const clinicianUserId = clinicianUsers.json().find((u: { externalSubject: string }) => u.externalSubject === "idp|clinician-bg").id;
                await app.inject({
                    method: "PATCH",
                    url: `/organizations/${orgId}/users/${clinicianUserId}`,
                    headers: { authorization: `Bearer ${adminToken}` },
                    payload: { permissionBoundaryPolicyId: boundaryPolicy.json().id },
                });
                const deniedByBoundary = await app.inject({
                    method: "POST",
                    url: `/organizations/${orgId}/authz/check`,
                    headers: { authorization: `Bearer ${clinicianToken}` },
                    payload: { action: "patientCase:view", resource: `organization:${orgId}/patientCase:case-1` },
                });
                expect(deniedByBoundary.json().effect).toBe("Deny");
            });

            it("rejects a second invocation while one is already active", async () => {
                await app.inject({
                    method: "POST",
                    url: `/organizations/${orgId}/break-glass/invoke`,
                    headers: { authorization: `Bearer ${clinicianToken}` },
                    payload: { justification: "First emergency, ten characters plus." },
                });
                const second = await app.inject({
                    method: "POST",
                    url: `/organizations/${orgId}/break-glass/invoke`,
                    headers: { authorization: `Bearer ${clinicianToken}` },
                    payload: { justification: "Second emergency, ten characters plus." },
                });
                expect(second.statusCode).toBe(409);
                expect(second.json().error).toBe("break_glass_already_active");
            });

            it("expiry: a grant stops unlocking the emergency policy once its duration has passed", async () => {
                const shortLivedApp = buildApp({
                    store,
                    caseStore: new InMemoryCaseStore(auditStore),
                    idempotencyStore: new InMemoryIdempotencyStore(),
                    auditStore,
                    jwks,
                    oidc: { issuer: ISSUER, audience: AUDIENCE },
                    breakGlassGrantDurationMs: 50,
                });
                await shortLivedApp.inject({
                    method: "POST",
                    url: `/organizations/${orgId}/break-glass/invoke`,
                    headers: { authorization: `Bearer ${clinicianToken}` },
                    payload: { justification: "Short-lived grant for the expiry test." },
                });
                await new Promise((resolve) => setTimeout(resolve, 75));
                const afterExpiry = await shortLivedApp.inject({
                    method: "POST",
                    url: `/organizations/${orgId}/authz/check`,
                    headers: { authorization: `Bearer ${clinicianToken}` },
                    payload: { action: "patientCase:view", resource: `organization:${orgId}/patientCase:case-1` },
                });
                expect(afterExpiry.json().effect).toBe("Deny");
            });

            it("review: rejects self-review, accepts a different reviewer, and is terminal", async () => {
                // Invoked by adminToken specifically because self-review
                // must be rejected even for a caller who *does* hold
                // breakGlass:review (admin has "*") — clinicianToken only
                // holds breakGlass:invoke, which would reject this attempt
                // for lack of permission before ever reaching the
                // self-review check, testing the wrong thing.
                const invoke = await app.inject({
                    method: "POST",
                    url: `/organizations/${orgId}/break-glass/invoke`,
                    headers: { authorization: `Bearer ${adminToken}` },
                    payload: { justification: "Needs review afterward, ten characters." },
                });
                const grantId = invoke.json().id;

                const selfReview = await app.inject({
                    method: "POST",
                    url: `/organizations/${orgId}/break-glass/grants/${grantId}/review`,
                    headers: { authorization: `Bearer ${adminToken}` },
                    payload: { outcome: "acknowledged" },
                });
                expect(selfReview.statusCode).toBe(400);
                expect(selfReview.json().error).toBe("self_review");

                const review = await app.inject({
                    method: "POST",
                    url: `/organizations/${orgId}/break-glass/grants/${grantId}/review`,
                    headers: { authorization: `Bearer ${reviewerToken}` },
                    payload: { outcome: "flagged" },
                });
                expect(review.statusCode).toBe(200);
                expect(review.json().status).toBe("reviewed");
                expect(review.json().reviewOutcome).toBe("flagged");

                const secondReview = await app.inject({
                    method: "POST",
                    url: `/organizations/${orgId}/break-glass/grants/${grantId}/review`,
                    headers: { authorization: `Bearer ${reviewerToken}` },
                    payload: { outcome: "acknowledged" },
                });
                expect(secondReview.statusCode).toBe(400);
                expect(secondReview.json().error).toBe("already_reviewed");
            });

            it("access reviews: snapshots active memberships, rejects self-decision, a revoke decision suspends the membership immediately, and the campaign auto-completes", async () => {
                const campaign = await app.inject({
                    method: "POST",
                    url: `/organizations/${orgId}/access-reviews`,
                    headers: { authorization: `Bearer ${adminToken}` },
                });
                expect(campaign.statusCode).toBe(201);
                expect(campaign.json().status).toBe("open");
                // admin (bootstrap), reviewer, clinician — three active
                // memberships at this point in the test.
                expect(campaign.json().itemCount).toBe(3);
                const campaignId = campaign.json().id;

                const items = await app.inject({
                    method: "GET",
                    url: `/organizations/${orgId}/access-reviews/${campaignId}/items`,
                    headers: { authorization: `Bearer ${adminToken}` },
                });
                const itemList = items.json() as { id: string; subjectUserId: string }[];
                const adminItem = itemList.find((i) => i.subjectUserId === adminUserId)!;
                const clinicianUsers = await app.inject({ method: "GET", url: `/organizations/${orgId}/users`, headers: { authorization: `Bearer ${adminToken}` } });
                const clinicianUserId = clinicianUsers.json().find((u: { externalSubject: string }) => u.externalSubject === "idp|clinician-bg").id;
                const clinicianItem = itemList.find((i) => i.subjectUserId === clinicianUserId)!;
                const reviewerUsers = clinicianUsers.json().find((u: { externalSubject: string }) => u.externalSubject === "idp|reviewer");
                const reviewerItem = itemList.find((i) => i.subjectUserId === reviewerUsers.id)!;

                const selfDecide = await app.inject({
                    method: "POST",
                    url: `/organizations/${orgId}/access-reviews/${campaignId}/items/${adminItem.id}/decide`,
                    headers: { authorization: `Bearer ${adminToken}` },
                    payload: { decision: "keep" },
                });
                expect(selfDecide.statusCode).toBe(400);
                expect(selfDecide.json().error).toBe("self_review");

                const keepReviewer = await app.inject({
                    method: "POST",
                    url: `/organizations/${orgId}/access-reviews/${campaignId}/items/${reviewerItem.id}/decide`,
                    headers: { authorization: `Bearer ${adminToken}` },
                    payload: { decision: "keep" },
                });
                expect(keepReviewer.statusCode).toBe(200);

                const alreadyDecided = await app.inject({
                    method: "POST",
                    url: `/organizations/${orgId}/access-reviews/${campaignId}/items/${reviewerItem.id}/decide`,
                    headers: { authorization: `Bearer ${adminToken}` },
                    payload: { decision: "keep" },
                });
                expect(alreadyDecided.statusCode).toBe(400);
                expect(alreadyDecided.json().error).toBe("already_decided");

                // Admin can't decide their own item — have the reviewer
                // decide it instead, so the campaign can actually complete.
                const decideAdminItem = await app.inject({
                    method: "POST",
                    url: `/organizations/${orgId}/access-reviews/${campaignId}/items/${adminItem.id}/decide`,
                    headers: { authorization: `Bearer ${reviewerToken}` },
                    payload: { decision: "keep" },
                });
                expect(decideAdminItem.statusCode).toBe(200);

                const revokeClinician = await app.inject({
                    method: "POST",
                    url: `/organizations/${orgId}/access-reviews/${campaignId}/items/${clinicianItem.id}/decide`,
                    headers: { authorization: `Bearer ${adminToken}` },
                    payload: { decision: "revoke" },
                });
                expect(revokeClinician.statusCode).toBe(200);

                // Effective on the very next request — no separate sweep/
                // propagation step.
                const clinicianAfterRevoke = await app.inject({
                    method: "GET",
                    url: `/organizations/${orgId}/users`,
                    headers: { authorization: `Bearer ${clinicianToken}` },
                });
                expect(clinicianAfterRevoke.statusCode).toBe(403);

                const completedCampaign = await app.inject({
                    method: "GET",
                    url: `/organizations/${orgId}/access-reviews`,
                    headers: { authorization: `Bearer ${adminToken}` },
                });
                const completed = completedCampaign.json().find((c: { id: string }) => c.id === campaignId);
                expect(completed.status).toBe("completed");
                expect(completed.decidedCount).toBe(3);
            });

            it("records an audit entry for every break-glass and access-review action", async () => {
                const invoke = await app.inject({
                    method: "POST",
                    url: `/organizations/${orgId}/break-glass/invoke`,
                    headers: { authorization: `Bearer ${clinicianToken}` },
                    payload: { justification: "Auditable emergency, ten characters." },
                });
                await app.inject({
                    method: "POST",
                    url: `/organizations/${orgId}/break-glass/grants/${invoke.json().id}/review`,
                    headers: { authorization: `Bearer ${reviewerToken}` },
                    payload: { outcome: "acknowledged" },
                });
                await app.inject({
                    method: "POST",
                    url: `/organizations/${orgId}/access-reviews`,
                    headers: { authorization: `Bearer ${adminToken}` },
                });

                const audit = await app.inject({ method: "GET", url: `/organizations/${orgId}/audit`, headers: { authorization: `Bearer ${adminToken}` } });
                const actions = (audit.json() as { action: string }[]).map((entry) => entry.action);
                expect(actions).toEqual(
                    expect.arrayContaining(["breakGlassPolicy.set", "breakGlass.invoke", "breakGlass.review", "accessReview.campaignCreate"])
                );
            });
        });

        describe("SCIM provisioning (P2 item 1: SCIM and external group reconciliation)", () => {
            let scimUserToken: string;

            beforeEach(async () => {
                const scimPolicy = await app.inject({
                    method: "POST",
                    url: `/organizations/${orgId}/policies`,
                    headers: { authorization: `Bearer ${adminToken}` },
                    payload: {
                        name: "ScimAdmin",
                        document: { version: "2026-01-01", statements: [{ effect: "Allow", actions: ["scim:manageTokens"], resources: ["*"] }] },
                    },
                });
                await app.inject({
                    method: "POST",
                    url: `/organizations/${orgId}/users`,
                    headers: { authorization: `Bearer ${adminToken}` },
                    payload: { externalSubject: "idp|scim-admin", displayName: "SCIM Admin", policyIds: [scimPolicy.json().id] },
                });
                scimUserToken = await tokenFor("idp|scim-admin");
            });

            it("scim:manageTokens is required to create/list/revoke SCIM tokens", async () => {
                const outsiderToken = await tokenFor("idp|scim-outsider");
                await app.inject({
                    method: "POST",
                    url: `/organizations/${orgId}/users`,
                    headers: { authorization: `Bearer ${adminToken}` },
                    payload: { externalSubject: "idp|scim-outsider", displayName: "No SCIM Perm" },
                });
                const denied = await app.inject({
                    method: "POST",
                    url: `/organizations/${orgId}/scim-tokens`,
                    headers: { authorization: `Bearer ${outsiderToken}` },
                    payload: { name: "Should be denied" },
                });
                expect(denied.statusCode).toBe(403);
            });

            it("creates a token (secret shown once), lists it without the hash, and can revoke it", async () => {
                const created = await app.inject({
                    method: "POST",
                    url: `/organizations/${orgId}/scim-tokens`,
                    headers: { authorization: `Bearer ${scimUserToken}` },
                    payload: { name: "Okta connector" },
                });
                expect(created.statusCode).toBe(201);
                expect(created.json().secret).toEqual(expect.any(String));
                expect(created.json().token.tokenHash).toBeUndefined();
                const tokenId = created.json().token.id;

                const list = await app.inject({
                    method: "GET",
                    url: `/organizations/${orgId}/scim-tokens`,
                    headers: { authorization: `Bearer ${scimUserToken}` },
                });
                expect(list.json()).toHaveLength(1);
                expect(list.json()[0].tokenHash).toBeUndefined();
                expect(list.json()[0].revokedAt).toBeUndefined();

                const revoke = await app.inject({
                    method: "DELETE",
                    url: `/organizations/${orgId}/scim-tokens/${tokenId}`,
                    headers: { authorization: `Bearer ${scimUserToken}` },
                });
                expect(revoke.statusCode).toBe(204);

                const revokedAgain = await app.inject({
                    method: "DELETE",
                    url: `/organizations/${orgId}/scim-tokens/${tokenId}`,
                    headers: { authorization: `Bearer ${scimUserToken}` },
                });
                expect(revokedAgain.statusCode).toBe(404);
            });

            describe("the SCIM protocol endpoints (bearer-token authenticated, not OIDC)", () => {
                let scimSecret: string;

                beforeEach(async () => {
                    const created = await app.inject({
                        method: "POST",
                        url: `/organizations/${orgId}/scim-tokens`,
                        headers: { authorization: `Bearer ${scimUserToken}` },
                        payload: { name: "Test connector" },
                    });
                    scimSecret = created.json().secret;
                });

                it("rejects a missing, malformed, or wrong bearer token with a SCIM-shaped 401", async () => {
                    const noAuth = await app.inject({ method: "GET", url: `/scim/v2/organizations/${orgId}/Users` });
                    expect(noAuth.statusCode).toBe(401);
                    expect(noAuth.json().schemas).toEqual(["urn:ietf:params:scim:api:messages:2.0:Error"]);

                    const wrongAuth = await app.inject({
                        method: "GET",
                        url: `/scim/v2/organizations/${orgId}/Users`,
                        headers: { authorization: "Bearer not-a-real-token" },
                    });
                    expect(wrongAuth.statusCode).toBe(401);
                });

                it("GET ServiceProviderConfig and ResourceTypes respond for a valid token", async () => {
                    const config = await app.inject({
                        method: "GET",
                        url: `/scim/v2/organizations/${orgId}/ServiceProviderConfig`,
                        headers: { authorization: `Bearer ${scimSecret}` },
                    });
                    expect(config.statusCode).toBe(200);
                    expect(config.json().patch.supported).toBe(true);

                    const resourceTypes = await app.inject({
                        method: "GET",
                        url: `/scim/v2/organizations/${orgId}/ResourceTypes`,
                        headers: { authorization: `Bearer ${scimSecret}` },
                    });
                    expect(resourceTypes.statusCode).toBe(200);
                    expect(resourceTypes.json()[0].name).toBe("User");
                });

                it("full lifecycle: create -> idempotent-create rejects duplicate -> filter finds it -> accept -> filter now resolves the real user (a different id) -> deactivate -> reactivate -> delete suspends, never hard-deletes", async () => {
                    // 1. Create — maps to an Invitation; the plaintext acceptance
                    // token is returned once, since nothing else can ever
                    // deliver it to the invitee (see routes/scim.ts's own
                    // doc comment).
                    const create = await app.inject({
                        method: "POST",
                        url: `/scim/v2/organizations/${orgId}/Users`,
                        headers: { authorization: `Bearer ${scimSecret}` },
                        payload: { userName: "scim.hire@example-hospital.test", displayName: "Scim Hire" },
                    });
                    expect(create.statusCode).toBe(201);
                    expect(create.json().active).toBe(true);
                    expect(create.json().modelforgeInviteToken).toEqual(expect.any(String));
                    const invitationId = create.json().id;
                    const acceptanceToken = create.json().modelforgeInviteToken;

                    // 2. Re-creating the same userName is rejected — SCIM
                    // uniqueness semantics, not a silent second invitation.
                    const duplicate = await app.inject({
                        method: "POST",
                        url: `/scim/v2/organizations/${orgId}/Users`,
                        headers: { authorization: `Bearer ${scimSecret}` },
                        payload: { userName: "scim.hire@example-hospital.test" },
                    });
                    expect(duplicate.statusCode).toBe(409);
                    expect(duplicate.json().scimType).toBe("uniqueness");

                    // 3. Filter-based lookup (what a real IdP's reconciliation
                    // loop actually polls with) finds the pending invitation.
                    const filtered = await app.inject({
                        method: "GET",
                        url: `/scim/v2/organizations/${orgId}/Users?${new URLSearchParams({ filter: 'userName eq "scim.hire@example-hospital.test"' })}`,
                        headers: { authorization: `Bearer ${scimSecret}` },
                    });
                    expect(filtered.statusCode).toBe(200);
                    expect(filtered.json().totalResults).toBe(1);
                    expect(filtered.json().Resources[0].id).toBe(invitationId);

                    // 4. GET by id works directly too, while still pending.
                    const byId = await app.inject({
                        method: "GET",
                        url: `/scim/v2/organizations/${orgId}/Users/${invitationId}`,
                        headers: { authorization: `Bearer ${scimSecret}` },
                    });
                    expect(byId.statusCode).toBe(200);
                    expect(byId.json().userName).toBe("scim.hire@example-hospital.test");

                    // 5. The invitee actually logs in and accepts — reusing
                    // routes/invitations.ts's real accept endpoint verbatim,
                    // exactly as the product decision intended.
                    const hireLoginToken = await tokenFor("idp|scim-hire", { email: "scim.hire@example-hospital.test", name: "Scim Hire" });
                    const accept = await app.inject({
                        method: "POST",
                        url: `/organizations/${orgId}/invitations/${invitationId}/accept`,
                        headers: { authorization: `Bearer ${hireLoginToken}` },
                        payload: { token: acceptanceToken },
                    });
                    expect(accept.statusCode).toBe(200);
                    const realUserId = accept.json().user.id;
                    expect(realUserId).not.toBe(invitationId);

                    // 6. Disclosed id-transition behavior: filtering by the
                    // same userName now resolves to the REAL user, with a
                    // DIFFERENT id than the original invitation — the
                    // documented consequence of reusing the invitation
                    // mechanism rather than a new identity-less User concept.
                    const filteredAfterAccept = await app.inject({
                        method: "GET",
                        url: `/scim/v2/organizations/${orgId}/Users?${new URLSearchParams({ filter: 'userName eq "scim.hire@example-hospital.test"' })}`,
                        headers: { authorization: `Bearer ${scimSecret}` },
                    });
                    expect(filteredAfterAccept.json().totalResults).toBe(1);
                    expect(filteredAfterAccept.json().Resources[0].id).toBe(realUserId);
                    expect(filteredAfterAccept.json().Resources[0].active).toBe(true);

                    // 7. PATCH (Azure AD's path-based shape) deactivates —
                    // suspends the real membership.
                    const patchDeactivate = await app.inject({
                        method: "PATCH",
                        url: `/scim/v2/organizations/${orgId}/Users/${realUserId}`,
                        headers: { authorization: `Bearer ${scimSecret}` },
                        payload: { Operations: [{ op: "replace", path: "active", value: false }] },
                    });
                    expect(patchDeactivate.statusCode).toBe(200);
                    expect(patchDeactivate.json().active).toBe(false);

                    // Deactivation actually took effect on real
                    // authorization, not just the SCIM view of it — a
                    // suspended membership is rejected at the requireOrgUser
                    // layer (403 "membership is not active"), before
                    // /authz/check ever reaches policy evaluation, so this
                    // is a 403, not a policy-evaluated {effect:"Deny"}.
                    const authzAfterDeactivate = await app.inject({
                        method: "POST",
                        url: `/organizations/${orgId}/authz/check`,
                        headers: { authorization: `Bearer ${hireLoginToken}` },
                        payload: { action: "iam:listUsers", resource: `organization:${orgId}` },
                    });
                    expect(authzAfterDeactivate.statusCode).toBe(403);

                    // 8. PATCH (Okta's value-object shape, no path) reactivates.
                    const patchReactivate = await app.inject({
                        method: "PATCH",
                        url: `/scim/v2/organizations/${orgId}/Users/${realUserId}`,
                        headers: { authorization: `Bearer ${scimSecret}` },
                        payload: { Operations: [{ op: "replace", value: { active: true } }] },
                    });
                    expect(patchReactivate.statusCode).toBe(200);
                    expect(patchReactivate.json().active).toBe(true);

                    // 9. DELETE — never a hard delete (this codebase's
                    // standing convention). Same effect as active:false; the
                    // user record still exists afterward via the normal
                    // admin-facing GET /users.
                    const del = await app.inject({
                        method: "DELETE",
                        url: `/scim/v2/organizations/${orgId}/Users/${realUserId}`,
                        headers: { authorization: `Bearer ${scimSecret}` },
                    });
                    expect(del.statusCode).toBe(204);
                    const stillExists = await app.inject({
                        method: "GET",
                        url: `/organizations/${orgId}/users`,
                        headers: { authorization: `Bearer ${adminToken}` },
                    });
                    expect(stillExists.json().some((u: { id: string }) => u.id === realUserId)).toBe(true);
                });

                it("GET .../Users rejects an unsupported filter expression with 400, rather than silently returning everyone", async () => {
                    const response = await app.inject({
                        method: "GET",
                        url: `/scim/v2/organizations/${orgId}/Users?${new URLSearchParams({ filter: 'displayName co "x"' })}`,
                        headers: { authorization: `Bearer ${scimSecret}` },
                    });
                    expect(response.statusCode).toBe(400);
                    expect(response.json().scimType).toBe("invalidFilter");
                });

                it("GET .../Users/:id for an unknown id is 404, SCIM-shaped", async () => {
                    const response = await app.inject({
                        method: "GET",
                        url: `/scim/v2/organizations/${orgId}/Users/00000000-0000-0000-0000-000000000000`,
                        headers: { authorization: `Bearer ${scimSecret}` },
                    });
                    expect(response.statusCode).toBe(404);
                    expect(response.json().schemas).toEqual(["urn:ietf:params:scim:api:messages:2.0:Error"]);
                });

                it("a revoked token can no longer authenticate SCIM requests", async () => {
                    const list = await app.inject({
                        method: "GET",
                        url: `/organizations/${orgId}/scim-tokens`,
                        headers: { authorization: `Bearer ${scimUserToken}` },
                    });
                    const tokenId = list.json()[0].id;
                    await app.inject({
                        method: "DELETE",
                        url: `/organizations/${orgId}/scim-tokens/${tokenId}`,
                        headers: { authorization: `Bearer ${scimUserToken}` },
                    });
                    const response = await app.inject({
                        method: "GET",
                        url: `/scim/v2/organizations/${orgId}/Users`,
                        headers: { authorization: `Bearer ${scimSecret}` },
                    });
                    expect(response.statusCode).toBe(401);
                });

                it("records an audit entry for token creation, revocation, and SCIM-driven user creation", async () => {
                    await app.inject({
                        method: "POST",
                        url: `/scim/v2/organizations/${orgId}/Users`,
                        headers: { authorization: `Bearer ${scimSecret}` },
                        payload: { userName: "audited.scim@example-hospital.test" },
                    });
                    const audit = await app.inject({
                        method: "GET",
                        url: `/organizations/${orgId}/audit`,
                        headers: { authorization: `Bearer ${adminToken}` },
                    });
                    const actions = audit.json().map((entry: { action: string }) => entry.action);
                    expect(actions).toContain("scimToken.create");
                    expect(actions).toContain("invitation.create");
                });
            });
        });

        describe("action catalog (P0 item 10: versioned action/resource catalog, domain/action-catalog.ts)", () => {
            it("GET .../action-catalog returns the catalog, gated the same as GET .../policies (iam:listPolicies)", async () => {
                const response = await app.inject({
                    method: "GET",
                    url: `/organizations/${orgId}/action-catalog`,
                    headers: { authorization: `Bearer ${adminToken}` },
                });
                expect(response.statusCode).toBe(200);
                const body = response.json();
                expect(body.version).toEqual(expect.any(String));
                expect(body.actions).toEqual(
                    expect.arrayContaining([expect.objectContaining({ action: "patientCase:view" })])
                );
                expect(body.resourceTypes.length).toBeGreaterThan(0);
            });

            it("GET .../action-catalog is denied for a caller without iam:listPolicies", async () => {
                const noPermsToken = await tokenFor("idp|catalog-no-perms");
                await app.inject({
                    method: "POST",
                    url: `/organizations/${orgId}/users`,
                    headers: { authorization: `Bearer ${adminToken}` },
                    payload: { externalSubject: "idp|catalog-no-perms", displayName: "No Perms" },
                });
                const response = await app.inject({
                    method: "GET",
                    url: `/organizations/${orgId}/action-catalog`,
                    headers: { authorization: `Bearer ${noPermsToken}` },
                });
                expect(response.statusCode).toBe(403);
            });

            it("POST .../policies rejects an action pattern that matches nothing in the catalog", async () => {
                const response = await app.inject({
                    method: "POST",
                    url: `/organizations/${orgId}/policies`,
                    headers: { authorization: `Bearer ${adminToken}` },
                    payload: {
                        name: "TypoPolicy",
                        document: { version: "2026-01-01", statements: [{ effect: "Allow", actions: ["patientCase:viewx"], resources: ["*"] }] },
                    },
                });
                expect(response.statusCode).toBe(400);
                expect(response.json().error).toBe("unknown_action");
                expect(response.json().unknownActions).toEqual(["patientCase:viewx"]);
            });

            it("POST .../policies accepts a real catalog action and a wildcard that matches one", async () => {
                const response = await app.inject({
                    method: "POST",
                    url: `/organizations/${orgId}/policies`,
                    headers: { authorization: `Bearer ${adminToken}` },
                    payload: {
                        name: "RealPolicy",
                        document: { version: "2026-01-01", statements: [{ effect: "Allow", actions: ["patientCase:view", "iam:*"], resources: ["*"] }] },
                    },
                });
                expect(response.statusCode).toBe(201);
            });

            it("PATCH .../policies/:id rejects an unknown action in the replacement document", async () => {
                const created = await app.inject({
                    method: "POST",
                    url: `/organizations/${orgId}/policies`,
                    headers: { authorization: `Bearer ${adminToken}` },
                    payload: {
                        name: "PatchTarget",
                        document: { version: "2026-01-01", statements: [{ effect: "Allow", actions: ["patientCase:view"], resources: ["*"] }] },
                    },
                });
                const response = await app.inject({
                    method: "PATCH",
                    url: `/organizations/${orgId}/policies/${created.json().id}`,
                    headers: { authorization: `Bearer ${adminToken}` },
                    payload: { document: { version: "2026-01-01", statements: [{ effect: "Allow", actions: ["nonsense:action"], resources: ["*"] }] } },
                });
                expect(response.statusCode).toBe(400);
                expect(response.json().error).toBe("unknown_action");
            });

            it("PATCH .../policies/:id with no document field is unaffected (the check only runs when a document is actually being replaced)", async () => {
                const created = await app.inject({
                    method: "POST",
                    url: `/organizations/${orgId}/policies`,
                    headers: { authorization: `Bearer ${adminToken}` },
                    payload: {
                        name: "RenameOnly",
                        document: { version: "2026-01-01", statements: [{ effect: "Allow", actions: ["patientCase:view"], resources: ["*"] }] },
                    },
                });
                const response = await app.inject({
                    method: "PATCH",
                    url: `/organizations/${orgId}/policies/${created.json().id}`,
                    headers: { authorization: `Bearer ${adminToken}` },
                    payload: { name: "RenamedOnly" },
                });
                expect(response.statusCode).toBe(200);
                expect(response.json().name).toBe("RenamedOnly");
            });

            it("POST .../policies/:id/versions (propose) rejects an unknown action the same way", async () => {
                const created = await app.inject({
                    method: "POST",
                    url: `/organizations/${orgId}/policies`,
                    headers: { authorization: `Bearer ${adminToken}` },
                    payload: {
                        name: "ProposeTarget",
                        document: { version: "2026-01-01", statements: [{ effect: "Allow", actions: ["patientCase:view"], resources: ["*"] }] },
                    },
                });
                const response = await app.inject({
                    method: "POST",
                    url: `/organizations/${orgId}/policies/${created.json().id}/versions`,
                    headers: { authorization: `Bearer ${adminToken}` },
                    payload: { document: { version: "2026-01-01", statements: [{ effect: "Allow", actions: ["totally:madeup"], resources: ["*"] }] } },
                });
                expect(response.statusCode).toBe(400);
                expect(response.json().error).toBe("unknown_action");
            });
        });

        describe("policy versioning, dual-control approval, and rollback (P1: signed central policy/configuration)", () => {
            let policyId: string;
            let proposerToken: string;
            let approverToken: string;

            beforeEach(async () => {
                const policy = await app.inject({
                    method: "POST",
                    url: `/organizations/${orgId}/policies`,
                    headers: { authorization: `Bearer ${adminToken}` },
                    payload: {
                        name: "VersionedPolicy",
                        document: { version: "2026-01-01", statements: [{ effect: "Allow", actions: ["patientCase:view"], resources: ["*"] }] },
                    },
                });
                policyId = policy.json().id;

                const proposerPolicy = await app.inject({
                    method: "POST",
                    url: `/organizations/${orgId}/policies`,
                    headers: { authorization: `Bearer ${adminToken}` },
                    payload: {
                        name: "CanPropose",
                        document: { version: "2026-01-01", statements: [{ effect: "Allow", actions: ["policy:propose", "iam:listPolicies"], resources: ["*"] }] },
                    },
                });
                await app.inject({
                    method: "POST",
                    url: `/organizations/${orgId}/users`,
                    headers: { authorization: `Bearer ${adminToken}` },
                    payload: { externalSubject: "idp|proposer", displayName: "Proposer", policyIds: [proposerPolicy.json().id] },
                });
                proposerToken = await tokenFor("idp|proposer");

                const approverPolicy = await app.inject({
                    method: "POST",
                    url: `/organizations/${orgId}/policies`,
                    headers: { authorization: `Bearer ${adminToken}` },
                    payload: {
                        name: "CanApprove",
                        document: { version: "2026-01-01", statements: [{ effect: "Allow", actions: ["policy:approve", "iam:listPolicies"], resources: ["*"] }] },
                    },
                });
                await app.inject({
                    method: "POST",
                    url: `/organizations/${orgId}/users`,
                    headers: { authorization: `Bearer ${adminToken}` },
                    payload: { externalSubject: "idp|approver", displayName: "Approver", policyIds: [approverPolicy.json().id] },
                });
                approverToken = await tokenFor("idp|approver");
            });

            it("propose -> self-approve rejected -> a different approver succeeds -> the live policy document actually changes", async () => {
                // Proposed by adminToken (holds "*", so it also legitimately
                // holds policy:approve) so the self-approve attempt below
                // reaches the self-check instead of 403ing for lack of
                // policy:approve in the first place.
                const propose = await app.inject({
                    method: "POST",
                    url: `/organizations/${orgId}/policies/${policyId}/versions`,
                    headers: { authorization: `Bearer ${adminToken}` },
                    payload: { document: { version: "2026-01-01", statements: [{ effect: "Allow", actions: ["patientCase:*"], resources: ["*"] }] } },
                });
                expect(propose.statusCode).toBe(201);
                expect(propose.json().status).toBe("pending");
                expect(propose.json().version).toBe(1);
                const versionId = propose.json().id;

                const selfApprove = await app.inject({
                    method: "POST",
                    url: `/organizations/${orgId}/policies/${policyId}/versions/${versionId}/approve`,
                    headers: { authorization: `Bearer ${adminToken}` },
                });
                expect(selfApprove.statusCode).toBe(400);
                expect(selfApprove.json().error).toBe("self_approval");

                const approve = await app.inject({
                    method: "POST",
                    url: `/organizations/${orgId}/policies/${policyId}/versions/${versionId}/approve`,
                    headers: { authorization: `Bearer ${approverToken}` },
                });
                expect(approve.statusCode).toBe(200);
                expect(approve.json().status).toBe("approved");

                const liveePolicy = await app.inject({
                    method: "GET",
                    url: `/organizations/${orgId}/policies`,
                    headers: { authorization: `Bearer ${adminToken}` },
                });
                const updated = liveePolicy.json().find((p: { id: string }) => p.id === policyId);
                expect(updated.document.statements[0].actions).toEqual(["patientCase:*"]);

                const alreadyApproved = await app.inject({
                    method: "POST",
                    url: `/organizations/${orgId}/policies/${policyId}/versions/${versionId}/approve`,
                    headers: { authorization: `Bearer ${approverToken}` },
                });
                expect(alreadyApproved.statusCode).toBe(400);
                expect(alreadyApproved.json().error).toBe("not_pending");
            });

            it("rejecting a pending version is allowed even by its own proposer, and never touches the live policy", async () => {
                // adminToken proposes AND rejects its own proposal here: the
                // point of this test is that there is no self-check on
                // reject (unlike approve), which is only meaningful for a
                // caller who actually holds policy:approve in the first
                // place — a proposer-only actor can't call reject at all.
                const propose = await app.inject({
                    method: "POST",
                    url: `/organizations/${orgId}/policies/${policyId}/versions`,
                    headers: { authorization: `Bearer ${adminToken}` },
                    payload: { document: { version: "2026-01-01", statements: [{ effect: "Deny", actions: ["*"], resources: ["*"] }] } },
                });
                const versionId = propose.json().id;

                const reject = await app.inject({
                    method: "POST",
                    url: `/organizations/${orgId}/policies/${policyId}/versions/${versionId}/reject`,
                    headers: { authorization: `Bearer ${adminToken}` },
                    payload: { reason: "Changed my mind." },
                });
                expect(reject.statusCode).toBe(200);
                expect(reject.json().status).toBe("rejected");

                const liveePolicy = await app.inject({
                    method: "GET",
                    url: `/organizations/${orgId}/policies`,
                    headers: { authorization: `Bearer ${adminToken}` },
                });
                const stillOriginal = liveePolicy.json().find((p: { id: string }) => p.id === policyId);
                expect(stillOriginal.document.statements[0].actions).toEqual(["patientCase:view"]);
            });

            it("rollback reactivates a superseded version and supersedes whatever was active, but refuses a pending or rejected target", async () => {
                const firstPropose = await app.inject({
                    method: "POST",
                    url: `/organizations/${orgId}/policies/${policyId}/versions`,
                    headers: { authorization: `Bearer ${proposerToken}` },
                    payload: { document: { version: "2026-01-01", statements: [{ effect: "Allow", actions: ["patientCase:view"], resources: ["organization:x"] }] } },
                });
                const firstVersionId = firstPropose.json().id;
                await app.inject({
                    method: "POST",
                    url: `/organizations/${orgId}/policies/${policyId}/versions/${firstVersionId}/approve`,
                    headers: { authorization: `Bearer ${approverToken}` },
                });

                const secondPropose = await app.inject({
                    method: "POST",
                    url: `/organizations/${orgId}/policies/${policyId}/versions`,
                    headers: { authorization: `Bearer ${proposerToken}` },
                    payload: { document: { version: "2026-01-01", statements: [{ effect: "Allow", actions: ["patientCase:delete"], resources: ["*"] }] } },
                });
                const secondVersionId = secondPropose.json().id;
                await app.inject({
                    method: "POST",
                    url: `/organizations/${orgId}/policies/${policyId}/versions/${secondVersionId}/approve`,
                    headers: { authorization: `Bearer ${approverToken}` },
                });

                // firstVersionId is now "superseded" by secondVersionId.
                const rollback = await app.inject({
                    method: "POST",
                    url: `/organizations/${orgId}/policies/${policyId}/rollback`,
                    headers: { authorization: `Bearer ${approverToken}` },
                    payload: { versionId: firstVersionId },
                });
                expect(rollback.statusCode).toBe(200);
                expect(rollback.json().status).toBe("approved");

                const history = await app.inject({
                    method: "GET",
                    url: `/organizations/${orgId}/policies/${policyId}/versions`,
                    headers: { authorization: `Bearer ${approverToken}` },
                });
                const versions = history.json() as { id: string; status: string }[];
                expect(versions.find((v) => v.id === firstVersionId)?.status).toBe("approved");
                expect(versions.find((v) => v.id === secondVersionId)?.status).toBe("superseded");

                const liveePolicy = await app.inject({
                    method: "GET",
                    url: `/organizations/${orgId}/policies`,
                    headers: { authorization: `Bearer ${adminToken}` },
                });
                const current = liveePolicy.json().find((p: { id: string }) => p.id === policyId);
                expect(current.document.statements[0].resources).toEqual(["organization:x"]);

                // secondVersionId is "superseded", not "pending"/"rejected" —
                // rolling back to a pending or already-rejected version must
                // never be allowed; propose a third, still-pending version
                // and confirm rollback refuses it.
                const thirdPropose = await app.inject({
                    method: "POST",
                    url: `/organizations/${orgId}/policies/${policyId}/versions`,
                    headers: { authorization: `Bearer ${proposerToken}` },
                    payload: { document: { version: "2026-01-01", statements: [{ effect: "Allow", actions: ["*"], resources: ["*"] }] } },
                });
                const rollbackToPending = await app.inject({
                    method: "POST",
                    url: `/organizations/${orgId}/policies/${policyId}/rollback`,
                    headers: { authorization: `Bearer ${approverToken}` },
                    payload: { versionId: thirdPropose.json().id },
                });
                expect(rollbackToPending.statusCode).toBe(400);
                expect(rollbackToPending.json().error).toBe("not_rollback_eligible");
            });

            it("records an audit entry for every policy-version action", async () => {
                const propose = await app.inject({
                    method: "POST",
                    url: `/organizations/${orgId}/policies/${policyId}/versions`,
                    headers: { authorization: `Bearer ${proposerToken}` },
                    payload: { document: { version: "2026-01-01", statements: [{ effect: "Allow", actions: ["patientCase:view"], resources: ["*"] }] } },
                });
                await app.inject({
                    method: "POST",
                    url: `/organizations/${orgId}/policies/${policyId}/versions/${propose.json().id}/approve`,
                    headers: { authorization: `Bearer ${approverToken}` },
                });

                const audit = await app.inject({ method: "GET", url: `/organizations/${orgId}/audit`, headers: { authorization: `Bearer ${adminToken}` } });
                const actions = (audit.json() as { action: string }[]).map((entry) => entry.action);
                expect(actions).toEqual(expect.arrayContaining(["policyVersion.propose", "policyVersion.approve", "policy.update"]));
            });
        });
    });
});

describe("CORS (@fastify/cors, gated on adminConsoleOrigin — see config.ts)", () => {
    let jwks: JWTVerifyGetKey;

    beforeAll(async () => {
        const pair = await generateKeyPair("RS256");
        const publicJwk = await exportJWK(pair.publicKey);
        publicJwk.kid = KID;
        publicJwk.alg = "RS256";
        jwks = createLocalJWKSet({ keys: [publicJwk] });
    });

    function buildTestApp(adminConsoleOrigin?: string): FastifyInstance {
        const auditStore = new InMemoryAuditStore();
        return buildApp({
            store: new InMemoryIamStore(auditStore),
            caseStore: new InMemoryCaseStore(auditStore),
            idempotencyStore: new InMemoryIdempotencyStore(),
            auditStore,
            jwks,
            oidc: { issuer: ISSUER, audience: AUDIENCE },
            adminConsoleOrigin,
        });
    }

    it("registers no CORS headers at all when adminConsoleOrigin is unset (today's default)", async () => {
        const app = buildTestApp();
        const response = await app.inject({ method: "GET", url: "/health", headers: { origin: "https://admin.example-hospital.test" } });
        expect(response.headers["access-control-allow-origin"]).toBeUndefined();
    });

    it("allows the configured origin on a simple request", async () => {
        const app = buildTestApp("https://admin.example-hospital.test");
        const response = await app.inject({ method: "GET", url: "/health", headers: { origin: "https://admin.example-hospital.test" } });
        expect(response.headers["access-control-allow-origin"]).toBe("https://admin.example-hospital.test");
    });

    it("never reflects an arbitrary request Origin — the header is always the one fixed configured value", async () => {
        // @fastify/cors with a static-string `origin` (as opposed to an
        // array/function) always sets that exact value on every response,
        // regardless of the request's own Origin header — this is correct,
        // not a bug: a browser at https://attacker.test compares the
        // response's Access-Control-Allow-Origin against *its own* origin,
        // so a fixed value that never equals attacker.test still blocks it
        // from reading the response, exactly as if attacker.test had been
        // omitted entirely. What would actually be a vulnerability is the
        // header *reflecting* whatever Origin was sent — this asserts that
        // does not happen.
        const app = buildTestApp("https://admin.example-hospital.test");
        const response = await app.inject({ method: "GET", url: "/health", headers: { origin: "https://attacker.test" } });
        expect(response.headers["access-control-allow-origin"]).toBe("https://admin.example-hospital.test");
    });

    it("answers a CORS preflight (OPTIONS) request for the configured origin", async () => {
        const app = buildTestApp("https://admin.example-hospital.test");
        const response = await app.inject({
            method: "OPTIONS",
            url: "/me",
            headers: {
                origin: "https://admin.example-hospital.test",
                "access-control-request-method": "GET",
                "access-control-request-headers": "authorization",
            },
        });
        expect(response.statusCode).toBe(204);
        expect(response.headers["access-control-allow-origin"]).toBe("https://admin.example-hospital.test");
    });

    it("allows PUT, PATCH, and DELETE preflights — every mutating admin-console call (quota, break-glass policy, user/group/policy updates, deletes) needs these, not just GET/POST", async () => {
        // Caught by an actual browser session against a real server, not by
        // any prior test: @fastify/cors's own default `methods` is
        // 'GET,HEAD,POST' only (verified directly against the installed
        // @fastify/cors@11 package) — the one preflight test that existed
        // before this only ever asserted a GET preflight, so a real
        // browser's PUT-method quota save silently failed CORS while every
        // .inject()-based integration test (which bypasses CORS entirely)
        // stayed green.
        const app = buildTestApp("https://admin.example-hospital.test");
        for (const method of ["PUT", "PATCH", "DELETE"]) {
            const response = await app.inject({
                method: "OPTIONS",
                url: "/me",
                headers: { origin: "https://admin.example-hospital.test", "access-control-request-method": method, "access-control-request-headers": "authorization" },
            });
            expect(response.statusCode, `${method} preflight`).toBe(204);
            expect(response.headers["access-control-allow-methods"], `${method} preflight`).toContain(method);
        }
    });

    it("never sets Access-Control-Allow-Credentials (auth here is a header, never an ambient cookie)", async () => {
        const app = buildTestApp("https://admin.example-hospital.test");
        const response = await app.inject({ method: "GET", url: "/health", headers: { origin: "https://admin.example-hospital.test" } });
        expect(response.headers["access-control-allow-credentials"]).toBeUndefined();
    });
});

describe("multiple-IdP compatibility (P2 item 3), end to end through a real HTTP request", () => {
    const PRIMARY_ISSUER = "https://idp-a.example-hospital.test/realms/clinical";
    const SECONDARY_ISSUER = "https://idp-b.example-hospital.test";
    const AUDIENCE = "modelforge-iam-server";
    const SECONDARY_AUDIENCE = "modelforge-iam-server-b";

    let primaryKey: CryptoKey;
    let primaryJwks: JWTVerifyGetKey;
    let secondaryKey: CryptoKey;
    let secondaryJwks: JWTVerifyGetKey;
    let app: FastifyInstance;

    beforeAll(async () => {
        const primaryPair = await generateKeyPair("RS256");
        primaryKey = primaryPair.privateKey;
        const primaryPublicJwk = await exportJWK(primaryPair.publicKey);
        primaryPublicJwk.kid = "primary-key";
        primaryPublicJwk.alg = "RS256";
        primaryJwks = createLocalJWKSet({ keys: [primaryPublicJwk] });

        const secondaryPair = await generateKeyPair("RS256");
        secondaryKey = secondaryPair.privateKey;
        const secondaryPublicJwk = await exportJWK(secondaryPair.publicKey);
        secondaryPublicJwk.kid = "secondary-key";
        secondaryPublicJwk.alg = "RS256";
        secondaryJwks = createLocalJWKSet({ keys: [secondaryPublicJwk] });
    });

    beforeEach(() => {
        const auditStore = new InMemoryAuditStore();
        app = buildApp({
            store: new InMemoryIamStore(auditStore),
            caseStore: new InMemoryCaseStore(auditStore),
            idempotencyStore: new InMemoryIdempotencyStore(),
            auditStore,
            jwks: primaryJwks,
            oidc: { issuer: PRIMARY_ISSUER, audience: AUDIENCE },
            additionalOidcIssuers: [{ issuer: SECONDARY_ISSUER, audience: SECONDARY_AUDIENCE, jwks: secondaryJwks }],
        });
    });

    function tokenFrom(key: CryptoKey, kid: string, issuer: string, audience: string, subject: string): Promise<string> {
        return new SignJWT({ sub: subject })
            .setProtectedHeader({ alg: "RS256", kid })
            .setIssuedAt()
            .setIssuer(issuer)
            .setAudience(audience)
            .setExpirationTime("1h")
            .sign(key);
    }

    it("a real request bearing a primary-issuer token authenticates normally", async () => {
        const token = await tokenFrom(primaryKey, "primary-key", PRIMARY_ISSUER, AUDIENCE, "idp-a|clinician-1");
        const response = await app.inject({ method: "GET", url: "/me", headers: { authorization: `Bearer ${token}` } });
        expect(response.statusCode).toBe(200);
    });

    it("a real request bearing a secondary-issuer token also authenticates, as a distinct identity", async () => {
        const token = await tokenFrom(secondaryKey, "secondary-key", SECONDARY_ISSUER, SECONDARY_AUDIENCE, "idp-b|clinician-2");
        const response = await app.inject({ method: "GET", url: "/me", headers: { authorization: `Bearer ${token}` } });
        expect(response.statusCode).toBe(200);
    });

    it("a token from neither configured issuer is rejected over real HTTP, same as the single-issuer case always was", async () => {
        const untrustedPair = await generateKeyPair("RS256");
        const token = await new SignJWT({ sub: "idp-x|nobody" })
            .setProtectedHeader({ alg: "RS256", kid: "unrelated-key" })
            .setIssuedAt()
            .setIssuer("https://never-configured.test")
            .setAudience(AUDIENCE)
            .setExpirationTime("1h")
            .sign(untrustedPair.privateKey);
        const response = await app.inject({ method: "GET", url: "/me", headers: { authorization: `Bearer ${token}` } });
        expect(response.statusCode).toBe(401);
    });
});

describe("institutional MCP registry (P2 item 4: managed model/MCP registry and egress controls)", () => {
    let privateKey: CryptoKey;
    let jwks: JWTVerifyGetKey;
    let app: FastifyInstance;
    let orgId: string;
    let adminToken: string;
    let listOnlyToken: string;

    beforeAll(async () => {
        const pair = await generateKeyPair("RS256");
        privateKey = pair.privateKey;
        const publicJwk = await exportJWK(pair.publicKey);
        publicJwk.kid = KID;
        publicJwk.alg = "RS256";
        jwks = createLocalJWKSet({ keys: [publicJwk] });
    });

    function tokenFor(subject: string): Promise<string> {
        return new SignJWT({ sub: subject })
            .setProtectedHeader({ alg: "RS256", kid: KID })
            .setIssuedAt()
            .setIssuer(ISSUER)
            .setAudience(AUDIENCE)
            .setExpirationTime("1h")
            .sign(privateKey);
    }

    beforeEach(async () => {
        const auditStore = new InMemoryAuditStore();
        app = buildApp({
            store: new InMemoryIamStore(auditStore),
            caseStore: new InMemoryCaseStore(auditStore),
            idempotencyStore: new InMemoryIdempotencyStore(),
            auditStore,
            jwks,
            oidc: { issuer: ISSUER, audience: AUDIENCE },
        });

        adminToken = await tokenFor("idp|mcp-admin");
        const org = await app.inject({ method: "POST", url: "/organizations", headers: { authorization: `Bearer ${adminToken}` }, payload: { name: "MCP Registry Test Hospital" } });
        orgId = org.json().organization.id;

        const listOnlyPolicy = await app.inject({
            method: "POST",
            url: `/organizations/${orgId}/policies`,
            headers: { authorization: `Bearer ${adminToken}` },
            payload: { name: "McpRegistryListOnly", document: { version: "2026-01-01", statements: [{ effect: "Allow", actions: ["mcpRegistry:list"], resources: ["*"] }] } },
        });
        await app.inject({
            method: "POST",
            url: `/organizations/${orgId}/users`,
            headers: { authorization: `Bearer ${adminToken}` },
            payload: { externalSubject: "idp|mcp-list-only", displayName: "List Only", policyIds: [listOnlyPolicy.json().id] },
        });
        listOnlyToken = await tokenFor("idp|mcp-list-only");
    });

    it("a caller with only mcpRegistry:list cannot create an entry", async () => {
        const response = await app.inject({
            method: "POST",
            url: `/organizations/${orgId}/mcp-registry`,
            headers: { authorization: `Bearer ${listOnlyToken}` },
            payload: { name: "Filesystem Tool", transport: "stdio", endpoint: "npx @acme/mcp-fs", allowedTools: "*", dataEgressPolicy: "none" },
        });
        expect(response.statusCode).toBe(403);
    });

    it("an admin creates an entry, a list-only caller can see it, and its shape matches what was sent", async () => {
        const create = await app.inject({
            method: "POST",
            url: `/organizations/${orgId}/mcp-registry`,
            headers: { authorization: `Bearer ${adminToken}` },
            payload: {
                name: "Internal Ticketing",
                transport: "http",
                endpoint: "https://mcp.internal.example-hospital.org/ticketing",
                allowedTools: ["create_ticket", "get_ticket_status"],
                dataEgressPolicy: "metadata-only",
                description: "Read-only access to the internal ticketing system.",
            },
        });
        expect(create.statusCode).toBe(201);
        const entry = create.json();
        expect(entry).toMatchObject({
            organizationId: orgId,
            name: "Internal Ticketing",
            transport: "http",
            allowedTools: ["create_ticket", "get_ticket_status"],
            dataEgressPolicy: "metadata-only",
            status: "active",
        });

        const list = await app.inject({ method: "GET", url: `/organizations/${orgId}/mcp-registry`, headers: { authorization: `Bearer ${listOnlyToken}` } });
        expect(list.statusCode).toBe(200);
        expect(list.json().map((e: { id: string }) => e.id)).toContain(entry.id);

        const getOne = await app.inject({ method: "GET", url: `/organizations/${orgId}/mcp-registry/${entry.id}`, headers: { authorization: `Bearer ${listOnlyToken}` } });
        expect(getOne.statusCode).toBe(200);
        expect(getOne.json().name).toBe("Internal Ticketing");
    });

    it("rejects an entry whose allowedTools is neither '*' nor an array of strings", async () => {
        const response = await app.inject({
            method: "POST",
            url: `/organizations/${orgId}/mcp-registry`,
            headers: { authorization: `Bearer ${adminToken}` },
            payload: { name: "Bad Tool", transport: "stdio", endpoint: "npx bad", allowedTools: "everything", dataEgressPolicy: "none" },
        });
        expect(response.statusCode).toBe(400);
    });

    it("rejects an unknown dataEgressPolicy value rather than silently accepting it", async () => {
        const response = await app.inject({
            method: "POST",
            url: `/organizations/${orgId}/mcp-registry`,
            headers: { authorization: `Bearer ${adminToken}` },
            payload: { name: "Bad Egress", transport: "stdio", endpoint: "npx bad", allowedTools: "*", dataEgressPolicy: "send-everything" },
        });
        expect(response.statusCode).toBe(400);
    });

    it("update changes only the submitted fields, preserving the rest", async () => {
        const create = await app.inject({
            method: "POST",
            url: `/organizations/${orgId}/mcp-registry`,
            headers: { authorization: `Bearer ${adminToken}` },
            payload: { name: "Original Name", transport: "stdio", endpoint: "npx original", allowedTools: "*", dataEgressPolicy: "none" },
        });
        const entryId = create.json().id;

        const update = await app.inject({
            method: "PATCH",
            url: `/organizations/${orgId}/mcp-registry/${entryId}`,
            headers: { authorization: `Bearer ${adminToken}` },
            payload: { dataEgressPolicy: "unrestricted" },
        });
        expect(update.statusCode).toBe(200);
        expect(update.json()).toMatchObject({ name: "Original Name", transport: "stdio", dataEgressPolicy: "unrestricted" });
    });

    it("setting status to disabled is reflected on subsequent reads and by the status filter", async () => {
        const create = await app.inject({
            method: "POST",
            url: `/organizations/${orgId}/mcp-registry`,
            headers: { authorization: `Bearer ${adminToken}` },
            payload: { name: "Retiring Tool", transport: "stdio", endpoint: "npx retiring", allowedTools: "*", dataEgressPolicy: "none" },
        });
        const entryId = create.json().id;

        const disable = await app.inject({
            method: "POST",
            url: `/organizations/${orgId}/mcp-registry/${entryId}/status`,
            headers: { authorization: `Bearer ${adminToken}` },
            payload: { status: "disabled" },
        });
        expect(disable.statusCode).toBe(200);
        expect(disable.json().status).toBe("disabled");

        const activeOnly = await app.inject({ method: "GET", url: `/organizations/${orgId}/mcp-registry?status=active`, headers: { authorization: `Bearer ${adminToken}` } });
        expect(activeOnly.json().map((e: { id: string }) => e.id)).not.toContain(entryId);

        const disabledOnly = await app.inject({ method: "GET", url: `/organizations/${orgId}/mcp-registry?status=disabled`, headers: { authorization: `Bearer ${adminToken}` } });
        expect(disabledOnly.json().map((e: { id: string }) => e.id)).toContain(entryId);
    });

    it("returns 404 for an entry id that doesn't exist, not a crash", async () => {
        const response = await app.inject({
            method: "GET",
            url: `/organizations/${orgId}/mcp-registry/${randomUUID()}`,
            headers: { authorization: `Bearer ${adminToken}` },
        });
        expect(response.statusCode).toBe(404);
    });

    it("never returns another organization's MCP registry entries", async () => {
        await app.inject({
            method: "POST",
            url: `/organizations/${orgId}/mcp-registry`,
            headers: { authorization: `Bearer ${adminToken}` },
            payload: { name: "Org A Tool", transport: "stdio", endpoint: "npx org-a", allowedTools: "*", dataEgressPolicy: "none" },
        });

        const otherOrgToken = await tokenFor("idp|other-org-admin-mcp");
        const otherOrg = await app.inject({ method: "POST", url: "/organizations", headers: { authorization: `Bearer ${otherOrgToken}` }, payload: { name: "A Different Hospital" } });
        const otherOrgId = otherOrg.json().organization.id;

        const otherOrgList = await app.inject({ method: "GET", url: `/organizations/${otherOrgId}/mcp-registry`, headers: { authorization: `Bearer ${otherOrgToken}` } });
        expect(otherOrgList.json()).toEqual([]);
    });
});
