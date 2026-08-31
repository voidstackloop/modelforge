import { describe, expect, it } from "vitest";
import { AiInferenceAdmission, AiAdmissionError } from "./admission.js";

describe("AiInferenceAdmission", () => {
    it("grants a request within capacity, and it appears in the snapshot", async () => {
        const admission = new AiInferenceAdmission({ cpuThreads: 4, ramMB: 8_000, vramBudgetMB: 0 });
        const lease = await admission.acquire({ organizationId: "org-1", priority: "interactive", requirements: { cpuThreads: 1, ramMB: 100 } });
        expect(lease.organizationId).toBe("org-1");
        expect(admission.getSnapshot().active).toHaveLength(1);
        admission.release(lease.leaseId);
        expect(admission.getSnapshot().active).toHaveLength(0);
    });

    it("rejects a request whose RAM requirement exceeds the total server budget outright, never queuing it", async () => {
        const admission = new AiInferenceAdmission({ cpuThreads: 4, ramMB: 1_000 });
        await expect(admission.acquire({ organizationId: "org-1", priority: "interactive", requirements: { ramMB: 5_000 }, queueIfUnavailable: false }))
            .rejects.toMatchObject({ status: "rejected-insufficient-resources" });
    });

    it("rejects VRAM requests outright when no VRAM budget is configured at all — 'local-GPU inference admission is not enabled'", async () => {
        const admission = new AiInferenceAdmission({ cpuThreads: 4, ramMB: 8_000, vramBudgetMB: 0 });
        await expect(admission.acquire({ organizationId: "org-1", priority: "imaging-inference", requirements: { vramMB: 100 }, queueIfUnavailable: false }))
            .rejects.toThrow(/VRAM budget is configured/);
    });

    it("enforces a per-tenant concurrency cap independent of overall server capacity", async () => {
        const admission = new AiInferenceAdmission({ cpuThreads: 100, ramMB: 100_000, maxConcurrentPerTenant: 2 });
        const l1 = await admission.acquire({ organizationId: "org-1", priority: "interactive" });
        const l2 = await admission.acquire({ organizationId: "org-1", priority: "interactive" });
        await expect(admission.acquire({ organizationId: "org-1", priority: "interactive", queueIfUnavailable: false }))
            .rejects.toMatchObject({ status: "rejected-tenant-quota" });
        // A different tenant is completely unaffected by org-1's cap.
        const otherOrgLease = await admission.acquire({ organizationId: "org-2", priority: "interactive" });
        expect(otherOrgLease.organizationId).toBe("org-2");
        admission.release(l1.leaseId);
        admission.release(l2.leaseId);
        admission.release(otherOrgLease.leaseId);
    });

    it("queues a lower-priority request behind a higher-priority one competing for the same CPU capacity, admitting it once the higher-priority one releases", async () => {
        const admission = new AiInferenceAdmission({ cpuThreads: 1, ramMB: 100_000, maxConcurrentPerTenant: 10 });
        const blocker = await admission.acquire({ organizationId: "org-1", priority: "administrative", requirements: { cpuThreads: 1 } });
        let interactiveGranted = false;
        const interactive = admission.acquire({ organizationId: "org-1", priority: "interactive", requirements: { cpuThreads: 1 } }).then((lease) => { interactiveGranted = true; return lease; });
        await new Promise((r) => setImmediate(r));
        expect(interactiveGranted).toBe(false);
        admission.release(blocker.leaseId);
        const lease = await interactive;
        expect(interactiveGranted).toBe(true);
        expect(lease.priority).toBe("interactive");
    });

    it("a higher-priority request is admitted ahead of an already-queued lower-priority one, not FIFO", async () => {
        const admission = new AiInferenceAdmission({ cpuThreads: 1, ramMB: 100_000 });
        const blocker = await admission.acquire({ organizationId: "org-1", priority: "interactive", requirements: { cpuThreads: 1 } });
        const order: string[] = [];
        const low = admission.acquire({ organizationId: "org-1", priority: "administrative", requirements: { cpuThreads: 1 } }).then((l) => { order.push("administrative"); return l; });
        await new Promise((r) => setImmediate(r));
        const high = admission.acquire({ organizationId: "org-1", priority: "imaging-inference", requirements: { cpuThreads: 1 } }).then((l) => { order.push("imaging-inference"); return l; });
        admission.release(blocker.leaseId);
        const highLease = await high;
        expect(order).toEqual(["imaging-inference"]);
        admission.release(highLease.leaseId);
        await low;
        expect(order).toEqual(["imaging-inference", "administrative"]);
    });

    it("withLease releases the lease even when the task throws", async () => {
        const admission = new AiInferenceAdmission({ cpuThreads: 4, ramMB: 8_000 });
        await expect(admission.withLease({ organizationId: "org-1", priority: "interactive" }, async () => { throw new Error("boom"); })).rejects.toThrow("boom");
        expect(admission.getSnapshot().active).toHaveLength(0);
    });

    it("sweepExpired reclaims a lease whose TTL has passed, and the reclaimed capacity becomes available again", async () => {
        let now = 1_000;
        const admission = new AiInferenceAdmission({ cpuThreads: 1, ramMB: 100_000, leaseTtlMs: 1_000, now: () => now });
        const lease = await admission.acquire({ organizationId: "org-1", priority: "interactive", requirements: { cpuThreads: 1 } });
        now = lease.expiresAt + 1;
        expect(admission.sweepExpired()).toEqual([lease.leaseId]);
        expect(admission.getSnapshot().active).toHaveLength(0);
        const next = await admission.acquire({ organizationId: "org-1", priority: "interactive", requirements: { cpuThreads: 1 } });
        expect(next).toBeDefined();
    });

    it("AiAdmissionError carries a machine-readable status alongside the human-readable reasons", async () => {
        const admission = new AiInferenceAdmission({ cpuThreads: 4, ramMB: 100 });
        try {
            await admission.acquire({ organizationId: "org-1", priority: "interactive", requirements: { ramMB: 99_999 }, queueIfUnavailable: false });
            expect.unreachable();
        } catch (err) {
            expect(err).toBeInstanceOf(AiAdmissionError);
            expect((err as AiAdmissionError).status).toBe("rejected-insufficient-resources");
        }
    });
});
