import { z } from "zod";

const identifier = z.string().min(1).max(512);
const timestamp = z.string().datetime({ offset: true });

export const mcpDestinationClassSchema = z.enum(["local_model_forge", "managed_model_forge", "approved_third_party"]);
export type McpDestinationClass = z.infer<typeof mcpDestinationClassSchema>;
export const mcpRiskClassSchema = z.enum(["read_only", "controlled_write", "prohibited"]);
export const mcpEgressClassSchema = z.enum(["none", "local_only", "approved_remote"]);

export const mcpCatalogEntrySchema = z.object({
    name: identifier,
    description: z.string().min(1).max(4_000),
    risk: mcpRiskClassSchema,
    egress: mcpEgressClassSchema,
    phiFields: z.array(z.string().min(1).max(100)).max(100),
    idempotencyRequired: z.boolean(),
}).strict();
export type McpCatalogEntry = z.infer<typeof mcpCatalogEntrySchema>;

export const mcpPolicySnapshotSchema = z.object({
    registryVersion: identifier,
    rbacVersion: identifier,
    egressPolicyVersion: identifier,
    killSwitchVersion: identifier,
    toolPolicyVersion: identifier,
}).strict();
export type McpPolicySnapshot = z.infer<typeof mcpPolicySnapshotSchema>;

export const mcpOperationResponseSchema = z.object({
    operationId: z.string().uuid(),
    operationDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    policySnapshot: mcpPolicySnapshotSchema,
    result: z.unknown(),
}).strict();
export type McpOperationResponse = z.infer<typeof mcpOperationResponseSchema>;

export const mcpContextGrantSchema = z.object({
    id: identifier,
    subjectId: identifier,
    clientId: identifier,
    organizationId: z.string().uuid(),
    caseId: identifier,
    allowedTools: z.array(identifier).min(1).max(100),
    allowedFields: z.array(z.string().min(1).max(100)).min(1).max(100),
    purpose: z.string().min(1).max(100),
    destination: mcpDestinationClassSchema,
    expiresAtEpochSeconds: z.number().int().positive(),
    version: z.number().int().positive(),
}).strict();
export type McpContextGrant = z.infer<typeof mcpContextGrantSchema>;

export const mcpApprovalChallengeSchema = z.object({
    challengeId: identifier,
    operationDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    policySnapshot: mcpPolicySnapshotSchema,
    expiresAtEpochSeconds: z.number().int().positive(),
}).strict();
export type McpApprovalChallenge = z.infer<typeof mcpApprovalChallengeSchema>;

export const mcpApprovalRequestSchema = z.object({
    id: z.string().uuid(),
    organizationId: z.string().uuid(),
    registryEntryId: z.string().uuid(),
    subjectId: identifier,
    clientId: identifier,
    toolName: identifier,
    operationDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    caseId: identifier.optional(),
    status: z.enum(["pending", "confirmed", "expired"]),
    expiresAt: timestamp,
    createdAt: timestamp,
    confirmedAt: timestamp.optional(),
}).strict();
export type McpApprovalRequest = z.infer<typeof mcpApprovalRequestSchema>;

export const mcpOperationProvenanceSchema = z.object({
    registryEntryId: z.string().uuid(),
    serverName: z.string().min(1).max(500),
    toolName: identifier,
    operationId: z.string().uuid(),
    operationDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    policySnapshot: mcpPolicySnapshotSchema,
    reviewId: z.string().uuid().optional(),
    reviewDecision: z.enum(["approved", "rejected", "needs_revision"]).optional(),
}).strict();
export type McpOperationProvenance = z.infer<typeof mcpOperationProvenanceSchema>;
