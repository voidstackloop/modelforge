import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { SignJWT, exportJWK, generateKeyPair, createLocalJWKSet, type JWTVerifyGetKey, type CryptoKey } from "jose";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../app.js";
import { InMemoryAuditStore } from "../store/audit-store.js";
import { InMemoryCaseStore } from "../store/in-memory-case-store.js";
import { InMemoryIamStore } from "../store/in-memory-iam-store.js";
import { InMemoryIdempotencyStore } from "../store/in-memory-idempotency-store.js";
import { TestAiProviderClient } from "../ai-gateway/provider-client.js";

/**
 * HTTP-level integration tests for routes/ai-gateway.ts — what only a real
 * app.inject() round trip can prove: route wiring, auth enforcement, HTTP-
 * level Idempotency-Key replay, and cross-tenant isolation. The lifecycle
 * itself (authorization gates, content scanning, admission, output safety)
 * is already covered at the unit level in ai-gateway/gateway.test.ts —
 * mirrors imaging.integration.test.ts's own division of labor.
 */
const ISSUER = "https://idp.example-hospital.test/realms/clinical";
const AUDIENCE = "modelforge-iam-server";
const KID = "test-key";

describe("ClinicalAiGateway: end-to-end route security", () => {
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
            // Never a real network call to an inference runtime in tests —
            // see app.ts's own defaultResolveAiProviderClient disclosure.
            resolveAiProviderClient: () => new TestAiProviderClient({ rawText: "SUMMARY: No interactions found.\nEVIDENCE:\n- Test evidence.\nFOLLOWUP:\n- Test follow-up.", modelVersion: "test-1" }),
        });
    });

    async function tokenFor(subject: string, extra?: Record<string, unknown>): Promise<string> {
        return new SignJWT({ sub: subject, ...extra }).setProtectedHeader({ alg: "RS256", kid: KID }).setIssuedAt().setIssuer(ISSUER).setAudience(AUDIENCE).setExpirationTime("1h").sign(privateKey);
    }

    async function createOrg(adminSubject: string): Promise<{ orgId: string; adminToken: string }> {
        const adminToken = await tokenFor(adminSubject, { name: "Dr. Admin" });
        const response = await app.inject({ method: "POST", url: "/organizations", headers: { authorization: `Bearer ${adminToken}` }, payload: { name: "Example Health System" } });
        expect(response.statusCode).toBe(201);
        return { orgId: response.json().organization.id, adminToken };
    }

    function caseFixturePayload(id: string) {
        const now = new Date().toISOString();
        return {
            id,
            title: "Synthetic case",
            demographics: { value: {}, includeInContext: false },
            presentingComplaint: { value: "", includeInContext: false },
            symptomsTimeline: { value: "", includeInContext: false },
            vitalSigns: { value: "", includeInContext: false },
            conditions: { value: [], includeInContext: false },
            allergies: { value: ["Penicillin"], includeInContext: true },
            medications: { value: ["Lisinopril 10mg daily"], includeInContext: true },
            labResults: { value: [], includeInContext: false },
            imagingAndReports: { value: "", includeInContext: false },
            clinicalNotes: [],
            attachments: [],
            consentRecords: [{ id: "consent-scope-1", scope: "ai-assistance", grantedAt: now, method: "in-person" }],
            createdAt: now,
            updatedAt: now,
        };
    }

    /** Creates an org, a case, an approved local provider/model, and a
     * treatment consent covering medications/allergies — the full setup
     * every request-lifecycle test below needs. */
    async function fullySetUp(orgSuffix: string) {
        const { orgId, adminToken } = await createOrg(`idp|dr-admin-${orgSuffix}`);
        const headers = { authorization: `Bearer ${adminToken}` };

        const caseId = `case-${orgSuffix}`;
        const caseResponse = await app.inject({ method: "POST", url: `/organizations/${orgId}/cases`, headers, payload: caseFixturePayload(caseId) });
        expect(caseResponse.statusCode).toBe(201);

        const providerResponse = await app.inject({ method: "POST", url: `/organizations/${orgId}/ai-providers`, headers, payload: { name: "Local inference", kind: "local" } });
        expect(providerResponse.statusCode).toBe(201);
        const providerId = providerResponse.json().id;

        const modelResponse = await app.inject({
            method: "POST",
            url: `/organizations/${orgId}/ai-providers/${providerId}/models`,
            headers,
            payload: {
                modelId: "llama3", modelVersion: "3.1", intendedUse: "medication review",
                supportedDataTypes: ["text"], maxContextTokens: 8192, hostingRegion: "local", processingLocation: "local",
                phiPermitted: true, validationStatus: "validated",
            },
        });
        expect(modelResponse.statusCode).toBe(201);
        const modelId = modelResponse.json().id;

        const settingsResponse = await app.inject({ method: "PUT", url: `/organizations/${orgId}/ai-provider-models/${modelId}/tenant-settings`, headers, payload: { enabled: true, phiAllowed: true, allowedRoles: [] } });
        expect(settingsResponse.statusCode).toBe(200);

        const consentResponse = await app.inject({ method: "POST", url: `/organizations/${orgId}/cases/${caseId}/ai-consents`, headers, payload: { purpose: "treatment", dataCategories: ["medications", "allergies"] } });
        expect(consentResponse.statusCode).toBe(201);

        return { orgId, adminToken, headers, caseId, providerId, modelId };
    }

    it("full happy path: preview, submit, read back, and review a clinical AI request", async () => {
        const { orgId, headers, caseId, modelId } = await fullySetUp("happy");

        const previewResponse = await app.inject({
            method: "POST",
            url: `/organizations/${orgId}/cases/${caseId}/ai-requests/preview`,
            headers,
            payload: { providerModelId: modelId, purposeOfUse: "medication-review", requestedCategories: ["medications", "allergies"] },
        });
        expect(previewResponse.statusCode).toBe(200);
        expect(previewResponse.json().dataCategories.sort()).toEqual(["allergies", "medications"]);

        const submitResponse = await app.inject({
            method: "POST",
            url: `/organizations/${orgId}/cases/${caseId}/ai-requests`,
            headers,
            payload: { providerModelId: modelId, purposeOfUse: "medication-review", requestedCategories: ["medications", "allergies"] },
        });
        expect(submitResponse.statusCode).toBe(201);
        const submitBody = submitResponse.json();
        expect(submitBody.outcome).toBe("completed");
        expect(submitBody.output.reviewStatus).toBe("unreviewed");
        expect(submitBody.output.summary).toContain("No interactions found");

        const getResponse = await app.inject({ method: "GET", url: `/organizations/${orgId}/ai-requests/${submitBody.request.id}`, headers });
        expect(getResponse.statusCode).toBe(200);
        expect(getResponse.json().outputs).toHaveLength(1);
        // Evidence provenance: both requested categories are scalar case
        // fields (not clinical notes), so before data-minimization.ts's
        // synthetic patientCaseField refs this would have had zero
        // citations despite both fields having actually reached the model.
        const citations = getResponse.json().outputs[0].citations;
        expect(citations).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ resourceType: "patientCaseField", resourceId: `medications:${caseId}`, locator: "medications" }),
                expect.objectContaining({ resourceType: "patientCaseField", resourceId: `allergies:${caseId}`, locator: "allergies" }),
            ])
        );
        expect(citations).toHaveLength(2);

        const reviewResponse = await app.inject({
            method: "POST",
            url: `/organizations/${orgId}/ai-outputs/${submitBody.output.id}/review`,
            headers,
            payload: { decision: "accepted" },
        });
        expect(reviewResponse.statusCode).toBe(201);

        const secondReview = await app.inject({ method: "POST", url: `/organizations/${orgId}/ai-outputs/${submitBody.output.id}/review`, headers, payload: { decision: "rejected" } });
        expect(secondReview.statusCode).toBe(409);
    });

    it("quality-monitor and quality-drift report real aggregate metrics from completed requests, gated by aiGateway:viewAuditTrail", async () => {
        const { orgId, headers, caseId, modelId } = await fullySetUp("quality-monitor");
        const payload = { providerModelId: modelId, purposeOfUse: "medication-review", requestedCategories: ["medications", "allergies"] };
        const submit = await app.inject({ method: "POST", url: `/organizations/${orgId}/cases/${caseId}/ai-requests`, headers, payload });
        expect(submit.statusCode).toBe(201);

        const snapshot = await app.inject({ method: "GET", url: `/organizations/${orgId}/ai-provider-models/${modelId}/quality-monitor`, headers });
        expect(snapshot.statusCode).toBe(200);
        expect(snapshot.json()).toMatchObject({ providerModelId: modelId, outputCount: 1, unreviewedCount: 1, reviewedRate: 0 });

        const drift = await app.inject({ method: "GET", url: `/organizations/${orgId}/ai-provider-models/${modelId}/quality-drift?splitAt=${encodeURIComponent(new Date(0).toISOString())}`, headers });
        expect(drift.statusCode).toBe(200);
        expect(drift.json()).toMatchObject({ sufficientData: false, drifted: false, alerts: [] });

        await app.inject({ method: "POST", url: `/organizations/${orgId}/users`, headers, payload: { externalSubject: "idp|no-audit-rights", displayName: "No Rights" } });
        const unprivilegedToken = await tokenFor("idp|no-audit-rights");
        const forbidden = await app.inject({ method: "GET", url: `/organizations/${orgId}/ai-provider-models/${modelId}/quality-monitor`, headers: { authorization: `Bearer ${unprivilegedToken}` } });
        expect(forbidden.statusCode).toBe(403);
    });

    it("omitting providerModelId auto-routes to the tenant's one eligible model — the route-level wiring for model-router.ts", async () => {
        const { orgId, headers, caseId } = await fullySetUp("auto-route");
        const submitResponse = await app.inject({
            method: "POST",
            url: `/organizations/${orgId}/cases/${caseId}/ai-requests`,
            headers,
            payload: { purposeOfUse: "medication-review", requestedCategories: ["medications", "allergies"] },
        });
        expect(submitResponse.statusCode).toBe(201);
        expect(submitResponse.json().outcome).toBe("completed");

        const previewResponse = await app.inject({
            method: "POST",
            url: `/organizations/${orgId}/cases/${caseId}/ai-requests/preview`,
            headers,
            payload: { purposeOfUse: "medication-review", requestedCategories: ["medications", "allergies"] },
        });
        expect(previewResponse.statusCode).toBe(200);
        expect(previewResponse.json().model?.modelId).toBe("llama3");
    });

    it("registers immutable llama.cpp artifacts and keeps deployments disabled until verification", async () => {
        const { orgId, headers, modelId } = await fullySetUp("inference-registry");
        const sha256 = "a".repeat(64);
        const configurationHash = "b".repeat(64);

        const artifactResponse = await app.inject({
            method: "POST",
            url: `/organizations/${orgId}/ai-provider-models/${modelId}/artifacts`,
            headers,
            payload: {
                runtime: "llamacpp",
                format: "gguf",
                sourceUri: "hf://acme/clinical-model",
                sourceRevision: "0123456789abcdef",
                fileName: "clinical-model-q4_k_m.gguf",
                sha256,
                configurationHash,
                licenseId: "apache-2.0",
                licenseAccepted: true,
                capabilities: {
                    chat: true,
                    streaming: true,
                    tools: false,
                    structuredOutput: true,
                    embeddings: false,
                    tokenCounting: true,
                },
                trustRemoteCode: false,
            },
        });
        expect(artifactResponse.statusCode).toBe(201);
        const artifact = artifactResponse.json();
        expect(artifact).toMatchObject({ runtime: "llamacpp", format: "gguf", status: "pending", sha256, configurationHash });

        const verifiedResponse = await app.inject({
            method: "POST",
            url: `/organizations/${orgId}/ai-model-artifacts/${artifact.id}/status`,
            headers,
            payload: { status: "verified" },
        });
        expect(verifiedResponse.statusCode).toBe(200);
        expect(verifiedResponse.json().status).toBe("verified");

        const deploymentResponse = await app.inject({
            method: "POST",
            url: `/organizations/${orgId}/ai-model-artifacts/${artifact.id}/deployments`,
            headers,
            payload: {
                name: "Local llama.cpp",
                endpointUrl: "http://llamacpp:8080/v1",
                servedModelName: "llama3",
                credentialRef: "env:MODELFORGE_LLAMACPP_API_KEY",
                tlsMode: "private-network",
                poolId: "00000000-0000-4000-8000-000000000001",
                maxConcurrency: 2,
                priority: 100,
            },
        });
        expect(deploymentResponse.statusCode).toBe(201);
        const deployment = deploymentResponse.json();
        expect(deployment.operationalStatus).toBe("disabled");
        expect(deployment.lastVerifiedAt).toBeUndefined();

        const prematureActivation = await app.inject({
            method: "POST",
            url: `/organizations/${orgId}/ai-inference-deployments/${deployment.id}/operational-status`,
            headers,
            payload: { status: "active" },
        });
        expect(prematureActivation.statusCode).toBe(409);
        expect(prematureActivation.json()).toMatchObject({ error: "verification_required" });

        const listResponse = await app.inject({
            method: "GET",
            url: `/organizations/${orgId}/ai-model-artifacts/${artifact.id}/deployments`,
            headers,
        });
        expect(listResponse.statusCode).toBe(200);
        expect(listResponse.json().deployments).toHaveLength(1);
    });

    it("an authorization-denied outcome (no consent) is reported as 403, not a 500", async () => {
        const { orgId, headers, caseId, modelId } = await fullySetUp("no-consent");
        // Revoke the consent fullySetUp granted so no active consent remains.
        const listResponse = await app.inject({ method: "GET", url: `/organizations/${orgId}/cases/${caseId}/ai-consents`, headers });
        const consentId = listResponse.json().consents[0].id;
        await app.inject({ method: "POST", url: `/organizations/${orgId}/cases/${caseId}/ai-consents/${consentId}/revoke`, headers, payload: { reason: "test revocation" } });

        const submitResponse = await app.inject({
            method: "POST",
            url: `/organizations/${orgId}/cases/${caseId}/ai-requests`,
            headers,
            payload: { providerModelId: modelId, purposeOfUse: "medication-review", requestedCategories: ["medications", "allergies"] },
        });
        expect(submitResponse.statusCode).toBe(403);
        expect(submitResponse.json()).toMatchObject({ outcome: "authorization-denied", reason: "no-active-consent" });
    });

    it("engaging a provider's kill switch blocks the very next request, end to end over HTTP", async () => {
        const { orgId, headers, caseId, providerId, modelId } = await fullySetUp("kill-switch");
        const killResponse = await app.inject({ method: "POST", url: `/organizations/${orgId}/ai-providers/${providerId}/kill-switch`, headers, payload: { engaged: true, reason: "vendor incident" } });
        expect(killResponse.statusCode).toBe(200);

        const submitResponse = await app.inject({
            method: "POST",
            url: `/organizations/${orgId}/cases/${caseId}/ai-requests`,
            headers,
            payload: { providerModelId: modelId, purposeOfUse: "medication-review", requestedCategories: ["medications", "allergies"] },
        });
        expect(submitResponse.statusCode).toBe(403);
        expect(submitResponse.json()).toMatchObject({ outcome: "authorization-denied", reason: "provider-kill-switch-engaged" });
    });

    it("a second submission with the same Idempotency-Key replays the original response instead of creating a second request", async () => {
        const { orgId, headers, caseId, modelId } = await fullySetUp("idempotent");
        const idempotentHeaders = { ...headers, "idempotency-key": "retry-key-1" };
        const payload = { providerModelId: modelId, purposeOfUse: "medication-review", requestedCategories: ["medications", "allergies"] };

        const first = await app.inject({ method: "POST", url: `/organizations/${orgId}/cases/${caseId}/ai-requests`, headers: idempotentHeaders, payload });
        expect(first.statusCode).toBe(201);
        const second = await app.inject({ method: "POST", url: `/organizations/${orgId}/cases/${caseId}/ai-requests`, headers: idempotentHeaders, payload });
        expect(second.statusCode).toBe(201);
        expect(second.json().request.id).toBe(first.json().request.id);

        const listResponse = await app.inject({ method: "GET", url: `/organizations/${orgId}/cases/${caseId}/ai-requests`, headers });
        expect(listResponse.json().requests).toHaveLength(1);
    });

    it("an unauthenticated request is rejected before touching any AI Gateway logic", async () => {
        const { orgId, caseId } = await fullySetUp("unauth");
        const response = await app.inject({ method: "POST", url: `/organizations/${orgId}/cases/${caseId}/ai-requests`, payload: { providerModelId: "x", purposeOfUse: "medication-review", requestedCategories: ["medications"] } });
        expect(response.statusCode).toBe(401);
    });

    it("a case that exists only in a different organization 404s identically to a case that doesn't exist at all", async () => {
        const orgA = await fullySetUp("tenant-a");
        const { orgId: orgBId, adminToken: orgBToken } = await createOrg("idp|dr-admin-tenant-b");
        const orgBHeaders = { authorization: `Bearer ${orgBToken}` };

        const crossTenantResponse = await app.inject({
            method: "POST",
            url: `/organizations/${orgBId}/cases/${orgA.caseId}/ai-requests/preview`,
            headers: orgBHeaders,
            payload: { providerModelId: orgA.modelId, purposeOfUse: "medication-review", requestedCategories: ["medications"] },
        });
        const nonexistentResponse = await app.inject({
            method: "POST",
            url: `/organizations/${orgBId}/cases/does-not-exist/ai-requests/preview`,
            headers: orgBHeaders,
            payload: { providerModelId: orgA.modelId, purposeOfUse: "medication-review", requestedCategories: ["medications"] },
        });
        expect(crossTenantResponse.statusCode).toBe(404);
        expect(nonexistentResponse.statusCode).toBe(404);
        expect(crossTenantResponse.json()).toEqual(nonexistentResponse.json());
    });
});
