import { randomUUID } from "node:crypto";
import type { McpApprovalRequest, McpContextGrant } from "@modelforge/contracts";
import type { Pool, PoolClient } from "pg";
import { type AuditActor, type AuditStore, InMemoryAuditStore, insertAuditEntry } from "./audit-store.js";

export interface CreateMcpContextGrantInput {
    organizationId: string;
    subjectId: string;
    clientId: string;
    caseId: string;
    allowedTools: string[];
    allowedFields: string[];
    purpose: string;
    destination: McpContextGrant["destination"];
    expiresAtEpochSeconds: number;
}

export interface CreateMcpApprovalRequestInput {
    organizationId: string;
    registryEntryId: string;
    subjectId: string;
    clientId: string;
    toolName: string;
    operationDigest: string;
    caseId?: string;
    expiresAt: string;
}

export interface RecordMcpReviewInput {
    organizationId: string;
    caseId: string;
    reviewerSubjectId: string;
    reviewedOperationId: string;
    decision: "approved" | "rejected" | "needs_revision";
    rationale: string;
}

export interface McpReviewResult { reviewId: string; decision: RecordMcpReviewInput["decision"] }

export interface McpClinicalStore {
    createGrant(input: CreateMcpContextGrantInput, actor: AuditActor): Promise<McpContextGrant>;
    introspectGrant(grantId: string): Promise<McpContextGrant | null>;
    createApprovalRequest(input: CreateMcpApprovalRequestInput, actor: AuditActor): Promise<McpApprovalRequest>;
    getApprovalRequest(organizationId: string, id: string): Promise<McpApprovalRequest | null>;
    confirmApprovalRequest(organizationId: string, id: string, subjectId: string, clientId: string, actor: AuditActor): Promise<McpApprovalRequest | null>;
    recordReview(input: RecordMcpReviewInput, actor: AuditActor): Promise<McpReviewResult>;
}

function currentStatus(value: McpApprovalRequest): McpApprovalRequest {
    return value.status === "pending" && value.expiresAt <= new Date().toISOString() ? { ...value, status: "expired" } : value;
}

export class InMemoryMcpClinicalStore implements McpClinicalStore {
    private readonly grants = new Map<string, McpContextGrant>();
    private readonly approvals = new Map<string, McpApprovalRequest>();
    private readonly reviewKeys = new Map<string, McpReviewResult>();

    constructor(private readonly audit: AuditStore = new InMemoryAuditStore()) {}

    async createGrant(input: CreateMcpContextGrantInput, actor: AuditActor): Promise<McpContextGrant> {
        const grant: McpContextGrant = {
            id: `${input.organizationId}.${randomUUID()}`,
            subjectId: input.subjectId,
            clientId: input.clientId,
            organizationId: input.organizationId,
            caseId: input.caseId,
            allowedTools: [...new Set(input.allowedTools)].sort(),
            allowedFields: [...new Set(input.allowedFields)].sort(),
            purpose: input.purpose,
            destination: input.destination,
            expiresAtEpochSeconds: input.expiresAtEpochSeconds,
            version: 1,
        };
        this.grants.set(grant.id, grant);
        await this.audit.record({ organizationId: input.organizationId, actorUserId: actor.userId, actorExternalSubject: actor.externalSubject, action: "mcpClinical.grantCreate", targetType: "mcpContextGrant", targetId: grant.id, details: { toolCount: grant.allowedTools.length, fieldCount: grant.allowedFields.length, purpose: grant.purpose, destination: grant.destination } });
        return grant;
    }

    async introspectGrant(grantId: string): Promise<McpContextGrant | null> {
        const grant = this.grants.get(grantId);
        return grant && grant.expiresAtEpochSeconds > Math.floor(Date.now() / 1000) ? grant : null;
    }

    async createApprovalRequest(input: CreateMcpApprovalRequestInput, actor: AuditActor): Promise<McpApprovalRequest> {
        const createdAt = new Date().toISOString();
        const approval: McpApprovalRequest = { id: randomUUID(), status: "pending", createdAt, ...input };
        this.approvals.set(approval.id, approval);
        await this.audit.record({ organizationId: input.organizationId, actorUserId: actor.userId, actorExternalSubject: actor.externalSubject, action: "mcpClinical.approvalPrepare", targetType: "mcpApprovalRequest", targetId: approval.id, details: { registryEntryId: input.registryEntryId, toolName: input.toolName } });
        return approval;
    }

    async getApprovalRequest(organizationId: string, id: string): Promise<McpApprovalRequest | null> {
        const value = this.approvals.get(id);
        return value?.organizationId === organizationId ? currentStatus(value) : null;
    }

    async confirmApprovalRequest(organizationId: string, id: string, subjectId: string, clientId: string, actor: AuditActor): Promise<McpApprovalRequest | null> {
        const current = await this.getApprovalRequest(organizationId, id);
        if (!current || current.status !== "pending" || current.subjectId !== subjectId || current.clientId !== clientId) return null;
        const confirmed = { ...current, status: "confirmed" as const, confirmedAt: new Date().toISOString() };
        this.approvals.set(id, confirmed);
        await this.audit.record({ organizationId, actorUserId: actor.userId, actorExternalSubject: actor.externalSubject, action: "mcpClinical.approvalConfirm", targetType: "mcpApprovalRequest", targetId: id, details: { registryEntryId: current.registryEntryId, toolName: current.toolName } });
        return confirmed;
    }

    async recordReview(input: RecordMcpReviewInput, actor: AuditActor): Promise<McpReviewResult> {
        const key = `${input.organizationId}:${input.reviewedOperationId}`;
        const existing = this.reviewKeys.get(key);
        if (existing) return existing;
        const result = { reviewId: randomUUID(), decision: input.decision };
        this.reviewKeys.set(key, result);
        await this.audit.record({ organizationId: input.organizationId, actorUserId: actor.userId, actorExternalSubject: actor.externalSubject, action: "mcpClinical.reviewRecord", targetType: "mcpOperation", targetId: input.reviewedOperationId, details: { reviewId: result.reviewId, decision: input.decision } });
        return result;
    }
}

interface GrantRow { id: string; organization_id: string; subject_id: string; client_id: string; case_id: string; allowed_tools: string[]; allowed_fields: string[]; purpose: string; destination: McpContextGrant["destination"]; expires_at: Date; version: string }
interface ApprovalRow { id: string; organization_id: string; registry_entry_id: string; subject_id: string; client_id: string; tool_name: string; operation_digest: string; case_id: string | null; status: "pending" | "confirmed"; expires_at: Date; created_at: Date; confirmed_at: Date | null }

function mapGrant(row: GrantRow): McpContextGrant {
    return { id: row.id, subjectId: row.subject_id, clientId: row.client_id, organizationId: row.organization_id, caseId: row.case_id, allowedTools: row.allowed_tools, allowedFields: row.allowed_fields, purpose: row.purpose, destination: row.destination, expiresAtEpochSeconds: Math.floor(row.expires_at.getTime() / 1000), version: Number(row.version) };
}

function mapApproval(row: ApprovalRow): McpApprovalRequest {
    return currentStatus({ id: row.id, organizationId: row.organization_id, registryEntryId: row.registry_entry_id, subjectId: row.subject_id, clientId: row.client_id, toolName: row.tool_name, operationDigest: row.operation_digest, caseId: row.case_id ?? undefined, status: row.status, expiresAt: row.expires_at.toISOString(), createdAt: row.created_at.toISOString(), confirmedAt: row.confirmed_at?.toISOString() });
}

function organizationFromGrantId(grantId: string): string | null {
    const candidate = grantId.slice(0, 36);
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(candidate) && grantId[36] === "." ? candidate : null;
}

export class PostgresMcpClinicalStore implements McpClinicalStore {
    constructor(private readonly pool: Pool) {}

    private async tenantTx<T>(organizationId: string, work: (client: PoolClient) => Promise<T>): Promise<T> {
        const client = await this.pool.connect();
        try {
            await client.query("BEGIN");
            await client.query("SELECT set_config('app.tenant_id', $1, true)", [organizationId]);
            const value = await work(client);
            await client.query("COMMIT");
            return value;
        } catch (error) {
            await client.query("ROLLBACK");
            throw error;
        } finally { client.release(); }
    }

    async createGrant(input: CreateMcpContextGrantInput, actor: AuditActor): Promise<McpContextGrant> {
        return this.tenantTx(input.organizationId, async (client) => {
            const id = `${input.organizationId}.${randomUUID()}`;
            const result = await client.query<GrantRow>(`INSERT INTO mcp_context_grants (id, organization_id, subject_id, client_id, case_id, allowed_tools, allowed_fields, purpose, destination, expires_at, version) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,to_timestamp($10),1) RETURNING *`, [id, input.organizationId, input.subjectId, input.clientId, input.caseId, [...new Set(input.allowedTools)].sort(), [...new Set(input.allowedFields)].sort(), input.purpose, input.destination, input.expiresAtEpochSeconds]);
            await insertAuditEntry(client, { organizationId: input.organizationId, actorUserId: actor.userId, actorExternalSubject: actor.externalSubject, action: "mcpClinical.grantCreate", targetType: "mcpContextGrant", targetId: id, details: { toolCount: input.allowedTools.length, fieldCount: input.allowedFields.length, purpose: input.purpose, destination: input.destination } });
            return mapGrant(result.rows[0]);
        });
    }

    async introspectGrant(grantId: string): Promise<McpContextGrant | null> {
        const organizationId = organizationFromGrantId(grantId);
        if (!organizationId) return null;
        return this.tenantTx(organizationId, async (client) => {
            const result = await client.query<GrantRow>("SELECT * FROM mcp_context_grants WHERE organization_id=$1 AND id=$2 AND revoked_at IS NULL AND expires_at > now()", [organizationId, grantId]);
            return result.rows[0] ? mapGrant(result.rows[0]) : null;
        });
    }

    async createApprovalRequest(input: CreateMcpApprovalRequestInput, actor: AuditActor): Promise<McpApprovalRequest> {
        return this.tenantTx(input.organizationId, async (client) => {
            const id = randomUUID();
            const result = await client.query<ApprovalRow>(`INSERT INTO mcp_approval_requests (id,organization_id,registry_entry_id,subject_id,client_id,tool_name,operation_digest,case_id,status,expires_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'pending',$9) RETURNING *`, [id, input.organizationId, input.registryEntryId, input.subjectId, input.clientId, input.toolName, input.operationDigest, input.caseId ?? null, input.expiresAt]);
            await insertAuditEntry(client, { organizationId: input.organizationId, actorUserId: actor.userId, actorExternalSubject: actor.externalSubject, action: "mcpClinical.approvalPrepare", targetType: "mcpApprovalRequest", targetId: id, details: { registryEntryId: input.registryEntryId, toolName: input.toolName } });
            return mapApproval(result.rows[0]);
        });
    }

    async getApprovalRequest(organizationId: string, id: string): Promise<McpApprovalRequest | null> {
        return this.tenantTx(organizationId, async (client) => {
            const result = await client.query<ApprovalRow>("SELECT * FROM mcp_approval_requests WHERE organization_id=$1 AND id=$2", [organizationId, id]);
            return result.rows[0] ? mapApproval(result.rows[0]) : null;
        });
    }

    async confirmApprovalRequest(organizationId: string, id: string, subjectId: string, clientId: string, actor: AuditActor): Promise<McpApprovalRequest | null> {
        return this.tenantTx(organizationId, async (client) => {
            const result = await client.query<ApprovalRow>(`UPDATE mcp_approval_requests SET status='confirmed', confirmed_at=now() WHERE organization_id=$1 AND id=$2 AND subject_id=$3 AND client_id=$4 AND status='pending' AND expires_at > now() RETURNING *`, [organizationId, id, subjectId, clientId]);
            if (!result.rows[0]) return null;
            await insertAuditEntry(client, { organizationId, actorUserId: actor.userId, actorExternalSubject: actor.externalSubject, action: "mcpClinical.approvalConfirm", targetType: "mcpApprovalRequest", targetId: id, details: { registryEntryId: result.rows[0].registry_entry_id, toolName: result.rows[0].tool_name } });
            return mapApproval(result.rows[0]);
        });
    }

    async recordReview(input: RecordMcpReviewInput, actor: AuditActor): Promise<McpReviewResult> {
        return this.tenantTx(input.organizationId, async (client) => {
            const reviewId = randomUUID();
            const result = await client.query<{ id: string; decision: RecordMcpReviewInput["decision"] }>(`INSERT INTO mcp_operation_reviews (id,organization_id,case_id,reviewer_subject_id,reviewed_operation_id,decision,rationale) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (organization_id, reviewed_operation_id) DO UPDATE SET reviewed_operation_id=EXCLUDED.reviewed_operation_id RETURNING id,decision`, [reviewId, input.organizationId, input.caseId, input.reviewerSubjectId, input.reviewedOperationId, input.decision, input.rationale]);
            await insertAuditEntry(client, { organizationId: input.organizationId, actorUserId: actor.userId, actorExternalSubject: actor.externalSubject, action: "mcpClinical.reviewRecord", targetType: "mcpOperation", targetId: input.reviewedOperationId, details: { reviewId: result.rows[0].id, decision: result.rows[0].decision } });
            return { reviewId: result.rows[0].id, decision: result.rows[0].decision };
        });
    }
}
