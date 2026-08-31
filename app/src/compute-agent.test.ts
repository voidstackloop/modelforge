import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ComputeResourceLease } from "@modelforge/contracts";

const { acquireMock, releaseMock, heartbeatMock } = vi.hoisted(() => ({
    acquireMock: vi.fn(),
    releaseMock: vi.fn(),
    heartbeatMock: vi.fn(),
}));

vi.mock("./resource-orchestrator", async () => {
    const actual = await vi.importActual<typeof import("./resource-orchestrator")>("./resource-orchestrator");
    return {
        ...actual,
        captureHardwareSnapshot: vi.fn(async () => ({
            capturedAt: Date.now(),
            cpuThreads: 8,
            availableCpuThreads: 6,
            totalRamMB: 16_000,
            availableRamMB: 10_000,
            gpus: [{ id: "gpu-0", vendor: "nvidia", totalVramMB: 8_000, availableVramMB: 6_000, computeAvailable: true }],
        })),
        mainResourceOrchestrator: {
            acquire: acquireMock,
            release: releaseMock,
            heartbeat: heartbeatMock,
        },
    };
});

vi.mock("./compute-agent-client", () => ({
    sendHeartbeat: vi.fn(async () => ({ accepted: true, nodeState: "online", policyRefreshRequired: false })),
    getAssignments: vi.fn(async () => ({ assignments: [], policies: [] })),
    acknowledgeLease: vi.fn(async () => ({})),
    renewLease: vi.fn(async (leaseId: string) => ({ fencingToken: "999" })),
    releaseLease: vi.fn(async () => ({})),
}));

vi.mock("./settings-store", () => ({
    getSettings: vi.fn(() => ({ computeAgentEnabled: true, computeNodeId: "node-1" })),
}));

import * as agentClient from "./compute-agent-client";
import { getSettings } from "./settings-store";
import { ComputeAgent } from "./compute-agent";
import { ResourceAdmissionError } from "./resource-orchestrator";

function makeLease(overrides: Partial<ComputeResourceLease> = {}): ComputeResourceLease {
    return {
        id: "lease-1",
        requestId: "req-1",
        organizationId: "org-1",
        poolId: "pool-1",
        nodeId: "node-1",
        acceleratorDeviceIds: [],
        vramMBPerDevice: 0,
        exclusiveAccelerators: true,
        cpuThreads: 2,
        ramMB: 1_000,
        pinnedMemoryMB: 0,
        fencingToken: "1",
        state: "offered",
        acknowledgmentDeadlineAt: new Date(Date.now() + 15_000).toISOString(),
        renewalDeadlineAt: new Date(Date.now() + 30_000).toISOString(),
        expiresAt: new Date(Date.now() + 90_000).toISOString(),
        explanation: { hardFilterReasons: [], score: 0, scoreReasons: [], degradedToCpu: false, borrowedCapacity: false },
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        ...overrides,
    } as ComputeResourceLease;
}

describe("ComputeAgent", () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.clearAllMocks();
        vi.mocked(getSettings).mockReturnValue({ computeAgentEnabled: true, computeNodeId: "node-1" } as ReturnType<typeof getSettings>);
        vi.mocked(agentClient.getAssignments).mockResolvedValue({ assignments: [], policies: [] });
        vi.mocked(agentClient.sendHeartbeat).mockResolvedValue({ accepted: true, nodeState: "online", policyRefreshRequired: false });
    });

    afterEach(async () => {
        vi.useRealTimers();
    });

    it("does nothing when disabled", async () => {
        vi.mocked(getSettings).mockReturnValue({ computeAgentEnabled: false } as ReturnType<typeof getSettings>);
        const agent = new ComputeAgent();
        agent.start();
        await vi.advanceTimersByTimeAsync(0);
        expect(agentClient.sendHeartbeat).not.toHaveBeenCalled();
        await agent.stop();
    });

    it("does nothing when no node id is configured", async () => {
        vi.mocked(getSettings).mockReturnValue({ computeAgentEnabled: true } as ReturnType<typeof getSettings>);
        const agent = new ComputeAgent();
        agent.start();
        await vi.advanceTimersByTimeAsync(0);
        expect(agentClient.sendHeartbeat).not.toHaveBeenCalled();
        await agent.stop();
    });

    it("sends a heartbeat with the current hardware snapshot and node id", async () => {
        const agent = new ComputeAgent();
        agent.start();
        await vi.advanceTimersByTimeAsync(0);
        expect(agentClient.sendHeartbeat).toHaveBeenCalledWith("node-1", expect.objectContaining({
            nodeId: "node-1",
            freeCpuThreads: 6,
            freeRamMB: 10_000,
            devices: [expect.objectContaining({ id: "gpu-0", vendor: "nvidia" })],
            runningLeaseIds: [],
        }));
        await agent.stop();
    });

    it("accepts an offered lease it can reserve local capacity for, then acknowledges it", async () => {
        acquireMock.mockResolvedValue({ leaseId: "local-1" });
        const lease = makeLease({ state: "offered" });
        vi.mocked(agentClient.getAssignments).mockResolvedValue({ assignments: [{ lease, request: {} }], policies: [] });

        const agent = new ComputeAgent();
        agent.start();
        await vi.advanceTimersByTimeAsync(0);

        expect(acquireMock).toHaveBeenCalledWith(expect.objectContaining({
            workloadKind: "fleet-assigned",
            priority: "background-compute",
            requirements: expect.objectContaining({ cpuThreads: 2, ramMB: 1_000, allowCpuFallback: false }),
            queueIfUnavailable: false,
        }));
        expect(agentClient.acknowledgeLease).toHaveBeenCalledWith("lease-1", "1");
        await agent.stop();
    });

    it("declines an offer without acknowledging it when local capacity is unavailable", async () => {
        acquireMock.mockRejectedValue(new ResourceAdmissionError("rejected-insufficient-resources", "fleet:lease-1", ["no capacity"]));
        const lease = makeLease({ state: "offered" });
        vi.mocked(agentClient.getAssignments).mockResolvedValue({ assignments: [{ lease, request: {} }], policies: [] });

        const agent = new ComputeAgent();
        agent.start();
        await vi.advanceTimersByTimeAsync(0);

        expect(agentClient.acknowledgeLease).not.toHaveBeenCalled();
        await agent.stop();
    });

    it("releases the local reservation once a tracked lease disappears from assignments", async () => {
        acquireMock.mockResolvedValue({ leaseId: "local-1" });
        const offered = makeLease({ state: "offered" });
        vi.mocked(agentClient.getAssignments).mockResolvedValueOnce({ assignments: [{ lease: offered, request: {} }], policies: [] });

        const agent = new ComputeAgent();
        agent.start();
        await vi.advanceTimersByTimeAsync(0);
        expect(agentClient.acknowledgeLease).toHaveBeenCalled();

        vi.mocked(agentClient.getAssignments).mockResolvedValueOnce({ assignments: [], policies: [] });
        await vi.advanceTimersByTimeAsync(19_000);

        expect(releaseMock).toHaveBeenCalledWith("local-1");
        await agent.stop();
    });

    it("renews a tracked acknowledged lease on the next cycle", async () => {
        acquireMock.mockResolvedValue({ leaseId: "local-1" });
        const offered = makeLease({ state: "offered" });
        vi.mocked(agentClient.getAssignments).mockResolvedValueOnce({ assignments: [{ lease: offered, request: {} }], policies: [] });

        const agent = new ComputeAgent();
        agent.start();
        await vi.advanceTimersByTimeAsync(0);

        const acknowledged = makeLease({ state: "acknowledged" });
        vi.mocked(agentClient.getAssignments).mockResolvedValueOnce({ assignments: [{ lease: acknowledged, request: {} }], policies: [] });
        await vi.advanceTimersByTimeAsync(19_000);

        expect(heartbeatMock).toHaveBeenCalledWith("local-1");
        expect(agentClient.renewLease).toHaveBeenCalledWith("lease-1", "1");
        await agent.stop();
    });

    it("stop() releases every tracked lease both locally and server-side", async () => {
        acquireMock.mockResolvedValue({ leaseId: "local-1" });
        const offered = makeLease({ state: "offered" });
        vi.mocked(agentClient.getAssignments).mockResolvedValue({ assignments: [{ lease: offered, request: {} }], policies: [] });

        const agent = new ComputeAgent();
        agent.start();
        await vi.advanceTimersByTimeAsync(0);
        await agent.stop();

        expect(releaseMock).toHaveBeenCalledWith("local-1");
        expect(agentClient.releaseLease).toHaveBeenCalledWith("lease-1", "1", "cancelled");
    });
});
