import { randomUUID } from "node:crypto";
import { getSpecs } from "./system-specs";
import { mainResourcePressureMonitor } from "./resource-pressure-monitor";
import { applyResourceBudgetMode } from "./resource-budget";
import { getSettings } from "./settings-store";
import {
    RESOURCE_PRIORITY_RANK,
    type HardwareSnapshot,
    type ResourceBudget,
    type ResourceBudgetSettings,
    type ResourceDecision,
    type ResourceDecisionStatus,
    type ResourceLease,
    type ResourcePressureLevel,
    type ResourceTelemetry,
    type WorkloadRequest,
} from "./resource-contracts";

function defaultBudgetSettingsProvider(): ResourceBudgetSettings {
    const settings = getSettings();
    return {
        mode: settings.resourceBudgetMode ?? "balanced",
        maxRamMB: settings.resourceMaxRamMB,
        maxVramMB: settings.resourceMaxVramMB,
        cpuThreadCeiling: settings.resourceCpuThreadCeiling,
    };
}

// Item 4/5: pressure-based throttling applies only to the two lowest
// priority tiers (embedding/indexing, downloads/backup/maintenance) — the
// spec's own priority ordering (section 5) puts these below scheduled
// inference, which is never throttled by this. Interactive and explicit
// user actions are never affected, matching "never silently reduce
// clinical context."
const BACKGROUND_TIER_MAX_RANK = RESOURCE_PRIORITY_RANK["background-compute"];

interface NormalizedWorkloadRequest extends WorkloadRequest {
    requestId: string;
    requirements: Required<NonNullable<WorkloadRequest["requirements"]>>;
    queueIfUnavailable: boolean;
}

interface PendingRequest {
    request: NormalizedWorkloadRequest;
    queuedAt: number;
    sequence: number;
    resolve: (lease: ResourceLease) => void;
    reject: (error: Error) => void;
    abortSignal?: AbortSignal;
    abortListener?: () => void;
}

interface ActiveLease {
    lease: ResourceLease;
}

interface AdmissionGrant {
    kind: "grant";
    budget: ResourceBudget;
    reasons: string[];
}

interface AdmissionWait {
    kind: "wait";
    reasons: string[];
}

interface AdmissionReject {
    kind: "reject";
    status: Extract<ResourceDecisionStatus, "rejected-incompatible" | "rejected-insufficient-resources">;
    reasons: string[];
}

type AdmissionResult = AdmissionGrant | AdmissionWait | AdmissionReject;

export interface ResourceOrchestratorOptions {
    hardwareProvider?: () => Promise<HardwareSnapshot>;
    now?: () => number;
    idGenerator?: () => string;
    leaseTtlMs?: number;
    sweepIntervalMs?: number;
    /** Defaults to mainResourcePressureMonitor.getLevel(). Injectable so
     * tests can drive admission decisions from a controlled pressure level
     * without real memory pressure or real timers. */
    pressureProvider?: () => ResourcePressureLevel;
    /** Defaults to mainResourcePressureMonitor.onChange(). Re-evaluates the
     * queue immediately when pressure changes level — without this, a
     * background request parked in "wait" during a pressure episode would
     * only be re-checked on the next unrelated acquire/release/sweep event,
     * which could be an arbitrarily long time after pressure actually
     * cleared. */
    pressureChangeSubscriber?: (listener: () => void) => () => void;
    /** Defaults to reading AppSettings.resourceBudgetMode/resourceMax*
     * live (settings-store.ts) — "balanced" when unset (item 4: "Default
     * to a Balanced mode"). Read fresh on every drain() cycle, not cached
     * at construction, so a user changing the mode mid-session takes
     * effect on the very next admission pass. */
    budgetSettingsProvider?: () => ResourceBudgetSettings;
}

export interface AcquireOptions {
    signal?: AbortSignal;
}

export class ResourceAdmissionError extends Error {
    constructor(
        public readonly status: Extract<ResourceDecisionStatus, "rejected-incompatible" | "rejected-insufficient-resources">,
        public readonly requestId: string,
        public readonly reasons: string[]
    ) {
        super(reasons.join(" "));
        this.name = "ResourceAdmissionError";
    }
}

function abortError(message = "Resource request was cancelled."): Error {
    const error = new Error(message);
    error.name = "AbortError";
    return error;
}

function finiteInteger(value: number | undefined, fallback: number): number {
    return value === undefined || !Number.isFinite(value) ? fallback : Math.max(0, Math.floor(value));
}

export async function captureHardwareSnapshot(): Promise<HardwareSnapshot> {
    const specs = await getSpecs();
    const cpuThreads = Math.max(1, specs.cpuCores);
    return {
        capturedAt: Date.now(),
        cpuThreads,
        availableCpuThreads: Math.max(1, cpuThreads - 1),
        totalRamMB: Math.max(0, Math.floor(specs.totalRAMGB * 1024)),
        availableRamMB: Math.max(0, Math.floor(specs.freeRAMGB * 1024)),
        gpus: specs.gpus.map((gpu, index) => ({
            id: gpu.id ?? `${gpu.vendor}:runtime-index:${gpu.index ?? index}`,
            vendor: gpu.vendor,
            totalVramMB: gpu.vramGB === null ? null : Math.max(0, Math.floor(gpu.vramGB * 1024)),
            availableVramMB: gpu.freeVramGB === null || gpu.freeVramGB === undefined
                ? gpu.vramGB === null ? null : Math.max(0, Math.floor(gpu.vramGB * 1024 * 0.88))
                : Math.max(0, Math.floor(gpu.freeVramGB * 1024)),
            computeAvailable: gpu.computeAvailable !== false && gpu.displayOnly !== true,
        })),
    };
}

export class ResourceOrchestrator {
    private readonly hardwareProvider: () => Promise<HardwareSnapshot>;
    private readonly now: () => number;
    private readonly idGenerator: () => string;
    private readonly leaseTtlMs: number;
    private readonly pending: PendingRequest[] = [];
    private readonly active = new Map<string, ActiveLease>();
    private readonly decisionListeners = new Set<(decision: ResourceDecision) => void>();
    private lastHardware: HardwareSnapshot | null = null;
    private sequence = 0;
    private draining = false;
    private drainAgain = false;
    private stopped = false;
    private readonly sweepTimer: NodeJS.Timeout | null;
    private readonly pressureProvider: () => ResourcePressureLevel;
    private readonly unsubscribePressure: () => void;
    private readonly budgetSettingsProvider: () => ResourceBudgetSettings;

    constructor(options: ResourceOrchestratorOptions = {}) {
        this.hardwareProvider = options.hardwareProvider ?? captureHardwareSnapshot;
        this.now = options.now ?? Date.now;
        this.idGenerator = options.idGenerator ?? randomUUID;
        this.leaseTtlMs = Math.max(1_000, options.leaseTtlMs ?? 120_000);
        const sweepIntervalMs = options.sweepIntervalMs === undefined ? 30_000 : Math.max(0, options.sweepIntervalMs);
        this.sweepTimer = sweepIntervalMs > 0
            ? setInterval(() => this.sweepExpiredLeases(), sweepIntervalMs)
            : null;
        this.sweepTimer?.unref();
        this.pressureProvider = options.pressureProvider ?? (() => mainResourcePressureMonitor.getLevel());
        const subscribe = options.pressureChangeSubscriber ?? ((listener: () => void) => mainResourcePressureMonitor.onChange(() => listener()));
        this.unsubscribePressure = subscribe(() => this.scheduleDrain());
        this.budgetSettingsProvider = options.budgetSettingsProvider ?? defaultBudgetSettingsProvider;
    }

    onDecision(listener: (decision: ResourceDecision) => void): () => void {
        this.decisionListeners.add(listener);
        return () => this.decisionListeners.delete(listener);
    }

    acquire(request: WorkloadRequest, options: AcquireOptions = {}): Promise<ResourceLease> {
        if (this.stopped) return Promise.reject(abortError("The resource orchestrator is shutting down."));
        const normalized = this.normalizeRequest(request);
        if (options.signal?.aborted) return Promise.reject(abortError());

        return new Promise<ResourceLease>((resolve, reject) => {
            const pending: PendingRequest = {
                request: normalized,
                queuedAt: this.now(),
                sequence: this.sequence++,
                resolve,
                reject,
                abortSignal: options.signal,
            };
            if (options.signal) {
                pending.abortListener = () => this.cancelPending(normalized.requestId, abortError());
                options.signal.addEventListener("abort", pending.abortListener, { once: true });
            }
            this.pending.push(pending);
            this.emitDecision({
                requestId: normalized.requestId,
                status: "queued",
                workloadKind: normalized.workloadKind,
                priority: normalized.priority,
                queuePosition: this.queuePosition(normalized.requestId),
                reasons: ["Waiting for resource admission."],
                decidedAt: this.now(),
            });
            this.scheduleDrain();
        });
    }

    async withLease<T>(request: WorkloadRequest, task: (lease: ResourceLease) => Promise<T>, options: AcquireOptions = {}): Promise<T> {
        const lease = await this.acquire(request, options);
        const heartbeatIntervalMs = Math.max(500, Math.floor(this.leaseTtlMs / 3));
        const heartbeatTimer = setInterval(() => this.heartbeat(lease.leaseId), heartbeatIntervalMs);
        heartbeatTimer.unref();
        try {
            return await task(lease);
        } finally {
            clearInterval(heartbeatTimer);
            this.release(lease.leaseId);
        }
    }

    heartbeat(leaseId: string): ResourceLease | null {
        const active = this.active.get(leaseId);
        if (!active) return null;
        active.lease = { ...active.lease, expiresAt: this.now() + this.leaseTtlMs };
        return this.cloneLease(active.lease);
    }

    release(leaseId: string): boolean {
        if (!this.active.delete(leaseId)) return false;
        this.scheduleDrain();
        return true;
    }

    sweepExpiredLeases(): string[] {
        const now = this.now();
        const expired: string[] = [];
        for (const [leaseId, active] of this.active) {
            if (active.lease.expiresAt > now) continue;
            this.active.delete(leaseId);
            expired.push(leaseId);
        }
        if (expired.length > 0) this.scheduleDrain();
        return expired;
    }

    getTelemetry(): ResourceTelemetry {
        const hardware = this.lastHardware;
        return {
            capturedAt: this.now(),
            capacity: hardware ? {
                cpuThreads: hardware.cpuThreads,
                availableCpuThreads: hardware.availableCpuThreads,
                totalRamMB: hardware.totalRamMB,
                availableRamMB: hardware.availableRamMB,
                gpuCount: hardware.gpus.length,
                availableGpuCount: hardware.gpus.filter((gpu) => gpu.computeAvailable).length,
            } : null,
            activeLeases: [...this.active.values()].map(({ lease }) => {
                const { requestId: _requestId, ...sanitized } = this.cloneLease(lease);
                return sanitized;
            }),
            queuedRequests: this.sortedPending().map((pending) => ({
                workloadKind: pending.request.workloadKind,
                priority: pending.request.priority,
                queuedAt: pending.queuedAt,
            })),
            pressure: this.pressureProvider(),
            budgetMode: this.budgetSettingsProvider().mode,
        };
    }

    shutdown(): void {
        if (this.stopped) return;
        this.stopped = true;
        if (this.sweepTimer) clearInterval(this.sweepTimer);
        this.unsubscribePressure();
        for (const pending of this.pending.splice(0)) {
            this.detachAbortListener(pending);
            pending.reject(abortError("The resource orchestrator is shutting down."));
        }
        this.active.clear();
        this.decisionListeners.clear();
    }

    private normalizeRequest(request: WorkloadRequest): NormalizedWorkloadRequest {
        const requirements = request.requirements ?? {};
        const accelerator = requirements.accelerator ?? "none";
        const acceleratorDeviceIds = [...new Set(requirements.acceleratorDeviceIds ?? [])];
        return {
            ...request,
            requestId: request.requestId?.trim() || this.idGenerator(),
            requirements: {
                cpuThreads: finiteInteger(requirements.cpuThreads, 1),
                ramMB: finiteInteger(requirements.ramMB, 0),
                accelerator,
                acceleratorDeviceIds,
                vramMB: finiteInteger(requirements.vramMB, 0),
                allowCpuFallback: requirements.allowCpuFallback ?? accelerator === "preferred",
                exclusiveAccelerator: requirements.exclusiveAccelerator ?? accelerator !== "none",
            },
            queueIfUnavailable: request.queueIfUnavailable ?? true,
        };
    }

    private scheduleDrain(): void {
        if (this.stopped) return;
        if (this.draining) {
            this.drainAgain = true;
            return;
        }
        void this.drain();
    }

    private async drain(): Promise<void> {
        if (this.draining || this.stopped) return;
        this.draining = true;
        this.drainAgain = false;
        try {
            const rawHardware = await this.hardwareProvider();
            // Read fresh every cycle (not cached at construction) so a
            // user changing the resource mode mid-session takes effect on
            // the very next admission pass, no restart needed.
            this.lastHardware = applyResourceBudgetMode(rawHardware, this.budgetSettingsProvider());
            let progressed = true;
            while (progressed && !this.stopped) {
                progressed = false;
                for (const pending of this.sortedPending()) {
                    if (!this.pending.includes(pending)) continue;
                    const result = this.evaluate(pending.request, this.lastHardware);
                    if (result.kind === "wait") {
                        if (!pending.request.queueIfUnavailable) {
                            this.rejectPending(pending, "rejected-insufficient-resources", result.reasons);
                            progressed = true;
                        }
                        continue;
                    }
                    if (result.kind === "reject") {
                        this.rejectPending(pending, result.status, result.reasons);
                        progressed = true;
                        continue;
                    }
                    this.grantPending(pending, result);
                    progressed = true;
                }
            }
        } catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            for (const pending of this.pending.splice(0)) {
                this.detachAbortListener(pending);
                pending.reject(new Error(`Resource hardware detection failed: ${reason}`));
            }
        } finally {
            this.draining = false;
            if (this.drainAgain && !this.stopped) this.scheduleDrain();
        }
    }

    private evaluate(request: NormalizedWorkloadRequest, hardware: HardwareSnapshot): AdmissionResult {
        // Item 4/5: sustained system pressure gates only the two lowest
        // priority tiers, regardless of whether THIS request's own declared
        // requirements would otherwise fit — pressure reflects system-wide
        // memory health this orchestrator's own per-lease bookkeeping can't
        // see (other processes, OS overhead), which is exactly the gap
        // hysteresis-based monitoring exists to cover. Interactive, explicit
        // model-load, and scheduled-inference requests are never gated here.
        if (RESOURCE_PRIORITY_RANK[request.priority] <= BACKGROUND_TIER_MAX_RANK) {
            const pressure = this.pressureProvider();
            if (pressure === "critical") {
                return { kind: "reject", status: "rejected-insufficient-resources", reasons: [
                    "System memory is under critical pressure; new background work is rejected until it recovers.",
                ] };
            }
            if (pressure === "warning") {
                return { kind: "wait", reasons: [
                    "System memory is under sustained pressure; background work is paused until it recovers.",
                ] };
            }
        }

        const requirements = request.requirements;
        const reasons: string[] = [];
        const activeBudgets = [...this.active.values()].map(({ lease }) => lease.budget);
        const reservedCpuThreads = activeBudgets.reduce((sum, budget) => sum + budget.cpuThreads, 0);
        const reservedRamMB = activeBudgets.reduce((sum, budget) => sum + budget.ramMB, 0);
        const availableCpuThreads = Math.max(0, hardware.availableCpuThreads - reservedCpuThreads);
        const availableRamMB = Math.max(0, hardware.availableRamMB - reservedRamMB);

        let cpuThreads = requirements.cpuThreads;
        if (cpuThreads > hardware.availableCpuThreads) {
            if (!requirements.allowCpuFallback || hardware.availableCpuThreads < 1) {
                return { kind: "reject", status: "rejected-insufficient-resources", reasons: [
                    `Requested ${cpuThreads} CPU threads, but only ${hardware.availableCpuThreads} are safely available.`,
                ] };
            }
            cpuThreads = hardware.availableCpuThreads;
            reasons.push(`CPU budget reduced to ${cpuThreads} threads.`);
        }
        if (requirements.ramMB > hardware.totalRamMB) {
            return { kind: "reject", status: "rejected-insufficient-resources", reasons: [
                `Requested ${requirements.ramMB}MB RAM, but the system has ${hardware.totalRamMB}MB.`,
            ] };
        }
        if (cpuThreads > availableCpuThreads || requirements.ramMB > availableRamMB) {
            return { kind: "wait", reasons: ["CPU or RAM budget is temporarily reserved by another workload."] };
        }

        let acceleratorDeviceIds: string[] = [];
        let vramMB = 0;
        const needsAccelerator = requirements.accelerator !== "none";
        const computeGpus = hardware.gpus.filter((gpu) => gpu.computeAvailable);
        let candidates = computeGpus;
        if (requirements.acceleratorDeviceIds.length > 0) {
            const requested = new Set(requirements.acceleratorDeviceIds);
            candidates = computeGpus.filter((gpu) => requested.has(gpu.id));
            const missing = requirements.acceleratorDeviceIds.filter((id) => !candidates.some((gpu) => gpu.id === id));
            if (missing.length > 0) {
                return { kind: "reject", status: "rejected-incompatible", reasons: [
                    `Requested accelerator device${missing.length === 1 ? " is" : "s are"} unavailable: ${missing.join(", ")}.`,
                ] };
            }
        }

        if (needsAccelerator && candidates.length === 0) {
            if (requirements.accelerator === "required" || !requirements.allowCpuFallback) {
                return { kind: "reject", status: "rejected-incompatible", reasons: ["No compatible compute accelerator is available."] };
            }
            reasons.push("No compatible accelerator is available; using CPU fallback.");
        } else if (needsAccelerator) {
            // Explicit selections are an atomic device group (tensor-parallel
            // requests must receive every selected device or none). Automatic
            // selection chooses one eligible device. Reservations are tracked
            // per stable device id, so two independent GPUs can run concurrent
            // workloads instead of contending on the old process-global slot.
            const requestedGroup = requirements.acceleratorDeviceIds.length > 0;
            const groups = requestedGroup ? [candidates] : candidates.map((candidate) => [candidate]);
            let selected: typeof candidates | null = null;
            let permanentlyTooSmall = true;
            for (const group of groups) {
                const groupTooSmall = group.some((gpu) => gpu.totalVramMB !== null && requirements.vramMB > gpu.totalVramMB);
                if (groupTooSmall) continue;
                permanentlyTooSmall = false;
                const groupAvailable = group.every((gpu) => {
                    const reservations = activeBudgets.filter((budget) => budget.acceleratorDeviceIds.includes(gpu.id));
                    const exclusiveConflict = reservations.some((budget) => budget.exclusiveAccelerator) || (requirements.exclusiveAccelerator && reservations.length > 0);
                    if (exclusiveConflict) return false;
                    const reservedVramMB = reservations.reduce((sum, budget) => sum + budget.vramMB, 0);
                    const safelyAvailableVramMB = gpu.availableVramMB === null
                        ? gpu.totalVramMB === null ? null : Math.max(0, gpu.totalVramMB - reservedVramMB)
                        : gpu.totalVramMB === null ? gpu.availableVramMB : Math.min(gpu.availableVramMB, Math.max(0, gpu.totalVramMB - reservedVramMB));
                    return requirements.vramMB === 0 || safelyAvailableVramMB === null || requirements.vramMB <= safelyAvailableVramMB;
                });
                if (groupAvailable) {
                    selected = group;
                    break;
                }
            }

            if (!selected && permanentlyTooSmall) {
                if (requirements.accelerator === "preferred" && requirements.allowCpuFallback) {
                    reasons.push("Requested VRAM exceeds every selected accelerator; using CPU fallback.");
                } else {
                    return { kind: "reject", status: "rejected-insufficient-resources", reasons: [
                        `Requested ${requirements.vramMB}MB VRAM per device, but the selected accelerator group cannot satisfy it.`,
                    ] };
                }
            } else if (!selected) {
                return { kind: "wait", reasons: [requestedGroup
                    ? "One or more accelerators in the requested group are currently reserved or lack free VRAM."
                    : "All compatible accelerators are currently reserved or lack free VRAM."] };
            } else {
                acceleratorDeviceIds = selected.map((gpu) => gpu.id);
                vramMB = requirements.vramMB;
            }
        }

        // A preferred GPU request that degraded to CPU still reserves one
        // CPU-fallback model-load slot, preserving the original OOM-race
        // protection without blocking unrelated real GPU devices.
        if (requirements.exclusiveAccelerator && acceleratorDeviceIds.length === 0
            && activeBudgets.some((budget) => budget.exclusiveAccelerator && budget.acceleratorDeviceIds.length === 0)) {
            return { kind: "wait", reasons: ["The exclusive CPU-fallback model-load slot is in use."] };
        }

        return {
            kind: "grant",
            budget: {
                cpuThreads,
                ramMB: requirements.ramMB,
                acceleratorDeviceIds,
                vramMB,
                exclusiveAccelerator: requirements.exclusiveAccelerator,
            },
            reasons,
        };
    }

    private grantPending(pending: PendingRequest, grant: AdmissionGrant): void {
        this.removePending(pending);
        const now = this.now();
        const lease: ResourceLease = {
            leaseId: this.idGenerator(),
            requestId: pending.request.requestId,
            workloadKind: pending.request.workloadKind,
            priority: pending.request.priority,
            decision: grant.reasons.length > 0 ? "granted-degraded" : "granted",
            budget: grant.budget,
            reasons: grant.reasons,
            grantedAt: now,
            expiresAt: now + this.leaseTtlMs,
        };
        this.active.set(lease.leaseId, { lease });
        this.emitDecision({
            requestId: lease.requestId,
            status: lease.decision,
            workloadKind: lease.workloadKind,
            priority: lease.priority,
            leaseId: lease.leaseId,
            budget: { ...lease.budget, acceleratorDeviceIds: [...lease.budget.acceleratorDeviceIds] },
            reasons: [...lease.reasons],
            decidedAt: now,
        });
        pending.resolve(this.cloneLease(lease));
    }

    private rejectPending(pending: PendingRequest, status: AdmissionReject["status"], reasons: string[]): void {
        this.removePending(pending);
        this.emitDecision({
            requestId: pending.request.requestId,
            status,
            workloadKind: pending.request.workloadKind,
            priority: pending.request.priority,
            reasons: [...reasons],
            decidedAt: this.now(),
        });
        pending.reject(new ResourceAdmissionError(status, pending.request.requestId, reasons));
    }

    private cancelPending(requestId: string, error: Error): boolean {
        const pending = this.pending.find((item) => item.request.requestId === requestId);
        if (!pending) return false;
        this.removePending(pending);
        pending.reject(error);
        this.scheduleDrain();
        return true;
    }

    private removePending(pending: PendingRequest): void {
        const index = this.pending.indexOf(pending);
        if (index >= 0) this.pending.splice(index, 1);
        this.detachAbortListener(pending);
    }

    private detachAbortListener(pending: PendingRequest): void {
        if (pending.abortSignal && pending.abortListener) {
            pending.abortSignal.removeEventListener("abort", pending.abortListener);
        }
    }

    private sortedPending(): PendingRequest[] {
        return [...this.pending].sort((left, right) =>
            RESOURCE_PRIORITY_RANK[right.request.priority] - RESOURCE_PRIORITY_RANK[left.request.priority]
            || left.sequence - right.sequence
        );
    }

    private queuePosition(requestId: string): number {
        return this.sortedPending().findIndex((pending) => pending.request.requestId === requestId) + 1;
    }

    private cloneLease(lease: ResourceLease): ResourceLease {
        return {
            ...lease,
            budget: { ...lease.budget, acceleratorDeviceIds: [...lease.budget.acceleratorDeviceIds] },
            reasons: [...lease.reasons],
        };
    }

    private emitDecision(decision: ResourceDecision): void {
        for (const listener of this.decisionListeners) {
            try { listener(decision); } catch { /* observers cannot break admission */ }
        }
    }
}

export const mainResourceOrchestrator = new ResourceOrchestrator();
