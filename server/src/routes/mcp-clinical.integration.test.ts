import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createLocalJWKSet, exportJWK, exportPKCS8, generateKeyPair, jwtVerify, SignJWT, type CryptoKey, type JWTVerifyGetKey } from "jose";
import type { FastifyInstance } from "fastify";
import { mcpContextGrantSchema } from "@modelforge/contracts";
import { buildApp } from "../app.js";
import { Rs256McpApprovalTicketIssuer } from "../mcp-approval-issuer.js";
import { InMemoryAuditStore } from "../store/audit-store.js";
import { InMemoryCaseStore } from "../store/in-memory-case-store.js";
import { InMemoryIamStore } from "../store/in-memory-iam-store.js";
import { InMemoryIdempotencyStore } from "../store/in-memory-idempotency-store.js";

const ISSUER = "https://identity.example.test";
const AUDIENCE = "modelforge-integration-test";
const CLIENT = "institutional-desktop";
const CASE = "synthetic-case";
const REVIEW = "clinical.record_review_decision";
const DIGEST = `sha256:${"b".repeat(64)}`;
const SNAPSHOT = { registryVersion: "1", rbacVersion: "1", egressPolicyVersion: "1", killSwitchVersion: "1", toolPolicyVersion: "1" };

// Real HTTP route/IAM/store/RS256 wiring with synthetic records. The MCP
// challenge service is mocked; Rust HTTP tests cover its digest generation.
describe("clinical MCP control-plane HTTP integration", () => {
    let privateKey: CryptoKey;
    let publicKey: CryptoKey;
    let jwks: JWTVerifyGetKey;
    let privatePem: string;
    let app: FastifyInstance;
    let audit: InMemoryAuditStore;
    let organizationId: string;
    let registryEntryId: string;
    let adminToken: string;
    let headers: { authorization: string };

    beforeAll(async () => {
        ({ privateKey, publicKey } = await generateKeyPair("RS256", { extractable: true }));
        const jwk = await exportJWK(publicKey);
        jwks = createLocalJWKSet({ keys: [{ ...jwk, kid: "test", alg: "RS256" }] });
        privatePem = await exportPKCS8(privateKey);
    });

    async function token(subject = "clinician", client: string | null = CLIENT) {
        return new SignJWT({ sub: subject, ...(client ? { azp: client } : {}) })
            .setProtectedHeader({ alg: "RS256", kid: "test" }).setIssuer(ISSUER)
            .setAudience(AUDIENCE).setIssuedAt().setExpirationTime("5m").sign(privateKey);
    }

    const path = (suffix: string) => `/organizations/${organizationId}/${suffix}`;
    const registry = () => ({ name: "Institutional clinical gateway", transport: "http", endpoint: "https://mcp.example.test/mcp", allowedTools: [REVIEW, "clinical.medication_conflict_check"], dataEgressPolicy: "unrestricted", integrationProfile: "modelforge-clinical", oauthClientId: CLIENT, approvalChallengeEndpoint: "https://mcp.example.test/approval-challenges" });
    const grantBody = () => ({ registryEntryId, caseId: CASE, purpose: "medication-review", toolNames: ["clinical.medication_conflict_check"], requestedFields: ["medications", "allergies"] });

    beforeEach(async () => {
        audit = new InMemoryAuditStore();
        app = buildApp({ store: new InMemoryIamStore(audit), caseStore: new InMemoryCaseStore(audit), idempotencyStore: new InMemoryIdempotencyStore(), auditStore: audit, jwks, oidc: { issuer: ISSUER, audience: AUDIENCE }, mcpApprovalTicketIssuer: new Rs256McpApprovalTicketIssuer(privatePem, ISSUER, "clinical-approval") });
        adminToken = await token();
        headers = { authorization: `Bearer ${adminToken}` };
        const org = await app.inject({ method: "POST", url: "/organizations", headers, payload: { name: "Synthetic hospital" } });
        expect(org.statusCode).toBe(201);
        organizationId = org.json().organization.id;
        const now = new Date().toISOString();
        const createdCase = await app.inject({ method: "POST", url: path("cases"), headers, payload: {
            id: CASE, title: "Synthetic case", demographics: { value: {}, includeInContext: false },
            presentingComplaint: { value: "", includeInContext: false }, symptomsTimeline: { value: "", includeInContext: false },
            vitalSigns: { value: "", includeInContext: false }, conditions: { value: [], includeInContext: false },
            allergies: { value: ["synthetic allergy"], includeInContext: true }, medications: { value: ["synthetic medication"], includeInContext: true },
            labResults: { value: [], includeInContext: false }, imagingAndReports: { value: "", includeInContext: false },
            clinicalNotes: [], attachments: [], createdAt: now, updatedAt: now,
            consentRecords: ["ai-assistance", "remote-model-use"].map((scope) => ({ id: scope, scope, grantedAt: now, method: "in-person" })),
        } });
        expect(createdCase.statusCode).toBe(201);
        const consent = await app.inject({ method: "POST", url: path(`cases/${CASE}/ai-consents`), headers, payload: { purpose: "treatment", dataCategories: ["medications", "allergies"] } });
        expect(consent.statusCode).toBe(201);
        const entry = await app.inject({ method: "POST", url: path("mcp-registry"), headers, payload: registry() });
        expect(entry.statusCode).toBe(201);
        registryEntryId = entry.json().id;
    });

    afterEach(async () => { vi.unstubAllGlobals(); await app.close(); });

    it("rejects incomplete clinical registry entries while retaining generic compatibility", async () => {
        const { oauthClientId: _client, ...incomplete } = registry();
        expect((await app.inject({ method: "POST", url: path("mcp-registry"), headers, payload: incomplete })).statusCode).toBe(400);
        expect((await app.inject({ method: "POST", url: path("mcp-registry"), headers, payload: { name: "Generic", transport: "http", endpoint: "https://generic.example.test/mcp", allowedTools: "*", dataEgressPolicy: "none" } })).statusCode).toBe(201);
    });

    it("issues field-bound grants with no clinical values and requires the matching OAuth client", async () => {
        const response = await app.inject({ method: "POST", url: path("mcp-context-grants"), headers, payload: grantBody() });
        expect(response.statusCode).toBe(201);
        const grant = mcpContextGrantSchema.parse(response.json());
        expect(grant).toMatchObject({ subjectId: "clinician", clientId: CLIENT, organizationId, caseId: CASE, allowedFields: ["allergies", "medications"] });
        expect(grant.expiresAtEpochSeconds - Math.floor(Date.now() / 1000)).toBeLessThanOrEqual(300);
        expect(response.body).not.toContain("synthetic medication");
        const otherClient = { authorization: `Bearer ${await token("clinician", "wrong-client")}` };
        expect((await app.inject({ method: "POST", url: path("mcp-context-grants"), headers: otherClient, payload: grantBody() })).statusCode).toBe(403);
        expect((await app.inject({ method: "POST", url: path("mcp-context-grants"), payload: grantBody() })).statusCode).toBe(401);
    });

    it("denies unknown cases, tools, uncovered fields, revoked consent, and disabled entries", async () => {
        const issue = (overrides: Record<string, unknown>) => app.inject({ method: "POST", url: path("mcp-context-grants"), headers, payload: { ...grantBody(), ...overrides } });
        expect((await issue({ caseId: "unknown" })).statusCode).toBe(404);
        expect((await issue({ toolNames: ["clinical.unknown"] })).statusCode).toBe(403);
        expect((await issue({ requestedFields: ["demographics"] })).statusCode).toBe(403);
        const consents = await app.inject({ method: "GET", url: path(`cases/${CASE}/ai-consents`), headers });
        const revoked = await app.inject({ method: "POST", url: path(`cases/${CASE}/ai-consents/${consents.json().consents[0].id}/revoke`), headers, payload: { reason: "Synthetic revocation" } });
        expect(revoked.statusCode).toBe(200);
        expect((await issue({})).statusCode).toBe(403);
        await app.inject({ method: "POST", url: path(`mcp-registry/${registryEntryId}/status`), headers, payload: { status: "disabled" } });
        expect((await issue({})).statusCode).toBe(404);
    });

    it("requires a registered tenant workload for introspection and review recording", async () => {
        const issued = await app.inject({ method: "POST", url: path("mcp-context-grants"), headers, payload: grantBody() });
        const grantId = issued.json().id;
        expect((await app.inject({ method: "POST", url: "/internal/mcp/context-grants/introspect", headers, payload: { grantId } })).statusCode).toBe(403);
        const policy = await app.inject({ method: "POST", url: path("policies"), headers, payload: { name: "MCP workload", document: { version: "2026-01-01", statements: [{ effect: "Allow", actions: ["mcpClinical:introspect", "mcpClinical:recordReview"], resources: [`organization:${organizationId}`, `organization:${organizationId}/patientCase:*`] }] } } });
        expect(policy.statusCode).toBe(201);
        const service = await app.inject({ method: "POST", url: path("service-principals"), headers, payload: { issuer: ISSUER, externalSubject: "mcp-workload", displayName: "MCP", policyIds: [policy.json().id] } });
        expect(service.statusCode).toBe(201);
        const workload = { authorization: `Bearer ${await token("mcp-workload", "workload-client")}` };
        const introspected = await app.inject({ method: "POST", url: "/internal/mcp/context-grants/introspect", headers: workload, payload: { grantId } });
        expect(introspected.statusCode).toBe(200);
        expect(introspected.json()).toEqual(issued.json());
        const payload = { organizationId, caseId: CASE, reviewerSubjectId: "clinician", reviewedOperationId: "10000000-0000-4000-8000-000000000001", decision: "approved", rationale: "Synthetic review text" };
        expect((await app.inject({ method: "POST", url: "/internal/mcp/reviews", headers, payload })).statusCode).toBe(403);
        const first = await app.inject({ method: "POST", url: "/internal/mcp/reviews", headers: workload, payload });
        const replay = await app.inject({ method: "POST", url: "/internal/mcp/reviews", headers: workload, payload });
        expect(first.statusCode).toBe(201);
        expect(replay.json()).toEqual(first.json());
        const log = JSON.stringify(await audit.listByOrganization(organizationId));
        expect(log).not.toContain(payload.rationale);
    });

    it("signs the challenged digest for the original identity and confirms only once", async () => {
        const fetchChallenge = vi.fn().mockResolvedValue(new Response(JSON.stringify({ challengeId: "challenge-1", operationDigest: DIGEST, policySnapshot: SNAPSHOT, expiresAtEpochSeconds: Math.floor(Date.now() / 1000) + 300 }), { status: 200 }));
        vi.stubGlobal("fetch", fetchChallenge);
        const prepared = await app.inject({ method: "POST", url: path("mcp-approvals/prepare"), headers, payload: { registryEntryId, toolName: REVIEW, caseId: CASE, arguments: { rationale: "Synthetic sensitive rationale" }, contextGrantId: "synthetic-grant" } });
        expect(prepared.statusCode).toBe(201);
        expect(fetchChallenge).toHaveBeenCalledWith(registry().approvalChallengeEndpoint, expect.objectContaining({ redirect: "error", headers: expect.objectContaining({ authorization: headers.authorization }) }));
        const confirmPath = path(`mcp-approvals/${prepared.json().approvalRequest.id}/confirm`);
        const wrongClient = { authorization: `Bearer ${await token("clinician", "wrong-client")}` };
        expect((await app.inject({ method: "POST", url: confirmPath, headers: wrongClient })).statusCode).toBe(409);
        const confirmed = await app.inject({ method: "POST", url: confirmPath, headers });
        expect(confirmed.statusCode).toBe(200);
        const { payload } = await jwtVerify(confirmed.json().approvalTicket, publicKey, { issuer: ISSUER, audience: "clinical-approval", algorithms: ["RS256"] });
        expect(payload).toMatchObject({ sub: "clinician", azp: CLIENT, tool: REVIEW, digest: DIGEST });
        expect(payload.exp! - payload.iat!).toBeLessThanOrEqual(300);
        expect((await app.inject({ method: "POST", url: confirmPath, headers })).statusCode).toBe(409);
        expect(JSON.stringify(await audit.listByOrganization(organizationId))).not.toContain("Synthetic sensitive rationale");
    });
});
