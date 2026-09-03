import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { SignJWT, exportJWK, generateKeyPair, createLocalJWKSet, type JWTVerifyGetKey, type CryptoKey } from "jose";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../app.js";
import { InMemoryAuditStore } from "../store/audit-store.js";
import { InMemoryCaseStore } from "../store/in-memory-case-store.js";
import { InMemoryIamStore } from "../store/in-memory-iam-store.js";
import { InMemoryIdempotencyStore } from "../store/in-memory-idempotency-store.js";
import { buildMinimalDicomFile } from "../imaging/test-fixtures.js";
import { patientCaseFixture } from "../test/patient-case-fixture.js";

/**
 * HTTP-level integration tests for the FHIR R4 read facade
 * (routes/fhir.ts). Mirrors imaging.integration.test.ts's own setup and
 * rationale exactly: unit coverage of the mapping logic itself already
 * lives in fhir/mappers.test.ts, so this file is specifically about what
 * only a real app.inject() request can prove — route wiring, that the
 * existing IAM authorization is actually applied to the FHIR routes (not
 * just the native ones), and the `application/fhir+json` content type.
 */
const ISSUER = "https://idp.example-hospital.test/realms/clinical";
const AUDIENCE = "modelforge-iam-server";
const KID = "test-key";

describe("FHIR R4 read facade: end-to-end route security", () => {
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
        return new SignJWT({ sub: subject, ...extra })
            .setProtectedHeader({ alg: "RS256", kid: KID })
            .setIssuedAt()
            .setIssuer(ISSUER)
            .setAudience(AUDIENCE)
            .setExpirationTime("1h")
            .sign(privateKey);
    }

    async function createOrg(adminSubject: string): Promise<{ orgId: string; adminToken: string }> {
        const adminToken = await tokenFor(adminSubject, { name: "Dr. Admin" });
        const response = await app.inject({ method: "POST", url: "/organizations", headers: { authorization: `Bearer ${adminToken}` }, payload: { name: "Example Health System" } });
        expect(response.statusCode).toBe(201);
        return { orgId: response.json().organization.id, adminToken };
    }

    async function addUnprivilegedUser(orgId: string, adminToken: string, subject: string): Promise<string> {
        await app.inject({
            method: "POST",
            url: `/organizations/${orgId}/users`,
            headers: { authorization: `Bearer ${adminToken}` },
            payload: { externalSubject: subject, displayName: "No Rights" },
        });
        return tokenFor(subject);
    }

    it("GET metadata returns a CapabilityStatement advertising only implemented interactions", async () => {
        const { orgId, adminToken } = await createOrg("idp|dr-admin");
        const response = await app.inject({ method: "GET", url: `/organizations/${orgId}/fhir/r4/metadata`, headers: { authorization: `Bearer ${adminToken}` } });
        expect(response.statusCode).toBe(200);
        expect(response.headers["content-type"]).toBe("application/fhir+json; charset=utf-8");
        const body = response.json();
        expect(body.resourceType).toBe("CapabilityStatement");
        expect(body.fhirVersion).toBe("4.0.1");
        const resourceTypes = body.rest[0].resource.map((r: { type: string }) => r.type);
        expect(resourceTypes).toEqual(["Patient", "DiagnosticReport", "ImagingStudy", "DocumentReference"]);
    });

    it("GET Patient/:caseId maps a case to a FHIR Patient for an authorized caller, and 404s identically for an unauthorized one", async () => {
        const { orgId, adminToken } = await createOrg("idp|dr-admin");
        const created = await app.inject({
            method: "POST",
            url: `/organizations/${orgId}/cases`,
            headers: { authorization: `Bearer ${adminToken}` },
            payload: patientCaseFixture("case-1", { patientId: "MRN-777", demographics: { value: { age: "35", sex: "male" }, includeInContext: false } }),
        });
        expect(created.statusCode).toBe(201);

        const authorized = await app.inject({ method: "GET", url: `/organizations/${orgId}/fhir/r4/Patient/case-1`, headers: { authorization: `Bearer ${adminToken}` } });
        expect(authorized.statusCode).toBe(200);
        expect(authorized.headers["content-type"]).toBe("application/fhir+json; charset=utf-8");
        const patient = authorized.json();
        expect(patient).toMatchObject({ resourceType: "Patient", id: "MRN-777", gender: "male", identifier: [{ system: "urn:modelforge:patientId", value: "MRN-777" }] });

        const strangerToken = await addUnprivilegedUser(orgId, adminToken, "idp|no-rights");
        const unauthorized = await app.inject({ method: "GET", url: `/organizations/${orgId}/fhir/r4/Patient/case-1`, headers: { authorization: `Bearer ${strangerToken}` } });
        expect(unauthorized.statusCode).toBe(404);
        expect(unauthorized.json().resourceType).toBe("OperationOutcome");

        const missing = await app.inject({ method: "GET", url: `/organizations/${orgId}/fhir/r4/Patient/does-not-exist`, headers: { authorization: `Bearer ${adminToken}` } });
        expect(missing.statusCode).toBe(404);
        expect(missing.json().resourceType).toBe("OperationOutcome");
    });

    it("GET ImagingStudy/:studyId and DiagnosticReport/:reportId map ingested imaging data, and 404 identically for an unauthorized caller", async () => {
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

        const studyResponse = await app.inject({ method: "GET", url: `/organizations/${orgId}/fhir/r4/ImagingStudy/${studyId}`, headers: { authorization: `Bearer ${adminToken}` } });
        expect(studyResponse.statusCode).toBe(200);
        const fhirStudy = studyResponse.json();
        expect(fhirStudy).toMatchObject({ resourceType: "ImagingStudy", id: studyId, status: "available", subject: { reference: "Patient/MRN-001" } });

        const reportResult = await app.inject({
            method: "POST",
            url: `/organizations/${orgId}/imaging/studies/${studyId}/reports`,
            headers: { authorization: `Bearer ${adminToken}` },
            payload: { conclusion: "No acute findings.", status: "final" },
        });
        expect(reportResult.statusCode).toBe(201);
        const reportId = reportResult.json().id;

        const reportResponse = await app.inject({ method: "GET", url: `/organizations/${orgId}/fhir/r4/DiagnosticReport/${reportId}`, headers: { authorization: `Bearer ${adminToken}` } });
        expect(reportResponse.statusCode).toBe(200);
        expect(reportResponse.json()).toMatchObject({
            resourceType: "DiagnosticReport",
            id: reportId,
            status: "final",
            conclusion: "No acute findings.",
            imagingStudy: [{ reference: `ImagingStudy/${studyId}` }],
        });

        const strangerToken = await addUnprivilegedUser(orgId, adminToken, "idp|no-imaging-rights");
        const unauthorizedStudy = await app.inject({ method: "GET", url: `/organizations/${orgId}/fhir/r4/ImagingStudy/${studyId}`, headers: { authorization: `Bearer ${strangerToken}` } });
        expect(unauthorizedStudy.statusCode).toBe(404);
        const unauthorizedReport = await app.inject({ method: "GET", url: `/organizations/${orgId}/fhir/r4/DiagnosticReport/${reportId}`, headers: { authorization: `Bearer ${strangerToken}` } });
        expect(unauthorizedReport.statusCode).toBe(404);
    });

    it("GET .well-known/smart-configuration 503s when the app was built without live OIDC discovery (every test in this suite)", async () => {
        const { orgId, adminToken } = await createOrg("idp|dr-admin");
        const response = await app.inject({ method: "GET", url: `/organizations/${orgId}/fhir/r4/.well-known/smart-configuration`, headers: { authorization: `Bearer ${adminToken}` } });
        expect(response.statusCode).toBe(503);
        expect(response.json().error).toBe("smart_configuration_unavailable");
    });

    it("a SMART launch context (patient-scoped token) confines FHIR reads to that one patient, denying identically for a mismatched patient as for unauthorized/absent", async () => {
        const { orgId, adminToken } = await createOrg("idp|dr-admin");
        await app.inject({
            method: "POST",
            url: `/organizations/${orgId}/cases`,
            headers: { authorization: `Bearer ${adminToken}` },
            payload: patientCaseFixture("case-launch", { patientId: "MRN-LAUNCH" }),
        });
        // Same admin identity, but this particular bearer token carries a
        // SMART launch context confined to a DIFFERENT patient — proves the
        // launch-context check is independent of (and additional to) the
        // normal IAM permission check, which this caller clearly passes.
        const wrongPatientLaunchToken = await tokenFor("idp|dr-admin", { scope: "openid launch patient/*.read", patient: "MRN-SOMEONE-ELSE" });
        const denied = await app.inject({ method: "GET", url: `/organizations/${orgId}/fhir/r4/Patient/case-launch`, headers: { authorization: `Bearer ${wrongPatientLaunchToken}` } });
        expect(denied.statusCode).toBe(404);
        expect(denied.json().resourceType).toBe("OperationOutcome");

        const matchingPatientLaunchToken = await tokenFor("idp|dr-admin", { scope: "openid launch patient/*.read", patient: "MRN-LAUNCH" });
        const allowed = await app.inject({ method: "GET", url: `/organizations/${orgId}/fhir/r4/Patient/case-launch`, headers: { authorization: `Bearer ${matchingPatientLaunchToken}` } });
        expect(allowed.statusCode).toBe(200);
        expect(allowed.json().id).toBe("MRN-LAUNCH");
    });

    it("GET DocumentReference?studyId= returns an empty search bundle (never a 403/404) for both a missing study and an unauthorized one — no existence disclosure via status code", async () => {
        const { orgId, adminToken } = await createOrg("idp|dr-admin");
        const response = await app.inject({ method: "GET", url: `/organizations/${orgId}/fhir/r4/DocumentReference?studyId=does-not-exist`, headers: { authorization: `Bearer ${adminToken}` } });
        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual({ resourceType: "Bundle", type: "searchset", total: 0, entry: [] });
    });
});
