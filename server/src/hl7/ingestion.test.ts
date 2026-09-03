import { describe, expect, it } from "vitest";
import { InMemoryCaseStore } from "../store/in-memory-case-store.js";
import { InMemoryHl7IngestionStore } from "../store/in-memory-hl7-ingestion-store.js";
import type { TenantContext } from "../tenant-context.js";
import { patientCaseFixture } from "../test/patient-case-fixture.js";
import { Hl7IngestionResolutionError, ingestInboundMessage, resolveIngestionJob } from "./ingestion.js";
import { Hl7ParseError } from "./message.js";

const actor = () => ({ externalSubject: "idp|system", userId: "user-1", organizationId: undefined as unknown as string });

function tenantContext(): TenantContext {
    return { organizationId: "org-1", schemaName: "tenant_" + "0".repeat(32), issuer: "test", subject: "test" };
}

const SAMPLE_ORU = (mrn: string) => [
    "MSH|^~\\&|LAB|HOSPITAL|EHR|HOSPITAL|20260315120000||ORU^R01|MSG00001|P|2.5.1",
    `PID|1||${mrn}||`,
    "OBX|1|NM|2345-7^Glucose^LN||95|mg/dL|70-99|N|||F",
].join("\r");

const SAMPLE_ADT = (mrn: string) => [
    "MSH|^~\\&|EHR|HOSPITAL|MODELFORGE|MODELFORGE|20260315120000||ADT^A01|MSG00002|P|2.5.1",
    `PID|1||${mrn}||`,
].join("\r");

async function setup() {
    const ctx = tenantContext();
    const caseStore = new InMemoryCaseStore();
    const ingestionStore = new InMemoryHl7IngestionStore();
    const caseRepo = caseStore.forTenant(ctx);
    const ingestionRepo = ingestionStore.forTenant(ctx);
    return { caseRepo, ingestionRepo };
}

describe("ingestInboundMessage", () => {
    it("applies an ORU message to the single unambiguously-matched case, appending its observations to labResults", async () => {
        const { caseRepo, ingestionRepo } = await setup();
        await caseRepo.writeOne(patientCaseFixture("case-1", { patientId: "MRN-001" }), null, actor(), { organizationId: "org-1", caseId: "case-1", patientId: "MRN-001", ownerUserId: "user-1", assignedUserIds: [], activeConsentScopes: [] });

        const { job } = await ingestInboundMessage(caseRepo, ingestionRepo, SAMPLE_ORU("MRN-001"), actor());
        expect(job).toMatchObject({ messageType: "ORU^R01", matchStatus: "matched", matchedCaseId: "case-1", status: "applied", observationsAdded: 1 });

        const updated = await caseRepo.getOne("case-1");
        expect(updated?.patientCase.labResults.value).toHaveLength(1);
        expect(updated?.patientCase.labResults.value[0]).toMatchObject({ name: "Glucose", value: "95" });
    });

    it("applies an ADT message to the matched case with zero observations added — no case field to update once matched", async () => {
        const { caseRepo, ingestionRepo } = await setup();
        await caseRepo.writeOne(patientCaseFixture("case-1", { patientId: "MRN-001" }), null, actor(), { organizationId: "org-1", caseId: "case-1", patientId: "MRN-001", ownerUserId: "user-1", assignedUserIds: [], activeConsentScopes: [] });

        const { job } = await ingestInboundMessage(caseRepo, ingestionRepo, SAMPLE_ADT("MRN-001"), actor());
        expect(job).toMatchObject({ messageType: "ADT^A01", matchStatus: "matched", matchedCaseId: "case-1", status: "applied", observationsAdded: 0 });

        const updated = await caseRepo.getOne("case-1");
        expect(updated?.patientCase.labResults.value).toEqual([]);
    });

    it("records a pending-review no-match job, and never touches any case, when no case has that patientId", async () => {
        const { caseRepo, ingestionRepo } = await setup();
        const { job } = await ingestInboundMessage(caseRepo, ingestionRepo, SAMPLE_ORU("MRN-DOES-NOT-EXIST"), actor());
        expect(job).toMatchObject({ matchStatus: "no-match", status: "pending-review" });
        expect(job.matchedCaseId).toBeUndefined();
        expect(await caseRepo.readAll()).toEqual([]);
    });

    it("records a pending-review ambiguous job listing every candidate, and never guesses which case to apply to", async () => {
        const { caseRepo, ingestionRepo } = await setup();
        await caseRepo.writeOne(patientCaseFixture("case-1", { patientId: "MRN-SHARED" }), null, actor(), { organizationId: "org-1", caseId: "case-1", patientId: "MRN-SHARED", ownerUserId: "user-1", assignedUserIds: [], activeConsentScopes: [] });
        await caseRepo.writeOne(patientCaseFixture("case-2", { patientId: "MRN-SHARED" }), null, actor(), { organizationId: "org-1", caseId: "case-2", patientId: "MRN-SHARED", ownerUserId: "user-1", assignedUserIds: [], activeConsentScopes: [] });

        const { job } = await ingestInboundMessage(caseRepo, ingestionRepo, SAMPLE_ORU("MRN-SHARED"), actor());
        expect(job.matchStatus).toBe("ambiguous");
        expect(job.status).toBe("pending-review");
        expect(job.candidateCaseIds?.sort()).toEqual(["case-1", "case-2"]);
        expect((await caseRepo.getOne("case-1"))?.patientCase.labResults.value).toEqual([]);
        expect((await caseRepo.getOne("case-2"))?.patientCase.labResults.value).toEqual([]);
    });

    it("throws Hl7ParseError for an unsupported message type, and creates no job at all", async () => {
        const { caseRepo, ingestionRepo } = await setup();
        const oul = "MSH|^~\\&|LAB|HOSPITAL|EHR|HOSPITAL|20260315120000||OUL^R21|MSG00003|P|2.5.1\rPID|1||MRN-001";
        await expect(ingestInboundMessage(caseRepo, ingestionRepo, oul, actor())).rejects.toThrow(Hl7ParseError);
        expect(await ingestionRepo.listJobs()).toEqual([]);
    });

    it("persists the raw message on the job record even for a no-match, so a reviewer can see what was actually sent", async () => {
        const { caseRepo, ingestionRepo } = await setup();
        const raw = SAMPLE_ORU("MRN-DOES-NOT-EXIST");
        const { job } = await ingestInboundMessage(caseRepo, ingestionRepo, raw, actor());
        expect(job.rawMessage).toBe(raw);
    });
});

describe("resolveIngestionJob", () => {
    it("applies an ambiguous job to a reviewer-chosen candidate case", async () => {
        const { caseRepo, ingestionRepo } = await setup();
        await caseRepo.writeOne(patientCaseFixture("case-1", { patientId: "MRN-SHARED" }), null, actor(), { organizationId: "org-1", caseId: "case-1", patientId: "MRN-SHARED", ownerUserId: "user-1", assignedUserIds: [], activeConsentScopes: [] });
        await caseRepo.writeOne(patientCaseFixture("case-2", { patientId: "MRN-SHARED" }), null, actor(), { organizationId: "org-1", caseId: "case-2", patientId: "MRN-SHARED", ownerUserId: "user-1", assignedUserIds: [], activeConsentScopes: [] });
        const { job } = await ingestInboundMessage(caseRepo, ingestionRepo, SAMPLE_ORU("MRN-SHARED"), actor());

        const resolved = await resolveIngestionJob(caseRepo, ingestionRepo, job.id, { action: "apply", caseId: "case-2" }, "reviewer-1", actor());
        expect(resolved).toMatchObject({ status: "applied", matchedCaseId: "case-2", observationsAdded: 1, reviewedByUserId: "reviewer-1" });
        expect((await caseRepo.getOne("case-2"))?.patientCase.labResults.value).toHaveLength(1);
        expect((await caseRepo.getOne("case-1"))?.patientCase.labResults.value).toEqual([]);
    });

    it("refuses to apply an ambiguous job to a case that wasn't among its own candidates", async () => {
        const { caseRepo, ingestionRepo } = await setup();
        await caseRepo.writeOne(patientCaseFixture("case-1", { patientId: "MRN-SHARED" }), null, actor(), { organizationId: "org-1", caseId: "case-1", patientId: "MRN-SHARED", ownerUserId: "user-1", assignedUserIds: [], activeConsentScopes: [] });
        await caseRepo.writeOne(patientCaseFixture("case-2", { patientId: "MRN-SHARED" }), null, actor(), { organizationId: "org-1", caseId: "case-2", patientId: "MRN-SHARED", ownerUserId: "user-1", assignedUserIds: [], activeConsentScopes: [] });
        await caseRepo.writeOne(patientCaseFixture("case-unrelated"), null, actor(), { organizationId: "org-1", caseId: "case-unrelated", patientId: "MRN-OTHER", ownerUserId: "user-1", assignedUserIds: [], activeConsentScopes: [] });
        const { job } = await ingestInboundMessage(caseRepo, ingestionRepo, SAMPLE_ORU("MRN-SHARED"), actor());

        await expect(resolveIngestionJob(caseRepo, ingestionRepo, job.id, { action: "apply", caseId: "case-unrelated" }, "reviewer-1", actor())).rejects.toThrow(Hl7IngestionResolutionError);
    });

    it("rejects a job with a recorded reason, touching no case data", async () => {
        const { caseRepo, ingestionRepo } = await setup();
        const { job } = await ingestInboundMessage(caseRepo, ingestionRepo, SAMPLE_ORU("MRN-DOES-NOT-EXIST"), actor());
        const resolved = await resolveIngestionJob(caseRepo, ingestionRepo, job.id, { action: "reject", reason: "duplicate delivery" }, "reviewer-1", actor());
        expect(resolved).toMatchObject({ status: "rejected", rejectionReason: "duplicate delivery" });
    });

    it("refuses to resolve a job that isn't pending-review anymore", async () => {
        const { caseRepo, ingestionRepo } = await setup();
        await caseRepo.writeOne(patientCaseFixture("case-1", { patientId: "MRN-001" }), null, actor(), { organizationId: "org-1", caseId: "case-1", patientId: "MRN-001", ownerUserId: "user-1", assignedUserIds: [], activeConsentScopes: [] });
        const { job } = await ingestInboundMessage(caseRepo, ingestionRepo, SAMPLE_ORU("MRN-001"), actor());
        expect(job.status).toBe("applied");
        await expect(resolveIngestionJob(caseRepo, ingestionRepo, job.id, { action: "reject", reason: "too late" }, "reviewer-1", actor())).rejects.toThrow(Hl7IngestionResolutionError);
    });

    it("returns null for a job id that doesn't exist", async () => {
        const { caseRepo, ingestionRepo } = await setup();
        expect(await resolveIngestionJob(caseRepo, ingestionRepo, "does-not-exist", { action: "reject", reason: "x" }, "reviewer-1", actor())).toBeNull();
    });
});
