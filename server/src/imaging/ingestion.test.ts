import { randomBytes, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { InMemoryImagingStore } from "../store/in-memory-imaging-store.js";
import { LocalFilesystemImagingObjectStore } from "./object-store.js";
import { LocalDicomwebAdapter } from "./dicomweb-adapter.js";
import { ingestOneInstance, generateAndStoreThumbnail, resolveAmbiguousIngestionJob, JobNotResolvableError, MAX_UPLOAD_SIZE_BYTES } from "./ingestion.js";
import { buildMinimalDicomFile } from "./test-fixtures.js";
import type { TenantContext } from "../tenant-context.js";

const actor = () => ({ externalSubject: "idp|test", userId: randomUUID(), organizationId: undefined as unknown as string });

function tenantContext(organizationId: string): TenantContext {
    return { organizationId, schemaName: `tenant_${organizationId.replaceAll("-", "")}`, issuer: "test", subject: "test" };
}

describe("ingestion pipeline (end to end: quarantine -> validate -> match -> publish)", () => {
    let root: string;
    let organizationId: string;
    let store: InMemoryImagingStore;
    let objectStore: LocalFilesystemImagingObjectStore;
    let repo: ReturnType<InMemoryImagingStore["forTenant"]>;
    let dicomweb: LocalDicomwebAdapter;

    beforeEach(async () => {
        root = await fs.mkdtemp(path.join(os.tmpdir(), "ingestion-test-"));
        organizationId = randomUUID();
        store = new InMemoryImagingStore();
        objectStore = new LocalFilesystemImagingObjectStore(root, randomBytes(32));
        repo = store.forTenant(tenantContext(organizationId));
        dicomweb = new LocalDicomwebAdapter(objectStore, organizationId);
    });

    afterEach(async () => {
        await fs.rm(root, { recursive: true, force: true });
    });

    function deps() {
        return { repo, objectStore, dicomweb, organizationId };
    }

    it("a valid, brand-new instance is published: study/series/instance created, immutable original stored, checksum recorded", async () => {
        const file = buildMinimalDicomFile({ patientId: "MRN1", issuerOfPatientId: "HOSP-A", modality: "CT" });
        const result = await ingestOneInstance(deps(), { fileName: "scan.dcm", fileBytes: file, uploadId: randomUUID(), ownerUserId: randomUUID() }, actor());

        expect(result.job.status).toBe("published");
        expect(result.requiresReview).toBe(false);
        const study = await repo.getStudy(result.studyId!);
        expect(study!.study.ingestionStatus).toBe("published");
        expect(study!.study.status).toBe("available");
        expect(study!.study.numberOfInstances).toBe(1);

        const series = await repo.listSeriesForStudy(result.studyId!);
        expect(series).toHaveLength(1);
        const instances = await repo.listInstancesForSeries(series[0].id);
        expect(instances).toHaveLength(1);

        // The original bytes are retrievable, unmodified, from the object
        // store — "keep original DICOM objects immutable."
        const retrieved = await objectStore.get(instances[0].objectStorageKey);
        expect(retrieved.equals(file)).toBe(true);
    });

    it("rejects an oversized upload before ever attempting to parse it", async () => {
        const oversized = Buffer.alloc(MAX_UPLOAD_SIZE_BYTES + 1);
        const result = await ingestOneInstance(deps(), { fileName: "huge.dcm", fileBytes: oversized, uploadId: randomUUID(), ownerUserId: randomUUID() }, actor());
        expect(result.job.status).toBe("rejected");
        expect(result.job.failureCategory).toBe("file-too-large");
        expect(result.studyId).toBeUndefined();
    });

    it("a malformed file fails cleanly with a PHI-safe failure category, and creates no study", async () => {
        const result = await ingestOneInstance(deps(), { fileName: "not-dicom.dcm", fileBytes: Buffer.from("garbage bytes"), uploadId: randomUUID(), ownerUserId: randomUUID() }, actor());
        expect(result.job.status).toBe("failed");
        expect(result.job.failureCategory).toBe("malformed-dicom");
        expect((await repo.listStudies())).toHaveLength(0);
    });

    it("an unsupported transfer syntax is rejected without creating a study", async () => {
        const file = buildMinimalDicomFile({ transferSyntaxUid: "1.2.9.9.9.not-real" });
        const result = await ingestOneInstance(deps(), { fileName: "x.dcm", fileBytes: file, uploadId: randomUUID(), ownerUserId: randomUUID() }, actor());
        expect(result.job.status).toBe("failed");
        expect(result.job.failureCategory).toBe("unsupported-transfer-syntax");
        expect((await repo.listStudies())).toHaveLength(0);
    });

    describe("ambiguous patient matching requires review, never auto-resolves", () => {
        it("flags for review when the same patient identifier already maps to more than one case", async () => {
            // Two existing studies for the SAME patient identifier, but
            // attached to two DIFFERENT cases — a real ambiguity.
            await repo.createStudy({ studyInstanceUid: "1.1", patientIdentifier: { value: "MRN1", issuer: "HOSP-A" }, modalities: ["CT"], ownerUserId: randomUUID(), caseId: "case-A" }, actor());
            await repo.createStudy({ studyInstanceUid: "1.2", patientIdentifier: { value: "MRN1", issuer: "HOSP-A" }, modalities: ["CT"], ownerUserId: randomUUID(), caseId: "case-B" }, actor());

            const file = buildMinimalDicomFile({ patientId: "MRN1", issuerOfPatientId: "HOSP-A" });
            const result = await ingestOneInstance(deps(), { fileName: "x.dcm", fileBytes: file, uploadId: randomUUID(), ownerUserId: randomUUID() }, actor());

            expect(result.requiresReview).toBe(true);
            expect(result.job.status).toBe("review-required");
            expect(result.job.failureCategory).toBe("ambiguous-patient-match");
            expect(result.studyId).toBeUndefined();
        });

        it("flags for review when the uploader's expectedCaseId conflicts with the patient's only known case", async () => {
            await repo.createStudy({ studyInstanceUid: "1.1", patientIdentifier: { value: "MRN1", issuer: "HOSP-A" }, modalities: ["CT"], ownerUserId: randomUUID(), caseId: "case-A" }, actor());
            const file = buildMinimalDicomFile({ patientId: "MRN1", issuerOfPatientId: "HOSP-A" });
            const result = await ingestOneInstance(deps(), { fileName: "x.dcm", fileBytes: file, uploadId: randomUUID(), ownerUserId: randomUUID(), expectedCaseId: "case-B" }, actor());
            expect(result.requiresReview).toBe(true);
            expect(result.job.failureCategory).toBe("ambiguous-patient-match");
        });

        it("a brand-new patient identifier (no existing studies at all) is NOT ambiguous — proceeds to publish", async () => {
            const file = buildMinimalDicomFile({ patientId: "BRAND-NEW-MRN", issuerOfPatientId: "HOSP-A" });
            const result = await ingestOneInstance(deps(), { fileName: "x.dcm", fileBytes: file, uploadId: randomUUID(), ownerUserId: randomUUID() }, actor());
            expect(result.requiresReview).toBe(false);
            expect(result.job.status).toBe("published");
        });
    });

    describe("resolveAmbiguousIngestionJob: manual resolution of a held review-required job", () => {
        async function makeAmbiguousJob(): Promise<{ jobId: string }> {
            await repo.createStudy({ studyInstanceUid: "1.1", patientIdentifier: { value: "MRN1", issuer: "HOSP-A" }, modalities: ["CT"], ownerUserId: randomUUID(), caseId: "case-A" }, actor());
            await repo.createStudy({ studyInstanceUid: "1.2", patientIdentifier: { value: "MRN1", issuer: "HOSP-A" }, modalities: ["CT"], ownerUserId: randomUUID(), caseId: "case-B" }, actor());
            const file = buildMinimalDicomFile({ patientId: "MRN1", issuerOfPatientId: "HOSP-A" });
            const result = await ingestOneInstance(deps(), { fileName: "x.dcm", fileBytes: file, uploadId: randomUUID(), ownerUserId: randomUUID() }, actor());
            return { jobId: result.job.id };
        }

        it("\"attach\" publishes the quarantined bytes to the human-chosen case, and cleans up the quarantine object", async () => {
            const { jobId } = await makeAmbiguousJob();
            const reviewer = randomUUID();
            const result = await resolveAmbiguousIngestionJob(deps(), { jobId, decision: "attach", caseId: "case-A", resolvingUserId: reviewer }, actor());

            expect(result.job.status).toBe("published");
            expect(result.requiresReview).toBe(false);
            const study = await repo.getStudy(result.studyId!);
            expect(study!.study.caseId).toBe("case-A");
            expect(study!.resource.ownerUserId).toBe(reviewer);

            // The quarantine copy is gone — resolving twice can't work from
            // stale bytes.
            await expect(resolveAmbiguousIngestionJob(deps(), { jobId, decision: "attach", caseId: "case-A", resolvingUserId: reviewer }, actor())).rejects.toThrow(JobNotResolvableError);
        });

        it("\"reject\" discards the held bytes without ever creating a study", async () => {
            const { jobId } = await makeAmbiguousJob();
            const result = await resolveAmbiguousIngestionJob(deps(), { jobId, decision: "reject", resolvingUserId: randomUUID() }, actor());
            expect(result.job.status).toBe("rejected");
            expect((await repo.listStudies()).map((s) => s.study.caseId).sort()).toEqual(["case-A", "case-B"]); // only the two pre-existing studies, no third
        });

        it("\"attach\" without a caseId is rejected before touching the quarantined bytes", async () => {
            const { jobId } = await makeAmbiguousJob();
            await expect(resolveAmbiguousIngestionJob(deps(), { jobId, decision: "attach", resolvingUserId: randomUUID() }, actor())).rejects.toThrow(JobNotResolvableError);
        });

        it("refuses to resolve a job that was never ambiguous (wrong status/failureCategory), and a nonexistent job id", async () => {
            const published = await ingestOneInstance(deps(), { fileName: "x.dcm", fileBytes: buildMinimalDicomFile({ patientId: "SOLO", issuerOfPatientId: "HOSP-A" }), uploadId: randomUUID(), ownerUserId: randomUUID() }, actor());
            await expect(resolveAmbiguousIngestionJob(deps(), { jobId: published.job.id, decision: "reject", resolvingUserId: randomUUID() }, actor())).rejects.toThrow(JobNotResolvableError);
            await expect(resolveAmbiguousIngestionJob(deps(), { jobId: "does-not-exist", decision: "reject", resolvingUserId: randomUUID() }, actor())).rejects.toThrow(JobNotResolvableError);
        });
    });

    describe("immutability under re-ingestion", () => {
        it("re-ingesting the byte-identical file for an existing SOPInstanceUID is a harmless no-op", async () => {
            const file = buildMinimalDicomFile({ patientId: "MRN1", issuerOfPatientId: "HOSP-A" });
            const first = await ingestOneInstance(deps(), { fileName: "x.dcm", fileBytes: file, uploadId: randomUUID(), ownerUserId: randomUUID() }, actor());
            const second = await ingestOneInstance(deps(), { fileName: "x.dcm", fileBytes: Buffer.from(file), uploadId: randomUUID(), ownerUserId: randomUUID() }, actor());

            expect(second.job.status).toBe("published");
            expect(second.studyId).toBe(first.studyId);
            const study = await repo.getStudy(first.studyId!);
            expect(study!.study.numberOfInstances).toBe(1); // not double-counted
        });

        it("rejects a DIFFERENT payload claiming the same SOPInstanceUID as an existing instance (immutability violation attempt)", async () => {
            const sopInstanceUid = "1.2.3.4.5.fixed-uid";
            const first = buildMinimalDicomFile({ patientId: "MRN1", issuerOfPatientId: "HOSP-A", sopInstanceUid, accessionNumber: "ACC-ORIGINAL" });
            await ingestOneInstance(deps(), { fileName: "x.dcm", fileBytes: first, uploadId: randomUUID(), ownerUserId: randomUUID() }, actor());

            const tampered = buildMinimalDicomFile({ patientId: "MRN1", issuerOfPatientId: "HOSP-A", sopInstanceUid, accessionNumber: "ACC-TAMPERED" });
            const result = await ingestOneInstance(deps(), { fileName: "x.dcm", fileBytes: tampered, uploadId: randomUUID(), ownerUserId: randomUUID() }, actor());

            expect(result.job.status).toBe("rejected");
            // The original object in storage is untouched.
            const instance = await repo.findInstanceByUid(sopInstanceUid);
            const stored = await objectStore.get(instance!.objectStorageKey);
            expect(stored.equals(first)).toBe(true);
        });
    });

    it("thumbnail generation runs separately and marks the instance once complete", async () => {
        const file = buildMinimalDicomFile({ patientId: "MRN1", issuerOfPatientId: "HOSP-A", pixels: { rows: 8, columns: 8 } });
        const result = await ingestOneInstance(deps(), { fileName: "x.dcm", fileBytes: file, uploadId: randomUUID(), ownerUserId: randomUUID() }, actor());
        const series = await repo.listSeriesForStudy(result.studyId!);
        const [instance] = await repo.listInstancesForSeries(series[0].id);
        expect(instance.hasThumbnail).toBe(false);

        const thumbResult = await generateAndStoreThumbnail(deps(), instance.id, file);
        expect(thumbResult.generated).toBe(true);
        expect((await repo.getInstance(instance.id))!.hasThumbnail).toBe(true);
        const artifacts = await repo.listDerivedArtifactsForSource("thumbnail", instance.id);
        expect(artifacts).toHaveLength(1);
    });

    it("second series/instance for an already-known study attaches to the SAME study, not a duplicate", async () => {
        const studyInstanceUid = "shared-study-uid";
        const file1 = buildMinimalDicomFile({ patientId: "MRN1", issuerOfPatientId: "HOSP-A", studyInstanceUid, seriesInstanceUid: "series-1" });
        const file2 = buildMinimalDicomFile({ patientId: "MRN1", issuerOfPatientId: "HOSP-A", studyInstanceUid, seriesInstanceUid: "series-2" });

        const r1 = await ingestOneInstance(deps(), { fileName: "a.dcm", fileBytes: file1, uploadId: randomUUID(), ownerUserId: randomUUID() }, actor());
        const r2 = await ingestOneInstance(deps(), { fileName: "b.dcm", fileBytes: file2, uploadId: randomUUID(), ownerUserId: randomUUID() }, actor());

        expect(r2.studyId).toBe(r1.studyId);
        const study = await repo.getStudy(r1.studyId!);
        expect(study!.study.numberOfSeries).toBe(2);
        expect(study!.study.numberOfInstances).toBe(2);
    });

    it("tenant isolation: ingesting for one organization never creates or matches against another organization's studies", async () => {
        const orgB = randomUUID();
        const repoB = store.forTenant(tenantContext(orgB));
        const dicomwebB = new LocalDicomwebAdapter(objectStore, orgB);

        const collidingUid = "colliding-study-uid";
        const fileA = buildMinimalDicomFile({ patientId: "MRN1", issuerOfPatientId: "HOSP-A", studyInstanceUid: collidingUid });
        const fileB = buildMinimalDicomFile({ patientId: "MRN1", issuerOfPatientId: "HOSP-A", studyInstanceUid: collidingUid, sopInstanceUid: "different-instance" });

        const resultA = await ingestOneInstance({ repo, objectStore, dicomweb, organizationId }, { fileName: "a.dcm", fileBytes: fileA, uploadId: randomUUID(), ownerUserId: randomUUID() }, actor());
        const resultB = await ingestOneInstance({ repo: repoB, objectStore, dicomweb: dicomwebB, organizationId: orgB }, { fileName: "b.dcm", fileBytes: fileB, uploadId: randomUUID(), ownerUserId: randomUUID() }, actor());

        expect(resultA.studyId).not.toBe(resultB.studyId);
        expect(await repoB.getStudy(resultA.studyId!)).toBeNull();
        expect((await repo.listStudies()).map((s) => s.study.id)).not.toContain(resultB.studyId);
    });
});
