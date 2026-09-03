import { describe, expect, it } from "vitest";
import { InMemoryAuditStore } from "./audit-store.js";
import { InMemoryMcpClinicalStore } from "./mcp-clinical-store.js";

const ORG = "10000000-0000-4000-8000-000000000001";
const actor = { userId: "10000000-0000-4000-8000-000000000002", externalSubject: "clinician-1", organizationId: ORG };

describe("InMemoryMcpClinicalStore", () => {
    it("issues introspectable grants and binds approval confirmation to the original subject/client", async () => {
        const audit = new InMemoryAuditStore();
        const store = new InMemoryMcpClinicalStore(audit);
        const grant = await store.createGrant({ organizationId: ORG, subjectId: "clinician-1", clientId: "desktop-1", caseId: "case-1", allowedTools: ["clinical.medication_conflict_check"], allowedFields: ["medications", "allergies"], purpose: "medication-review", destination: "managed_model_forge", expiresAtEpochSeconds: Math.floor(Date.now() / 1000) + 60 }, actor);
        expect(await store.introspectGrant(grant.id)).toEqual(grant);
        expect(grant.id.startsWith(`${ORG}.`)).toBe(true);

        const approval = await store.createApprovalRequest({ organizationId: ORG, registryEntryId: "10000000-0000-4000-8000-000000000003", subjectId: "clinician-1", clientId: "desktop-1", toolName: "clinical.record_review_decision", operationDigest: `sha256:${"b".repeat(64)}`, caseId: "case-1", expiresAt: new Date(Date.now() + 60_000).toISOString() }, actor);
        expect(await store.confirmApprovalRequest(ORG, approval.id, "other", "desktop-1", actor)).toBeNull();
        expect((await store.confirmApprovalRequest(ORG, approval.id, "clinician-1", "desktop-1", actor))?.status).toBe("confirmed");
        expect((await audit.listByOrganization(ORG)).map((entry) => entry.action)).toEqual(expect.arrayContaining(["mcpClinical.grantCreate", "mcpClinical.approvalPrepare", "mcpClinical.approvalConfirm"]));
    });

    it("makes review recording idempotent by reviewed operation", async () => {
        const store = new InMemoryMcpClinicalStore();
        const input = { organizationId: ORG, caseId: "case-1", reviewerSubjectId: "clinician-1", reviewedOperationId: "10000000-0000-4000-8000-000000000004", decision: "approved" as const, rationale: "Reviewed against source record." };
        expect(await store.recordReview(input, actor)).toEqual(await store.recordReview(input, actor));
    });
});
