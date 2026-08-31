import type { AcceleratorDevice, ComputeResourceLease, NodeHeartbeat } from "@modelforge/contracts";
import { logger } from "./logger";
import { getSettings } from "./settings-store";
import { captureHardwareSnapshot, mainResourceOrchestrator, ResourceAdmissionError } from "./resource-orchestrator";
import * as agentClient from "./compute-agent-client";

/**
 * The desktop-side half of the enterprise compute control plane
 * (docs/COMPUTE_CONTROL_PLANE.md) — everything server-side (contracts,
 * scheduler, store, routes) already existed and was fully tested before
 * this file; nothing in app/ called any of it. This closes that gap.
 *
 * Scope, disclosed rather than silently assumed: this module makes the
 * control plane's admission/scheduling protocol real for a desktop node —
 * heartbeating capacity, receiving lease offers, and reserving the matching
 * local capacity (via resource-orchestrator.ts's own admission, at
 * "background-compute" priority — see resource-contracts.ts's
 * "fleet-assigned" workload kind) so local work never oversubscribes
 * capacity the fleet has committed elsewhere. It does NOT implement actual
 * remote job dispatch: what runs *inside* a granted lease (e.g. serving a
 * managed AI-gateway deployment to other users) is a separate, larger,
 * unbuilt integration. Node *registration* (POST /compute/nodes) is also
 * out of scope here — it requires the admin-level `compute:manageNodes`
 * permission and is an organization compute admin's action, not this app's;
 * this module only ever calls the agent-scoped endpoints for an already-
 * registered node id (settings.computeNodeId, entered manually once an
 * admin has registered this device's fingerprint — see
 * compute-node-identity.ts).
 *
 * Polling-based, not push-based: an offer is only discovered on the next
 * heartbeat cycle, which happens to run at the same ~15s cadence as the
 * server's own 15s acknowledgment deadline. An offer that lands just after
 * this cycle's poll could occasionally miss that deadline and simply get
 * reassigned — a real, accepted limitation of polling rather than a bug to
 * chase; a push channel would close the gap but is not built.
 */

const HEARTBEAT_INTERVAL_MS = 15_000;
const HEARTBEAT_JITTER_MS = 3_000;
const INVENTORY_VERSION = "1";

interface TrackedLease {
    localLeaseId: string;
    fencingToken: string;
}

function jitteredInterval(fn: () => void, baseMs: number, jitterMs: number): { stop: () => void } {
    let timer: NodeJS.Timeout | null = null;
    let stopped = false;
    const schedule = (): void => {
        if (stopped) return;
        const delay = baseMs + Math.floor((Math.random() * 2 - 1) * jitterMs);
        timer = setTimeout(() => {
            if (stopped) return;
            fn();
            schedule();
        }, Math.max(1_000, delay));
        timer.unref();
    };
    schedule();
    return { stop: () => { stopped = true; if (timer) clearTimeout(timer); } };
}

function normalizeVendor(vendor: string): AcceleratorDevice["vendor"] {
    const lower = vendor.toLowerCase();
    if (lower.includes("nvidia")) return "nvidia";
    if (lower.includes("amd")) return "amd";
    if (lower.includes("intel")) return "intel";
    if (lower.includes("apple")) return "apple";
    return "other";
}

async function buildInventoryDevices(nodeId: string): Promise<AcceleratorDevice[]> {
    const hardware = await captureHardwareSnapshot();
    return hardware.gpus.map((gpu) => ({
        id: gpu.id,
        nodeId,
        vendor: normalizeVendor(gpu.vendor),
        // No per-device model name is available from this app's own hardware
        // detection today — the vendor string is the best identifying label
        // on hand, disclosed here rather than fabricating a model name.
        model: gpu.vendor,
        totalVramMB: gpu.totalVramMB ?? 0,
        freeVramMB: Math.min(gpu.availableVramMB ?? gpu.totalVramMB ?? 0, gpu.totalVramMB ?? Number.MAX_SAFE_INTEGER),
        sharingMode: "exclusive" as const,
        maxConcurrency: 1,
        health: gpu.computeAvailable ? ("healthy" as const) : ("unhealthy" as const),
        supportedRuntimes: ["llamacpp" as const],
        throttled: false,
    }));
}

export class ComputeAgent {
    private readonly tracked = new Map<string, TrackedLease>();
    private loop: { stop: () => void } | null = null;
    private cycleInFlight = false;

    isRunning(): boolean {
        return this.loop !== null;
    }

    start(): void {
        if (this.loop) return;
        logger.info("compute-agent: starting.");
        this.loop = jitteredInterval(() => { void this.runCycle(); }, HEARTBEAT_INTERVAL_MS, HEARTBEAT_JITTER_MS);
        void this.runCycle();
    }

    async stop(): Promise<void> {
        if (!this.loop) return;
        this.loop.stop();
        this.loop = null;
        logger.info("compute-agent: stopping — releasing all tracked fleet leases.");
        const releases = [...this.tracked.entries()].map(async ([serverLeaseId, tracked]) => {
            mainResourceOrchestrator.release(tracked.localLeaseId);
            try {
                await agentClient.releaseLease(serverLeaseId, tracked.fencingToken, "cancelled");
            } catch (err) {
                logger.warn(`compute-agent: failed to release lease ${serverLeaseId} on shutdown: ${(err as Error).message}`);
            }
        });
        await Promise.allSettled(releases);
        this.tracked.clear();
    }

    private async runCycle(): Promise<void> {
        if (this.cycleInFlight) return;
        this.cycleInFlight = true;
        try {
            const settings = getSettings();
            const nodeId = settings.computeNodeId;
            if (!settings.computeAgentEnabled || !nodeId) return;

            const devices = await buildInventoryDevices(nodeId);
            const hardware = await captureHardwareSnapshot();
            const heartbeat: NodeHeartbeat = {
                nodeId,
                inventoryVersion: INVENTORY_VERSION,
                capturedAt: new Date().toISOString(),
                freeCpuThreads: hardware.availableCpuThreads,
                freeRamMB: hardware.availableRamMB,
                devices,
                runningLeaseIds: [...this.tracked.keys()],
            };
            await agentClient.sendHeartbeat(nodeId, heartbeat);

            const { assignments } = await agentClient.getAssignments(nodeId);
            const liveLeaseIds = new Set(assignments.map((item) => item.lease.id));

            for (const [serverLeaseId, tracked] of [...this.tracked.entries()]) {
                if (liveLeaseIds.has(serverLeaseId)) continue;
                // No longer offered/acknowledged/running server-side (released,
                // expired, or preempted) — drop the matching local reservation.
                mainResourceOrchestrator.release(tracked.localLeaseId);
                this.tracked.delete(serverLeaseId);
            }

            for (const { lease } of assignments) {
                if (lease.state === "offered" && !this.tracked.has(lease.id)) {
                    await this.tryAcceptOffer(lease);
                } else if ((lease.state === "acknowledged" || lease.state === "running") && this.tracked.has(lease.id)) {
                    await this.renewTracked(lease);
                }
            }
        } catch (err) {
            logger.warn(`compute-agent: heartbeat cycle failed: ${(err as Error).message}`);
        } finally {
            this.cycleInFlight = false;
        }
    }

    private async tryAcceptOffer(lease: ComputeResourceLease): Promise<void> {
        try {
            const localLease = await mainResourceOrchestrator.acquire({
                requestId: `fleet:${lease.id}`,
                workloadKind: "fleet-assigned",
                priority: "background-compute",
                requirements: {
                    cpuThreads: lease.cpuThreads,
                    ramMB: lease.ramMB,
                    accelerator: lease.acceleratorDeviceIds.length > 0 ? "required" : "none",
                    acceleratorDeviceIds: lease.acceleratorDeviceIds,
                    vramMB: lease.vramMBPerDevice,
                    allowCpuFallback: false,
                    exclusiveAccelerator: lease.exclusiveAccelerators,
                },
                queueIfUnavailable: false,
            });
            await agentClient.acknowledgeLease(lease.id, lease.fencingToken);
            this.tracked.set(lease.id, { localLeaseId: localLease.leaseId, fencingToken: lease.fencingToken });
            logger.info(`compute-agent: accepted and reserved local capacity for fleet lease ${lease.id}.`);
        } catch (err) {
            // Local capacity has changed since the server decided to offer
            // this node the lease (a ResourceAdmissionError), or the
            // acknowledgment call itself failed — either way, never
            // acknowledge a lease this node hasn't actually reserved
            // capacity for. Left un-acknowledged, the server reclaims it
            // after its acknowledgment deadline and can reassign it.
            const reason = err instanceof ResourceAdmissionError ? err.reasons.join(" ") : (err as Error).message;
            logger.info(`compute-agent: declining fleet lease ${lease.id} — ${reason}`);
        }
    }

    private async renewTracked(lease: ComputeResourceLease): Promise<void> {
        const tracked = this.tracked.get(lease.id);
        if (!tracked) return;
        mainResourceOrchestrator.heartbeat(tracked.localLeaseId);
        try {
            const renewed = await agentClient.renewLease(lease.id, tracked.fencingToken);
            tracked.fencingToken = renewed.fencingToken;
        } catch (err) {
            logger.warn(`compute-agent: failed to renew fleet lease ${lease.id}: ${(err as Error).message}`);
        }
    }
}

export const mainComputeAgent = new ComputeAgent();
