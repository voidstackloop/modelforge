import type {
    AcceleratorDevice,
    AllocationExplanation,
    ComputeNode,
    ComputePriority,
    ComputeResourceLease,
    ComputeResourceRequest,
    ResourcePolicy,
    ResourcePool,
    TenantComputeQuota,
} from "@modelforge/contracts";

const PRIORITY_SCORE: Readonly<Record<ComputePriority, number>> = {
    interactive: 5,
    imaging: 4,
    scheduled: 3,
    background: 2,
    maintenance: 1,
};

export interface SchedulerSnapshot {
    nodes: ComputeNode[];
    pool: ResourcePool;
    quota?: TenantComputeQuota;
    policy?: ResourcePolicy;
    activeLeases: ComputeResourceLease[];
    activeRequests?: ComputeResourceRequest[];
    now: string;
}

export interface SchedulerPlacement {
    nodeId: string;
    acceleratorDeviceIds: string[];
    degradedToCpu: boolean;
    borrowedCapacity: boolean;
    score: number;
    explanation: AllocationExplanation;
    preemptLeaseIds: string[];
}

export type SchedulerDecision =
    | { status: "placed"; placement: SchedulerPlacement }
    | { status: "queued" | "rejected"; reasons: string[] };

interface DeviceReservation {
    concurrency: number;
    vramMB: number;
    exclusive: boolean;
}

interface Candidate {
    node: ComputeNode;
    devices: AcceleratorDevice[];
    degradedToCpu: boolean;
    borrowedCapacity: boolean;
    score: number;
    scoreReasons: string[];
}

function activeLease(lease: ComputeResourceLease): boolean {
    return lease.state === "offered" || lease.state === "acknowledged" || lease.state === "running";
}

function resourceUsage(leases: ComputeResourceLease[]): { cpuThreads: number; ramMB: number; accelerators: number } {
    return leases.filter(activeLease).reduce((usage, lease) => ({
        cpuThreads: usage.cpuThreads + lease.cpuThreads,
        ramMB: usage.ramMB + lease.ramMB,
        accelerators: usage.accelerators + lease.acceleratorDeviceIds.length,
    }), { cpuThreads: 0, ramMB: 0, accelerators: 0 });
}

function deviceReservations(leases: ComputeResourceLease[]): Map<string, DeviceReservation> {
    const result = new Map<string, DeviceReservation>();
    for (const lease of leases.filter(activeLease)) {
        for (const deviceId of lease.acceleratorDeviceIds) {
            const current = result.get(deviceId) ?? { concurrency: 0, vramMB: 0, exclusive: false };
            current.concurrency += 1;
            current.vramMB += lease.vramMBPerDevice;
            current.exclusive ||= lease.exclusiveAccelerators;
            result.set(deviceId, current);
        }
    }
    return result;
}

function effectivePolicyReasons(request: ComputeResourceRequest, policy: ResourcePolicy | undefined): string[] {
    if (!policy || policy.status !== "active") return [];
    const limits = { ...policy.hardLimits, ...(policy.workloadClassLimits[request.priority] ?? {}) };
    const reasons: string[] = [];
    const req = request.requirements;
    if (limits.maxCpuThreads !== undefined && req.cpuThreads > limits.maxCpuThreads) reasons.push(`CPU request exceeds policy limit of ${limits.maxCpuThreads} threads.`);
    if (limits.maxRamMB !== undefined && req.ramMB > limits.maxRamMB) reasons.push(`RAM request exceeds policy limit of ${limits.maxRamMB}MB.`);
    if (limits.maxPinnedMemoryMB !== undefined && req.pinnedMemoryMB > limits.maxPinnedMemoryMB) reasons.push(`Pinned-memory request exceeds policy limit of ${limits.maxPinnedMemoryMB}MB.`);
    if (limits.maxAccelerators !== undefined && req.acceleratorCount > limits.maxAccelerators) reasons.push(`Accelerator request exceeds policy limit of ${limits.maxAccelerators}.`);
    if (limits.maxVramMBPerDevice !== undefined && req.vramMBPerDevice > limits.maxVramMBPerDevice) reasons.push(`VRAM request exceeds policy limit of ${limits.maxVramMBPerDevice}MB per device.`);
    if (limits.allowedRuntimes && !limits.allowedRuntimes.includes(req.runtime)) reasons.push(`Runtime ${req.runtime} is not allowed by policy.`);
    if (limits.allowedModelIds && req.modelId && !limits.allowedModelIds.includes(req.modelId)) reasons.push(`Model ${req.modelId} is not allowed by policy.`);
    if (req.allowCpuFallback && limits.allowCpuFallback === false) reasons.push("CPU fallback is disabled by policy.");
    return reasons;
}

function quotaResult(request: ComputeResourceRequest, snapshot: SchedulerSnapshot): { rejected?: string; borrowed: boolean } {
    if (!snapshot.quota) return { borrowed: false };
    const used = resourceUsage(snapshot.activeLeases.filter((lease) => lease.organizationId === request.organizationId && lease.poolId === request.poolId));
    const quota = snapshot.quota;
    const next = {
        cpuThreads: used.cpuThreads + request.requirements.cpuThreads,
        ramMB: used.ramMB + request.requirements.ramMB,
        accelerators: used.accelerators + request.requirements.acceleratorCount,
    };
    if (next.cpuThreads > quota.burstCpuThreads || next.ramMB > quota.burstRamMB || next.accelerators > quota.burstAccelerators) {
        return { rejected: "The request exceeds this tenant's burst quota for the pool.", borrowed: false };
    }
    const borrowed = next.cpuThreads > quota.reservedCpuThreads || next.ramMB > quota.reservedRamMB || next.accelerators > quota.reservedAccelerators;
    if (borrowed && !quota.borrowingEnabled) return { rejected: "The tenant reservation is exhausted and capacity borrowing is disabled.", borrowed: false };
    return { borrowed };
}

function deviceEligible(device: AcceleratorDevice, request: ComputeResourceRequest, reservations: Map<string, DeviceReservation>, policy: ResourcePolicy | undefined): boolean {
    const req = request.requirements;
    if (device.health !== "healthy" || device.throttled) return false;
    if (!device.supportedRuntimes.includes(req.runtime)) return false;
    if (req.acceleratorVendor && device.vendor !== req.acceleratorVendor) return false;
    if (req.computeCapability && device.computeCapability !== req.computeCapability) return false;
    const limits = policy?.status === "active" ? { ...policy.hardLimits, ...(policy.workloadClassLimits[request.priority] ?? {}) } : undefined;
    if (limits?.maxTemperatureC !== undefined && device.temperatureC !== undefined && device.temperatureC > limits.maxTemperatureC) return false;
    if (limits?.maxPowerWatts !== undefined && device.powerWatts !== undefined && device.powerWatts > limits.maxPowerWatts) return false;
    const reserved = reservations.get(device.id) ?? { concurrency: 0, vramMB: 0, exclusive: false };
    if (reserved.exclusive || (req.exclusiveAccelerators && reserved.concurrency > 0)) return false;
    const concurrencyLimit = Math.min(device.maxConcurrency, limits?.maxConcurrencyPerDevice ?? device.maxConcurrency);
    if (reserved.concurrency >= concurrencyLimit) return false;
    const safelyFreeVramMB = Math.min(device.freeVramMB, Math.max(0, device.totalVramMB - reserved.vramMB));
    return safelyFreeVramMB >= req.vramMBPerDevice;
}

function chooseDevices(node: ComputeNode, request: ComputeResourceRequest, reservations: Map<string, DeviceReservation>, policy: ResourcePolicy | undefined): AcceleratorDevice[] | null {
    const req = request.requirements;
    if (req.acceleratorCount === 0) return [];
    const explicit = new Set(req.acceleratorDeviceIds);
    let devices = node.devices.filter((device) => explicit.size === 0 || explicit.has(device.id));
    if (explicit.size > 0 && devices.length !== explicit.size) return null;
    devices = devices.filter((device) => deviceEligible(device, request, reservations, policy));
    if (req.sameVendor && devices.length > 0) {
        const groups = new Map<string, AcceleratorDevice[]>();
        for (const device of devices) groups.set(device.vendor, [...(groups.get(device.vendor) ?? []), device]);
        devices = [...groups.values()].sort((a, b) => b.length - a.length || a[0]!.vendor.localeCompare(b[0]!.vendor))[0] ?? [];
    }
    if (req.sameNumaNode && devices.length > 0) {
        const groups = new Map<number, AcceleratorDevice[]>();
        for (const device of devices) {
            if (device.numaNode === undefined) continue;
            groups.set(device.numaNode, [...(groups.get(device.numaNode) ?? []), device]);
        }
        devices = [...groups.values()].sort((a, b) => b.length - a.length || (a[0]!.numaNode ?? 0) - (b[0]!.numaNode ?? 0))[0] ?? [];
    }
    devices.sort((a, b) => b.freeVramMB - a.freeVramMB || a.id.localeCompare(b.id));
    return devices.length >= req.acceleratorCount ? devices.slice(0, req.acceleratorCount) : null;
}

// Only scales *this* tenant's own borrowed-capacity penalty by their own
// quota weight (a higher-weight tenant is meant to be preferred for spare
// pool capacity, so their borrowing costs less) — deliberately not a full
// cross-tenant weighted-fair-share comparison. SchedulerSnapshot is fetched
// per (organizationId, poolId) under that organization's own RLS scope
// (see compute-control-store.ts's getSchedulingSnapshot), so a single
// scheduling pass has no visibility into *other* organizations' usage or
// weight sharing the same pool — comparing this tenant's weighted usage
// against theirs would need a new privileged, cross-tenant aggregate query
// (the same category of thing the maintenance sweep's SECURITY DEFINER
// functions exist for), which is a real, disclosed follow-up, not attempted
// here.
function scoreCandidate(node: ComputeNode, devices: AcceleratorDevice[], request: ComputeResourceRequest, now: Date, borrowed: boolean, weight: number): { score: number; reasons: string[] } {
    let score = PRIORITY_SCORE[request.priority] * 1_000_000;
    const reasons = [`Priority class ${request.priority} supplied the primary score.`];
    const ageSeconds = Math.max(0, (now.getTime() - new Date(request.queuedAt).getTime()) / 1_000);
    const ageScore = Math.min(100_000, ageSeconds * 100);
    score += ageScore;
    if (ageScore > 0) reasons.push("Queue age increased placement priority to prevent starvation.");
    if (request.deadlineAt) {
        const secondsToDeadline = (new Date(request.deadlineAt).getTime() - now.getTime()) / 1_000;
        const deadlineScore = Math.max(0, 100_000 - Math.max(0, secondsToDeadline) * 100);
        score += deadlineScore;
        reasons.push("Deadline urgency increased placement priority.");
    }
    if (request.requirements.modelId && node.warmModelIds.includes(request.requirements.modelId)) {
        score += 25_000;
        reasons.push("The requested model is already warm on this node.");
    }
    const freeVram = devices.reduce((sum, device) => sum + device.freeVramMB, 0);
    score += Math.min(20_000, freeVram);
    score += Math.min(10_000, node.freeCpuThreads * 100 + node.freeRamMB / 128);
    const thermalHeadroom = devices.reduce((sum, device) => sum + Math.max(0, 100 - (device.temperatureC ?? 50)), 0);
    score += thermalHeadroom * 10;
    if (borrowed) {
        // Guarded against non-finite/non-positive weight values reaching
        // here from bad data — never let a malformed weight invert the
        // penalty into a bonus or divide by zero.
        const safeWeight = Number.isFinite(weight) && weight > 0 ? weight : 1;
        const penalty = Math.round(50_000 / safeWeight);
        score -= penalty;
        reasons.push(safeWeight === 1
            ? "Borrowed capacity was penalized behind reserved capacity."
            : `Borrowed capacity was penalized behind reserved capacity (scaled by this tenant's fair-share weight of ${safeWeight}).`);
    }
    return { score, reasons };
}

function candidates(request: ComputeResourceRequest, snapshot: SchedulerSnapshot, leases: ComputeResourceLease[]): Candidate[] {
    const reservations = deviceReservations(leases);
    const quota = quotaResult(request, { ...snapshot, activeLeases: leases });
    if (quota.rejected) return [];
    const now = new Date(snapshot.now);
    const result: Candidate[] = [];
    for (const node of snapshot.nodes) {
        if (node.organizationId !== request.organizationId || !snapshot.pool.nodeIds.includes(node.id)) continue;
        if (node.region !== snapshot.pool.region || node.state !== "online") continue;
        if (!node.supportedRuntimes.includes(request.requirements.runtime)) continue;
        const nodeLeases = leases.filter((lease) => lease.nodeId === node.id && activeLease(lease));
        const usage = resourceUsage(nodeLeases);
        const safelyFreeCpuThreads = Math.min(node.freeCpuThreads, Math.max(0, node.cpuThreads - usage.cpuThreads));
        const safelyFreeRamMB = Math.min(node.freeRamMB, Math.max(0, node.totalRamMB - usage.ramMB));
        if (request.requirements.cpuThreads > safelyFreeCpuThreads) continue;
        if (request.requirements.ramMB > safelyFreeRamMB) continue;
        let devices = chooseDevices(node, request, reservations, snapshot.policy);
        let degradedToCpu = false;
        if (!devices && request.requirements.acceleratorCount > 0 && request.requirements.allowCpuFallback) {
            devices = [];
            degradedToCpu = true;
        }
        if (!devices) continue;
        const scored = scoreCandidate(node, devices, request, now, quota.borrowed, snapshot.quota?.weight ?? 1);
        result.push({ node, devices, degradedToCpu, borrowedCapacity: quota.borrowed, score: scored.score, scoreReasons: scored.reasons });
    }
    return result.sort((left, right) => right.score - left.score || left.node.id.localeCompare(right.node.id));
}

function safePreemptionVictims(request: ComputeResourceRequest, snapshot: SchedulerSnapshot): Array<{ lease: ComputeResourceLease; request: ComputeResourceRequest }> {
    if (request.priority !== "interactive") return [];
    const byId = new Map((snapshot.activeRequests ?? []).map((active) => [active.id, active]));
    return snapshot.activeLeases
        .filter(activeLease)
        .map((lease) => ({ lease, request: byId.get(lease.requestId) }))
        .filter((entry): entry is { lease: ComputeResourceLease; request: ComputeResourceRequest } => Boolean(entry.request))
        .filter((entry) => entry.request.priority !== "interactive" && (entry.request.checkpointable || entry.request.restartable))
        .sort((left, right) => PRIORITY_SCORE[left.request.priority] - PRIORITY_SCORE[right.request.priority] || left.request.queuedAt.localeCompare(right.request.queuedAt));
}

export class ComputeScheduler {
    schedule(request: ComputeResourceRequest, snapshot: SchedulerSnapshot, options: { allowSafePreemption?: boolean } = {}): SchedulerDecision {
        if (request.organizationId !== snapshot.pool.organizationId || request.poolId !== snapshot.pool.id) {
            return { status: "rejected", reasons: ["The request is not eligible for this organization and pool."] };
        }
        if (snapshot.pool.status !== "active") return { status: "queued", reasons: [`Pool ${snapshot.pool.id} is ${snapshot.pool.status}.`] };
        const policyReasons = effectivePolicyReasons(request, snapshot.policy);
        if (policyReasons.length > 0) return { status: "rejected", reasons: policyReasons };
        const quota = quotaResult(request, snapshot);
        if (quota.rejected) return { status: "rejected", reasons: [quota.rejected] };

        let placements = candidates(request, snapshot, snapshot.activeLeases);
        let preemptLeaseIds: string[] = [];
        if (placements.length === 0 && options.allowSafePreemption) {
            let leases = [...snapshot.activeLeases];
            for (const victim of safePreemptionVictims(request, snapshot)) {
                leases = leases.filter((lease) => lease.id !== victim.lease.id);
                preemptLeaseIds.push(victim.lease.id);
                placements = candidates(request, snapshot, leases);
                if (placements.length > 0) break;
            }
        }
        const selected = placements[0];
        if (!selected) {
            const explicit = request.requirements.acceleratorDeviceIds;
            return { status: "queued", reasons: explicit.length > 0
                ? [`Requested accelerator devices are stale, unhealthy, busy, or incompatible: ${explicit.join(", ")}.`]
                : ["No healthy node currently satisfies the CPU, RAM, accelerator, topology, runtime, and policy requirements."] };
        }
        const explanation: AllocationExplanation = {
            hardFilterReasons: [], score: selected.score, scoreReasons: selected.scoreReasons,
            degradedToCpu: selected.degradedToCpu, borrowedCapacity: selected.borrowedCapacity,
        };
        return { status: "placed", placement: {
            nodeId: selected.node.id,
            acceleratorDeviceIds: selected.devices.map((device) => device.id),
            degradedToCpu: selected.degradedToCpu,
            borrowedCapacity: selected.borrowedCapacity,
            score: selected.score,
            explanation,
            preemptLeaseIds,
        } };
    }
}
