import type { FastifyInstance, FastifyRequest } from "fastify";
import {
    computeNodeInventorySchema,
    computeNodeStateSchema,
    computeResourceRequestSchema,
    nodeHeartbeatSchema,
    resourcePolicyInputSchema,
    resourcePoolSchema,
    tenantComputeQuotaSchema,
    type ComputeResourceRequest,
} from "@modelforge/contracts";
import { z } from "zod";
import { computeSchedulingDecisionDuration, computeSchedulingDecisions, startTimer } from "../metrics.js";
import { actorFrom } from "../store/audit-store.js";
import type { RouteDeps } from "./deps.js";
import { AuthzError, requireOrgUser, requirePermission, type ResolvedPrincipal } from "./guards.js";

const organizationParams = z.object({ organizationId: z.string().uuid() });
const nodeParams = organizationParams.extend({ nodeId: z.string().uuid() });
const poolParams = organizationParams.extend({ poolId: z.string().uuid() });
const policyParams = organizationParams.extend({ policyId: z.string().uuid() });
const requestParams = organizationParams.extend({ requestId: z.string().uuid() });
const leaseParams = organizationParams.extend({ leaseId: z.string().uuid() });

const registerNodeBody = computeNodeInventorySchema;
const createPoolBody = resourcePoolSchema.omit({ id: true, organizationId: true, createdAt: true, updatedAt: true });
const quotaBody = tenantComputeQuotaSchema.omit({ organizationId: true, poolId: true, updatedAt: true });
const createPolicyBody = resourcePolicyInputSchema;
const submitRequestBody = computeResourceRequestSchema.omit({ id: true, organizationId: true, state: true, queuedAt: true, assignedAt: true, updatedAt: true });
const nodeStateBody = z.object({ state: computeNodeStateSchema, reason: z.string().min(1).max(2_000) }).strict();
const fencingBody = z.object({ fencingToken: z.string().regex(/^\d+$/) }).strict();
const releaseBody = fencingBody.extend({ outcome: z.enum(["completed", "failed", "cancelled"]) }).strict();

async function requireAgentNode(deps: RouteDeps, request: FastifyRequest, organizationId: string, nodeId: string): Promise<ResolvedPrincipal> {
    const caller = await requireOrgUser(deps, request, organizationId);
    await requirePermission(deps.store, caller, "compute:agent", `organization:${organizationId}/computeNode:${nodeId}`);
    const node = await deps.computeControlStore.getNode(organizationId, nodeId);
    if (!node) throw new AuthzError(404, "Compute node not found.");
    const fingerprint = deps.resolveComputeAgentCertificateFingerprint(request);
    if (!fingerprint || fingerprint !== node.certificateFingerprint) {
        throw new AuthzError(403, "The authenticated agent certificate does not match this node enrollment.");
    }
    return caller;
}

export function registerComputeControlRoutes(fastify: FastifyInstance, deps: RouteDeps): void {
    fastify.get("/organizations/:organizationId/compute/nodes", { preHandler: deps.authPreHandler }, async (request, reply) => {
        const { organizationId } = organizationParams.parse(request.params);
        const caller = await requireOrgUser(deps, request, organizationId);
        await requirePermission(deps.store, caller, "compute:list", `organization:${organizationId}/computeNode:*`);
        reply.send(await deps.computeControlStore.listNodes(organizationId));
    });

    fastify.post("/organizations/:organizationId/compute/nodes", { preHandler: deps.authPreHandler }, async (request, reply) => {
        const { organizationId } = organizationParams.parse(request.params);
        const caller = await requireOrgUser(deps, request, organizationId);
        await requirePermission(deps.store, caller, "compute:manageNodes", `organization:${organizationId}/computeNode:*`);
        reply.code(201).send(await deps.computeControlStore.registerNode(organizationId, registerNodeBody.parse(request.body), actorFrom(caller)));
    });

    fastify.post("/organizations/:organizationId/compute/nodes/:nodeId/state", { preHandler: deps.authPreHandler }, async (request, reply) => {
        const { organizationId, nodeId } = nodeParams.parse(request.params);
        const body = nodeStateBody.parse(request.body);
        const caller = await requireOrgUser(deps, request, organizationId);
        const action = body.state === "quarantined" ? "compute:manageCritical" : "compute:manageNodes";
        await requirePermission(deps.store, caller, action, `organization:${organizationId}/computeNode:${nodeId}`);
        const node = await deps.computeControlStore.setNodeState(organizationId, nodeId, body.state, actorFrom(caller));
        if (!node) return reply.code(404).send({ error: "not_found" });
        reply.send(node);
    });

    fastify.post("/organizations/:organizationId/compute/nodes/:nodeId/heartbeat", { preHandler: deps.authPreHandler }, async (request, reply) => {
        const { organizationId, nodeId } = nodeParams.parse(request.params);
        await requireAgentNode(deps, request, organizationId, nodeId);
        const node = await deps.computeControlStore.heartbeat(organizationId, nodeId, nodeHeartbeatSchema.parse(request.body));
        if (!node) return reply.code(404).send({ error: "not_found" });
        reply.send({ accepted: true, nodeState: node.state, policyRefreshRequired: false });
    });

    fastify.get("/organizations/:organizationId/compute/nodes/:nodeId/assignments", { preHandler: deps.authPreHandler }, async (request, reply) => {
        const { organizationId, nodeId } = nodeParams.parse(request.params);
        await requireAgentNode(deps, request, organizationId, nodeId);
        const leases = (await deps.computeControlStore.listLeases(organizationId, { nodeId }))
            .filter((lease) => ["offered", "acknowledged", "running"].includes(lease.state));
        const requests = await deps.computeControlStore.listRequests(organizationId);
        const requestById = new Map(requests.map((item) => [item.id, item]));
        const poolIds = [...new Set(leases.map((lease) => lease.poolId))];
        const policies = (await Promise.all(poolIds.map((poolId) => deps.computeControlStore.listPolicies(organizationId, poolId))))
            .flat().filter((policy) => policy.status === "active" && policy.expiresAt > new Date().toISOString());
        reply.send({ assignments: leases.map((lease) => ({ lease, request: requestById.get(lease.requestId) })).filter((item) => item.request), policies });
    });

    fastify.get("/organizations/:organizationId/compute/pools", { preHandler: deps.authPreHandler }, async (request, reply) => {
        const { organizationId } = organizationParams.parse(request.params);
        const caller = await requireOrgUser(deps, request, organizationId);
        await requirePermission(deps.store, caller, "compute:list", `organization:${organizationId}/computePool:*`);
        reply.send(await deps.computeControlStore.listPools(organizationId));
    });

    fastify.post("/organizations/:organizationId/compute/pools", { preHandler: deps.authPreHandler }, async (request, reply) => {
        const { organizationId } = organizationParams.parse(request.params);
        const caller = await requireOrgUser(deps, request, organizationId);
        await requirePermission(deps.store, caller, "compute:managePools", `organization:${organizationId}/computePool:*`);
        reply.code(201).send(await deps.computeControlStore.createPool(organizationId, createPoolBody.parse(request.body), actorFrom(caller)));
    });

    fastify.get("/organizations/:organizationId/compute/pools/:poolId/quota", { preHandler: deps.authPreHandler }, async (request, reply) => {
        const { organizationId, poolId } = poolParams.parse(request.params);
        const caller = await requireOrgUser(deps, request, organizationId);
        await requirePermission(deps.store, caller, "compute:list", `organization:${organizationId}/computePool:${poolId}`);
        const quota = await deps.computeControlStore.getQuota(organizationId, poolId);
        if (!quota) return reply.code(404).send({ error: "not_found" });
        reply.send(quota);
    });

    fastify.put("/organizations/:organizationId/compute/pools/:poolId/quota", { preHandler: deps.authPreHandler }, async (request, reply) => {
        const { organizationId, poolId } = poolParams.parse(request.params);
        const caller = await requireOrgUser(deps, request, organizationId);
        await requirePermission(deps.store, caller, "compute:manageCritical", `organization:${organizationId}/computePool:${poolId}`);
        reply.send(await deps.computeControlStore.upsertQuota(organizationId, { ...quotaBody.parse(request.body), poolId }, actorFrom(caller)));
    });

    fastify.get("/organizations/:organizationId/compute/policies", { preHandler: deps.authPreHandler }, async (request, reply) => {
        const { organizationId } = organizationParams.parse(request.params);
        const caller = await requireOrgUser(deps, request, organizationId);
        await requirePermission(deps.store, caller, "compute:list", `organization:${organizationId}/computePolicy:*`);
        const poolId = (request.query as { poolId?: string }).poolId;
        reply.send(await deps.computeControlStore.listPolicies(organizationId, poolId));
    });

    fastify.post("/organizations/:organizationId/compute/policies", { preHandler: deps.authPreHandler }, async (request, reply) => {
        const { organizationId } = organizationParams.parse(request.params);
        const caller = await requireOrgUser(deps, request, organizationId);
        await requirePermission(deps.store, caller, "compute:managePolicies", `organization:${organizationId}/computePolicy:*`);
        const body = createPolicyBody.parse(request.body);
        const verification = deps.verifyComputePolicySignature(organizationId, body);
        if (verification === "unconfigured") return reply.code(503).send({ error: "compute_policy_trust_unconfigured", message: "Compute policy signing trust is not configured on this server." });
        if (verification === "invalid") return reply.code(400).send({ error: "invalid_compute_policy_signature", message: "The resource policy signature is invalid for this organization and payload." });
        reply.code(201).send(await deps.computeControlStore.createPolicy(organizationId, body, actorFrom(caller)));
    });

    fastify.post("/organizations/:organizationId/compute/policies/:policyId/activate", { preHandler: deps.authPreHandler }, async (request, reply) => {
        const { organizationId, policyId } = policyParams.parse(request.params);
        const caller = await requireOrgUser(deps, request, organizationId);
        await requirePermission(deps.store, caller, "compute:managePolicies", `organization:${organizationId}/computePolicy:${policyId}`);
        const policy = await deps.computeControlStore.activatePolicy(organizationId, policyId, actorFrom(caller));
        if (!policy) return reply.code(404).send({ error: "not_found" });
        reply.send(policy);
    });

    fastify.post("/organizations/:organizationId/compute/requests", { preHandler: deps.authPreHandler }, async (request, reply) => {
        const { organizationId } = organizationParams.parse(request.params);
        const caller = await requireOrgUser(deps, request, organizationId);
        await requirePermission(deps.store, caller, "compute:submit", `organization:${organizationId}/computeRequest:*`);
        const elapsed = startTimer();
        const result = await deps.computeControlPlane.submit(organizationId, submitRequestBody.parse(request.body), actorFrom(caller), { allowSafePreemption: true });
        const decisionStatus = result.decision.status;
        computeSchedulingDecisionDuration.observe({ result: decisionStatus }, elapsed());
        computeSchedulingDecisions.inc({ result: decisionStatus });
        reply.code(201).send(result);
    });

    fastify.get("/organizations/:organizationId/compute/requests", { preHandler: deps.authPreHandler }, async (request, reply) => {
        const { organizationId } = organizationParams.parse(request.params);
        const caller = await requireOrgUser(deps, request, organizationId);
        await requirePermission(deps.store, caller, "compute:list", `organization:${organizationId}/computeRequest:*`);
        const query = request.query as { poolId?: string; state?: ComputeResourceRequest["state"] };
        reply.send(await deps.computeControlStore.listRequests(organizationId, query));
    });

    fastify.post("/organizations/:organizationId/compute/requests/:requestId/cancel", { preHandler: deps.authPreHandler }, async (request, reply) => {
        const { organizationId, requestId } = requestParams.parse(request.params);
        const caller = await requireOrgUser(deps, request, organizationId);
        await requirePermission(deps.store, caller, "compute:submit", `organization:${organizationId}/computeRequest:${requestId}`);
        const cancelled = await deps.computeControlStore.cancelRequest(organizationId, requestId, actorFrom(caller));
        if (!cancelled) return reply.code(404).send({ error: "not_found" });
        reply.send(cancelled);
    });

    fastify.get("/organizations/:organizationId/compute/leases", { preHandler: deps.authPreHandler }, async (request, reply) => {
        const { organizationId } = organizationParams.parse(request.params);
        const caller = await requireOrgUser(deps, request, organizationId);
        await requirePermission(deps.store, caller, "compute:list", `organization:${organizationId}/computeLease:*`);
        reply.send(await deps.computeControlStore.listLeases(organizationId, request.query as never));
    });

    fastify.post("/organizations/:organizationId/compute/leases/:leaseId/acknowledge", { preHandler: deps.authPreHandler }, async (request, reply) => {
        const { organizationId, leaseId } = leaseParams.parse(request.params);
        const lease = await deps.computeControlStore.getLease(organizationId, leaseId);
        if (!lease) return reply.code(404).send({ error: "not_found" });
        const caller = await requireAgentNode(deps, request, organizationId, lease.nodeId);
        const updated = await deps.computeControlStore.acknowledgeLease(organizationId, leaseId, fencingBody.parse(request.body).fencingToken, actorFrom(caller));
        if (!updated) return reply.code(409).send({ error: "stale_or_expired_lease" });
        reply.send(updated);
    });

    fastify.post("/organizations/:organizationId/compute/leases/:leaseId/renew", { preHandler: deps.authPreHandler }, async (request, reply) => {
        const { organizationId, leaseId } = leaseParams.parse(request.params);
        const lease = await deps.computeControlStore.getLease(organizationId, leaseId);
        if (!lease) return reply.code(404).send({ error: "not_found" });
        await requireAgentNode(deps, request, organizationId, lease.nodeId);
        const updated = await deps.computeControlStore.renewLease(organizationId, leaseId, fencingBody.parse(request.body).fencingToken);
        if (!updated) return reply.code(409).send({ error: "stale_or_expired_lease" });
        reply.send(updated);
    });

    fastify.post("/organizations/:organizationId/compute/leases/:leaseId/release", { preHandler: deps.authPreHandler }, async (request, reply) => {
        const { organizationId, leaseId } = leaseParams.parse(request.params);
        const lease = await deps.computeControlStore.getLease(organizationId, leaseId);
        if (!lease) return reply.code(404).send({ error: "not_found" });
        const caller = await requireAgentNode(deps, request, organizationId, lease.nodeId);
        const body = releaseBody.parse(request.body);
        const updated = await deps.computeControlStore.releaseLease(organizationId, leaseId, body.fencingToken, body.outcome, actorFrom(caller));
        if (!updated) return reply.code(409).send({ error: "stale_or_expired_lease" });
        reply.send(updated);
    });

    fastify.get("/organizations/:organizationId/compute/summary", { preHandler: deps.authPreHandler }, async (request, reply) => {
        const { organizationId } = organizationParams.parse(request.params);
        const caller = await requireOrgUser(deps, request, organizationId);
        await requirePermission(deps.store, caller, "compute:list", `organization:${organizationId}/computeSummary`);
        const [nodes, pools, requests, leases] = await Promise.all([
            deps.computeControlStore.listNodes(organizationId), deps.computeControlStore.listPools(organizationId),
            deps.computeControlStore.listRequests(organizationId), deps.computeControlStore.listLeases(organizationId),
        ]);
        reply.send({
            nodes: { total: nodes.length, online: nodes.filter((node) => node.state === "online").length },
            capacity: { cpuThreads: nodes.reduce((sum, node) => sum + node.cpuThreads, 0), ramMB: nodes.reduce((sum, node) => sum + node.totalRamMB, 0), accelerators: nodes.reduce((sum, node) => sum + node.devices.length, 0) },
            pools: pools.length, queuedRequests: requests.filter((item) => item.state === "queued").length,
            activeLeases: leases.filter((item) => ["offered", "acknowledged", "running"].includes(item.state)).length,
        });
    });
}
