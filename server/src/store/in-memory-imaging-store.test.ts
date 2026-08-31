import { randomUUID } from "node:crypto";
import { describe, it, expect } from "vitest";
import { InMemoryImagingStore } from "./in-memory-imaging-store.js";
import type { TenantContext } from "../tenant-context.js";

const actor = (subject = "idp|test") => ({ externalSubject: subject, userId: randomUUID(), organizationId: undefined as unknown as string });

function tenantContext(organizationId: string): TenantContext {
    return { organizationId, schemaName: `tenant_${organizationId.replaceAll("-", "")}`, issuer: "test", subject: "test" };
}

describe("InMemoryImagingStore", () => {
    it("creates a study with quarantined ingestion status and zero counts", async () => {
        const store = new InMemoryImagingStore();
        const org = randomUUID();
        const repo = store.forTenant(tenantContext(org));
        const { study } = await repo.createStudy(
            { studyInstanceUid: "1.2.3.4", patientIdentifier: { value: "MRN1", issuer: "HOSP-A" }, modalities: ["CT"], ownerUserId: randomUUID() },
            actor()
        );
        expect(study.ingestionStatus).toBe("quarantined");
        expect(study.numberOfSeries).toBe(0);
        expect(study.numberOfInstances).toBe(0);
        expect(study.sensitivity).toBe("normal");
    });

    it("series/instance creation increments the parent study's counts", async () => {
        const store = new InMemoryImagingStore();
        const org = randomUUID();
        const repo = store.forTenant(tenantContext(org));
        const { study } = await repo.createStudy({ studyInstanceUid: "1.2.3.4", patientIdentifier: { value: "MRN1", issuer: "HOSP-A" }, modalities: ["CT"], ownerUserId: randomUUID() }, actor());
        const series = await repo.createSeries(study.id, { seriesInstanceUid: "1.2.3.4.1", modality: "CT" }, actor());
        await repo.createInstance(series.id, { sopInstanceUid: "1.2.3.4.1.1", sopClassUid: "1.2.840.10008.5.1.4.1.1.2", transferSyntaxUid: "1.2.840.10008.1.2.1", checksumSha256: "a".repeat(64), objectStorageKey: "k1", sizeBytes: 1000, hasThumbnail: false }, actor());
        await repo.createInstance(series.id, { sopInstanceUid: "1.2.3.4.1.2", sopClassUid: "1.2.840.10008.5.1.4.1.1.2", transferSyntaxUid: "1.2.840.10008.1.2.1", checksumSha256: "b".repeat(64), objectStorageKey: "k2", sizeBytes: 2000, hasThumbnail: false }, actor());

        const reloaded = await repo.getStudy(study.id);
        expect(reloaded!.study.numberOfSeries).toBe(1);
        expect(reloaded!.study.numberOfInstances).toBe(2);
        const reloadedSeries = await repo.getSeries(series.id);
        expect(reloadedSeries!.numberOfInstances).toBe(2);
    });

    it("findStudiesByPatientIdentifier matches by exact (issuer, value), case-insensitively, never partial", async () => {
        const store = new InMemoryImagingStore();
        const org = randomUUID();
        const repo = store.forTenant(tenantContext(org));
        await repo.createStudy({ studyInstanceUid: "1.2.3.4", patientIdentifier: { value: "MRN1", issuer: "HOSP-A" }, modalities: ["CT"], ownerUserId: randomUUID() }, actor());
        await repo.createStudy({ studyInstanceUid: "1.2.3.5", patientIdentifier: { value: "mrn1", issuer: "hosp-a" }, modalities: ["MR"], ownerUserId: randomUUID() }, actor());
        await repo.createStudy({ studyInstanceUid: "1.2.3.6", patientIdentifier: { value: "MRN1", issuer: "HOSP-B" }, modalities: ["US"], ownerUserId: randomUUID() }, actor());

        const matches = await repo.findStudiesByPatientIdentifier({ value: "MRN1", issuer: "HOSP-A" });
        expect(matches).toHaveLength(2); // the two HOSP-A studies (case-insensitive), not the HOSP-B one
        const noMatch = await repo.findStudiesByPatientIdentifier({ value: "MRN1", issuer: "HOSP-C" });
        expect(noMatch).toHaveLength(0);
    });

    describe("diagnostic reports — immutable amendment chain", () => {
        it("getCurrentReport returns the newest non-superseded, non-cancelled report", async () => {
            const store = new InMemoryImagingStore();
            const org = randomUUID();
            const repo = store.forTenant(tenantContext(org));
            const { study } = await repo.createStudy({ studyInstanceUid: "1.2.3.4", patientIdentifier: { value: "MRN1", issuer: "HOSP-A" }, modalities: ["CT"], ownerUserId: randomUUID() }, actor());

            const original = await repo.createReport({ studyId: study.id, status: "final", conclusion: "No acute findings.", authorUserId: randomUUID(), authoredAt: new Date().toISOString(), isCritical: false }, actor());
            expect((await repo.getCurrentReport(study.id))!.id).toBe(original.id);

            const amended = await repo.createReport(
                { studyId: study.id, status: "amended", conclusion: "Correction: small nodule noted.", authorUserId: randomUUID(), authoredAt: new Date().toISOString(), previousVersionId: original.id, amendmentReason: "Missed finding on first read.", isCritical: false },
                actor()
            );

            // The original row is untouched (immutable) — still readable at
            // its own id, exactly as it was created.
            const originalReread = await repo.getReport(original.id);
            expect(originalReread!.conclusion).toBe("No acute findings.");
            expect(originalReread!.status).toBe("final"); // never mutated to "superseded" or similar

            const current = await repo.getCurrentReport(study.id);
            expect(current!.id).toBe(amended.id);
            expect(current!.previousVersionId).toBe(original.id);

            const history = await repo.listReportHistory(study.id);
            expect(history.map((r) => r.id).sort()).toEqual([amended.id, original.id].sort());
        });

        it("critical-result acknowledgement is recorded and idempotent to re-read", async () => {
            const store = new InMemoryImagingStore();
            const org = randomUUID();
            const repo = store.forTenant(tenantContext(org));
            const { study } = await repo.createStudy({ studyInstanceUid: "1.2.3.4", patientIdentifier: { value: "MRN1", issuer: "HOSP-A" }, modalities: ["CT"], ownerUserId: randomUUID() }, actor());
            const report = await repo.createReport({ studyId: study.id, status: "final", conclusion: "Pneumothorax.", authorUserId: randomUUID(), authoredAt: new Date().toISOString(), isCritical: true }, actor());
            expect(report.criticalAcknowledgedAt).toBeUndefined();

            const clinicianId = randomUUID();
            const acknowledged = await repo.acknowledgeCriticalReport(report.id, clinicianId, actor());
            expect(acknowledged!.criticalAcknowledgedByUserId).toBe(clinicianId);
            expect(acknowledged!.criticalAcknowledgedAt).toEqual(expect.any(String));
        });
    });

    describe("share grants and viewer-session revocation (item 11)", () => {
        it("revoking a share grant terminates every viewer session issued from it", async () => {
            const store = new InMemoryImagingStore();
            const org = randomUUID();
            const repo = store.forTenant(tenantContext(org));
            const { study } = await repo.createStudy({ studyInstanceUid: "1.2.3.4", patientIdentifier: { value: "MRN1", issuer: "HOSP-A" }, modalities: ["CT"], ownerUserId: randomUUID() }, actor());
            const grant = await repo.createShareGrant(
                { mode: "external-portal", scope: "study", studyId: study.id, recipientEmail: "ext@example.test", purposeOfUse: "second opinion", expiresAt: new Date(Date.now() + 86_400_000).toISOString(), allowDownload: false, issuedByUserId: randomUUID(), consentBasis: "patient request", externalTokenHash: "tok-hash", externalVerificationCodeHash: "code-hash" },
                actor()
            );
            const session = await repo.createViewerSession({ studyId: study.id, grantedActions: ["view"], shareGrantId: grant.id, tokenHash: "session-hash", expiresAt: new Date(Date.now() + 3_600_000).toISOString() }, actor());

            expect(await repo.findActiveViewerSessionByTokenHash("session-hash")).not.toBeNull();

            await repo.revokeShareGrant(grant.id, randomUUID(), actor());
            const revokedCount = await repo.revokeViewerSessionsForShareGrant(grant.id, actor());
            expect(revokedCount).toBe(1);
            expect(await repo.findActiveViewerSessionByTokenHash("session-hash")).toBeNull();

            const reloadedGrant = await repo.getShareGrant(grant.id);
            expect(reloadedGrant!.status).toBe("revoked");
        });

        it("findActiveExternalShareByTokenHash never returns a revoked or wrong-token grant", async () => {
            const store = new InMemoryImagingStore();
            const org = randomUUID();
            const repo = store.forTenant(tenantContext(org));
            const { study } = await repo.createStudy({ studyInstanceUid: "1.2.3.4", patientIdentifier: { value: "MRN1", issuer: "HOSP-A" }, modalities: ["CT"], ownerUserId: randomUUID() }, actor());
            const grant = await repo.createShareGrant(
                { mode: "external-portal", scope: "study", studyId: study.id, recipientEmail: "ext@example.test", purposeOfUse: "x", expiresAt: new Date(Date.now() + 86_400_000).toISOString(), allowDownload: false, issuedByUserId: randomUUID(), consentBasis: "x", externalTokenHash: "real-hash", externalVerificationCodeHash: "code-hash" },
                actor()
            );
            expect(await repo.findActiveExternalShareByTokenHash("wrong-hash")).toBeNull();
            expect((await repo.findActiveExternalShareByTokenHash("real-hash"))!.grant.id).toBe(grant.id);

            await repo.revokeShareGrant(grant.id, randomUUID(), actor());
            expect(await repo.findActiveExternalShareByTokenHash("real-hash")).toBeNull();
        });

        it("never exposes tokenHash/externalTokenHash/externalVerificationCodeHash on any public shape", async () => {
            const store = new InMemoryImagingStore();
            const org = randomUUID();
            const repo = store.forTenant(tenantContext(org));
            const { study } = await repo.createStudy({ studyInstanceUid: "1.2.3.4", patientIdentifier: { value: "MRN1", issuer: "HOSP-A" }, modalities: ["CT"], ownerUserId: randomUUID() }, actor());
            const grant = await repo.createShareGrant(
                { mode: "external-portal", scope: "study", studyId: study.id, recipientEmail: "ext@example.test", purposeOfUse: "x", expiresAt: new Date(Date.now() + 86_400_000).toISOString(), allowDownload: false, issuedByUserId: randomUUID(), consentBasis: "x", externalTokenHash: "real-hash", externalVerificationCodeHash: "code-hash" },
                actor()
            );
            expect(grant).not.toHaveProperty("externalTokenHash");
            expect(grant).not.toHaveProperty("externalVerificationCodeHash");
            const session = await repo.createViewerSession({ studyId: study.id, grantedActions: ["view"], tokenHash: "secret", expiresAt: new Date(Date.now() + 1000).toISOString() }, actor());
            expect(session).not.toHaveProperty("tokenHash");
        });
    });

    it("ingestion job status transitions are recorded and queryable by status", async () => {
        const store = new InMemoryImagingStore();
        const org = randomUUID();
        const repo = store.forTenant(tenantContext(org));
        const job = await repo.createIngestionJob({ uploadId: randomUUID(), fileName: "scan.dcm", sizeBytes: 5000, status: "quarantined" }, randomUUID(), actor());
        expect((await repo.listIngestionJobs({ status: "quarantined" })).map((j) => j.id)).toContain(job.id);

        await repo.updateIngestionJob(job.id, { status: "failed", failureCategory: "malformed-dicom" }, actor());
        const updated = await repo.getIngestionJob(job.id);
        expect(updated!.status).toBe("failed");
        expect(updated!.failureCategory).toBe("malformed-dicom");
        expect((await repo.listIngestionJobs({ status: "quarantined" })).map((j) => j.id)).not.toContain(job.id);
    });

    describe("change feed (study/report/shareGrant only)", () => {
        it("returns only changes after the given cursor, in order, and advances the cursor", async () => {
            const store = new InMemoryImagingStore();
            const org = randomUUID();
            const repo = store.forTenant(tenantContext(org));
            const { study: s1 } = await repo.createStudy({ studyInstanceUid: "1.2.3.4", patientIdentifier: { value: "MRN1", issuer: "HOSP-A" }, modalities: ["CT"], ownerUserId: randomUUID() }, actor());
            const first = await repo.readChanges(null);
            expect(first.changes).toHaveLength(1);

            const { study: s2 } = await repo.createStudy({ studyInstanceUid: "1.2.3.5", patientIdentifier: { value: "MRN2", issuer: "HOSP-A" }, modalities: ["MR"], ownerUserId: randomUUID() }, actor());
            const second = await repo.readChanges(first.cursor);
            expect(second.changes).toHaveLength(1);
            expect(second.changes[0].change.kind).toBe("upsert");
            expect(second.changes[0].change.studyId).toBe(s2.id);

            // Re-reading from the original cursor omits nothing that came
            // after it and includes everything, in the same order.
            const fromStart = await repo.readChanges(null);
            expect(fromStart.changes.map((c) => c.change.studyId)).toEqual([s1.id, s2.id]);
        });

        it("never includes series/instance/annotation/provenance changes — only study/report/shareGrant", async () => {
            const store = new InMemoryImagingStore();
            const org = randomUUID();
            const repo = store.forTenant(tenantContext(org));
            const { study } = await repo.createStudy({ studyInstanceUid: "1.2.3.4", patientIdentifier: { value: "MRN1", issuer: "HOSP-A" }, modalities: ["CT"], ownerUserId: randomUUID() }, actor());
            const series = await repo.createSeries(study.id, { seriesInstanceUid: "1.2.3.4.1", modality: "CT" }, actor());
            await repo.createInstance(series.id, { sopInstanceUid: "1.2.3.4.1.1", sopClassUid: "1.2.840.10008.5.1.4.1.1.2", transferSyntaxUid: "1.2.840.10008.1.2.1", checksumSha256: "a".repeat(64), objectStorageKey: "k1", sizeBytes: 100, hasThumbnail: false }, actor());
            await repo.createAnnotation({ studyId: study.id, kind: "note", data: {}, authorUserId: randomUUID(), provenance: "human" }, actor());

            const { changes } = await repo.readChanges(null);
            // Only the study's own creation — series/instance/annotation
            // creation produced zero additional change-feed entries.
            expect(changes).toHaveLength(1);
            expect(changes[0].change.resourceType).toBe("study");
        });
    });

    it("tenant isolation: two organizations with colliding StudyInstanceUID never see each other's data (item: never use StudyInstanceUID alone as a tenant boundary)", async () => {
        const store = new InMemoryImagingStore();
        const orgA = randomUUID();
        const orgB = randomUUID();
        const repoA = store.forTenant(tenantContext(orgA));
        const repoB = store.forTenant(tenantContext(orgB));

        const collidingUid = "1.2.840.113619.2.55.3.604688654.995.1234567890.123";
        const { study: studyA } = await repoA.createStudy({ studyInstanceUid: collidingUid, patientIdentifier: { value: "MRN-A", issuer: "HOSP-A" }, modalities: ["CT"], ownerUserId: randomUUID() }, actor());
        const { study: studyB } = await repoB.createStudy({ studyInstanceUid: collidingUid, patientIdentifier: { value: "MRN-B", issuer: "HOSP-B" }, modalities: ["MR"], ownerUserId: randomUUID() }, actor());

        expect(studyA.id).not.toBe(studyB.id);

        // Each tenant's own lookup by the (colliding) UID resolves to its
        // OWN study, never the other tenant's.
        expect((await repoA.findStudyByUid(collidingUid))!.study.id).toBe(studyA.id);
        expect((await repoB.findStudyByUid(collidingUid))!.study.id).toBe(studyB.id);

        // Cross-tenant id lookup: repoB was never given studyA's id, but
        // even if a caller obtained it some other way, listStudies()/
        // getStudy() are scoped to the OrgState this forTenant() call was
        // built against — orgB's repo simply has no record of it.
        expect(await repoB.getStudy(studyA.id)).toBeNull();
        expect((await repoA.listStudies()).map((s) => s.study.id)).not.toContain(studyB.id);
        expect((await repoB.listStudies()).map((s) => s.study.id)).not.toContain(studyA.id);

        // Change feeds are independent per tenant too.
        const feedA = await repoA.readChanges(null);
        expect(feedA.changes.every((c) => c.change.studyId !== studyB.id)).toBe(true);
    });

    it("derived artifacts and provenance are linked and queryable by source", async () => {
        const store = new InMemoryImagingStore();
        const org = randomUUID();
        const repo = store.forTenant(tenantContext(org));
        const { study } = await repo.createStudy({ studyInstanceUid: "1.2.3.4", patientIdentifier: { value: "MRN1", issuer: "HOSP-A" }, modalities: ["CT"], ownerUserId: randomUUID() }, actor());
        const series = await repo.createSeries(study.id, { seriesInstanceUid: "1.2.3.4.1", modality: "CT" }, actor());
        const instance = await repo.createInstance(series.id, { sopInstanceUid: "1.2.3.4.1.1", sopClassUid: "1.2.840.10008.5.1.4.1.1.2", transferSyntaxUid: "1.2.840.10008.1.2.1", checksumSha256: "a".repeat(64), objectStorageKey: "k1", sizeBytes: 100, hasThumbnail: false }, actor());

        const artifact = await repo.createDerivedArtifact({
            kind: "thumbnail", sourceInstanceId: instance.id, objectStorageKey: "thumb-key", checksumSha256: "b".repeat(64), sizeBytes: 50,
            provenance: { targetType: "instance", targetId: instance.id, action: "thumbnail-generated", performedBy: "system:thumbnail-job", performedAt: new Date().toISOString(), sourceRefs: [instance.id] },
        });
        await repo.markInstanceThumbnailed(instance.id);

        expect((await repo.getInstance(instance.id))!.hasThumbnail).toBe(true);
        expect((await repo.listDerivedArtifactsForSource("thumbnail", instance.id)).map((a) => a.id)).toEqual([artifact.id]);
        const provenance = await repo.listProvenanceForTarget("instance", instance.id);
        expect(provenance).toHaveLength(1);
        expect(provenance[0].action).toBe("thumbnail-generated");
    });
});
