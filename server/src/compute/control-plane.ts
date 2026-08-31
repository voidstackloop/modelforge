import type { ComputeResourceLease, ComputeResourceRequest } from "@modelforge/contracts";
import { ComputeScheduler, type SchedulerDecision } from "./scheduler.js";
import type { AuditActor } from "../store/audit-store.js";
import type { ComputeControlStore, SubmitComputeRequestInput } from "../store/compute-control-store.js";

export interface SubmitResult {
    request: ComputeResourceRequest;
    decision: SchedulerDecision;
    lease?: ComputeResourceLease;
}

/** Coordinates durable state with the pure deterministic scheduler. Store
 * implementations own the atomic queued->assigned transition and fencing
 * token; duplicate scheduler workers can race safely and only one commits. */
export class ComputeControlPlane {
    constructor(private readonly store: ComputeControlStore, private readonly scheduler = new ComputeScheduler(), private readonly now: () => Date = () => new Date()) {}

    async submit(organizationId: string, input: SubmitComputeRequestInput, actor: AuditActor, options: { allowSafePreemption?: boolean } = {}): Promise<SubmitResult> {
        const request = await this.store.submitRequest(organizationId, input, actor);
        const scheduled = await this.scheduleRequest(request, actor, options);
        return { request: (await this.store.getRequest(organizationId, request.id)) ?? request, ...scheduled };
    }

    async scheduleRequest(request: ComputeResourceRequest, actor: AuditActor, options: { allowSafePreemption?: boolean } = {}): Promise<{ decision: SchedulerDecision; lease?: ComputeResourceLease }> {
        const snapshot = await this.store.getSchedulingSnapshot(request.organizationId, request.poolId, this.now().toISOString());
        if (!snapshot) return { decision: { status: "rejected", reasons: ["The selected compute pool no longer exists."] } };
        const decision = this.scheduler.schedule(request, snapshot, options);
        if (decision.status !== "placed") return { decision };
        const lease = await this.store.commitPlacement(request.organizationId, request.id, decision.placement, snapshot.policy?.version, actor);
        if (!lease) return { decision: { status: "queued", reasons: ["The request changed while placement was being committed; it will be re-evaluated."] } };
        return { decision, lease };
    }

    async scheduleQueued(organizationId: string, poolId: string, actor: AuditActor, limit = 100): Promise<Array<{ requestId: string; decision: SchedulerDecision; leaseId?: string }>> {
        const queued = (await this.store.listRequests(organizationId, { poolId, state: "queued" })).slice(0, Math.max(1, Math.min(limit, 1_000)));
        const results: Array<{ requestId: string; decision: SchedulerDecision; leaseId?: string }> = [];
        for (const request of queued) {
            const result = await this.scheduleRequest(request, actor, { allowSafePreemption: true });
            results.push({ requestId: request.id, decision: result.decision, leaseId: result.lease?.id });
        }
        return results;
    }

    async sweep(): Promise<{ expiredLeaseIds: string[]; offlineNodeIds: string[] }> {
        const now = this.now();
        const expiredLeaseIds = await this.store.sweepExpired(now.toISOString());
        const offlineNodeIds = await this.store.markStaleNodes(new Date(now.getTime() - 45_000).toISOString());
        return { expiredLeaseIds, offlineNodeIds };
    }
}
