import { createVerify, generateKeyPairSync } from "node:crypto";
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { SignJWT, exportJWK, generateKeyPair, createLocalJWKSet, type JWTVerifyGetKey, type CryptoKey } from "jose";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../app.js";
import { InMemoryAuditStore } from "../store/audit-store.js";
import { InMemoryCaseStore } from "../store/in-memory-case-store.js";
import { InMemoryIamStore } from "../store/in-memory-iam-store.js";
import { InMemoryIdempotencyStore } from "../store/in-memory-idempotency-store.js";
import { buildMinimalDicomFile } from "../imaging/test-fixtures.js";
import { CloudFrontContentDelivery } from "../imaging/content-delivery.js";

/**
 * HTTP-level integration/security tests for the clinical imaging routes
 * (item 22/23 of the imaging spec). Unit-level coverage of the pipeline
 * itself, the object store, the DICOM parser, and the in-memory repository
 * already lives in server/src/imaging/*.test.ts and
 * server/src/store/in-memory-imaging-store.test.ts — this file is
 * specifically about what only a real app.inject() end-to-end request can
 * prove: route wiring, auth enforcement, and cross-cutting security
 * properties (identical 404s, cross-tenant isolation, immediate revocation)
 * that no single unit test exercises.
 *
 * Mirrors app.test.ts's own buildApp()/tokenFor() setup exactly — see that
 * file for the established pattern this follows.
 */
const ISSUER = "https://idp.example-hospital.test/realms/clinical";
const AUDIENCE = "modelforge-iam-server";
const KID = "test-key";

describe("clinical imaging: end-to-end route security", () => {
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
        const response = await app.inject({
            method: "POST",
            url: "/organizations",
            headers: { authorization: `Bearer ${adminToken}` },
            payload: { name: "Example Health System" },
        });
        expect(response.statusCode).toBe(201);
        return { orgId: response.json().organization.id, adminToken };
    }

    async function ingest(orgId: string, token: string, dicomBytes: Buffer, query = ""): Promise<{ statusCode: number; body: any }> {
        const response = await app.inject({
            method: "POST",
            url: `/organizations/${orgId}/imaging/ingestion${query}`,
            headers: { authorization: `Bearer ${token}`, "content-type": "application/dicom" },
            payload: dicomBytes,
        });
        return { statusCode: response.statusCode, body: response.statusCode === 204 ? undefined : response.json() };
    }

    it("full happy path: an org admin ingests a DICOM instance, reads the study, opens a viewer session, and retrieves the pixel data over WADO", async () => {
        const { orgId, adminToken } = await createOrg("idp|dr-admin");
        const dicomBytes = buildMinimalDicomFile({ patientId: "MRN-001", issuerOfPatientId: "TEST-HOSPITAL" });

        const ingestResult = await ingest(orgId, adminToken, dicomBytes);
        expect(ingestResult.statusCode).toBe(201);
        expect(ingestResult.body.job.status).toBe("published");
        expect(ingestResult.body.requiresReview).toBe(false);
        const studyId = ingestResult.body.studyId;
        expect(studyId).toBeTruthy();

        const studyResponse = await app.inject({
            method: "GET",
            url: `/organizations/${orgId}/imaging/studies/${studyId}`,
            headers: { authorization: `Bearer ${adminToken}` },
        });
        expect(studyResponse.statusCode).toBe(200);
        const studyBody = studyResponse.json();
        expect(studyBody.instances).toHaveLength(1);
        // objectStorageKey must never reach a client response (imaging.ts's
        // own doc comment on why the public contract type excludes it).
        expect(studyBody.instances[0][0].objectStorageKey).toBeUndefined();
        const instanceId = studyBody.instances[0][0].id;

        const sessionResponse = await app.inject({
            method: "POST",
            url: `/organizations/${orgId}/imaging/studies/${studyId}/viewer-sessions`,
            headers: { authorization: `Bearer ${adminToken}` },
            payload: {},
        });
        expect(sessionResponse.statusCode).toBe(201);
        const viewerToken = sessionResponse.json().token;
        expect(typeof viewerToken).toBe("string");

        const wadoResponse = await app.inject({
            method: "GET",
            url: `/organizations/${orgId}/imaging/wado/instances/${instanceId}`,
            headers: { authorization: `Bearer ${viewerToken}` },
        });
        expect(wadoResponse.statusCode).toBe(200);
        expect(wadoResponse.headers["content-type"]).toBe("application/dicom");
        expect(wadoResponse.headers["cache-control"]).toBe("no-store");
        expect(Buffer.from(wadoResponse.rawPayload).equals(dicomBytes)).toBe(true);
    });

    it("rejects an upload without imagingStudy:ingest with 403, and a non-DICOM/unsupported content type with 415 — neither ever creates a study", async () => {
        const { orgId, adminToken } = await createOrg("idp|dr-admin");
        const unprivilegedToken = await tokenFor("idp|no-imaging-rights");
        await app.inject({
            method: "POST",
            url: `/organizations/${orgId}/users`,
            headers: { authorization: `Bearer ${adminToken}` },
            payload: { externalSubject: "idp|no-imaging-rights", displayName: "No Rights" },
        });

        const forbidden = await ingest(orgId, unprivilegedToken, buildMinimalDicomFile());
        expect(forbidden.statusCode).toBe(403);

        const wrongContentType = await app.inject({
            method: "POST",
            url: `/organizations/${orgId}/imaging/ingestion`,
            headers: { authorization: `Bearer ${adminToken}`, "content-type": "text/plain" },
            payload: "not a dicom file",
        });
        expect(wrongContentType.statusCode).toBe(415);
    });

    it("a malformed DICOM upload is recorded as a failed ingestion job (PHI-safe failure category), never a 500, and never creates a study", async () => {
        const { orgId, adminToken } = await createOrg("idp|dr-admin");
        const garbage = Buffer.from("this is not a DICOM file at all, just plain bytes");

        const result = await ingest(orgId, adminToken, garbage);
        expect(result.statusCode).toBe(201);
        expect(result.body.job.status).toBe("failed");
        expect(result.body.job.failureCategory).toBe("malformed-dicom");
        expect(result.body.studyId).toBeUndefined();

        const jobStatus = await app.inject({
            method: "GET",
            url: `/organizations/${orgId}/imaging/ingestion/${result.body.job.id}`,
            headers: { authorization: `Bearer ${adminToken}` },
        });
        expect(jobStatus.statusCode).toBe(200);
        expect(jobStatus.json().status).toBe("failed");
    });

    it("identical 404 for a study that doesn't exist and one that exists but the caller cannot view (item 7 nondisclosure)", async () => {
        const { orgId, adminToken } = await createOrg("idp|dr-admin");
        const ingestResult = await ingest(orgId, adminToken, buildMinimalDicomFile());
        const realStudyId = ingestResult.body.studyId;

        const unprivilegedToken = await tokenFor("idp|no-imaging-rights-2");
        await app.inject({
            method: "POST",
            url: `/organizations/${orgId}/users`,
            headers: { authorization: `Bearer ${adminToken}` },
            payload: { externalSubject: "idp|no-imaging-rights-2", displayName: "No Rights" },
        });

        const realStudyAsUnprivileged = await app.inject({
            method: "GET",
            url: `/organizations/${orgId}/imaging/studies/${realStudyId}`,
            headers: { authorization: `Bearer ${unprivilegedToken}` },
        });
        const fakeStudyAsUnprivileged = await app.inject({
            method: "GET",
            url: `/organizations/${orgId}/imaging/studies/does-not-exist`,
            headers: { authorization: `Bearer ${unprivilegedToken}` },
        });
        expect(realStudyAsUnprivileged.statusCode).toBe(404);
        expect(fakeStudyAsUnprivileged.statusCode).toBe(404);
        expect(realStudyAsUnprivileged.json()).toEqual(fakeStudyAsUnprivileged.json());
    });

    it("cross-tenant isolation: a member of a different organization gets 404 for a study id from another org, even holding a resources: ['*'] policy in their own org", async () => {
        const { orgId: orgAId, adminToken: orgAAdminToken } = await createOrg("idp|org-a-admin");
        const ingestResult = await ingest(orgAId, orgAAdminToken, buildMinimalDicomFile());
        const studyIdFromOrgA = ingestResult.body.studyId;

        const { orgId: orgBId, adminToken: orgBAdminToken } = await createOrg("idp|org-b-admin");

        // orgB's own admin has a full-access ["*"]/["*"] policy in orgB —
        // the point is that it must never resolve a resource string
        // belonging to a different tenant schema.
        const crossTenantRead = await app.inject({
            method: "GET",
            url: `/organizations/${orgBId}/imaging/studies/${studyIdFromOrgA}`,
            headers: { authorization: `Bearer ${orgBAdminToken}` },
        });
        expect(crossTenantRead.statusCode).toBe(404);

        // Sanity check: the same study id, same admin, but against orgA
        // (its real home) works fine — proves the 404 above is tenant
        // isolation, not a broken/nonexistent studyId.
        const sameOrgRead = await app.inject({
            method: "GET",
            url: `/organizations/${orgAId}/imaging/studies/${studyIdFromOrgA}`,
            headers: { authorization: `Bearer ${orgAAdminToken}` },
        });
        expect(sameOrgRead.statusCode).toBe(200);
    });

    it("revoking a share grant immediately invalidates every viewer session it issued, without touching unrelated sessions (item 11)", async () => {
        const { orgId, adminToken } = await createOrg("idp|dr-admin");
        const ingestResult = await ingest(orgId, adminToken, buildMinimalDicomFile());
        const studyId = ingestResult.body.studyId;

        // An ordinary internal viewer session, unrelated to any share grant.
        const internalSession = await app.inject({
            method: "POST",
            url: `/organizations/${orgId}/imaging/studies/${studyId}/viewer-sessions`,
            headers: { authorization: `Bearer ${adminToken}` },
            payload: {},
        });
        const internalToken = internalSession.json().token;

        const shareResponse = await app.inject({
            method: "POST",
            url: `/organizations/${orgId}/imaging/studies/${studyId}/shares`,
            headers: { authorization: `Bearer ${adminToken}` },
            payload: { mode: "external-portal", scope: "study", recipientEmail: "patient@example.test", purposeOfUse: "patient access to own results", consentBasis: "patient request" },
        });
        expect(shareResponse.statusCode).toBe(201);
        const { grant, linkToken, verificationCode } = shareResponse.json();
        expect(grant.allowDownload).toBe(false);

        const externalAccess = await app.inject({
            method: "POST",
            url: `/organizations/${orgId}/imaging/external-access/${linkToken}`,
            payload: { verificationCode },
        });
        expect(externalAccess.statusCode).toBe(200);
        const externalToken = externalAccess.json().token;

        const studyDetail = await app.inject({
            method: "GET",
            url: `/organizations/${orgId}/imaging/studies/${studyId}`,
            headers: { authorization: `Bearer ${adminToken}` },
        });
        const realInstanceId = studyDetail.json().instances[0][0].id;

        const beforeRevoke = await app.inject({
            method: "GET",
            url: `/organizations/${orgId}/imaging/wado/instances/${realInstanceId}`,
            headers: { authorization: `Bearer ${externalToken}` },
        });
        expect(beforeRevoke.statusCode).toBe(200);

        const revoke = await app.inject({
            method: "POST",
            url: `/organizations/${orgId}/imaging/shares/${grant.id}/revoke`,
            headers: { authorization: `Bearer ${adminToken}` },
        });
        expect(revoke.statusCode).toBe(200);

        const afterRevoke = await app.inject({
            method: "GET",
            url: `/organizations/${orgId}/imaging/wado/instances/${realInstanceId}`,
            headers: { authorization: `Bearer ${externalToken}` },
        });
        expect(afterRevoke.statusCode).toBe(401);

        // The unrelated internal session must still work — revocation is
        // scoped to sessions issued from THIS grant, never a blanket wipe.
        const internalStillWorks = await app.inject({
            method: "GET",
            url: `/organizations/${orgId}/imaging/wado/instances/${realInstanceId}`,
            headers: { authorization: `Bearer ${internalToken}` },
        });
        expect(internalStillWorks.statusCode).toBe(200);
    });

    it("external-portal access is identical-404 for a wrong verification code and a wrong link token (anti-enumeration)", async () => {
        const { orgId, adminToken } = await createOrg("idp|dr-admin");
        const ingestResult = await ingest(orgId, adminToken, buildMinimalDicomFile());
        const studyId = ingestResult.body.studyId;

        const shareResponse = await app.inject({
            method: "POST",
            url: `/organizations/${orgId}/imaging/studies/${studyId}/shares`,
            headers: { authorization: `Bearer ${adminToken}` },
            payload: { mode: "external-portal", scope: "study", recipientEmail: "patient@example.test", purposeOfUse: "patient access", consentBasis: "patient request" },
        });
        const { linkToken, verificationCode } = shareResponse.json();

        const wrongCode = await app.inject({
            method: "POST",
            url: `/organizations/${orgId}/imaging/external-access/${linkToken}`,
            payload: { verificationCode: "000000" },
        });
        const wrongToken = await app.inject({
            method: "POST",
            url: `/organizations/${orgId}/imaging/external-access/not-a-real-token`,
            payload: { verificationCode },
        });
        expect(wrongCode.statusCode).toBe(404);
        expect(wrongToken.statusCode).toBe(404);
        expect(wrongCode.json()).toEqual(wrongToken.json());

        const correct = await app.inject({
            method: "POST",
            url: `/organizations/${orgId}/imaging/external-access/${linkToken}`,
            payload: { verificationCode },
        });
        expect(correct.statusCode).toBe(200);
    });

    it("a replayed/revoked viewer session token is rejected (401), never silently treated as still-valid", async () => {
        const { orgId, adminToken } = await createOrg("idp|dr-admin");
        const ingestResult = await ingest(orgId, adminToken, buildMinimalDicomFile());
        const studyId = ingestResult.body.studyId;

        const sessionResponse = await app.inject({
            method: "POST",
            url: `/organizations/${orgId}/imaging/studies/${studyId}/viewer-sessions`,
            headers: { authorization: `Bearer ${adminToken}` },
            payload: {},
        });
        const { session, token } = sessionResponse.json();

        await app.inject({
            method: "POST",
            url: `/organizations/${orgId}/imaging/viewer-sessions/${session.id}/revoke`,
            headers: { authorization: `Bearer ${adminToken}` },
        });

        const studyDetail = await app.inject({
            method: "GET",
            url: `/organizations/${orgId}/imaging/studies/${studyId}`,
            headers: { authorization: `Bearer ${adminToken}` },
        });
        const instanceId = studyDetail.json().instances[0][0].id;

        const replay = await app.inject({
            method: "GET",
            url: `/organizations/${orgId}/imaging/wado/instances/${instanceId}`,
            headers: { authorization: `Bearer ${token}` },
        });
        expect(replay.statusCode).toBe(401);
    });

    it("a viewer session scoped to one series cannot retrieve an instance outside that scope (direct-object-reference protection)", async () => {
        const { orgId, adminToken } = await createOrg("idp|dr-admin");
        // Two independent studies (distinct StudyInstanceUID), each with its
        // own single instance.
        const first = await ingest(orgId, adminToken, buildMinimalDicomFile());
        const second = await ingest(orgId, adminToken, buildMinimalDicomFile());
        expect(first.body.studyId).not.toBe(second.body.studyId);

        const secondStudyDetail = await app.inject({
            method: "GET",
            url: `/organizations/${orgId}/imaging/studies/${second.body.studyId}`,
            headers: { authorization: `Bearer ${adminToken}` },
        });
        const secondInstanceId = secondStudyDetail.json().instances[0][0].id;

        // A viewer session scoped to the FIRST study only.
        const sessionResponse = await app.inject({
            method: "POST",
            url: `/organizations/${orgId}/imaging/studies/${first.body.studyId}/viewer-sessions`,
            headers: { authorization: `Bearer ${adminToken}` },
            payload: {},
        });
        const { token } = sessionResponse.json();

        // Attempting to use that token to fetch an instance belonging to
        // the SECOND study must fail identically to a nonexistent instance.
        const crossStudyAttempt = await app.inject({
            method: "GET",
            url: `/organizations/${orgId}/imaging/wado/instances/${secondInstanceId}`,
            headers: { authorization: `Bearer ${token}` },
        });
        const nonexistentAttempt = await app.inject({
            method: "GET",
            url: `/organizations/${orgId}/imaging/wado/instances/does-not-exist`,
            headers: { authorization: `Bearer ${token}` },
        });
        expect(crossStudyAttempt.statusCode).toBe(404);
        expect(nonexistentAttempt.statusCode).toBe(404);
        expect(crossStudyAttempt.json()).toEqual(nonexistentAttempt.json());
    });

    it("re-ingesting the identical bytes for an already-published SOPInstanceUID is a harmless no-op; a different payload under the same UID is rejected (immutability)", async () => {
        const { orgId, adminToken } = await createOrg("idp|dr-admin");
        const sopInstanceUid = "1.2.3.4.5.6.7.8.9";
        const original = buildMinimalDicomFile({ sopInstanceUid });

        const first = await ingest(orgId, adminToken, original);
        expect(first.body.job.status).toBe("published");

        const resend = await ingest(orgId, adminToken, original);
        expect(resend.body.job.status).toBe("published");
        expect(resend.body.studyId).toBe(first.body.studyId);

        const tampered = buildMinimalDicomFile({ sopInstanceUid, patientId: "DIFFERENT-PATIENT" });
        const tamperedResend = await ingest(orgId, adminToken, tampered);
        expect(tamperedResend.body.job.status).toBe("rejected");
    });

    it("an ambiguous-patient-match job can be manually resolved: attach publishes to the chosen case, and a second resolution attempt is rejected", async () => {
        const { orgId, adminToken } = await createOrg("idp|dr-admin");
        // One study already attached to case-A for this patient; a second
        // upload for the SAME PatientID/Issuer but hinted at case-B is
        // genuinely ambiguous and must be held, never auto-resolved.
        const first = await ingest(orgId, adminToken, buildMinimalDicomFile({ patientId: "MRN-AMBIG-2", issuerOfPatientId: "TEST-HOSPITAL" }), "?expectedCaseId=case-A");
        expect(first.body.job.status).toBe("published");
        const second = await ingest(orgId, adminToken, buildMinimalDicomFile({ patientId: "MRN-AMBIG-2", issuerOfPatientId: "TEST-HOSPITAL" }), "?expectedCaseId=case-B");
        expect(second.body.job.status).toBe("review-required");
        expect(second.body.requiresReview).toBe(true);
        const jobId = second.body.job.id;

        const resolve = await app.inject({
            method: "POST",
            url: `/organizations/${orgId}/imaging/ingestion/${jobId}/resolve`,
            headers: { authorization: `Bearer ${adminToken}` },
            payload: { decision: "attach", caseId: "case-B" },
        });
        expect(resolve.statusCode).toBe(200);
        expect(resolve.json().job.status).toBe("published");
        expect(resolve.json().studyId).toBeTruthy();
        expect(resolve.json().studyId).not.toBe(first.body.studyId);

        const secondResolveAttempt = await app.inject({
            method: "POST",
            url: `/organizations/${orgId}/imaging/ingestion/${jobId}/resolve`,
            headers: { authorization: `Bearer ${adminToken}` },
            payload: { decision: "attach", caseId: "case-B" },
        });
        expect(secondResolveAttempt.statusCode).toBe(409);
    });

    it("resolving an ambiguous job requires imagingStudy:ingest, and rejecting one creates no study", async () => {
        const { orgId, adminToken } = await createOrg("idp|dr-admin");
        const first = await ingest(orgId, adminToken, buildMinimalDicomFile({ patientId: "MRN-AMBIG-3", issuerOfPatientId: "TEST-HOSPITAL" }), "?expectedCaseId=case-A");
        expect(first.body.job.status).toBe("published");
        const second = await ingest(orgId, adminToken, buildMinimalDicomFile({ patientId: "MRN-AMBIG-3", issuerOfPatientId: "TEST-HOSPITAL" }), "?expectedCaseId=case-B");
        expect(second.body.job.status).toBe("review-required");
        const jobId = second.body.job.id;

        const unprivilegedToken = await tokenFor("idp|no-imaging-rights-3");
        await app.inject({
            method: "POST",
            url: `/organizations/${orgId}/users`,
            headers: { authorization: `Bearer ${adminToken}` },
            payload: { externalSubject: "idp|no-imaging-rights-3", displayName: "No Rights" },
        });
        const forbidden = await app.inject({
            method: "POST",
            url: `/organizations/${orgId}/imaging/ingestion/${jobId}/resolve`,
            headers: { authorization: `Bearer ${unprivilegedToken}` },
            payload: { decision: "reject" },
        });
        expect(forbidden.statusCode).toBe(403);

        const reject = await app.inject({
            method: "POST",
            url: `/organizations/${orgId}/imaging/ingestion/${jobId}/resolve`,
            headers: { authorization: `Bearer ${adminToken}` },
            payload: { decision: "reject" },
        });
        expect(reject.statusCode).toBe(200);
        expect(reject.json().job.status).toBe("rejected");
    });

    /**
     * CloudFront delivery moves pixel bytes off the origin path, so these
     * assert the property that actually matters: authorization is unchanged,
     * and a signed URL is minted ONLY after every check the proxy path runs.
     * A regression that signed before authorizing would turn a 404 into a
     * working CDN link, so each negative case asserts both the status code
     * and the absence of a Location header.
     */
    describe("CloudFront content delivery", () => {
        let cdnApp: FastifyInstance;
        let cloudFrontPublicKeyPem: string;

        beforeEach(() => {
            const rsa = generateKeyPairSync("rsa", {
                modulusLength: 2048,
                publicKeyEncoding: { type: "spki", format: "pem" },
                privateKeyEncoding: { type: "pkcs8", format: "pem" },
            });
            cloudFrontPublicKeyPem = rsa.publicKey;
            const auditStore = new InMemoryAuditStore();
            cdnApp = buildApp({
                store: new InMemoryIamStore(auditStore),
                caseStore: new InMemoryCaseStore(auditStore),
                idempotencyStore: new InMemoryIdempotencyStore(),
                auditStore,
                jwks,
                oidc: { issuer: ISSUER, audience: AUDIENCE },
                imagingContentDelivery: new CloudFrontContentDelivery("cdn.imaging.example.test", "KTESTKEYPAIRID", rsa.privateKey),
            });
        });

        /** Same flow as the top-level helpers, against the CloudFront app. */
        async function setupStudy(): Promise<{ orgId: string; adminToken: string; instanceId: string; studyId: string }> {
            const adminToken = await tokenFor("idp|dr-admin", { name: "Dr. Admin" });
            const org = await cdnApp.inject({ method: "POST", url: "/organizations", headers: { authorization: `Bearer ${adminToken}` }, payload: { name: "CDN Health System" } });
            const orgId = org.json().organization.id;
            const ingested = await cdnApp.inject({
                method: "POST",
                url: `/organizations/${orgId}/imaging/ingestion`,
                headers: { authorization: `Bearer ${adminToken}`, "content-type": "application/dicom" },
                payload: buildMinimalDicomFile({ patientId: "MRN-CDN", issuerOfPatientId: "TEST-HOSPITAL" }),
            });
            const studyId = ingested.json().studyId;
            const detail = await cdnApp.inject({ method: "GET", url: `/organizations/${orgId}/imaging/studies/${studyId}`, headers: { authorization: `Bearer ${adminToken}` } });
            return { orgId, adminToken, studyId, instanceId: detail.json().instances[0][0].id };
        }

        async function viewerTokenFor(orgId: string, studyId: string, adminToken: string): Promise<string> {
            const session = await cdnApp.inject({
                method: "POST",
                url: `/organizations/${orgId}/imaging/studies/${studyId}/viewer-sessions`,
                headers: { authorization: `Bearer ${adminToken}` },
                payload: {},
            });
            return session.json().token;
        }

        it("redirects an authorized WADO request to a short-lived signed CloudFront URL instead of streaming through the origin", async () => {
            const { orgId, adminToken, studyId, instanceId } = await setupStudy();
            const viewerToken = await viewerTokenFor(orgId, studyId, adminToken);

            const response = await cdnApp.inject({
                method: "GET",
                url: `/organizations/${orgId}/imaging/wado/instances/${instanceId}`,
                headers: { authorization: `Bearer ${viewerToken}` },
            });

            expect(response.statusCode).toBe(307);
            expect(response.headers["cache-control"]).toBe("no-store");
            const location = new URL(response.headers.location as string);
            expect(location.origin).toBe("https://cdn.imaging.example.test");

            // The signature is real: verify it against the public key rather
            // than trusting that a Signature parameter merely exists.
            const decode = (v: string) => Buffer.from(v.replaceAll("-", "+").replaceAll("~", "/").replaceAll("_", "="), "base64");
            const verifier = createVerify("RSA-SHA1");
            verifier.update(decode(location.searchParams.get("Policy")!));
            expect(verifier.verify(cloudFrontPublicKeyPem, decode(location.searchParams.get("Signature")!))).toBe(true);

            // The redirect body carries no pixel data — the whole point.
            expect(response.rawPayload.length).toBe(0);
        });

        it("mints no URL for an instance outside the viewer session's scope — identical 404 to a nonexistent one, with no Location header", async () => {
            const { orgId, adminToken, studyId } = await setupStudy();
            // A second, unrelated study the session is NOT scoped to.
            const other = await cdnApp.inject({
                method: "POST",
                url: `/organizations/${orgId}/imaging/ingestion`,
                headers: { authorization: `Bearer ${adminToken}`, "content-type": "application/dicom" },
                payload: buildMinimalDicomFile({ patientId: "MRN-CDN", issuerOfPatientId: "TEST-HOSPITAL" }),
            });
            const otherDetail = await cdnApp.inject({ method: "GET", url: `/organizations/${orgId}/imaging/studies/${other.json().studyId}`, headers: { authorization: `Bearer ${adminToken}` } });
            const outOfScopeInstanceId = otherDetail.json().instances[0][0].id;

            const viewerToken = await viewerTokenFor(orgId, studyId, adminToken);
            const outOfScope = await cdnApp.inject({
                method: "GET",
                url: `/organizations/${orgId}/imaging/wado/instances/${outOfScopeInstanceId}`,
                headers: { authorization: `Bearer ${viewerToken}` },
            });
            const nonexistent = await cdnApp.inject({
                method: "GET",
                url: `/organizations/${orgId}/imaging/wado/instances/does-not-exist`,
                headers: { authorization: `Bearer ${viewerToken}` },
            });

            expect(outOfScope.statusCode).toBe(404);
            expect(nonexistent.statusCode).toBe(404);
            expect(outOfScope.json()).toEqual(nonexistent.json());
            expect(outOfScope.headers.location).toBeUndefined();
            expect(nonexistent.headers.location).toBeUndefined();
        });

        it("mints no URL without a viewer session, or with a revoked one", async () => {
            const { orgId, adminToken, studyId, instanceId } = await setupStudy();

            const anonymous = await cdnApp.inject({ method: "GET", url: `/organizations/${orgId}/imaging/wado/instances/${instanceId}` });
            expect(anonymous.statusCode).toBe(401);
            expect(anonymous.headers.location).toBeUndefined();

            const session = await cdnApp.inject({
                method: "POST",
                url: `/organizations/${orgId}/imaging/studies/${studyId}/viewer-sessions`,
                headers: { authorization: `Bearer ${adminToken}` },
                payload: {},
            });
            const { session: created, token } = session.json();
            await cdnApp.inject({
                method: "POST",
                url: `/organizations/${orgId}/imaging/viewer-sessions/${created.id}/revoke`,
                headers: { authorization: `Bearer ${adminToken}` },
            });

            const afterRevoke = await cdnApp.inject({
                method: "GET",
                url: `/organizations/${orgId}/imaging/wado/instances/${instanceId}`,
                headers: { authorization: `Bearer ${token}` },
            });
            expect(afterRevoke.statusCode).toBe(401);
            expect(afterRevoke.headers.location).toBeUndefined();
        });

        it("the signed URL path carries no DICOM identifier — object keys are opaque UUIDs, and CloudFront logs full paths", async () => {
            const sopInstanceUid = "1.2.840.99999.SENTINEL.UID";
            const adminToken = await tokenFor("idp|dr-admin", { name: "Dr. Admin" });
            const org = await cdnApp.inject({ method: "POST", url: "/organizations", headers: { authorization: `Bearer ${adminToken}` }, payload: { name: "CDN Health System" } });
            const orgId = org.json().organization.id;
            const ingested = await cdnApp.inject({
                method: "POST",
                url: `/organizations/${orgId}/imaging/ingestion`,
                headers: { authorization: `Bearer ${adminToken}`, "content-type": "application/dicom" },
                payload: buildMinimalDicomFile({ sopInstanceUid, patientId: "MRN-SENTINEL", issuerOfPatientId: "TEST-HOSPITAL" }),
            });
            const studyId = ingested.json().studyId;
            const detail = await cdnApp.inject({ method: "GET", url: `/organizations/${orgId}/imaging/studies/${studyId}`, headers: { authorization: `Bearer ${adminToken}` } });
            const instanceId = detail.json().instances[0][0].id;
            const viewerToken = await viewerTokenFor(orgId, studyId, adminToken);

            const response = await cdnApp.inject({
                method: "GET",
                url: `/organizations/${orgId}/imaging/wado/instances/${instanceId}`,
                headers: { authorization: `Bearer ${viewerToken}` },
            });
            const location = new URL(response.headers.location as string);
            expect(location.pathname).not.toContain(sopInstanceUid);
            expect(location.pathname).not.toContain("MRN-SENTINEL");
        });
    });
});
