import { Agent, fetch as undiciFetch } from "undici";
import type { ComputeResourceLease, NodeHeartbeat, ResourcePolicy } from "@modelforge/contracts";
import { getSharedBackendConfig } from "./shared-backend-config-store";
import { getValidAccessToken, isAllowedRemoteUrl } from "./shared-backend-auth";
import { getOrCreateNodeIdentity, getNodePrivateKeyPem } from "./compute-node-identity";

/**
 * HTTP client for the compute control plane's *agent-scoped* endpoints
 * (server/src/routes/compute-control.ts's requireAgentNode() routes) — the
 * ones a fleet node calls about itself: heartbeat, assignments, and lease
 * acknowledge/renew/release. Deliberately separate from
 * shared-backend-client.ts's authorizedRequest(): those calls only need the
 * bearer token, but requireAgentNode() additionally requires the request's
 * TLS peer certificate fingerprint to match this node's registered
 * fingerprint (see compute-node-identity.ts) — a plain fetch() can't
 * present a client certificate, so this module builds its own undici
 * dispatcher with the node's cert/key attached to the TLS connection.
 *
 * Reuses the *same* connected identity as the rest of enterprise mode
 * (shared-backend-config-store.ts's baseUrl/organizationId,
 * shared-backend-auth.ts's bearer token) rather than a separate login —
 * compute-agent mode is an opt-in addition on top of an already-connected
 * shared backend, never a standalone credential of its own.
 */

export class ComputeAgentClientError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "ComputeAgentClientError";
    }
}

let cachedAgent: { fingerprint256: string; agent: Agent } | null = null;

async function getMtlsDispatcher(): Promise<Agent> {
    const identity = await getOrCreateNodeIdentity();
    if (cachedAgent && cachedAgent.fingerprint256 === identity.fingerprint256) return cachedAgent.agent;
    const key = getNodePrivateKeyPem();
    if (!key) throw new ComputeAgentClientError("This node's compute-agent private key is missing — its identity may need to be regenerated.");
    const agent = new Agent({ connect: { cert: identity.certificatePem, key } });
    cachedAgent = { fingerprint256: identity.fingerprint256, agent };
    return agent;
}

interface AgentContext {
    baseUrl: string;
    organizationId: string;
    token: string;
    dispatcher: Agent;
}

async function resolveContext(): Promise<AgentContext> {
    const config = getSharedBackendConfig();
    if (!config) throw new ComputeAgentClientError("No shared backend is configured — connect to one first.");
    if (!config.organizationId) throw new ComputeAgentClientError("No organization is selected — select one in Settings first.");
    if (!isAllowedRemoteUrl(config.baseUrl)) {
        throw new ComputeAgentClientError("The configured shared backend URL is not a trusted HTTPS endpoint — refusing to send the compute-agent identity to it.");
    }
    const token = await getValidAccessToken();
    if (!token) throw new ComputeAgentClientError("Not connected to the shared backend — connect first.");
    const dispatcher = await getMtlsDispatcher();
    return { baseUrl: config.baseUrl, organizationId: config.organizationId, token, dispatcher };
}

async function agentRequest(context: AgentContext, path: string, init: { method: string; body?: unknown }): Promise<unknown> {
    let response: Awaited<ReturnType<typeof undiciFetch>>;
    try {
        response = await undiciFetch(`${context.baseUrl}${path}`, {
            method: init.method,
            dispatcher: context.dispatcher,
            headers: {
                Authorization: `Bearer ${context.token}`,
                ...(init.body !== undefined ? { "Content-Type": "application/json" } : {}),
            },
            body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
        });
    } catch (err) {
        throw new ComputeAgentClientError(`Could not reach the compute control plane: ${(err as Error).message}`);
    }
    if (!response.ok) {
        let detail = `HTTP ${response.status}`;
        try {
            const body = (await response.json()) as { error?: string; message?: string };
            detail = body.message ?? body.error ?? detail;
        } catch { /* no JSON body */ }
        throw new ComputeAgentClientError(`Compute-agent request to ${path} failed: ${detail}`);
    }
    return response.json();
}

export interface HeartbeatResult {
    accepted: boolean;
    nodeState: string;
    policyRefreshRequired: boolean;
}

export async function sendHeartbeat(nodeId: string, heartbeat: NodeHeartbeat): Promise<HeartbeatResult> {
    const context = await resolveContext();
    return (await agentRequest(context, `/organizations/${context.organizationId}/compute/nodes/${nodeId}/heartbeat`, { method: "POST", body: heartbeat })) as HeartbeatResult;
}

export interface AgentAssignment {
    lease: ComputeResourceLease;
    request: unknown;
}

export async function getAssignments(nodeId: string): Promise<{ assignments: AgentAssignment[]; policies: ResourcePolicy[] }> {
    const context = await resolveContext();
    return (await agentRequest(context, `/organizations/${context.organizationId}/compute/nodes/${nodeId}/assignments`, { method: "GET" })) as {
        assignments: AgentAssignment[];
        policies: ResourcePolicy[];
    };
}

export async function acknowledgeLease(leaseId: string, fencingToken: string): Promise<ComputeResourceLease> {
    const context = await resolveContext();
    return (await agentRequest(context, `/organizations/${context.organizationId}/compute/leases/${leaseId}/acknowledge`, { method: "POST", body: { fencingToken } })) as ComputeResourceLease;
}

export async function renewLease(leaseId: string, fencingToken: string): Promise<ComputeResourceLease> {
    const context = await resolveContext();
    return (await agentRequest(context, `/organizations/${context.organizationId}/compute/leases/${leaseId}/renew`, { method: "POST", body: { fencingToken } })) as ComputeResourceLease;
}

export async function releaseLease(leaseId: string, fencingToken: string, outcome: "completed" | "failed" | "cancelled"): Promise<ComputeResourceLease> {
    const context = await resolveContext();
    return (await agentRequest(context, `/organizations/${context.organizationId}/compute/leases/${leaseId}/release`, { method: "POST", body: { fencingToken, outcome } })) as ComputeResourceLease;
}
