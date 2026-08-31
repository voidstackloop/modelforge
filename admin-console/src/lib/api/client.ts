import { userManager } from "../auth/oidc-config";
import type * as T from "./types";

export class ApiError extends Error {
    readonly status: number;
    readonly body: T.ApiErrorBody | undefined;

    constructor(status: number, body: T.ApiErrorBody | undefined, message: string) {
        super(message);
        this.name = "ApiError";
        this.status = status;
        this.body = body;
    }
}

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL;

// A dead token (401) means the only correct response is a forced full
// re-login — distinct from a 403 (authorization_error), a normal in-app
// denial that never triggers this. client.ts has no router access, so a
// direct hash write is the escape hatch; RequireAuth (require-auth.tsx)
// picks up the cleared user on the very next render.
async function onUnauthorized(): Promise<void> {
    await userManager.removeUser();
    window.location.hash = "#/login";
}

async function safeJson(response: Response): Promise<T.ApiErrorBody | undefined> {
    try {
        return (await response.json()) as T.ApiErrorBody;
    } catch {
        return undefined;
    }
}

async function authorizedRequest(path: string, init?: RequestInit): Promise<Response> {
    const user = await userManager.getUser();
    if (!user || user.expired) {
        await onUnauthorized();
        throw new ApiError(401, undefined, "Your session has expired — please sign in again.");
    }
    let response: Response;
    try {
        response = await fetch(`${API_BASE_URL}${path}`, {
            ...init,
            headers: { ...(init?.headers ?? {}), Authorization: `Bearer ${user.access_token}`, "Content-Type": "application/json" },
        });
    } catch (err) {
        throw new ApiError(0, undefined, `Could not reach the admin API: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (response.status === 401) {
        await onUnauthorized();
        throw new ApiError(401, await safeJson(response), "Your session has expired — please sign in again.");
    }
    return response;
}

async function parseOrThrow<R>(response: Response): Promise<R> {
    if (!response.ok) {
        const body = await safeJson(response);
        throw new ApiError(response.status, body, body?.message ?? `Request failed: HTTP ${response.status}`);
    }
    if (response.status === 204) return undefined as R;
    return (await response.json()) as R;
}

export const getMe = (): Promise<T.MeResponse> => authorizedRequest("/me").then((r) => parseOrThrow<T.MeResponse>(r));

export const createOrganization = (name: string): Promise<{ organization: T.Organization; user: T.User }> =>
    authorizedRequest("/organizations", { method: "POST", body: JSON.stringify({ name }) }).then((r) =>
        parseOrThrow<{ organization: T.Organization; user: T.User }>(r)
    );

export const getOrganization = (orgId: string): Promise<T.Organization> =>
    authorizedRequest(`/organizations/${orgId}`).then((r) => parseOrThrow<T.Organization>(r));

export const listUsers = (orgId: string): Promise<T.User[]> =>
    authorizedRequest(`/organizations/${orgId}/users`).then((r) => parseOrThrow<T.User[]>(r));

export const createUser = (orgId: string, body: T.CreateUserRequest): Promise<T.User> =>
    authorizedRequest(`/organizations/${orgId}/users`, { method: "POST", body: JSON.stringify(body) }).then((r) => parseOrThrow<T.User>(r));

export const updateUser = (orgId: string, userId: string, body: T.UpdateUserRequest): Promise<T.User> =>
    authorizedRequest(`/organizations/${orgId}/users/${userId}`, { method: "PATCH", body: JSON.stringify(body) }).then((r) =>
        parseOrThrow<T.User>(r)
    );

export const listGroups = (orgId: string): Promise<T.Group[]> =>
    authorizedRequest(`/organizations/${orgId}/groups`).then((r) => parseOrThrow<T.Group[]>(r));

export const createGroup = (orgId: string, body: T.CreateGroupRequest): Promise<T.Group> =>
    authorizedRequest(`/organizations/${orgId}/groups`, { method: "POST", body: JSON.stringify(body) }).then((r) => parseOrThrow<T.Group>(r));

export const updateGroup = (orgId: string, groupId: string, body: T.UpdateGroupRequest): Promise<T.Group> =>
    authorizedRequest(`/organizations/${orgId}/groups/${groupId}`, { method: "PATCH", body: JSON.stringify(body) }).then((r) =>
        parseOrThrow<T.Group>(r)
    );

export const listPolicies = (orgId: string): Promise<T.Policy[]> =>
    authorizedRequest(`/organizations/${orgId}/policies`).then((r) => parseOrThrow<T.Policy[]>(r));

export const createPolicy = (orgId: string, body: T.CreatePolicyRequest): Promise<T.Policy> =>
    authorizedRequest(`/organizations/${orgId}/policies`, { method: "POST", body: JSON.stringify(body) }).then((r) => parseOrThrow<T.Policy>(r));

export const updatePolicy = (orgId: string, policyId: string, body: T.UpdatePolicyRequest): Promise<T.Policy> =>
    authorizedRequest(`/organizations/${orgId}/policies/${policyId}`, { method: "PATCH", body: JSON.stringify(body) }).then((r) =>
        parseOrThrow<T.Policy>(r)
    );

export const deletePolicy = (orgId: string, policyId: string): Promise<void> =>
    authorizedRequest(`/organizations/${orgId}/policies/${policyId}`, { method: "DELETE" }).then((r) => parseOrThrow<void>(r));

export const listInvitations = (orgId: string): Promise<T.Invitation[]> =>
    authorizedRequest(`/organizations/${orgId}/invitations`).then((r) => parseOrThrow<T.Invitation[]>(r));

export const createInvitation = (orgId: string, body: T.CreateInvitationRequest): Promise<T.CreateInvitationResponse> =>
    authorizedRequest(`/organizations/${orgId}/invitations`, { method: "POST", body: JSON.stringify(body) }).then((r) =>
        parseOrThrow<T.CreateInvitationResponse>(r)
    );

export const revokeInvitation = (orgId: string, invitationId: string): Promise<void> =>
    authorizedRequest(`/organizations/${orgId}/invitations/${invitationId}`, { method: "DELETE" }).then((r) => parseOrThrow<void>(r));

export const listServicePrincipals = (orgId: string): Promise<T.ServicePrincipal[]> =>
    authorizedRequest(`/organizations/${orgId}/service-principals`).then((r) => parseOrThrow<T.ServicePrincipal[]>(r));

export const createServicePrincipal = (orgId: string, body: T.CreateServicePrincipalRequest): Promise<T.ServicePrincipal> =>
    authorizedRequest(`/organizations/${orgId}/service-principals`, { method: "POST", body: JSON.stringify(body) }).then((r) =>
        parseOrThrow<T.ServicePrincipal>(r)
    );

export const updateServicePrincipal = (orgId: string, id: string, body: T.UpdateServicePrincipalRequest): Promise<T.ServicePrincipal> =>
    authorizedRequest(`/organizations/${orgId}/service-principals/${id}`, { method: "PATCH", body: JSON.stringify(body) }).then((r) =>
        parseOrThrow<T.ServicePrincipal>(r)
    );

/** Serializes AuditSearchFilters into a query string, skipping empty
 * values so an untouched filter never narrows the result — the server
 * treats an absent param and an empty one differently only by accident,
 * and this keeps the "no filters means full history" contract exact. */
function auditFilterQuery(filters: T.AuditSearchFilters = {}): string {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(filters)) {
        if (value !== undefined && value !== "") params.set(key, String(value));
    }
    const query = params.toString();
    return query ? `?${query}` : "";
}

export const listAudit = (orgId: string, filters?: T.AuditSearchFilters): Promise<T.AuditEvent[]> =>
    authorizedRequest(`/organizations/${orgId}/audit${auditFilterQuery(filters)}`).then((r) => parseOrThrow<T.AuditEvent[]>(r));

/** Returns the CSV as a Blob rather than a URL: the export route needs the
 * bearer token, which a plain `<a href>` download can't attach. The caller
 * turns this into a download via URL.createObjectURL — see Audit.tsx. */
export const exportAudit = async (orgId: string, filters?: T.AuditSearchFilters): Promise<Blob> => {
    const response = await authorizedRequest(`/organizations/${orgId}/audit/export${auditFilterQuery(filters)}`);
    if (!response.ok) {
        const body = await response.json().catch(() => undefined);
        throw new ApiError(response.status, body as T.ApiErrorBody | undefined, `Export failed: HTTP ${response.status}`);
    }
    return response.blob();
};

export const verifyAuditChain = (orgId: string): Promise<T.ChainVerificationResult> =>
    authorizedRequest(`/organizations/${orgId}/audit/verify-chain`).then((r) => parseOrThrow<T.ChainVerificationResult>(r));

export const listAuditLegalHolds = (orgId: string): Promise<T.AuditLegalHold[]> =>
    authorizedRequest(`/organizations/${orgId}/audit/legal-holds`).then((r) => parseOrThrow<T.AuditLegalHold[]>(r));

export const placeAuditLegalHold = (orgId: string, body: T.PlaceAuditLegalHoldRequest): Promise<T.AuditLegalHold> =>
    authorizedRequest(`/organizations/${orgId}/audit/legal-holds`, { method: "POST", body: JSON.stringify(body) }).then((r) =>
        parseOrThrow<T.AuditLegalHold>(r)
    );

export const releaseAuditLegalHold = (orgId: string, holdId: string, body: T.ReleaseAuditLegalHoldRequest): Promise<T.AuditLegalHold> =>
    authorizedRequest(`/organizations/${orgId}/audit/legal-holds/${holdId}/release`, { method: "POST", body: JSON.stringify(body) }).then((r) =>
        parseOrThrow<T.AuditLegalHold>(r)
    );

/** Returns the backup artifact as a Blob rather than parsed JSON — the
 * caller (Backup.tsx) triggers a browser download from it, same pattern as
 * exportAudit. The artifact is also valid JSON the caller can re-upload
 * later via proposeRestore, so returning the raw Blob (not re-serializing
 * parsed JSON) guarantees byte-identical round-tripping. */
export const exportTenantBackup = async (orgId: string): Promise<Blob> => {
    const response = await authorizedRequest(`/organizations/${orgId}/backup/export`);
    if (!response.ok) {
        const body = await response.json().catch(() => undefined);
        throw new ApiError(response.status, body as T.ApiErrorBody | undefined, `Export failed: HTTP ${response.status}`);
    }
    return response.blob();
};

export const proposeTenantRestore = (orgId: string, body: T.ProposeRestoreRequest): Promise<T.TenantRestoreRequest> =>
    authorizedRequest(`/organizations/${orgId}/backup/restore-requests`, { method: "POST", body: JSON.stringify(body) }).then((r) =>
        parseOrThrow<T.TenantRestoreRequest>(r)
    );

export const listTenantRestoreRequests = (orgId: string): Promise<T.TenantRestoreRequest[]> =>
    authorizedRequest(`/organizations/${orgId}/backup/restore-requests`).then((r) => parseOrThrow<T.TenantRestoreRequest[]>(r));

export const approveTenantRestore = (orgId: string, requestId: string): Promise<T.TenantRestoreRequest> =>
    authorizedRequest(`/organizations/${orgId}/backup/restore-requests/${requestId}/approve`, { method: "POST" }).then((r) =>
        parseOrThrow<T.TenantRestoreRequest>(r)
    );

export const rejectTenantRestore = (orgId: string, requestId: string, body: T.RejectRestoreRequest): Promise<T.TenantRestoreRequest> =>
    authorizedRequest(`/organizations/${orgId}/backup/restore-requests/${requestId}/reject`, { method: "POST", body: JSON.stringify(body) }).then((r) =>
        parseOrThrow<T.TenantRestoreRequest>(r)
    );

export const checkAuthz = (orgId: string, action: string, resource: string, context?: Record<string, string>): Promise<T.AuthzCheckResponse> =>
    authorizedRequest(`/organizations/${orgId}/authz/check`, { method: "POST", body: JSON.stringify({ action, resource, context }) }).then((r) =>
        parseOrThrow<T.AuthzCheckResponse>(r)
    );

export const invokeBreakGlass = (orgId: string, body: T.InvokeBreakGlassRequest): Promise<T.BreakGlassGrant> =>
    authorizedRequest(`/organizations/${orgId}/break-glass/invoke`, { method: "POST", body: JSON.stringify(body) }).then((r) =>
        parseOrThrow<T.BreakGlassGrant>(r)
    );

export const listBreakGlassGrants = (orgId: string): Promise<T.BreakGlassGrant[]> =>
    authorizedRequest(`/organizations/${orgId}/break-glass/grants`).then((r) => parseOrThrow<T.BreakGlassGrant[]>(r));

export const reviewBreakGlassGrant = (orgId: string, grantId: string, body: T.ReviewBreakGlassGrantRequest): Promise<T.BreakGlassGrant> =>
    authorizedRequest(`/organizations/${orgId}/break-glass/grants/${grantId}/review`, { method: "POST", body: JSON.stringify(body) }).then((r) =>
        parseOrThrow<T.BreakGlassGrant>(r)
    );

export const setBreakGlassPolicy = (orgId: string, body: T.SetBreakGlassPolicyRequest): Promise<T.Policy | null> =>
    authorizedRequest(`/organizations/${orgId}/break-glass/policy`, { method: "PUT", body: JSON.stringify(body) }).then((r) =>
        parseOrThrow<T.Policy | null>(r)
    );

export const createAccessReviewCampaign = (orgId: string): Promise<T.AccessReviewCampaign> =>
    authorizedRequest(`/organizations/${orgId}/access-reviews`, { method: "POST" }).then((r) => parseOrThrow<T.AccessReviewCampaign>(r));

export const listAccessReviewCampaigns = (orgId: string): Promise<T.AccessReviewCampaign[]> =>
    authorizedRequest(`/organizations/${orgId}/access-reviews`).then((r) => parseOrThrow<T.AccessReviewCampaign[]>(r));

export const listAccessReviewItems = (orgId: string, campaignId: string): Promise<T.AccessReviewItem[]> =>
    authorizedRequest(`/organizations/${orgId}/access-reviews/${campaignId}/items`).then((r) => parseOrThrow<T.AccessReviewItem[]>(r));

export const proposePolicyVersion = (orgId: string, policyId: string, body: T.ProposePolicyVersionRequest): Promise<T.PolicyVersion> =>
    authorizedRequest(`/organizations/${orgId}/policies/${policyId}/versions`, { method: "POST", body: JSON.stringify(body) }).then((r) =>
        parseOrThrow<T.PolicyVersion>(r)
    );

export const listPolicyVersions = (orgId: string, policyId: string): Promise<T.PolicyVersion[]> =>
    authorizedRequest(`/organizations/${orgId}/policies/${policyId}/versions`).then((r) => parseOrThrow<T.PolicyVersion[]>(r));

export const approvePolicyVersion = (orgId: string, policyId: string, versionId: string): Promise<T.PolicyVersion> =>
    authorizedRequest(`/organizations/${orgId}/policies/${policyId}/versions/${versionId}/approve`, { method: "POST" }).then((r) =>
        parseOrThrow<T.PolicyVersion>(r)
    );

export const rejectPolicyVersion = (
    orgId: string,
    policyId: string,
    versionId: string,
    body: T.RejectPolicyVersionRequest
): Promise<T.PolicyVersion> =>
    authorizedRequest(`/organizations/${orgId}/policies/${policyId}/versions/${versionId}/reject`, {
        method: "POST",
        body: JSON.stringify(body),
    }).then((r) => parseOrThrow<T.PolicyVersion>(r));

export const rollbackPolicy = (orgId: string, policyId: string, body: T.RollbackPolicyRequest): Promise<T.PolicyVersion> =>
    authorizedRequest(`/organizations/${orgId}/policies/${policyId}/rollback`, { method: "POST", body: JSON.stringify(body) }).then((r) =>
        parseOrThrow<T.PolicyVersion>(r)
    );

export const decideAccessReviewItem = (
    orgId: string,
    campaignId: string,
    itemId: string,
    body: T.DecideAccessReviewItemRequest
): Promise<T.AccessReviewItem> =>
    authorizedRequest(`/organizations/${orgId}/access-reviews/${campaignId}/items/${itemId}/decide`, {
        method: "POST",
        body: JSON.stringify(body),
    }).then((r) => parseOrThrow<T.AccessReviewItem>(r));

export const listAiProviders = (orgId: string): Promise<T.AiProvider[]> =>
    authorizedRequest(`/organizations/${orgId}/ai-providers`).then((r) => parseOrThrow<{ providers: T.AiProvider[] }>(r)).then((value) => value.providers);
export const listAiProviderModels = (orgId: string, providerId: string): Promise<T.AiProviderModel[]> =>
    authorizedRequest(`/organizations/${orgId}/ai-providers/${providerId}/models`).then((r) => parseOrThrow<{ models: T.AiProviderModel[] }>(r)).then((value) => value.models);
export const listAiModelArtifacts = (orgId: string, modelId: string): Promise<T.AiModelArtifact[]> =>
    authorizedRequest(`/organizations/${orgId}/ai-provider-models/${modelId}/artifacts`).then((r) => parseOrThrow<{ artifacts: T.AiModelArtifact[] }>(r)).then((value) => value.artifacts);
export const createAiModelArtifact = (orgId: string, modelId: string, body: T.CreateArtifactRequest): Promise<T.AiModelArtifact> =>
    authorizedRequest(`/organizations/${orgId}/ai-provider-models/${modelId}/artifacts`, { method: "POST", body: JSON.stringify(body) }).then((r) => parseOrThrow<T.AiModelArtifact>(r));
export const setAiModelArtifactStatus = (orgId: string, artifactId: string, status: T.AiModelArtifact["status"]): Promise<T.AiModelArtifact> =>
    authorizedRequest(`/organizations/${orgId}/ai-model-artifacts/${artifactId}/status`, { method: "POST", body: JSON.stringify({ status }) }).then((r) => parseOrThrow<T.AiModelArtifact>(r));
export const listAiInferenceDeployments = (orgId: string, artifactId: string): Promise<T.AiInferenceDeployment[]> =>
    authorizedRequest(`/organizations/${orgId}/ai-model-artifacts/${artifactId}/deployments`).then((r) => parseOrThrow<{ deployments: T.AiInferenceDeployment[] }>(r)).then((value) => value.deployments);
export const createAiInferenceDeployment = (orgId: string, artifactId: string, body: T.CreateDeploymentRequest): Promise<T.AiInferenceDeployment> =>
    authorizedRequest(`/organizations/${orgId}/ai-model-artifacts/${artifactId}/deployments`, { method: "POST", body: JSON.stringify(body) }).then((r) => parseOrThrow<T.AiInferenceDeployment>(r));
export const verifyAiInferenceDeployment = (orgId: string, deploymentId: string): Promise<{ healthy: boolean; deployment: T.AiInferenceDeployment }> =>
    authorizedRequest(`/organizations/${orgId}/ai-inference-deployments/${deploymentId}/verify`, { method: "POST" }).then((r) => parseOrThrow<{ healthy: boolean; deployment: T.AiInferenceDeployment }>(r));
export const setAiInferenceDeploymentStatus = (orgId: string, deploymentId: string, status: T.AiInferenceDeployment["operationalStatus"]): Promise<T.AiInferenceDeployment> =>
    authorizedRequest(`/organizations/${orgId}/ai-inference-deployments/${deploymentId}/operational-status`, { method: "POST", body: JSON.stringify({ status }) }).then((r) => parseOrThrow<T.AiInferenceDeployment>(r));

export const listMcpRegistryEntries = (orgId: string): Promise<T.McpRegistryEntry[]> =>
    authorizedRequest(`/organizations/${orgId}/mcp-registry`).then((r) => parseOrThrow<T.McpRegistryEntry[]>(r));

export const createMcpRegistryEntry = (orgId: string, body: T.CreateMcpRegistryEntryRequest): Promise<T.McpRegistryEntry> =>
    authorizedRequest(`/organizations/${orgId}/mcp-registry`, { method: "POST", body: JSON.stringify(body) }).then((r) =>
        parseOrThrow<T.McpRegistryEntry>(r)
    );

export const updateMcpRegistryEntry = (orgId: string, entryId: string, body: T.UpdateMcpRegistryEntryRequest): Promise<T.McpRegistryEntry> =>
    authorizedRequest(`/organizations/${orgId}/mcp-registry/${entryId}`, { method: "PATCH", body: JSON.stringify(body) }).then((r) =>
        parseOrThrow<T.McpRegistryEntry>(r)
    );

export const setMcpRegistryEntryStatus = (orgId: string, entryId: string, status: T.McpRegistryStatus): Promise<T.McpRegistryEntry> =>
    authorizedRequest(`/organizations/${orgId}/mcp-registry/${entryId}/status`, { method: "POST", body: JSON.stringify({ status }) }).then((r) =>
        parseOrThrow<T.McpRegistryEntry>(r)
    );

export const getComputeSummary = (orgId: string): Promise<T.ComputeSummary> =>
    authorizedRequest(`/organizations/${orgId}/compute/summary`).then((r) => parseOrThrow<T.ComputeSummary>(r));
export const listComputeNodes = (orgId: string): Promise<T.ComputeNode[]> =>
    authorizedRequest(`/organizations/${orgId}/compute/nodes`).then((r) => parseOrThrow<T.ComputeNode[]>(r));
export const listComputePools = (orgId: string): Promise<T.ComputePool[]> =>
    authorizedRequest(`/organizations/${orgId}/compute/pools`).then((r) => parseOrThrow<T.ComputePool[]>(r));
export const listComputeRequests = (orgId: string): Promise<T.ComputeRequest[]> =>
    authorizedRequest(`/organizations/${orgId}/compute/requests`).then((r) => parseOrThrow<T.ComputeRequest[]>(r));
export const listComputeLeases = (orgId: string): Promise<T.ComputeLease[]> =>
    authorizedRequest(`/organizations/${orgId}/compute/leases`).then((r) => parseOrThrow<T.ComputeLease[]>(r));
export const listComputePolicies = (orgId: string): Promise<T.ComputePolicy[]> =>
    authorizedRequest(`/organizations/${orgId}/compute/policies`).then((r) => parseOrThrow<T.ComputePolicy[]>(r));
export const setComputeNodeState = (orgId: string, nodeId: string, state: T.ComputeNodeState, reason: string): Promise<T.ComputeNode> =>
    authorizedRequest(`/organizations/${orgId}/compute/nodes/${nodeId}/state`, { method: "POST", body: JSON.stringify({ state, reason }) }).then((r) => parseOrThrow<T.ComputeNode>(r));

/** Returns null rather than throwing when a pool has no quota configured
 * yet (the server 404s) — the common, expected state for a freshly created
 * pool, not an error condition the caller should have to catch. */
export const getComputeQuota = async (orgId: string, poolId: string): Promise<T.ComputeQuota | null> => {
    const response = await authorizedRequest(`/organizations/${orgId}/compute/pools/${poolId}/quota`);
    if (response.status === 404) return null;
    return parseOrThrow<T.ComputeQuota>(response);
};
export const setComputeQuota = (orgId: string, poolId: string, body: T.SetComputeQuotaRequest): Promise<T.ComputeQuota> =>
    authorizedRequest(`/organizations/${orgId}/compute/pools/${poolId}/quota`, { method: "PUT", body: JSON.stringify(body) }).then((r) => parseOrThrow<T.ComputeQuota>(r));

export const listComputePoliciesForPool = (orgId: string, poolId: string): Promise<T.ComputePolicy[]> =>
    authorizedRequest(`/organizations/${orgId}/compute/policies?poolId=${encodeURIComponent(poolId)}`).then((r) => parseOrThrow<T.ComputePolicy[]>(r));

/** The signed body must already carry a valid Ed25519 signature produced
 * offline by server/scripts/sign-compute-policy.js — this call never signs
 * anything itself, and the server rejects (400/503) anything it can't
 * verify against the organization's configured public key. */
export const createComputePolicy = (orgId: string, body: T.SignedComputePolicyRequest): Promise<T.ComputePolicy> =>
    authorizedRequest(`/organizations/${orgId}/compute/policies`, { method: "POST", body: JSON.stringify(body) }).then((r) => parseOrThrow<T.ComputePolicy>(r));

/** Activating any retained (non-expired) earlier version is how a rollback
 * is expressed — there is no separate rollback endpoint (see
 * docs/COMPUTE_CONTROL_PLANE.md's "Signed resource policies" section). */
export const activateComputePolicy = (orgId: string, policyId: string): Promise<T.ComputePolicy> =>
    authorizedRequest(`/organizations/${orgId}/compute/policies/${policyId}/activate`, { method: "POST" }).then((r) => parseOrThrow<T.ComputePolicy>(r));
