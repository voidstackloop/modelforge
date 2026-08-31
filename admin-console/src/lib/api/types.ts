// Mirrors server/src/domain/types.ts's zod-inferred shapes as plain TS
// interfaces. packages/contracts has no IAM types (only patient-case/
// migration schemas) — there is nothing to import for this feature, so
// these are kept as a local, hand-maintained mirror instead.

export type Effect = "Allow" | "Deny";

export interface PolicyCondition {
    StringEquals?: Record<string, string | string[]>;
    StringNotEquals?: Record<string, string | string[]>;
}

export interface PolicyStatement {
    sid?: string;
    effect: Effect;
    actions: string[];
    resources: string[];
    condition?: PolicyCondition;
}

export interface PolicyDocument {
    version: "2026-01-01";
    statements: PolicyStatement[];
}

export interface Organization {
    id: string;
    name: string;
    tenantSchema?: string;
    createdAt: string;
}

export interface Policy {
    id: string;
    organizationId: string;
    name: string;
    description?: string;
    document: PolicyDocument;
    builtin: boolean;
    isBreakGlassPolicy: boolean;
    createdAt: string;
    updatedAt: string;
}

export interface Group {
    id: string;
    organizationId: string;
    name: string;
    policyIds: string[];
    createdAt: string;
    updatedAt: string;
}

export type UserStatus = "active" | "suspended";

export interface User {
    id: string;
    organizationId: string;
    externalSubject: string;
    displayName: string;
    email?: string;
    status: UserStatus;
    groupIds: string[];
    policyIds: string[];
    permissionBoundaryPolicyId?: string;
    createdAt: string;
    updatedAt: string;
}

export type InvitationStatus = "pending" | "accepted" | "revoked" | "expired";

export interface Invitation {
    id: string;
    organizationId: string;
    email: string;
    displayName?: string;
    status: InvitationStatus;
    invitedByUserId: string;
    expiresAt: string;
    acceptedAt?: string;
    createdAt: string;
    updatedAt: string;
    // tokenHash intentionally absent — the server strips it before ever
    // sending an Invitation back (routes/invitations.ts's publicInvitation()).
}

export type ServicePrincipalStatus = "active" | "suspended" | "deprovisioned";

export interface ServicePrincipal {
    id: string;
    organizationId: string;
    issuer: string;
    externalSubject: string;
    displayName: string;
    status: ServicePrincipalStatus;
    policyIds: string[];
    permissionBoundaryPolicyId?: string;
    createdAt: string;
    updatedAt: string;
}

export interface AuditEvent {
    id: string;
    organizationId?: string;
    actorUserId?: string;
    actorExternalSubject: string;
    action: string;
    targetType: string;
    targetId: string;
    details?: Record<string, unknown>;
    createdAt: string;
    // Hash-chain fields (P1: immutable audit ingestion). Absent on entries
    // written before the chain existed — see the server's own
    // StoredAuditLogEntry doc comment. Decimal strings, not numbers: the
    // underlying column is BIGINT.
    sequence?: string;
    entryHash?: string;
    prevHash?: string;
}

export interface MembershipSummary {
    organization: Organization;
    user: { id: string; displayName: string; status: string };
    effectivePolicyNames: string[];
}

export interface MeResponse {
    subject: string;
    email?: string;
    name?: string;
    memberships: MembershipSummary[];
}

export interface AuthzCheckResponse {
    effect: Effect;
    matchedStatement?: PolicyStatement;
}

export interface CreateUserRequest {
    externalSubject: string;
    displayName: string;
    email?: string;
    groupIds?: string[];
    policyIds?: string[];
    permissionBoundaryPolicyId?: string;
}

export interface UpdateUserRequest {
    displayName?: string;
    email?: string;
    status?: UserStatus;
    groupIds?: string[];
    policyIds?: string[];
    permissionBoundaryPolicyId?: string;
}

export interface CreateGroupRequest {
    name: string;
    policyIds?: string[];
}

export interface UpdateGroupRequest {
    name?: string;
    policyIds?: string[];
}

export interface CreatePolicyRequest {
    name: string;
    description?: string;
    document: PolicyDocument;
}

export interface UpdatePolicyRequest {
    name?: string;
    description?: string;
    document?: PolicyDocument;
}

export interface CreateInvitationRequest {
    email: string;
    displayName?: string;
    expiresInHours?: number;
}

export interface CreateInvitationResponse {
    invitation: Invitation;
    token: string;
}

export interface CreateServicePrincipalRequest {
    issuer: string;
    externalSubject: string;
    displayName: string;
    policyIds?: string[];
    permissionBoundaryPolicyId?: string;
}

export interface UpdateServicePrincipalRequest {
    displayName?: string;
    status?: ServicePrincipalStatus;
    policyIds?: string[];
    permissionBoundaryPolicyId?: string;
}

// --- Break-glass and access reviews (P1: approvals/access-reviews/break-glass) ---

export type BreakGlassGrantStatus = "active" | "expired" | "reviewed";
export type BreakGlassReviewOutcome = "acknowledged" | "flagged";

export interface BreakGlassGrant {
    id: string;
    organizationId: string;
    userId: string;
    emergencyPolicyId: string;
    justification: string;
    grantedAt: string;
    expiresAt: string;
    status: BreakGlassGrantStatus;
    reviewedByUserId?: string;
    reviewedAt?: string;
    reviewOutcome?: BreakGlassReviewOutcome;
}

export type AccessReviewCampaignStatus = "open" | "completed";

export interface AccessReviewCampaign {
    id: string;
    organizationId: string;
    createdByUserId: string;
    status: AccessReviewCampaignStatus;
    createdAt: string;
    completedAt?: string;
    itemCount: number;
    decidedCount: number;
}

export type AccessReviewDecision = "pending" | "keep" | "revoke";

export interface AccessReviewItem {
    id: string;
    campaignId: string;
    organizationId: string;
    membershipId: string;
    subjectUserId: string;
    decision: AccessReviewDecision;
    decidedByUserId?: string;
    decidedAt?: string;
    createdAt: string;
}

export interface InvokeBreakGlassRequest {
    justification: string;
}

export interface ReviewBreakGlassGrantRequest {
    outcome: BreakGlassReviewOutcome;
}

export interface SetBreakGlassPolicyRequest {
    policyId: string | null;
}

export interface DecideAccessReviewItemRequest {
    decision: Exclude<AccessReviewDecision, "pending">;
}

// --- Policy versioning, dual-control approval, and rollback (P1: signed
// central policy/configuration, minus signing — see server/src/routes/
// policy-versions.ts's header comment) ---

export type PolicyVersionStatus = "pending" | "approved" | "rejected" | "superseded";

export interface PolicyVersion {
    id: string;
    policyId: string;
    organizationId: string;
    version: number;
    document: PolicyDocument;
    // sha256 hex of the document — an integrity/audit aid, NOT a
    // cryptographic signature. No signing-key infrastructure exists here.
    contentHash: string;
    status: PolicyVersionStatus;
    proposedByUserId: string;
    proposedAt: string;
    decidedByUserId?: string;
    decidedAt?: string;
    rejectionReason?: string;
}

export interface ProposePolicyVersionRequest {
    document: PolicyDocument;
}

export interface RejectPolicyVersionRequest {
    reason?: string;
}

export interface RollbackPolicyRequest {
    versionId: string;
}

// --- Immutable audit search, export, and legal hold (P1: immutable audit
// ingestion, search, export, and legal hold) ---

export interface AuditSearchFilters {
    action?: string;
    targetType?: string;
    targetId?: string;
    actorUserId?: string;
    /** ISO 8601, inclusive lower bound on createdAt. */
    since?: string;
    /** ISO 8601, exclusive upper bound on createdAt. */
    until?: string;
    /** Decimal string — see AuditEvent.sequence. Returns entries strictly
     * older than this, i.e. the next page further back in history. */
    cursor?: string;
    limit?: number;
}

export interface ChainVerificationResult {
    valid: boolean;
    checkedCount: number;
    brokenAtSequence?: string;
}

export type AuditLegalHoldStatus = "active" | "released";

export interface AuditLegalHold {
    id: string;
    organizationId: string;
    reason: string;
    status: AuditLegalHoldStatus;
    placedByUserId: string;
    placedAt: string;
    releasedByUserId?: string;
    releasedAt?: string;
    releaseReason?: string;
}

export interface PlaceAuditLegalHoldRequest {
    reason: string;
}

export interface ReleaseAuditLegalHoldRequest {
    releaseReason?: string;
}

// --- Enterprise backup, PITR, and tenant-scoped restore (P1: see
// server/src/store/tenant-backup-store.ts's header comment for what
// "restore" does and does not do — reconciliation/recovery, never a
// point-in-time rollback) ---

export interface TenantBackupArtifact {
    organizationId: string;
    exportedAt: string;
    tables: Record<string, unknown[]>;
}

export type TenantRestoreRequestStatus = "pending" | "approved" | "rejected" | "completed" | "failed";

export interface TenantRestoreRequest {
    id: string;
    organizationId: string;
    status: TenantRestoreRequestStatus;
    summary: Record<string, { willInsert: number; alreadyPresent: number }>;
    requestedByUserId: string;
    requestedAt: string;
    decidedByUserId?: string;
    decidedAt?: string;
    rejectionReason?: string;
    completedAt?: string;
    errorMessage?: string;
}

export interface ProposeRestoreRequest {
    artifact: TenantBackupArtifact;
}

export interface RejectRestoreRequest {
    reason?: string;
}

export interface AiProvider { id: string; name: string; kind: "local" | "on-premises" | "tenant-managed" | "cloud"; killSwitchEngaged: boolean; operationalStatus: string }
export interface AiProviderModel { id: string; providerId: string; modelId: string; modelVersion: string; validationStatus: string; safetyStatus: string }
export interface InferenceCapabilities { chat: boolean; streaming: boolean; tools: boolean; structuredOutput: boolean; embeddings: boolean; tokenCounting: boolean }
export interface AiModelArtifact {
    id: string; providerModelId: string; runtime: "llamacpp" | "vllm"; format: "gguf" | "safetensors"; sourceUri: string; sourceRevision: string;
    fileName?: string; sha256: string; configurationHash: string; licenseId: string; licenseAccepted: boolean; capabilities: InferenceCapabilities;
    chatTemplate?: string; toolCallParser?: string; trustRemoteCode: boolean; status: "pending" | "verified" | "rejected" | "retired"; createdAt: string; updatedAt: string;
}
export interface AiInferenceDeployment {
    id: string; artifactId: string; name: string; endpointUrl: string; servedModelName: string; credentialRef: string; tlsMode: "required" | "private-network";
    poolId: string; maxConcurrency: number; priority: number; operationalStatus: "active" | "degraded" | "disabled"; runtimeVersion?: string; lastVerifiedAt?: string;
}
export type CreateArtifactRequest = Omit<AiModelArtifact, "id" | "providerModelId" | "status" | "createdAt" | "updatedAt">;
export type CreateDeploymentRequest = Omit<AiInferenceDeployment, "id" | "artifactId" | "operationalStatus" | "runtimeVersion" | "lastVerifiedAt">;

// --- Institutional MCP registry (P2: managed MCP allowlist and egress) ---

export type McpTransport = "stdio" | "http";
export type McpDataEgressPolicy = "none" | "metadata-only" | "unrestricted";
export type McpRegistryStatus = "active" | "disabled";

export interface McpRegistryEntry {
    id: string;
    organizationId: string;
    name: string;
    transport: McpTransport;
    endpoint: string;
    allowedTools: "*" | string[];
    dataEgressPolicy: McpDataEgressPolicy;
    status: McpRegistryStatus;
    description?: string;
    createdByUserId: string;
    createdAt: string;
    updatedByUserId?: string;
    updatedAt: string;
}

export interface CreateMcpRegistryEntryRequest {
    name: string;
    transport: McpTransport;
    endpoint: string;
    allowedTools: "*" | string[];
    dataEgressPolicy: McpDataEgressPolicy;
    description?: string;
}

export type UpdateMcpRegistryEntryRequest = Partial<CreateMcpRegistryEntryRequest>;

// --- Enterprise compute control plane (PHI-free fleet metadata) ---
export type ComputeNodeState = "online" | "offline" | "cordoned" | "draining" | "quarantined";
export interface AcceleratorDevice { id: string; vendor: string; model: string; totalVramMB: number; freeVramMB: number; health: "healthy" | "degraded" | "unhealthy" | "quarantined"; utilizationPercent?: number; temperatureC?: number; powerWatts?: number; throttled: boolean }
export interface ComputeNode { id: string; name: string; region: string; state: ComputeNodeState; operatingSystem: string; agentVersion: string; cpuThreads: number; freeCpuThreads: number; totalRamMB: number; freeRamMB: number; devices: AcceleratorDevice[]; warmModelIds: string[]; lastHeartbeatAt: string }
export interface ComputePool { id: string; name: string; region: string; status: "active" | "draining" | "disabled"; schedulingPolicy: string; nodeIds: string[] }
export interface ComputeRequest { id: string; poolId: string; workloadKind: string; priority: string; profile: string; state: "queued" | "assigned" | "running" | "preempting" | "completed" | "failed" | "cancelled"; queuedAt: string }
export interface ComputeLease { id: string; requestId: string; poolId: string; nodeId: string; acceleratorDeviceIds: string[]; cpuThreads: number; ramMB: number; fencingToken: string; state: "offered" | "acknowledged" | "running" | "released" | "expired" | "failed"; expiresAt: string; explanation: { score: number; scoreReasons: string[]; degradedToCpu: boolean; borrowedCapacity: boolean } }
export interface ComputePolicy { id: string; name: string; poolId?: string; version: number; status: "draft" | "active" | "retired"; issuedAt: string; expiresAt: string; hardLimits: Record<string, unknown> }
export interface ComputeSummary { nodes: { total: number; online: number }; capacity: { cpuThreads: number; ramMB: number; accelerators: number }; pools: number; queuedRequests: number; activeLeases: number }
export interface ComputeQuota { poolId: string; reservedCpuThreads: number; reservedRamMB: number; reservedAccelerators: number; burstCpuThreads: number; burstRamMB: number; burstAccelerators: number; weight: number; borrowingEnabled: boolean }
export interface SetComputeQuotaRequest { reservedCpuThreads: number; reservedRamMB: number; reservedAccelerators: number; burstCpuThreads: number; burstRamMB: number; burstAccelerators: number; weight: number; borrowingEnabled: boolean }

export interface ApiErrorBody {
    error: string;
    message?: string;
    issues?: unknown;
}
