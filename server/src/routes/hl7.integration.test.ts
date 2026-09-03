import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { SignJWT, exportJWK, generateKeyPair, createLocalJWKSet, type JWTVerifyGetKey, type CryptoKey } from "jose";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../app.js";
import { InMemoryAuditStore } from "../store/audit-store.js";
import { InMemoryCaseStore } from "../store/in-memory-case-store.js";
import { InMemoryIamStore } from "../store/in-memory-iam-store.js";
import { InMemoryIdempotencyStore } from "../store/in-memory-idempotency-store.js";
import { buildMinimalDicomFile } from "../imaging/test-fixtures.js";
import { parseHl7Message, getField } from "../hl7/message.js";

/**
 * HTTP-level integration tests for routes/hl7.ts — mirrors
 * fhir.integration.test.ts's own setup/rationale: unit coverage of the
 * mapping logic lives in hl7/oru-builder.test.ts, so this file is
 * specifically about route wiring, IAM enforcement being actually applied,
 * and the `application/hl7-v2` content type.
 */
const ISSUER = "https://idp.example-hospital.test/realms/clinical";
const AUDIENCE = "modelforge-iam-server";
const KID = "test-key";

describe("HL7 v2 ORU^R01 generation: end-to-end route security", () => {
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

    function caseFixturePayload(id: string, patientId: string) {
        const now = new Date().toISOString();
        return {
            id, title: "Synthetic case", patientId,
            demographics: { value: {}, includeInContext: false },
            presentingComplaint: { value: "", includeInContext: false },
            symptomsTimeline: { value: "", includeInContext: false },
            vitalSigns: { value: "", includeInContext: false },
            conditions: { value: [], includeInContext: false },
            allergies: { value: [], includeInContext: false },
            medications: { value: [], includeInContext: false },
            labResults: { value: [], includeInContext: false },
            imagingAndReports: { value: "", includeInContext: false },
            clinicalNotes: [], attachments: [], consentRecords: [],
            createdAt: now, updatedAt: now,
        };
    }

    async function createCase(orgId: string, adminToken: string, caseId: string, patientId: string): Promise<void> {
        const response = await app.inject({ method: "POST", url: `/organizations/${orgId}/cases`, headers: { authorization: `Bearer ${adminToken}` }, payload: caseFixturePayload(caseId, patientId) });
        expect(response.statusCode).toBe(201);
    }

    it("GET oru-r01 returns a well-formed ORU^R01 message for an authorized caller, and 404s identically for an unauthorized one", async () => {
        const { orgId, adminToken } = await createOrg("idp|dr-admin");
        const dicomBytes = buildMinimalDicomFile({ patientId: "MRN-001", issuerOfPatientId: "TEST-HOSPITAL" });
        const ingestResult = await app.inject({
            method: "POST",
            url: `/organizations/${orgId}/imaging/ingestion`,
            headers: { authorization: `Bearer ${adminToken}`, "content-type": "application/dicom" },
            payload: dicomBytes,
        });
        expect(ingestResult.statusCode).toBe(201);
        const studyId = ingestResult.json().studyId;

        const reportResult = await app.inject({
            method: "POST",
            url: `/organizations/${orgId}/imaging/studies/${studyId}/reports`,
            headers: { authorization: `Bearer ${adminToken}` },
            payload: { conclusion: "No acute findings.", status: "final" },
        });
        expect(reportResult.statusCode).toBe(201);
        const reportId = reportResult.json().id;

        const url = `/organizations/${orgId}/hl7/v2/DiagnosticReport/${reportId}/oru-r01?receivingApplication=EHR&receivingFacility=Example%20Health%20System`;
        const response = await app.inject({ method: "GET", url, headers: { authorization: `Bearer ${adminToken}` } });
        expect(response.statusCode).toBe(200);
        expect(response.headers["content-type"]).toBe("application/hl7-v2; charset=utf-8");
        const message = parseHl7Message(response.body);
        expect(message.segments.map((s) => s.id)).toEqual(["MSH", "PID", "OBR", "OBX"]);
        expect(getField(message.segments[0], 9)).toBe("ORU^R01");
        expect(getField(message.segments[1], 3)).toBe("MRN-001^^^TEST-HOSPITAL");

        await app.inject({ method: "POST", url: `/organizations/${orgId}/users`, headers: { authorization: `Bearer ${adminToken}` }, payload: { externalSubject: "idp|no-imaging-rights", displayName: "No Rights" } });
        const strangerToken = await tokenFor("idp|no-imaging-rights");
        const unauthorized = await app.inject({ method: "GET", url, headers: { authorization: `Bearer ${strangerToken}` } });
        expect(unauthorized.statusCode).toBe(404);
    });

    it("requires receivingApplication/receivingFacility query params", async () => {
        const { orgId, adminToken } = await createOrg("idp|dr-admin");
        const response = await app.inject({ method: "GET", url: `/organizations/${orgId}/hl7/v2/DiagnosticReport/does-not-exist/oru-r01`, headers: { authorization: `Bearer ${adminToken}` } });
        expect(response.statusCode).toBe(400);
    });

    describe("POST inbound/oru-r01/parse", () => {
        const SAMPLE_ORU = [
            "MSH|^~\\&|LAB|HOSPITAL|EHR|HOSPITAL|20260315120000||ORU^R01|MSG00001|P|2.5.1",
            "PID|1||MRN-001^^^TEST-HOSPITAL||",
            "OBX|1|NM|2345-7^Glucose^LN||95|mg/dL|70-99|N|||F",
        ].join("\r");

        it("parses a well-formed inbound ORU^R01 for an authorized caller", async () => {
            const { orgId, adminToken } = await createOrg("idp|dr-admin");
            const response = await app.inject({
                method: "POST",
                url: `/organizations/${orgId}/hl7/v2/inbound/oru-r01/parse`,
                headers: { authorization: `Bearer ${adminToken}`, "content-type": "application/hl7-v2" },
                payload: SAMPLE_ORU,
            });
            expect(response.statusCode).toBe(200);
            const body = response.json();
            expect(body.messageControlId).toBe("MSG00001");
            expect(body.patientIdentifier).toEqual({ value: "MRN-001", issuer: "TEST-HOSPITAL" });
            expect(body.observations).toHaveLength(1);
            expect(body.observations[0]).toMatchObject({ name: "Glucose", value: "95", unit: "mg/dL" });
        });

        it("returns 422 (not 500) for structurally invalid HL7, and 400 for an empty body", async () => {
            const { orgId, adminToken } = await createOrg("idp|dr-admin");
            const invalid = await app.inject({
                method: "POST",
                url: `/organizations/${orgId}/hl7/v2/inbound/oru-r01/parse`,
                headers: { authorization: `Bearer ${adminToken}`, "content-type": "application/hl7-v2" },
                payload: "this is not HL7 at all",
            });
            expect(invalid.statusCode).toBe(422);

            const empty = await app.inject({
                method: "POST",
                url: `/organizations/${orgId}/hl7/v2/inbound/oru-r01/parse`,
                headers: { authorization: `Bearer ${adminToken}`, "content-type": "application/hl7-v2" },
                payload: "",
            });
            expect(empty.statusCode).toBe(400);
        });

        it("rejects a caller without hl7:parseInbound with 403", async () => {
            const { orgId, adminToken } = await createOrg("idp|dr-admin");
            await app.inject({ method: "POST", url: `/organizations/${orgId}/users`, headers: { authorization: `Bearer ${adminToken}` }, payload: { externalSubject: "idp|no-hl7-rights", displayName: "No Rights" } });
            const strangerToken = await tokenFor("idp|no-hl7-rights");
            const response = await app.inject({
                method: "POST",
                url: `/organizations/${orgId}/hl7/v2/inbound/oru-r01/parse`,
                headers: { authorization: `Bearer ${strangerToken}`, "content-type": "application/hl7-v2" },
                payload: SAMPLE_ORU,
            });
            expect(response.statusCode).toBe(403);
        });
    });

    describe("POST inbound/ingest, GET jobs, POST jobs/:jobId/resolve", () => {
        const SAMPLE_ORU = (mrn: string) => [
            "MSH|^~\\&|LAB|HOSPITAL|EHR|HOSPITAL|20260315120000||ORU^R01|MSG00001|P|2.5.1",
            `PID|1||${mrn}||`,
            "OBX|1|NM|2345-7^Glucose^LN||95|mg/dL|70-99|N|||F",
        ].join("\r");

        it("ingests an ORU matching exactly one case and merges the observation into it", async () => {
            const { orgId, adminToken } = await createOrg("idp|dr-admin");
            await createCase(orgId, adminToken, "case-1", "MRN-001");

            const ingest = await app.inject({
                method: "POST",
                url: `/organizations/${orgId}/hl7/v2/inbound/ingest`,
                headers: { authorization: `Bearer ${adminToken}`, "content-type": "application/hl7-v2" },
                payload: SAMPLE_ORU("MRN-001"),
            });
            expect(ingest.statusCode).toBe(201);
            expect(ingest.json()).toMatchObject({ matchStatus: "matched", matchedCaseId: "case-1", status: "applied", observationsAdded: 1 });

            const updatedCase = await app.inject({ method: "GET", url: `/organizations/${orgId}/cases/case-1`, headers: { authorization: `Bearer ${adminToken}` } });
            expect(updatedCase.json().labResults.value).toHaveLength(1);
        });

        it("an ambiguous match creates a pending-review job listing candidates, resolvable by picking one of them", async () => {
            const { orgId, adminToken } = await createOrg("idp|dr-admin");
            await createCase(orgId, adminToken, "case-1", "MRN-SHARED");
            await createCase(orgId, adminToken, "case-2", "MRN-SHARED");

            const ingest = await app.inject({
                method: "POST",
                url: `/organizations/${orgId}/hl7/v2/inbound/ingest`,
                headers: { authorization: `Bearer ${adminToken}`, "content-type": "application/hl7-v2" },
                payload: SAMPLE_ORU("MRN-SHARED"),
            });
            expect(ingest.statusCode).toBe(201);
            const job = ingest.json();
            expect(job.matchStatus).toBe("ambiguous");
            expect(job.status).toBe("pending-review");

            const jobsList = await app.inject({ method: "GET", url: `/organizations/${orgId}/hl7/v2/inbound/jobs?status=pending-review`, headers: { authorization: `Bearer ${adminToken}` } });
            expect(jobsList.statusCode).toBe(200);
            expect(jobsList.json().jobs).toHaveLength(1);

            const resolve = await app.inject({
                method: "POST",
                url: `/organizations/${orgId}/hl7/v2/inbound/jobs/${job.id}/resolve`,
                headers: { authorization: `Bearer ${adminToken}` },
                payload: { action: "apply", caseId: "case-2" },
            });
            expect(resolve.statusCode).toBe(200);
            expect(resolve.json()).toMatchObject({ status: "applied", matchedCaseId: "case-2" });

            const case2 = await app.inject({ method: "GET", url: `/organizations/${orgId}/cases/case-2`, headers: { authorization: `Bearer ${adminToken}` } });
            expect(case2.json().labResults.value).toHaveLength(1);
        });

        it("refuses resolving a job to a case outside its own candidates with 409, not a silent apply", async () => {
            const { orgId, adminToken } = await createOrg("idp|dr-admin");
            await createCase(orgId, adminToken, "case-1", "MRN-SHARED");
            await createCase(orgId, adminToken, "case-2", "MRN-SHARED");
            await createCase(orgId, adminToken, "case-unrelated", "MRN-OTHER");

            const ingest = await app.inject({
                method: "POST",
                url: `/organizations/${orgId}/hl7/v2/inbound/ingest`,
                headers: { authorization: `Bearer ${adminToken}`, "content-type": "application/hl7-v2" },
                payload: SAMPLE_ORU("MRN-SHARED"),
            });
            const job = ingest.json();

            const resolve = await app.inject({
                method: "POST",
                url: `/organizations/${orgId}/hl7/v2/inbound/jobs/${job.id}/resolve`,
                headers: { authorization: `Bearer ${adminToken}` },
                payload: { action: "apply", caseId: "case-unrelated" },
            });
            expect(resolve.statusCode).toBe(409);
        });

        it("rejects a caller without hl7:ingest/hl7:reviewIngestion with 403", async () => {
            const { orgId, adminToken } = await createOrg("idp|dr-admin");
            await app.inject({ method: "POST", url: `/organizations/${orgId}/users`, headers: { authorization: `Bearer ${adminToken}` }, payload: { externalSubject: "idp|no-hl7-rights", displayName: "No Rights" } });
            const strangerToken = await tokenFor("idp|no-hl7-rights");

            const ingest = await app.inject({
                method: "POST",
                url: `/organizations/${orgId}/hl7/v2/inbound/ingest`,
                headers: { authorization: `Bearer ${strangerToken}`, "content-type": "application/hl7-v2" },
                payload: SAMPLE_ORU("MRN-001"),
            });
            expect(ingest.statusCode).toBe(403);

            const jobs = await app.inject({ method: "GET", url: `/organizations/${orgId}/hl7/v2/inbound/jobs`, headers: { authorization: `Bearer ${strangerToken}` } });
            expect(jobs.statusCode).toBe(403);
        });
    });
});
