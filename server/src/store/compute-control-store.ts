import { randomUUID } from "node:crypto";
import type {
    ComputeNode,
    ComputeNodeState,
    ComputeResourceLease,
    ComputeResourceRequest,
    NodeHeartbeat,
    ResourcePolicy,
    ResourcePool,
    TenantComputeQuota,
} from "@modelforge/contracts";
import type { SchedulerDecision, SchedulerPlacement, SchedulerSnapshot } from "../compute/scheduler.js";
import { type AuditActor, type AuditStore, InMemoryAuditStore } from "./audit-store.js";

export type RegisterComputeNodeInput = Omit<ComputeNode, "organizationId" | "state" | "lastHeartbeatAt" | "createdAt" | "updatedAt">;
export type CreateResourcePoolInput = Omit<ResourcePool, "id" | "organizationId" | "createdAt" | "updatedAt">;
export type CreateResourcePolicyInput = Omit<ResourcePolicy, "id" | "organizationId" | "version" | "status" | "createdAt">;
export type SubmitComputeRequestInput = Omit<ComputeResourceRequest, "id" | "organizationId" | "state" | "queuedAt" | "assignedAt" | "updatedAt">;

export interface ComputeControlStore {
    registerNode(organizationId: string, input: RegisterComputeNodeInput, actor: AuditActor): Promise<ComputeNode>;
    heartbeat(organizationId: string, nodeId: string, heartbeat: NodeHeartbeat): Promise<ComputeNode | null>;
    markStaleNodes(olderThan: string): Promise<string[]>;
    getNode(organizationId: string, nodeId: string): Promise<ComputeNode | null>;
    listNodes(organizationId: string): Promise<ComputeNode[]>;
    setNodeState(organizationId: string, nodeId: string, state: ComputeNodeState, actor: AuditActor): Promise<ComputeNode | null>;

    createPool(organizationId: string, input: CreateResourcePoolInput, actor: AuditActor): Promise<ResourcePool>;
    getPool(organizationId: string, poolId: string): Promise<ResourcePool | null>;
    listPools(organizationId: string): Promise<ResourcePool[]>;
    upsertQuota(organizationId: string, quota: Omit<TenantComputeQuota, "organizationId" | "updatedAt">, actor: AuditActor): Promise<TenantComputeQuota>;
    getQuota(organizationId: string, poolId: string): Promise<TenantComputeQuota | null>;

    createPolicy(organizationId: string, input: CreateResourcePolicyInput, actor: AuditActor): Promise<ResourcePolicy>;
    activatePolicy(organizationId: string, policyId: string, actor: AuditActor): Promise<ResourcePolicy | null>;
    listPolicies(organizationId: string, poolId?: string): Promise<ResourcePolicy[]>;

    submitRequest(organizationId: string, input: SubmitComputeRequestInput, actor: AuditActor): Promise<ComputeResourceRequest>;
    getRequest(organizationId: string, requestId: string): Promise<ComputeResourceRequest | null>;
    listRequests(organizationId: string, filter?: { poolId?: string; state?: ComputeResourceRequest["state"] }): Promise<ComputeResourceRequest[]>;
    cancelRequest(organizationId: string, requestId: string, actor: AuditActor): Promise<ComputeResourceRequest | null>;
    getSchedulingSnapshot(organizationId: string, poolId: string, now: string): Promise<SchedulerSnapshot | null>;
    commitPlacement(organizationId: string, requestId: string, placement: SchedulerPlacement, policyVersion: number | undefined, actor: AuditActor): Promise<ComputeResourceLease | null>;
    /** Shadow mode (see docs/COMPUTE_CONTROL_PLANE_ROLLOUT.md phase 3) — logs
     * what the scheduler *would* have decided for a request that is never
     * actually committed to a lease. Recorded against a real, already-
     * persisted (and about to be cancelled) request id, since
     * compute_allocation_events.request_id is a hard NOT NULL foreign key —
     * there is deliberately no way to log a shadow decision without a real
     * request row behind it. */
    recordShadowDecision(organizationId: string, requestId: string, decision: SchedulerDecision, actor: AuditActor): Promise<void>;

    getLease(organizationId: string, leaseId: string): Promise<ComputeResourceLease | null>;
    listLeases(organizationId: string, filter?: { poolId?: string; nodeId?: string; state?: ComputeResourceLease["state"] }): Promise<ComputeResourceLease[]>;
    acknowledgeLease(organizationId: string, leaseId: string, fencingToken: string, actor: AuditActor): Promise<ComputeResourceLease | null>;
    renewLease(organizationId: string, leaseId: string, fencingToken: string): Promise<ComputeResourceLease | null>;
    releaseLease(organizationId: string, leaseId: string, fencingToken: string, outcome: "completed" | "failed" | "cancelled", actor: AuditActor): Promise<ComputeResourceLease | null>;
    sweepExpired(now: string): Promise<string[]>;
}

function clone<T>(value: T): T {
    return structuredClone(value);
}

export class InMemoryComputeControlStore implements ComputeControlStore {
    private readonly nodes = new Map<string, ComputeNode>();
    private readonly pools = new Map<string, ResourcePool>();
    private readonly quotas = new Map<string, TenantComputeQuota>();
    private readonly policies = new Map<string, ResourcePolicy>();
    private readonly requests = new Map<string, ComputeResourceRequest>();
    private readonly leases = new Map<string, ComputeResourceLease>();
    private fencingToken = 0n;

    constructor(private readonly auditStore: AuditStore = new InMemoryAuditStore(), private readonly now: () => Date = () => new Date()) {}

    private iso(): string { return this.now().toISOString(); }
    private key(organizationId: string, id: string): string { return `${organizationId}:${id}`; }
    private async audit(organizationId: string, actor: AuditActor, action: string, targetType: string, targetId: string, details?: Record<string, unknown>): Promise<void> {
        await this.auditStore.record({ organizationId, actorUserId: actor.userId, actorExternalSubject: actor.externalSubject, action, targetType, targetId, details });
    }

    async registerNode(organizationId: string, input: RegisterComputeNodeInput, actor: AuditActor): Promise<ComputeNode> {
        const now = this.iso();
        const existing = this.nodes.get(this.key(organizationId, input.id));
        const node: ComputeNode = { ...clone(input), organizationId, state: existing?.state ?? "online", lastHeartbeatAt: now, createdAt: existing?.createdAt ?? now, updatedAt: now };
        this.nodes.set(this.key(organizationId, node.id), node);
        await this.audit(organizationId, actor, existing ? "computeNode.inventoryUpdated" : "computeNode.registered", "computeNode", node.id, { region: node.region, deviceCount: node.devices.length });
        return clone(node);
    }

    async heartbeat(organizationId: string, nodeId: string, heartbeat: NodeHeartbeat): Promise<ComputeNode | null> {
        const key = this.key(organizationId, nodeId);
        const existing = this.nodes.get(key);
        if (!existing || heartbeat.nodeId !== nodeId) return null;
        const node: ComputeNode = {
            ...existing,
            freeCpuThreads: Math.min(existing.cpuThreads, heartbeat.freeCpuThreads),
            freeRamMB: Math.min(existing.totalRamMB, heartbeat.freeRamMB),
            devices: clone(heartbeat.devices), inventoryVersion: heartbeat.inventoryVersion,
            lastHeartbeatAt: heartbeat.capturedAt,
            state: existing.state === "offline" ? "online" : existing.state,
            // Server-generated, not the agent-supplied capturedAt: updatedAt
            // is this row's own bookkeeping timestamp, and a heartbeat's
            // capturedAt is untrusted client input — a clock-skewed or
            // malformed agent payload must never propagate into it.
            updatedAt: this.iso(),
        };
        this.nodes.set(key, node);
        return clone(node);
    }

    async markStaleNodes(olderThan: string): Promise<string[]> {
        const stale: string[] = [];
        for (const [key, node] of this.nodes) {
            if (node.state === "online" && node.lastHeartbeatAt < olderThan) {
                this.nodes.set(key, { ...node, state: "offline", updatedAt: this.iso() });
                stale.push(node.id);
            }
        }
        return stale;
    }

    async getNode(organizationId: string, nodeId: string): Promise<ComputeNode | null> { return clone(this.nodes.get(this.key(organizationId, nodeId)) ?? null); }
    async listNodes(organizationId: string): Promise<ComputeNode[]> { return [...this.nodes.values()].filter((node) => node.organizationId === organizationId).map(clone).sort((a, b) => a.name.localeCompare(b.name)); }

    async setNodeState(organizationId: string, nodeId: string, state: ComputeNodeState, actor: AuditActor): Promise<ComputeNode | null> {
        const key = this.key(organizationId, nodeId);
        const existing = this.nodes.get(key);
        if (!existing) return null;
        const updated = { ...existing, state, updatedAt: this.iso() };
        this.nodes.set(key, updated);
        await this.audit(organizationId, actor, "computeNode.stateChanged", "computeNode", nodeId, { from: existing.state, to: state });
        return clone(updated);
    }

    async createPool(organizationId: string, input: CreateResourcePoolInput, actor: AuditActor): Promise<ResourcePool> {
        for (const nodeId of input.nodeIds) if (!this.nodes.has(this.key(organizationId, nodeId))) throw new Error(`Unknown compute node ${nodeId}.`);
        const now = this.iso();
        const pool: ResourcePool = { ...clone(input), id: randomUUID(), organizationId, createdAt: now, updatedAt: now };
        this.pools.set(this.key(organizationId, pool.id), pool);
        await this.audit(organizationId, actor, "computePool.created", "computePool", pool.id, { region: pool.region, nodeCount: pool.nodeIds.length });
        return clone(pool);
    }
    async getPool(organizationId: string, poolId: string): Promise<ResourcePool | null> { return clone(this.pools.get(this.key(organizationId, poolId)) ?? null); }
    async listPools(organizationId: string): Promise<ResourcePool[]> { return [...this.pools.values()].filter((pool) => pool.organizationId === organizationId).map(clone).sort((a, b) => a.name.localeCompare(b.name)); }

    async upsertQuota(organizationId: string, input: Omit<TenantComputeQuota, "organizationId" | "updatedAt">, actor: AuditActor): Promise<TenantComputeQuota> {
        if (!this.pools.has(this.key(organizationId, input.poolId))) throw new Error(`Unknown compute pool ${input.poolId}.`);
        const quota: TenantComputeQuota = { ...clone(input), organizationId, updatedAt: this.iso() };
        this.quotas.set(this.key(organizationId, input.poolId), quota);
        await this.audit(organizationId, actor, "computeQuota.updated", "computePool", input.poolId, { borrowingEnabled: quota.borrowingEnabled, weight: quota.weight });
        return clone(quota);
    }
    async getQuota(organizationId: string, poolId: string): Promise<TenantComputeQuota | null> { return clone(this.quotas.get(this.key(organizationId, poolId)) ?? null); }

    async createPolicy(organizationId: string, input: CreateResourcePolicyInput, actor: AuditActor): Promise<ResourcePolicy> {
        const versions = [...this.policies.values()].filter((policy) => policy.organizationId === organizationId && policy.poolId === input.poolId).map((policy) => policy.version);
        const policy: ResourcePolicy = { ...clone(input), id: randomUUID(), organizationId, version: Math.max(0, ...versions) + 1, status: "draft", createdAt: this.iso() };
        this.policies.set(this.key(organizationId, policy.id), policy);
        await this.audit(organizationId, actor, "computePolicy.created", "computePolicy", policy.id, { version: policy.version, poolId: policy.poolId });
        return clone(policy);
    }

    async activatePolicy(organizationId: string, policyId: string, actor: AuditActor): Promise<ResourcePolicy | null> {
        const key = this.key(organizationId, policyId);
        const policy = this.policies.get(key);
        if (!policy) return null;
        for (const [otherKey, other] of this.policies) {
            if (other.organizationId === organizationId && other.poolId === policy.poolId && other.status === "active") this.policies.set(otherKey, { ...other, status: "retired" });
        }
        const active = { ...policy, status: "active" as const };
        this.policies.set(key, active);
        await this.audit(organizationId, actor, "computePolicy.activated", "computePolicy", policyId, { version: active.version, poolId: active.poolId });
        return clone(active);
    }
    async listPolicies(organizationId: string, poolId?: string): Promise<ResourcePolicy[]> { return [...this.policies.values()].filter((policy) => policy.organizationId === organizationId && (poolId === undefined || policy.poolId === poolId)).map(clone).sort((a, b) => b.version - a.version); }

    async submitRequest(organizationId: string, input: SubmitComputeRequestInput, actor: AuditActor): Promise<ComputeResourceRequest> {
        if (!this.pools.has(this.key(organizationId, input.poolId))) throw new Error(`Unknown compute pool ${input.poolId}.`);
        const now = this.iso();
        const request: ComputeResourceRequest = { ...clone(input), id: randomUUID(), organizationId, state: "queued", queuedAt: now, updatedAt: now };
        this.requests.set(this.key(organizationId, request.id), request);
        await this.audit(organizationId, actor, "computeRequest.submitted", "computeRequest", request.id, { poolId: request.poolId, priority: request.priority, workloadKind: request.workloadKind });
        return clone(request);
    }
    async getRequest(organizationId: string, requestId: string): Promise<ComputeResourceRequest | null> { return clone(this.requests.get(this.key(organizationId, requestId)) ?? null); }
    async listRequests(organizationId: string, filter?: { poolId?: string; state?: ComputeResourceRequest["state"] }): Promise<ComputeResourceRequest[]> { return [...this.requests.values()].filter((request) => request.organizationId === organizationId && (!filter?.poolId || request.poolId === filter.poolId) && (!filter?.state || request.state === filter.state)).map(clone).sort((a, b) => a.queuedAt.localeCompare(b.queuedAt)); }

    async cancelRequest(organizationId: string, requestId: string, actor: AuditActor): Promise<ComputeResourceRequest | null> {
        const key = this.key(organizationId, requestId);
        const request = this.requests.get(key);
        if (!request || request.state === "completed" || request.state === "failed") return null;
        const updated = { ...request, state: "cancelled" as const, updatedAt: this.iso() };
        this.requests.set(key, updated);
        await this.audit(organizationId, actor, "computeRequest.cancelled", "computeRequest", requestId);
        return clone(updated);
    }

    async recordShadowDecision(organizationId: string, requestId: string, decision: SchedulerDecision, actor: AuditActor): Promise<void> {
        await this.audit(organizationId, actor, "computeRequest.shadowDecision", "computeRequest", requestId, { decision });
    }

    async getSchedulingSnapshot(organizationId: string, poolId: string, now: string): Promise<SchedulerSnapshot | null> {
        const pool = this.pools.get(this.key(organizationId, poolId));
        if (!pool) return null;
        const policies = await this.listPolicies(organizationId, poolId);
        return {
            nodes: (await this.listNodes(organizationId)).filter((node) => pool.nodeIds.includes(node.id)), pool: clone(pool),
            quota: await this.getQuota(organizationId, poolId) ?? undefined,
            policy: policies.find((policy) => policy.status === "active" && policy.expiresAt > now),
            activeLeases: (await this.listLeases(organizationId, { poolId })).filter((lease) => ["offered", "acknowledged", "running"].includes(lease.state)),
            activeRequests: (await this.listRequests(organizationId, { poolId })).filter((request) => ["assigned", "running", "preempting"].includes(request.state)),
            now,
        };
    }

    async commitPlacement(organizationId: string, requestId: string, placement: SchedulerPlacement, policyVersion: number | undefined, actor: AuditActor): Promise<ComputeResourceLease | null> {
        const entry = [...this.requests.entries()].find(([, request]) => request.id === requestId);
        if (!entry || entry[1].organizationId !== organizationId || entry[1].state !== "queued") return null;
        const [requestKey, request] = entry;
        const now = this.now();
        for (const victimId of placement.preemptLeaseIds) {
            const victim = this.leases.get(victimId);
            if (!victim || victim.organizationId !== request.organizationId || !["offered", "acknowledged", "running"].includes(victim.state)) continue;
            this.leases.set(victimId, { ...victim, state: "failed", updatedAt: now.toISOString() });
            const victimRequestKey = this.key(victim.organizationId, victim.requestId);
            const victimRequest = this.requests.get(victimRequestKey);
            if (victimRequest) this.requests.set(victimRequestKey, { ...victimRequest, state: "preempting", updatedAt: now.toISOString() });
        }
        const ack = new Date(now.getTime() + 15_000).toISOString();
        const renewal = new Date(now.getTime() + 30_000).toISOString();
        const expiry = new Date(now.getTime() + 90_000).toISOString();
        const lease: ComputeResourceLease = {
            id: randomUUID(), requestId, organizationId: request.organizationId, poolId: request.poolId, nodeId: placement.nodeId,
            acceleratorDeviceIds: [...placement.acceleratorDeviceIds], vramMBPerDevice: request.requirements.vramMBPerDevice,
            exclusiveAccelerators: request.requirements.exclusiveAccelerators, cpuThreads: request.requirements.cpuThreads,
            ramMB: request.requirements.ramMB, pinnedMemoryMB: request.requirements.pinnedMemoryMB,
            fencingToken: (++this.fencingToken).toString(), state: "offered", acknowledgmentDeadlineAt: ack,
            renewalDeadlineAt: renewal, expiresAt: expiry, explanation: clone(placement.explanation),
            effectivePolicyVersion: policyVersion, createdAt: now.toISOString(), updatedAt: now.toISOString(),
        };
        this.leases.set(lease.id, lease);
        this.requests.set(requestKey, { ...request, state: "assigned", assignedAt: now.toISOString(), updatedAt: now.toISOString() });
        await this.audit(request.organizationId, actor, "computeLease.allocated", "computeLease", lease.id, { requestId, nodeId: lease.nodeId, acceleratorDeviceIds: lease.acceleratorDeviceIds, fencingToken: lease.fencingToken, preemptLeaseIds: placement.preemptLeaseIds });
        return clone(lease);
    }

    async getLease(organizationId: string, leaseId: string): Promise<ComputeResourceLease | null> { const lease = this.leases.get(leaseId); return clone(lease?.organizationId === organizationId ? lease : null); }
    async listLeases(organizationId: string, filter?: { poolId?: string; nodeId?: string; state?: ComputeResourceLease["state"] }): Promise<ComputeResourceLease[]> { return [...this.leases.values()].filter((lease) => lease.organizationId === organizationId && (!filter?.poolId || lease.poolId === filter.poolId) && (!filter?.nodeId || lease.nodeId === filter.nodeId) && (!filter?.state || lease.state === filter.state)).map(clone).sort((a, b) => b.createdAt.localeCompare(a.createdAt)); }

    async acknowledgeLease(organizationId: string, leaseId: string, fencingToken: string, actor: AuditActor): Promise<ComputeResourceLease | null> {
        const lease = this.leases.get(leaseId);
        const now = this.iso();
        if (!lease || lease.organizationId !== organizationId || lease.fencingToken !== fencingToken || lease.state !== "offered" || lease.acknowledgmentDeadlineAt < now) return null;
        const updated = { ...lease, state: "running" as const, acknowledgedAt: now, updatedAt: now };
        this.leases.set(leaseId, updated);
        const requestKey = this.key(organizationId, lease.requestId);
        const request = this.requests.get(requestKey);
        if (request) this.requests.set(requestKey, { ...request, state: "running", updatedAt: now });
        await this.audit(organizationId, actor, "computeLease.acknowledged", "computeLease", leaseId, { requestId: lease.requestId, nodeId: lease.nodeId });
        return clone(updated);
    }

    async renewLease(organizationId: string, leaseId: string, fencingToken: string): Promise<ComputeResourceLease | null> {
        const lease = this.leases.get(leaseId);
        const now = this.now();
        if (!lease || lease.organizationId !== organizationId || lease.fencingToken !== fencingToken || !["acknowledged", "running"].includes(lease.state) || lease.expiresAt <= now.toISOString()) return null;
        const updated = { ...lease, renewalDeadlineAt: new Date(now.getTime() + 30_000).toISOString(), expiresAt: new Date(now.getTime() + 90_000).toISOString(), updatedAt: now.toISOString() };
        this.leases.set(leaseId, updated);
        return clone(updated);
    }

    async releaseLease(organizationId: string, leaseId: string, fencingToken: string, outcome: "completed" | "failed" | "cancelled", actor: AuditActor): Promise<ComputeResourceLease | null> {
        const lease = this.leases.get(leaseId);
        if (!lease || lease.organizationId !== organizationId || lease.fencingToken !== fencingToken || !["offered", "acknowledged", "running"].includes(lease.state)) return null;
        const now = this.iso();
        const updated = { ...lease, state: outcome === "failed" ? "failed" as const : "released" as const, updatedAt: now };
        this.leases.set(leaseId, updated);
        const requestKey = this.key(organizationId, lease.requestId);
        const request = this.requests.get(requestKey);
        if (request) this.requests.set(requestKey, { ...request, state: outcome, updatedAt: now });
        await this.audit(organizationId, actor, "computeLease.released", "computeLease", leaseId, { outcome, requestId: lease.requestId, nodeId: lease.nodeId });
        return clone(updated);
    }

    async sweepExpired(now: string): Promise<string[]> {
        const expired: string[] = [];
        for (const [id, lease] of this.leases) {
            const missedAck = lease.state === "offered" && lease.acknowledgmentDeadlineAt <= now;
            if (!["offered", "acknowledged", "running"].includes(lease.state) || (!missedAck && lease.expiresAt > now)) continue;
            this.leases.set(id, { ...lease, state: "expired", updatedAt: now });
            const requestKey = this.key(lease.organizationId, lease.requestId);
            const request = this.requests.get(requestKey);
            if (request && request.state !== "cancelled") this.requests.set(requestKey, { ...request, state: "queued", assignedAt: undefined, updatedAt: now });
            expired.push(id);
        }
        return expired;
    }
}
