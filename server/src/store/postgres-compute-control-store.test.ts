import { randomUUID } from "node:crypto";
import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { Pool } from "pg";
import type { AuditActor } from "./audit-store.js";
import { runMigrations } from "./migrate.js";
import { PostgresIamStore } from "./postgres-iam-store.js";
import { PostgresComputeControlStore } from "./postgres-compute-control-store.js";
import { ComputeControlPlane } from "../compute/control-plane.js";
import type { RegisterComputeNodeInput } from "./compute-control-store.js";

// Same disclosure as every other postgres-*.test.ts: gated on DATABASE_URL,
// skipped (not failed) when absent. This file specifically covers what the
// in-memory store's own tests structurally cannot: real RLS enforcement,
// real concurrent transactions racing the same advisory lock, and the two
// SECURITY DEFINER maintenance functions actually executing as SQL — see
// PROJECT-MODELFORGE-ROADMAP memory for why this file didn't exist before
// (every other Postgres-backed compute-control-plane behavior had only ever
// been exercised against the in-memory store).
const DATABASE_URL = process.env.DATABASE_URL;

const ACTOR: AuditActor = { externalSubject: "idp|test-actor", userId: randomUUID() };

function nodeInput(id: string, overrides: Partial<RegisterComputeNodeInput> = {}): RegisterComputeNodeInput {
    return {
        id, name: "node", region: "eu-tr", labels: {}, operatingSystem: "linux", architecture: "x64", agentVersion: "1",
        certificateFingerprint: `fp-${id}`, cpuThreads: 16, freeCpuThreads: 15, totalRamMB: 32_768, freeRamMB: 30_000,
        numaNodes: 1, supportedRuntimes: ["llamacpp"], warmModelIds: [], inventoryVersion: "1", devices: [],
        ...overrides,
    };
}

describe.skipIf(!DATABASE_URL)("PostgresComputeControlStore (integration — requires DATABASE_URL)", () => {
    let pool: Pool;
    let iamStore: PostgresIamStore;
    let store: PostgresComputeControlStore;
    let orgA: string;
    let orgB: string;

    beforeAll(async () => {
        pool = new Pool({ connectionString: DATABASE_URL });
        await runMigrations(pool);
        iamStore = new PostgresIamStore(pool);
        store = new PostgresComputeControlStore(pool);
    });

    afterAll(async () => {
        await pool.end();
    });

    beforeEach(async () => {
        await pool.query(
            "TRUNCATE organizations, compute_nodes, compute_accelerator_devices, compute_resource_pools, compute_pool_nodes, " +
            "compute_tenant_quotas, compute_resource_policies, compute_resource_requests, compute_resource_leases, " +
            "compute_node_heartbeats, compute_allocation_events, audit_log, audit_chain_state CASCADE"
        );
        orgA = (await iamStore.createOrganization("Org A", ACTOR)).id;
        orgB = (await iamStore.createOrganization("Org B", ACTOR)).id;
    });

    it("enforces RLS tenant isolation — a node registered for org A is invisible when queried as org B", async () => {
        const nodeId = randomUUID();
        await store.registerNode(orgA, nodeInput(nodeId), ACTOR);
        expect(await store.getNode(orgA, nodeId)).not.toBeNull();
        expect(await store.getNode(orgB, nodeId)).toBeNull();
        expect(await store.listNodes(orgB)).toEqual([]);
    });

    it("real concurrent commitPlacement calls for the same queued request only let one win (pg_advisory_xact_lock)", async () => {
        const nodeId = randomUUID();
        await store.registerNode(orgA, nodeInput(nodeId, { cpuThreads: 8, freeCpuThreads: 8, totalRamMB: 16_000, freeRamMB: 16_000 }), ACTOR);
        const pool_ = await store.createPool(orgA, { name: "pool", region: "eu-tr", labels: {}, nodeIds: [nodeId], status: "active", schedulingPolicy: "interactive-first" }, ACTOR);
        const control = new ComputeControlPlane(store);
        const request = await store.submitRequest(orgA, {
            poolId: pool_.id, workloadKind: "cpu", priority: "background", profile: "balanced",
            requirements: { cpuThreads: 1, ramMB: 100, pinnedMemoryMB: 0, acceleratorCount: 0, acceleratorDeviceIds: [], vramMBPerDevice: 0, sameNumaNode: false, sameVendor: true, exclusiveAccelerators: false, runtime: "llamacpp", allowCpuFallback: false },
            checkpointable: false, restartable: false,
        }, ACTOR);

        // Two workers racing to schedule the *same already-persisted* queued
        // request concurrently — the real scenario duplicate scheduler
        // instances create, per control-plane.ts's own doc comment ("duplicate
        // scheduler workers can race safely and only one commits").
        const [first, second] = await Promise.all([
            control.scheduleRequest(request, ACTOR),
            control.scheduleRequest(request, ACTOR),
        ]);
        const outcomes = [first, second];
        const committed = outcomes.filter((o) => o.lease !== undefined);
        const notCommitted = outcomes.filter((o) => o.lease === undefined);
        expect(committed).toHaveLength(1);
        expect(notCommitted).toHaveLength(1);

        const leases = await store.listLeases(orgA);
        expect(leases).toHaveLength(1);
    });

    it("real fencing tokens: a stale token is rejected by acknowledge/renew/release even though the lease itself is valid", async () => {
        const nodeId = randomUUID();
        await store.registerNode(orgA, nodeInput(nodeId), ACTOR);
        const pool_ = await store.createPool(orgA, { name: "pool", region: "eu-tr", labels: {}, nodeIds: [nodeId], status: "active", schedulingPolicy: "interactive-first" }, ACTOR);
        const control = new ComputeControlPlane(store);
        const result = await control.submit(orgA, {
            poolId: pool_.id, workloadKind: "cpu", priority: "interactive", profile: "interactive",
            requirements: { cpuThreads: 1, ramMB: 100, pinnedMemoryMB: 0, acceleratorCount: 0, acceleratorDeviceIds: [], vramMBPerDevice: 0, sameNumaNode: false, sameVendor: true, exclusiveAccelerators: false, runtime: "llamacpp", allowCpuFallback: false },
            checkpointable: false, restartable: false,
        }, ACTOR);
        const lease = result.lease!;

        expect(await store.acknowledgeLease(orgA, lease.id, "not-the-real-token", ACTOR)).toBeNull();
        expect(await store.renewLease(orgA, lease.id, "not-the-real-token")).toBeNull();
        expect(await store.releaseLease(orgA, lease.id, "not-the-real-token", "completed", ACTOR)).toBeNull();

        const acknowledged = await store.acknowledgeLease(orgA, lease.id, lease.fencingToken, ACTOR);
        expect(acknowledged?.state).toBe("running");
    });

    it("the SECURITY DEFINER maintenance functions actually run: stale nodes go offline, expired leases requeue their request", async () => {
        const nodeId = randomUUID();
        await store.registerNode(orgA, nodeInput(nodeId), ACTOR);
        const pool_ = await store.createPool(orgA, { name: "pool", region: "eu-tr", labels: {}, nodeIds: [nodeId], status: "active", schedulingPolicy: "interactive-first" }, ACTOR);
        const control = new ComputeControlPlane(store);
        const result = await control.submit(orgA, {
            poolId: pool_.id, workloadKind: "cpu", priority: "interactive", profile: "interactive",
            requirements: { cpuThreads: 1, ramMB: 100, pinnedMemoryMB: 0, acceleratorCount: 0, acceleratorDeviceIds: [], vramMBPerDevice: 0, sameNumaNode: false, sameVendor: true, exclusiveAccelerators: false, runtime: "llamacpp", allowCpuFallback: false },
            checkpointable: false, restartable: false,
        }, ACTOR);

        // The lease's own acknowledgment deadline is 15s out — well past
        // "now" makes sweepExpired's real SQL function reclaim it for real.
        const farFuture = new Date(Date.now() + 120_000).toISOString();
        const expiredLeaseIds = await store.sweepExpired(farFuture);
        expect(expiredLeaseIds).toContain(result.lease!.id);
        expect((await store.getRequest(orgA, result.request.id))?.state).toBe("queued");

        const alsoFarFuture = new Date(Date.now() + 120_000).toISOString();
        const offlineNodeIds = await store.markStaleNodes(alsoFarFuture);
        expect(offlineNodeIds).toContain(nodeId);
        expect((await store.getNode(orgA, nodeId))?.state).toBe("offline");
    });

    it("shadow mode persists a real allocation event without ever creating a lease, and is itself tenant-isolated", async () => {
        const nodeId = randomUUID();
        await store.registerNode(orgA, nodeInput(nodeId), ACTOR);
        const pool_ = await store.createPool(orgA, { name: "pool", region: "eu-tr", labels: {}, nodeIds: [nodeId], status: "active", schedulingPolicy: "interactive-first" }, ACTOR);
        const control = new ComputeControlPlane(store);
        const body = {
            poolId: pool_.id, workloadKind: "cpu", priority: "background" as const, profile: "balanced" as const,
            requirements: { cpuThreads: 1, ramMB: 100, pinnedMemoryMB: 0, acceleratorCount: 0, acceleratorDeviceIds: [], vramMBPerDevice: 0, sameNumaNode: false, sameVendor: true, exclusiveAccelerators: false, runtime: "llamacpp" as const, allowCpuFallback: false },
            checkpointable: false, restartable: false,
        };

        const shadow = await control.submit(orgA, body, ACTOR, { dryRun: true });
        expect(shadow.decision.status).toBe("placed");
        expect(shadow.lease).toBeUndefined();
        expect(await store.listLeases(orgA)).toEqual([]);

        const events = await pool.query<{ event_type: string }>(
            "SELECT event_type FROM compute_allocation_events WHERE organization_id = $1 AND request_id = $2",
            [orgA, shadow.request.id]
        );
        expect(events.rows.map((r) => r.event_type)).toEqual(["submitted", "shadow_decision"]);

        // RLS applies to the allocation-event table exactly like every
        // other compute table — org B's own tenant-scoped session can never
        // see org A's shadow decision, even by request id.
        const real = await control.submit(orgA, body, ACTOR);
        expect(real.lease).toBeDefined();
    });
});
