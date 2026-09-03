import { randomUUID } from "node:crypto";
import type { ManagedMcpPolicy } from "./managed-mcp-policy";
import * as patientCases from "./patient-cases-store";
import { confirmMcpApproval, createMcpContextGrant, prepareMcpApproval } from "./shared-backend-client";

export interface ClinicalMcpExecutionContext {
    patientCaseId?: string;
    humanApproved?: boolean;
}

const INFRASTRUCTURE_FIELDS = new Set(["contextGrantId", "approvalTicket", "idempotencyKey"]);
const TOOL_FIELDS: Record<string, string[]> = {
    "clinical.medication_conflict_check": ["allergies", "medications"],
    "clinical.response_contract_check": ["assistantResponse"],
    "clinical.response_contract_check_batch": ["items"],
    "clinical.record_review_decision": ["rationale"],
};
const PURPOSE = {
    "clinical.medication_conflict_check": "medication-review",
    "clinical.response_contract_check": "documentation-assist",
    "clinical.response_contract_check_batch": "documentation-assist",
    "clinical.record_review_decision": "documentation-assist",
} as const;

export function modelVisibleClinicalSchema(schema: Record<string, unknown> | undefined, toolName?: string): Record<string, unknown> | undefined {
    if (!schema) return schema;
    const brokerFields = new Set(INFRASTRUCTURE_FIELDS);
    if (toolName === "clinical.medication_conflict_check") {
        brokerFields.add("medications");
        brokerFields.add("allergies");
    }
    const properties = { ...((schema.properties ?? {}) as Record<string, unknown>) };
    for (const field of brokerFields) delete properties[field];
    const required = Array.isArray(schema.required) ? schema.required.filter((field) => typeof field !== "string" || !brokerFields.has(field)) : undefined;
    return { ...schema, properties, ...(required ? { required } : {}) };
}

function stripInfrastructureArgs(args: Record<string, unknown>): Record<string, unknown> {
    const clean = { ...args };
    for (const field of INFRASTRUCTURE_FIELDS) delete clean[field];
    return clean;
}

async function authoritativeArguments(toolName: string, args: Record<string, unknown>, caseId?: string): Promise<Record<string, unknown>> {
    const clean = stripInfrastructureArgs(args);
    if (toolName !== "clinical.medication_conflict_check") return clean;
    if (!caseId) throw new Error("Attach a patient case before running a clinical medication check.");
    const patientCase = await patientCases.getCase(caseId);
    if (!patientCase) throw new Error("The attached patient case is no longer available.");
    if (!patientCase.medications.includeInContext || !patientCase.allergies.includeInContext) {
        throw new Error("Include both medications and allergies in the attached case context before running this check.");
    }
    return { medications: patientCase.medications.value, allergies: patientCase.allergies.value };
}

export async function prepareClinicalMcpArguments(
    policy: ManagedMcpPolicy,
    toolName: string,
    args: Record<string, unknown>,
    context: ClinicalMcpExecutionContext = {}
): Promise<Record<string, unknown>> {
    if (policy.integrationProfile !== "modelforge-clinical") return args;
    if (toolName === "clinical.submit_compute_request") throw new Error("Governed compute submission is not enabled in this clinical-review release.");
    if (toolName === "clinical.record_review_decision" && !context.humanApproved) {
        throw new Error("This controlled clinical write requires explicit approval for this call.");
    }
    const domainArguments = await authoritativeArguments(toolName, args, context.patientCaseId);
    const fields = TOOL_FIELDS[toolName] ?? [];
    let contextGrantId: string | undefined;
    if (fields.length > 0) {
        if (!context.patientCaseId) throw new Error(`Attach a patient case before running "${toolName}".`);
        const purpose = PURPOSE[toolName as keyof typeof PURPOSE] ?? "documentation-assist";
        const grant = await createMcpContextGrant({ registryEntryId: policy.entryId, caseId: context.patientCaseId, purpose, toolNames: [toolName], requestedFields: fields });
        contextGrantId = grant.id;
    }
    const injected: Record<string, unknown> = { ...domainArguments, ...(contextGrantId ? { contextGrantId } : {}) };
    if (toolName === "clinical.record_review_decision") {
        const prepared = await prepareMcpApproval({ registryEntryId: policy.entryId, toolName, arguments: domainArguments, contextGrantId, caseId: context.patientCaseId });
        const confirmed = await confirmMcpApproval(prepared.approvalRequest.id);
        injected.approvalTicket = confirmed.approvalTicket;
        injected.idempotencyKey = randomUUID();
    }
    return injected;
}
