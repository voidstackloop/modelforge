import { describe, expect, it } from "vitest";
import type { HardwareSnapshot, ResourceDecision, WorkloadRequest } from "./resource-contracts";
import { ResourceOrchestrator } from "./resource-orchestrator";

function hardware(overrides: Partial<HardwareSnapshot> = {}): HardwareSnapshot {
    return {
        capturedAt: 1_000,
        cpuThreads: 8,
        availableCpuThreads: 7,
        totalRamMB: 32_768,
        availableRamMB: 24_576,
        gpus: [{
            id: "nvidia:gpu-1",
            vendor: "nvidia",
            totalVramMB: 16_384,
            availableVramMB: 14_000,
            computeAvailable: true,
        }],
        ...overrides,
    };
}

function acceleratorRequest(requestId: string, priority: WorkloadRequest["priority"] = "explicit-model-load"): WorkloadRequest {
    return {
        requestId,
        workloadKind: "model-load",
        priority,
        requirements: {
            cpuThreads: 1,
            accelerator: "preferred",
            allowCpuFallback: true,
            exclusiveAccelerator: true,
        },
    };
}

async function nextTurn(): Promise<void> {
    await new Promise<void>((resolve) => setImmediate(resolve));
}

describe("ResourceOrchestrator", () => {
    it("grants a typed lease and exposes only sanitized telemetry", async () => {
        const decisions: ResourceDecision[] = [];
        const orchestrator = new ResourceOrchestrator({
            hardwareProvider: async () => hardware(),
            idGenerator: (() => { let id = 0; return () => `id-${++id}`; })(),
            now: () => 2_000,
            sweepIntervalMs: 0,
        });
        orchestrator.onDecision((decision) => decisions.push(decision));

        const lease = await orchestrator.acquire(acceleratorRequest("patient-name-must-not-leak"));

        expect(lease).toMatchObject({
            requestId: "patient-name-must-not-leak",
            decision: "granted",
            budget: { acceleratorDeviceIds: ["nvidia:gpu-1"], exclusiveAccelerator: true },
        });
        expect(decisions.map((decision) => decision.status)).toEqual(["queued", "granted"]);
        const telemetry = orchestrator.getTelemetry();
        expect(telemetry.activeLeases).toHaveLength(1);
        expect(JSON.stringify(telemetry)).not.toContain("patient-name-must-not-leak");
        expect(telemetry.capacity).toMatchObject({ gpuCount: 1, availableGpuCount: 1 });
        orchestrator.shutdown();
    });

    it("serializes the primary accelerator and admits queued work by priority", async () => {
        const orchestrator = new ResourceOrchestrator({ hardwareProvider: async () => hardware(), sweepIntervalMs: 0 });
        const blocker = await orchestrator.acquire(acceleratorRequest("blocker"));
        const low = orchestrator.acquire(acceleratorRequest("low", "maintenance"));
        const high = orchestrator.acquire({ ...acceleratorRequest("high", "active-inference"), workloadKind: "active-inference" });
        await nextTurn();
        expect(orchestrator.getTelemetry().queuedRequests.map((item) => item.priority)).toEqual(["active-inference", "maintenance"]);

        orchestrator.release(blocker.leaseId);
        const highLease = await high;
        let lowGranted = false;
        void low.then(() => { lowGranted = true; });
        await nextTurn();
        expect(lowGranted).toBe(false);
        orchestrator.release(highLease.leaseId);
        const lowLease = await low;
        expect(lowLease.requestId).toBe("low");
        orchestrator.shutdown();
    });

    it("admits independent workloads concurrently on separate GPU ids", async () => {
        const twoGpuHardware = hardware({ gpus: [
            ...hardware().gpus,
            { id: "nvidia:gpu-2", vendor: "nvidia", totalVramMB: 16_384, availableVramMB: 14_000, computeAvailable: true },
        ] });
        const orchestrator = new ResourceOrchestrator({ hardwareProvider: async () => twoGpuHardware, sweepIntervalMs: 0 });
        const first = await orchestrator.acquire({ ...acceleratorRequest("first"), requirements: { ...acceleratorRequest("first").requirements, acceleratorDeviceIds: ["nvidia:gpu-1"] } });
        const second = await orchestrator.acquire({ ...acceleratorRequest("second"), requirements: { ...acceleratorRequest("second").requirements, acceleratorDeviceIds: ["nvidia:gpu-2"] } });
        expect(first.budget.acceleratorDeviceIds).toEqual(["nvidia:gpu-1"]);
        expect(second.budget.acceleratorDeviceIds).toEqual(["nvidia:gpu-2"]);
        expect(orchestrator.getTelemetry().activeLeases).toHaveLength(2);
        orchestrator.shutdown();
    });

    it("grants explicit multi-GPU groups atomically and waits when any member is busy", async () => {
        const twoGpuHardware = hardware({ gpus: [
            ...hardware().gpus,
            { id: "nvidia:gpu-2", vendor: "nvidia", totalVramMB: 16_384, availableVramMB: 14_000, computeAvailable: true },
        ] });
        const orchestrator = new ResourceOrchestrator({ hardwareProvider: async () => twoGpuHardware, sweepIntervalMs: 0 });
        const blocker = await orchestrator.acquire({ ...acceleratorRequest("blocker"), requirements: { ...acceleratorRequest("blocker").requirements, acceleratorDeviceIds: ["nvidia:gpu-1"] } });
        const gangPromise = orchestrator.acquire({ ...acceleratorRequest("gang"), requirements: { ...acceleratorRequest("gang").requirements, acceleratorDeviceIds: ["nvidia:gpu-1", "nvidia:gpu-2"] } });
        await nextTurn();
        expect(orchestrator.getTelemetry().queuedRequests).toHaveLength(1);
        orchestrator.release(blocker.leaseId);
        expect((await gangPromise).budget.acceleratorDeviceIds).toEqual(["nvidia:gpu-1", "nvidia:gpu-2"]);
        orchestrator.shutdown();
    });

    it("allows CPU workloads to run concurrently within CPU and RAM budgets", async () => {
        const orchestrator = new ResourceOrchestrator({ hardwareProvider: async () => hardware({ gpus: [] }), sweepIntervalMs: 0 });
        const request = (requestId: string): WorkloadRequest => ({
            requestId,
            workloadKind: "embedding",
            priority: "background-compute",
            requirements: { cpuThreads: 3, ramMB: 1_024, accelerator: "none" },
        });

        const [first, second] = await Promise.all([orchestrator.acquire(request("first")), orchestrator.acquire(request("second"))]);
        expect(orchestrator.getTelemetry().activeLeases).toHaveLength(2);
        orchestrator.release(first.leaseId);
        orchestrator.release(second.leaseId);
        orchestrator.shutdown();
    });

    it("degrades a preferred accelerator request to CPU when no GPU exists", async () => {
        const orchestrator = new ResourceOrchestrator({ hardwareProvider: async () => hardware({ gpus: [] }), sweepIntervalMs: 0 });
        const lease = await orchestrator.acquire(acceleratorRequest("fallback"));
        expect(lease.decision).toBe("granted-degraded");
        expect(lease.budget.acceleratorDeviceIds).toEqual([]);
        expect(lease.reasons[0]).toContain("CPU fallback");
        orchestrator.shutdown();
    });

    it("rejects incompatible devices and impossible memory requests", async () => {
        const orchestrator = new ResourceOrchestrator({ hardwareProvider: async () => hardware(), sweepIntervalMs: 0 });
        await expect(orchestrator.acquire({
            requestId: "missing-gpu",
            workloadKind: "active-inference",
            priority: "active-inference",
            requirements: { accelerator: "required", acceleratorDeviceIds: ["nvidia:missing"] },
        })).rejects.toMatchObject({ status: "rejected-incompatible" });
        await expect(orchestrator.acquire({
            requestId: "too-much-ram",
            workloadKind: "python-worker",
            priority: "user-interactive",
            requirements: { accelerator: "none", ramMB: 99_999 },
        })).rejects.toMatchObject({ status: "rejected-insufficient-resources" });
        orchestrator.shutdown();
    });

    it("cancels queued requests and reclaims expired leases", async () => {
        let now = 10_000;
        const orchestrator = new ResourceOrchestrator({
            hardwareProvider: async () => hardware(),
            now: () => now,
            leaseTtlMs: 1_000,
            sweepIntervalMs: 0,
        });
        const blocker = await orchestrator.acquire(acceleratorRequest("blocker"));
        const controller = new AbortController();
        const cancelled = orchestrator.acquire(acceleratorRequest("cancelled"), { signal: controller.signal });
        controller.abort();
        await expect(cancelled).rejects.toMatchObject({ name: "AbortError" });

        const waiting = orchestrator.acquire(acceleratorRequest("waiting"));
        now = blocker.expiresAt + 1;
        expect(orchestrator.sweepExpiredLeases()).toEqual([blocker.leaseId]);
        const replacement = await waiting;
        expect(replacement.requestId).toBe("waiting");
        orchestrator.shutdown();
    });

    it("releases leases in finally when a leased task fails", async () => {
        const orchestrator = new ResourceOrchestrator({ hardwareProvider: async () => hardware(), sweepIntervalMs: 0 });
        await expect(orchestrator.withLease(acceleratorRequest("failing"), async () => {
            throw new Error("boom");
        })).rejects.toThrow("boom");
        expect(orchestrator.getTelemetry().activeLeases).toEqual([]);
        orchestrator.shutdown();
    });

    describe("item 4/7: OS-reserve budget mode", () => {
        it("reports the effective budget mode in telemetry, defaulting to 'balanced' when unset", () => {
            const orchestrator = new ResourceOrchestrator({ hardwareProvider: async () => hardware(), sweepIntervalMs: 0, budgetSettingsProvider: () => ({ mode: "balanced" }) });
            expect(orchestrator.getTelemetry().budgetMode).toBe("balanced");
            orchestrator.shutdown();
        });

        it("an 'efficient' mode's larger OS reserve can turn an otherwise-fitting request into an immediate rejection", async () => {
            // queueIfUnavailable: false turns a "budget-reduced availability
            // says wait" result into an immediate reject instead of parking
            // the request forever — reduced availability from a budget mode
            // is ordinary admission pressure (queue), not a hard
            // incompatibility, exactly like reduced availability from any
            // other active lease.
            const bigRequest: WorkloadRequest = { requestId: "big", workloadKind: "embedding", priority: "background-compute", queueIfUnavailable: false, requirements: { cpuThreads: 1, ramMB: hardware().availableRamMB - 100, accelerator: "none" } };

            const performanceOrchestrator = new ResourceOrchestrator({ hardwareProvider: async () => hardware(), sweepIntervalMs: 0, budgetSettingsProvider: () => ({ mode: "performance" }) });
            const grantedUnderPerformance = await performanceOrchestrator.acquire(bigRequest);
            expect(grantedUnderPerformance.decision).toBe("granted");
            performanceOrchestrator.shutdown();

            const efficientOrchestrator = new ResourceOrchestrator({ hardwareProvider: async () => hardware(), sweepIntervalMs: 0, budgetSettingsProvider: () => ({ mode: "efficient" }) });
            await expect(efficientOrchestrator.acquire(bigRequest)).rejects.toMatchObject({ status: "rejected-insufficient-resources" });
            efficientOrchestrator.shutdown();
        });

        it("a manual RAM ceiling is honored on the very next drain cycle after being changed — no restart needed", async () => {
            let mode: { mode: "manual"; maxRamMB?: number } = { mode: "manual", maxRamMB: 100 };
            const orchestrator = new ResourceOrchestrator({ hardwareProvider: async () => hardware(), sweepIntervalMs: 0, budgetSettingsProvider: () => mode });
            const request: WorkloadRequest = { requestId: "manual-1", workloadKind: "embedding", priority: "background-compute", queueIfUnavailable: false, requirements: { cpuThreads: 1, ramMB: 5_000, accelerator: "none" } };

            await expect(orchestrator.acquire(request)).rejects.toMatchObject({ status: "rejected-insufficient-resources" });

            mode = { mode: "manual", maxRamMB: 10_000 };
            const lease = await orchestrator.acquire({ ...request, requestId: "manual-2" });
            expect(lease.decision).toBe("granted");
            orchestrator.shutdown();
        });
    });

    describe("item 4/5: sustained-pressure gating of background-tier work", () => {
        function backgroundRequest(requestId: string, priority: WorkloadRequest["priority"] = "background-compute"): WorkloadRequest {
            return { requestId, workloadKind: "indexing", priority, requirements: { cpuThreads: 1, ramMB: 10, accelerator: "none" } };
        }

        it("reports the injected pressure level in telemetry", () => {
            const orchestrator = new ResourceOrchestrator({ hardwareProvider: async () => hardware(), sweepIntervalMs: 0, pressureProvider: () => "warning" });
            expect(orchestrator.getTelemetry().pressure).toBe("warning");
            orchestrator.shutdown();
        });

        it("queues (never runs) a new background-compute/transfer/maintenance request while pressure is 'warning', even though CPU/RAM would otherwise easily admit it", async () => {
            let pressure: "normal" | "warning" | "critical" = "warning";
            const orchestrator = new ResourceOrchestrator({ hardwareProvider: async () => hardware(), sweepIntervalMs: 0, pressureProvider: () => pressure });
            let admitted = false;
            const acquired = orchestrator.acquire(backgroundRequest("bg-1")).then((lease) => { admitted = true; return lease; });
            await nextTurn();
            expect(admitted).toBe(false);
            expect(orchestrator.getTelemetry().queuedRequests).toHaveLength(1);

            pressure = "normal";
            orchestrator.acquire(acceleratorRequest("nudge", "maintenance")); // any acquire() call re-triggers drain()
            const lease = await acquired;
            expect(lease.requestId).toBe("bg-1");
            orchestrator.shutdown();
        });

        it("rejects (does not even queue) a background request outright while pressure is 'critical'", async () => {
            const orchestrator = new ResourceOrchestrator({ hardwareProvider: async () => hardware(), sweepIntervalMs: 0, pressureProvider: () => "critical" });
            await expect(orchestrator.acquire(backgroundRequest("bg-2"))).rejects.toMatchObject({ status: "rejected-insufficient-resources" });
            orchestrator.shutdown();
        });

        it("never gates active-inference, user-interactive, explicit-model-load, or scheduled-inference — only the two lowest tiers", async () => {
            const orchestrator = new ResourceOrchestrator({ hardwareProvider: async () => hardware({ gpus: [] }), sweepIntervalMs: 0, pressureProvider: () => "critical" });
            const interactive = await orchestrator.acquire({
                requestId: "interactive-1", workloadKind: "active-inference", priority: "active-inference",
                requirements: { cpuThreads: 1, ramMB: 10, accelerator: "none" },
            });
            const scheduled = await orchestrator.acquire({
                requestId: "scheduled-1", workloadKind: "scheduled-inference", priority: "scheduled-inference",
                requirements: { cpuThreads: 1, ramMB: 10, accelerator: "none" },
            });
            expect(interactive.decision).toBe("granted");
            expect(scheduled.decision).toBe("granted");
            orchestrator.shutdown();
        });

        it("re-evaluates the queue immediately when the pressure subscriber fires a change, not just on the next unrelated acquire/release", async () => {
            let pressure: "normal" | "warning" | "critical" = "warning";
            // A plain reassigned `let` here defeats TS's narrowing (it can't
            // see that the subscriber callback below runs synchronously
            // inside the constructor), so state lives on an object instead.
            const subscription: { listener: (() => void) | null } = { listener: null };
            const orchestrator = new ResourceOrchestrator({
                hardwareProvider: async () => hardware(),
                sweepIntervalMs: 0,
                pressureProvider: () => pressure,
                pressureChangeSubscriber: (listener) => { subscription.listener = listener; return () => { subscription.listener = null; }; },
            });
            let admitted = false;
            const acquired = orchestrator.acquire(backgroundRequest("bg-3")).then((lease) => { admitted = true; return lease; });
            await nextTurn();
            expect(admitted).toBe(false);

            pressure = "normal";
            subscription.listener?.(); // simulates the monitor's onChange firing, with no other orchestrator activity at all
            const lease = await acquired;
            expect(lease.requestId).toBe("bg-3");
            orchestrator.shutdown();
        });
    });
});
