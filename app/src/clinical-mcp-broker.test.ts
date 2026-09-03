import { beforeEach, describe, expect, it, vi } from "vitest";
import { modelVisibleClinicalSchema, prepareClinicalMcpArguments } from "./clinical-mcp-broker";
import * as patientCases from "./patient-cases-store";
import * as backend from "./shared-backend-client";

vi.mock("./patient-cases-store");
vi.mock("./shared-backend-client");

const policy = { entryId: "10000000-0000-4000-8000-000000000001", organizationId: "10000000-0000-4000-8000-000000000002", allowedTools: "*" as const, dataEgressPolicy: "unrestricted" as const, integrationProfile: "modelforge-clinical" as const };

describe("clinical MCP broker", () => {
    beforeEach(() => vi.clearAllMocks());

    it("removes infrastructure-only fields from model-visible tool schemas", () => {
        expect(modelVisibleClinicalSchema({ type: "object", properties: { contextGrantId: {}, approvalTicket: {}, idempotencyKey: {}, rationale: {} }, required: ["contextGrantId", "approvalTicket", "idempotencyKey", "rationale"] })).toEqual({ type: "object", properties: { rationale: {} }, required: ["rationale"] });
    });

    it("hides authoritative medication fields without mutating the wire schema", () => {
        const schema = { type: "object", additionalProperties: false, properties: { medications: {}, allergies: {}, contextGrantId: {} }, required: ["medications", "allergies", "contextGrantId"] };
        expect(modelVisibleClinicalSchema(schema, "clinical.medication_conflict_check")).toEqual({ type: "object", additionalProperties: false, properties: {}, required: [] });
        expect(schema.required).toEqual(["medications", "allergies", "contextGrantId"]);
        expect(Object.keys(schema.properties)).toEqual(["medications", "allergies", "contextGrantId"]);
        expect(modelVisibleClinicalSchema(undefined, "clinical.medication_conflict_check")).toBeUndefined();
    });

    it("does not remove similarly named domain fields from other tools", () => {
        const schema = { properties: { medications: {} }, required: ["medications"] };
        expect(modelVisibleClinicalSchema(schema, "clinical.response_contract_check")).toEqual(schema);
    });

    it("rejects missing or excluded case data before requesting a grant", async () => {
        await expect(prepareClinicalMcpArguments(policy, "clinical.medication_conflict_check", {})).rejects.toThrow(/Attach a patient case/);
        vi.mocked(patientCases.getCase).mockResolvedValue(null);
        await expect(prepareClinicalMcpArguments(policy, "clinical.medication_conflict_check", {}, { patientCaseId: "case-1" })).rejects.toThrow(/no longer available/);
        vi.mocked(patientCases.getCase).mockResolvedValue({ medications: { includeInContext: false, value: [] }, allergies: { includeInContext: true, value: [] } } as never);
        await expect(prepareClinicalMcpArguments(policy, "clinical.medication_conflict_check", {}, { patientCaseId: "case-1" })).rejects.toThrow(/Include both/);
        expect(backend.createMcpContextGrant).not.toHaveBeenCalled();
    });

    it("uses medications and allergies from the attached case and injects only the grant handle", async () => {
        vi.mocked(patientCases.getCase).mockResolvedValue({ medications: { includeInContext: true, value: ["warfarin"] }, allergies: { includeInContext: true, value: ["aspirin"] } } as never);
        vi.mocked(backend.createMcpContextGrant).mockResolvedValue({ id: "grant-1" } as never);
        await expect(prepareClinicalMcpArguments(policy, "clinical.medication_conflict_check", { medications: ["untrusted"] }, { patientCaseId: "case-1" })).resolves.toEqual({ medications: ["warfarin"], allergies: ["aspirin"], contextGrantId: "grant-1" });
        expect(backend.createMcpContextGrant).toHaveBeenCalledWith(expect.objectContaining({ caseId: "case-1", requestedFields: ["allergies", "medications"] }));
    });

    it("requires a human-approved review and injects an operation-bound ticket and idempotency key", async () => {
        vi.mocked(backend.createMcpContextGrant).mockResolvedValue({ id: "grant-2" } as never);
        vi.mocked(backend.prepareMcpApproval).mockResolvedValue({ approvalRequest: { id: "10000000-0000-4000-8000-000000000003" }, challenge: {} } as never);
        vi.mocked(backend.confirmMcpApproval).mockResolvedValue({ approvalRequest: {}, approvalTicket: "ticket-1" } as never);
        const args = { reviewedOperationId: "10000000-0000-4000-8000-000000000004", decision: "approved", rationale: "Checked." };
        await expect(prepareClinicalMcpArguments(policy, "clinical.record_review_decision", args, { patientCaseId: "case-1" })).rejects.toThrow(/explicit approval/);
        expect(backend.createMcpContextGrant).not.toHaveBeenCalled();
        expect(backend.prepareMcpApproval).not.toHaveBeenCalled();
        expect(backend.confirmMcpApproval).not.toHaveBeenCalled();
        const result = await prepareClinicalMcpArguments(policy, "clinical.record_review_decision", args, { patientCaseId: "case-1", humanApproved: true });
        expect(result).toMatchObject({ ...args, contextGrantId: "grant-2", approvalTicket: "ticket-1" });
        expect(result.idempotencyKey).toEqual(expect.any(String));
    });

    it("strips model-provided infrastructure credentials and leaves generic tools unchanged", async () => {
        vi.mocked(backend.createMcpContextGrant).mockResolvedValue({ id: "trusted-grant" } as never);
        const args = { assistantResponse: "draft", contextGrantId: "model-grant", approvalTicket: "model-ticket", idempotencyKey: "model-key" };
        await expect(prepareClinicalMcpArguments(policy, "clinical.response_contract_check", args, { patientCaseId: "case-1" })).resolves.toEqual({ assistantResponse: "draft", contextGrantId: "trusted-grant" });
        await expect(prepareClinicalMcpArguments({ ...policy, integrationProfile: "generic" }, "generic.tool", args)).resolves.toBe(args);
    });
});
