import { describe, expect, it } from "vitest";
import type { ComputeNode, ComputeResourceLease, ComputeResourceRequest, ResourcePool, TenantComputeQuota } from "@modelforge/contracts";
import { ComputeScheduler, type SchedulerSnapshot } from "./scheduler.js";

const NOW = "2026-08-30T12:00:00.000Z";
const ORG = "00000000-0000-4000-8000-000000000001";
const POOL = "00000000-0000-4000-8000-000000000002";
const NODE = "00000000-0000-4000-8000-000000000003";

function node(): ComputeNode {
    const devices = ["gpu-a", "gpu-b"].map((id, index) => ({
        id, nodeId: NODE, vendor: "nvidia" as const, model: "RTX", totalVramMB: 16_384, freeVramMB: 16_384,
        numaNode: 0, sharingMode: "exclusive" as const, maxConcurrency: 1, health: "healthy" as const,
        supportedRuntimes: ["llamacpp" as const], utilizationPercent: 0, temperatureC: 45, throttled: false,
    }));
    return {
        id: NODE, organizationId: ORG, name: "node", region: "eu-tr", labels: {}, operatingSystem: "linux", architecture: "x64",
        agentVersion: "1.0.0", certificateFingerprint: "fp", state: "online", cpuThreads: 32, freeCpuThreads: 31,
        totalRamMB: 65_536, freeRamMB: 60_000, numaNodes: 1, supportedRuntimes: ["llamacpp"], warmModelIds: ["model-4b"],
        devices, lastHeartbeatAt: NOW, inventoryVersion: "1", createdAt: NOW, updatedAt: NOW,
    };
}

function pool(): ResourcePool {
    return { id: POOL, organizationId: ORG, name: "pool", region: "eu-tr", labels: {}, nodeIds: [NODE], status: "active", schedulingPolicy: "interactive-first", createdAt: NOW, updatedAt: NOW };
}

function request(overrides: Partial<ComputeResourceRequest> = {}): ComputeResourceRequest {
    return {
        id: "00000000-0000-4000-8000-000000000010", organizationId: ORG, poolId: POOL, workloadKind: "inference", priority: "interactive",
        profile: "interactive", state: "queued", requirements: { cpuThreads: 4, ramMB: 4_096, pinnedMemoryMB: 0, acceleratorCount: 1,
            acceleratorDeviceIds: [], acceleratorVendor: "nvidia", vramMBPerDevice: 4_096, sameNumaNode: false, sameVendor: true,
            exclusiveAccelerators: true, runtime: "llamacpp", modelId: "model-4b", allowCpuFallback: false },
        checkpointable: false, restartable: false, queuedAt: "2026-08-30T11:59:30.000Z", updatedAt: NOW, ...overrides,
    };
}

function lease(id: string, requestId: string, deviceId: string): ComputeResourceLease {
    return {
        id, requestId, organizationId: ORG, poolId: POOL, nodeId: NODE, acceleratorDeviceIds: [deviceId], vramMBPerDevice: 4_096,
        exclusiveAccelerators: true, cpuThreads: 4, ramMB: 4_096, pinnedMemoryMB: 0, fencingToken: "1", state: "running",
        acknowledgedAt: NOW, acknowledgmentDeadlineAt: NOW, renewalDeadlineAt: "2026-08-30T12:00:30.000Z", expiresAt: "2026-08-30T12:01:30.000Z",
        explanation: { hardFilterReasons: [], score: 1, scoreReasons: [], degradedToCpu: false, borrowedCapacity: false }, createdAt: NOW, updatedAt: NOW,
    };
}

function snapshot(activeLeases: ComputeResourceLease[] = [], activeRequests: ComputeResourceRequest[] = [], quota?: TenantComputeQuota): SchedulerSnapshot {
    return { nodes: [node()], pool: pool(), activeLeases, activeRequests, quota, now: NOW };
}

function quota(weight: number): TenantComputeQuota {
    // Zero reservation makes every request "borrowed" against burst
    // capacity, so the borrowed-capacity penalty (and this weight's effect
    // on it) is exercised deterministically regardless of usage history.
    return {
        organizationId: ORG, poolId: POOL, reservedCpuThreads: 0, reservedRamMB: 0, reservedAccelerators: 0,
        burstCpuThreads: 64, burstRamMB: 131_072, burstAccelerators: 8, weight, borrowingEnabled: true, updatedAt: NOW,
    };
}

describe("ComputeScheduler", () => {
    it("uses a second GPU while an independent exclusive device is leased", () => {
        const decision = new ComputeScheduler().schedule(request(), snapshot([lease("lease-a", "active-a", "gpu-a")]));
        expect(decision.status).toBe("placed");
        if (decision.status === "placed") expect(decision.placement.acceleratorDeviceIds).toEqual(["gpu-b"]);
    });

    it("gang-schedules multi-GPU requests atomically", () => {
        const gang = request({ requirements: { ...request().requirements, acceleratorCount: 2 } });
        const decision = new ComputeScheduler().schedule(gang, snapshot([lease("lease-a", "active-a", "gpu-a")]));
        expect(decision.status).toBe("queued");
    });

    it("never substitutes a stale explicit device id", () => {
        const explicit = request({ requirements: { ...request().requirements, acceleratorDeviceIds: ["gpu-stale"] } });
        const decision = new ComputeScheduler().schedule(explicit, snapshot());
        expect(decision.status).toBe("queued");
        if (decision.status !== "placed") expect(decision.reasons.join(" ")).toContain("gpu-stale");
    });

    it("preempts only restartable or checkpointable non-interactive work", () => {
        const background = request({ id: "active-a", priority: "background", state: "running", restartable: true });
        const bothBusy = [lease("lease-a", "active-a", "gpu-a"), lease("lease-b", "active-b", "gpu-b")];
        const other = request({ id: "active-b", priority: "background", state: "running", restartable: false });
        const decision = new ComputeScheduler().schedule(request(), snapshot(bothBusy, [background, other]), { allowSafePreemption: true });
        expect(decision.status).toBe("placed");
        if (decision.status === "placed") expect(decision.placement.preemptLeaseIds).toEqual(["lease-a"]);
    });

    it("penalizes borrowed capacity less for a higher fair-share weight", () => {
        const lowWeight = new ComputeScheduler().schedule(request(), snapshot([], [], quota(1)));
        const highWeight = new ComputeScheduler().schedule(request(), snapshot([], [], quota(4)));
        expect(lowWeight.status).toBe("placed");
        expect(highWeight.status).toBe("placed");
        if (lowWeight.status === "placed" && highWeight.status === "placed") {
            expect(highWeight.placement.score).toBeGreaterThan(lowWeight.placement.score);
            expect(highWeight.placement.explanation.scoreReasons.join(" ")).toContain("fair-share weight of 4");
        }
    });

    it("falls back to an unscaled penalty for a malformed weight", () => {
        const decision = new ComputeScheduler().schedule(request(), snapshot([], [], quota(0)));
        expect(decision.status).toBe("placed");
        if (decision.status === "placed") {
            expect(decision.placement.explanation.scoreReasons.join(" ")).toContain("penalized behind reserved capacity.");
            expect(decision.placement.explanation.scoreReasons.join(" ")).not.toContain("fair-share weight");
        }
    });

    it("rejects a request that exceeds an active hard policy", () => {
        const decision = new ComputeScheduler().schedule(request(), {
            ...snapshot(),
            policy: { id: "policy", organizationId: ORG, poolId: POOL, name: "guardrails", version: 1, status: "active",
                hardLimits: { maxCpuThreads: 2 }, workloadClassLimits: {}, signature: "signed", issuedAt: "2026-08-30T00:00:00.000Z",
                expiresAt: "2026-09-30T00:00:00.000Z", createdAt: NOW },
        });
        expect(decision.status).toBe("rejected");
    });
});
