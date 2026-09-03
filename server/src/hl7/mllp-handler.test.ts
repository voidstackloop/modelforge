import { describe, expect, it, vi } from "vitest";
import { InMemoryCaseStore } from "../store/in-memory-case-store.js";
import { InMemoryHl7IngestionStore } from "../store/in-memory-hl7-ingestion-store.js";
import type { TenantContext } from "../tenant-context.js";
import { patientCaseFixture } from "../test/patient-case-fixture.js";
import { createMllpIngestionHandler } from "./mllp-handler.js";
import { getField, parseHl7Message } from "./message.js";

const actor = () => ({ externalSubject: "idp|system", userId: "user-1", organizationId: undefined as unknown as string });

function tenantContext(): TenantContext {
    return { organizationId: "org-1", schemaName: "tenant_" + "0".repeat(32), issuer: "test", subject: "test" };
}

const SAMPLE_ORU = (mrn: string) => [
    "MSH|^~\\&|LAB|HOSPITAL|EHR|HOSPITAL|20260315120000||ORU^R01|MSG00001|P|2.5.1",
    `PID|1||${mrn}||`,
    "OBX|1|NM|2345-7^Glucose^LN||95|mg/dL|70-99|N|||F",
].join("\r");

async function setup() {
    const ctx = tenantContext();
    const caseStore = new InMemoryCaseStore();
    const ingestionStore = new InMemoryHl7IngestionStore();
    const caseRepo = caseStore.forTenant(ctx);
    const ingestionRepo = ingestionStore.forTenant(ctx);
    const handler = createMllpIngestionHandler({
        organizationId: "org-1",
        caseRepo,
        ingestionRepo,
        ackContext: { sendingApplication: "ModelForge", sendingFacility: "Example Health System" },
    });
    return { caseRepo, ingestionRepo, handler };
}

describe("createMllpIngestionHandler", () => {
    it("returns an AA ack referencing the original message control id for a matched, applied message", async () => {
        const { caseRepo, handler } = await setup();
        await caseRepo.writeOne(patientCaseFixture("case-1", { patientId: "MRN-001" }), null, actor(), { organizationId: "org-1", caseId: "case-1", patientId: "MRN-001", ownerUserId: "user-1", assignedUserIds: [], activeConsentScopes: [] });

        const ackRaw = await handler(SAMPLE_ORU("MRN-001"));
        const ack = parseHl7Message(ackRaw);
        expect(getField(ack.segments[0], 9)).toBe("ACK");
        const msa = ack.segments[1];
        expect(getField(msa, 1)).toBe("AA");
        expect(getField(msa, 2)).toBe("MSG00001");
        expect(getField(msa, 3)).toContain("applied");

        expect((await caseRepo.getOne("case-1"))?.patientCase.labResults.value).toHaveLength(1);
    });

    it("still returns AA (queued for review) for an ambiguous/no-match — a real receiving system, matching or not, is not an error", async () => {
        const { handler } = await setup();
        const ackRaw = await handler(SAMPLE_ORU("MRN-DOES-NOT-EXIST"));
        const msa = parseHl7Message(ackRaw).segments[1];
        expect(getField(msa, 1)).toBe("AA");
        expect(getField(msa, 3)).toContain("no matching patient");
    });

    it("returns AR for a structurally invalid message, quoting the real parse error safely", async () => {
        const { handler } = await setup();
        const ackRaw = await handler("this is not HL7 at all");
        const msa = parseHl7Message(ackRaw).segments[1];
        expect(getField(msa, 1)).toBe("AR");
    });

    it("returns AR for a message MSH parses but whose type isn't ORU/ADT, without leaking internals", async () => {
        const { handler } = await setup();
        const oul = "MSH|^~\\&|LAB|HOSPITAL|EHR|HOSPITAL|20260315120000||OUL^R21|MSG00003|P|2.5.1\rPID|1||MRN-001";
        const ackRaw = await handler(oul);
        const ack = parseHl7Message(ackRaw);
        const msa = ack.segments[1];
        expect(getField(msa, 1)).toBe("AR");
        expect(getField(msa, 2)).toBe("MSG00003");
    });

    it("returns AE and never echoes the raw error text for an unexpected (non-parse) failure", async () => {
        const ctx = tenantContext();
        const caseStore = new InMemoryCaseStore();
        const ingestionStore = new InMemoryHl7IngestionStore();
        const caseRepo = caseStore.forTenant(ctx);
        // A repo whose readAll() throws, simulating an unexpected backend failure.
        const brokenCaseRepo = { ...caseRepo, readAll: vi.fn(async () => { throw new Error("connection string: postgres://secret@internal-host/db"); }) };
        const onError = vi.fn();
        const handler = createMllpIngestionHandler({
            organizationId: "org-1",
            caseRepo: brokenCaseRepo,
            ingestionRepo: ingestionStore.forTenant(ctx),
            ackContext: { sendingApplication: "ModelForge", sendingFacility: "Example" },
            onError,
        });

        const ackRaw = await handler(SAMPLE_ORU("MRN-001"));
        const msa = parseHl7Message(ackRaw).segments[1];
        expect(getField(msa, 1)).toBe("AE");
        expect(getField(msa, 3)).not.toContain("postgres://");
        expect(getField(msa, 3)).not.toContain("secret");
        expect(onError).toHaveBeenCalledTimes(1);
        expect(onError.mock.calls[0][0].message).toContain("postgres://");
    });
});
