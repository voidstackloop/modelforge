import { describe, expect, it } from "vitest";
import { ComputeControlPlane } from "../compute/control-plane.js";
import { InMemoryComputeControlStore } from "./compute-control-store.js";

const ORG = "00000000-0000-4000-8000-000000000001";
const NODE = "00000000-0000-4000-8000-000000000003";
const actor = { userId: "user", externalSubject: "idp|user" };

describe("InMemoryComputeControlStore", () => {
    it("issues fenced leases and rejects stale renewal tokens", async () => {
        let now = new Date("2026-08-30T12:00:00.000Z");
        const store = new InMemoryComputeControlStore(undefined, () => now);
        await store.registerNode(ORG, {
            id: NODE, name: "node", region: "eu-tr", labels: {}, operatingSystem: "linux", architecture: "x64", agentVersion: "1",
            certificateFingerprint: "fp", cpuThreads: 16, freeCpuThreads: 15, totalRamMB: 32_768, freeRamMB: 30_000, numaNodes: 1,
            supportedRuntimes: ["llamacpp"], warmModelIds: [], inventoryVersion: "1", devices: [{ id: "gpu", nodeId: NODE, vendor: "nvidia",
                model: "gpu", totalVramMB: 12_000, freeVramMB: 12_000, sharingMode: "exclusive", maxConcurrency: 1, health: "healthy",
                supportedRuntimes: ["llamacpp"], throttled: false }],
        }, actor);
        const pool = await store.createPool(ORG, { name: "pool", region: "eu-tr", labels: {}, nodeIds: [NODE], status: "active", schedulingPolicy: "interactive-first" }, actor);
        const control = new ComputeControlPlane(store, undefined, () => now);
        const result = await control.submit(ORG, {
            poolId: pool.id, workloadKind: "inference", priority: "interactive", profile: "interactive",
            requirements: { cpuThreads: 4, ramMB: 2_000, pinnedMemoryMB: 0, acceleratorCount: 1, acceleratorDeviceIds: [],
                vramMBPerDevice: 4_000, sameNumaNode: false, sameVendor: true, exclusiveAccelerators: true, runtime: "llamacpp", allowCpuFallback: false },
            checkpointable: false, restartable: false,
        }, actor);
        expect(result.lease?.fencingToken).toBe("1");
        expect(await store.renewLease(ORG, result.lease!.id, "0")).toBeNull();
        expect((await store.acknowledgeLease(ORG, result.lease!.id, "1", actor))?.state).toBe("running");
        now = new Date("2026-08-30T12:00:20.000Z");
        expect((await store.renewLease(ORG, result.lease!.id, "1"))?.expiresAt).toBe("2026-08-30T12:01:50.000Z");
    });

    it("requeues an assignment that misses its acknowledgement deadline", async () => {
        let now = new Date("2026-08-30T12:00:00.000Z");
        const store = new InMemoryComputeControlStore(undefined, () => now);
        await store.registerNode(ORG, { id: NODE, name: "cpu", region: "eu-tr", labels: {}, operatingSystem: "linux", architecture: "x64", agentVersion: "1", certificateFingerprint: "fp", cpuThreads: 8, freeCpuThreads: 7, totalRamMB: 16_000, freeRamMB: 14_000, numaNodes: 1, supportedRuntimes: ["llamacpp"], warmModelIds: [], inventoryVersion: "1", devices: [] }, actor);
        const pool = await store.createPool(ORG, { name: "pool", region: "eu-tr", labels: {}, nodeIds: [NODE], status: "active", schedulingPolicy: "interactive-first" }, actor);
        const result = await new ComputeControlPlane(store, undefined, () => now).submit(ORG, { poolId: pool.id, workloadKind: "cpu", priority: "background", profile: "balanced", requirements: { cpuThreads: 1, ramMB: 100, pinnedMemoryMB: 0, acceleratorCount: 0, acceleratorDeviceIds: [], vramMBPerDevice: 0, sameNumaNode: false, sameVendor: true, exclusiveAccelerators: false, runtime: "llamacpp", allowCpuFallback: false }, checkpointable: true, restartable: true }, actor);
        now = new Date("2026-08-30T12:00:16.000Z");
        expect(await store.sweepExpired(now.toISOString())).toEqual([result.lease!.id]);
        expect((await store.getRequest(ORG, result.request.id))?.state).toBe("queued");
    });
});
