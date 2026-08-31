export type ResourceWorkloadKind =
    | "active-inference"
    | "user-ocr"
    | "user-rag"
    | "user-media"
    | "model-load"
    | "scheduled-inference"
    | "embedding"
    | "indexing"
    | "download"
    | "backup"
    | "maintenance"
    | "python-worker"
    | "mcp-tool"
    // A lease this desktop node was granted by the enterprise compute
    // control plane (compute-agent.ts) — reserved locally at
    // "background-compute" priority regardless of the server-side request's
    // own priority label, since fleet-delegated work is always someone
    // else's job filling this workstation's spare capacity and must never
    // contend with the person actually sitting at it.
    | "fleet-assigned";

export type ResourcePriority =
    | "active-inference"
    | "user-interactive"
    | "explicit-model-load"
    | "scheduled-inference"
    | "background-compute"
    | "transfer"
    | "maintenance";

export const RESOURCE_PRIORITY_RANK: Readonly<Record<ResourcePriority, number>> = {
    "active-inference": 700,
    "user-interactive": 600,
    "explicit-model-load": 500,
    "scheduled-inference": 400,
    "background-compute": 300,
    transfer: 200,
    maintenance: 100,
};

export type AcceleratorRequirement = "none" | "preferred" | "required";

export interface ResourceRequirements {
    cpuThreads?: number;
    ramMB?: number;
    accelerator?: AcceleratorRequirement;
    acceleratorDeviceIds?: string[];
    vramMB?: number;
    allowCpuFallback?: boolean;
    /**
     * Reserves the one primary accelerator admission slot. The slot remains
     * exclusive when a preferred GPU workload degrades to CPU so two model
     * loads cannot race large RAM allocations on a GPU-less machine.
     */
    exclusiveAccelerator?: boolean;
}

export interface WorkloadRequest {
    requestId?: string;
    workloadKind: ResourceWorkloadKind;
    priority: ResourcePriority;
    requirements?: ResourceRequirements;
    queueIfUnavailable?: boolean;
}

export interface ResourceGpuSnapshot {
    id: string;
    vendor: string;
    totalVramMB: number | null;
    availableVramMB: number | null;
    computeAvailable: boolean;
}

export interface HardwareSnapshot {
    capturedAt: number;
    cpuThreads: number;
    availableCpuThreads: number;
    totalRamMB: number;
    availableRamMB: number;
    gpus: ResourceGpuSnapshot[];
}

export interface ResourceBudget {
    cpuThreads: number;
    ramMB: number;
    acceleratorDeviceIds: string[];
    vramMB: number;
    exclusiveAccelerator: boolean;
}

export type ResourceDecisionStatus =
    | "granted"
    | "granted-degraded"
    | "queued"
    | "rejected-incompatible"
    | "rejected-insufficient-resources";

export interface ResourceDecision {
    requestId: string;
    status: ResourceDecisionStatus;
    workloadKind: ResourceWorkloadKind;
    priority: ResourcePriority;
    leaseId?: string;
    queuePosition?: number;
    budget?: ResourceBudget;
    reasons: string[];
    decidedAt: number;
}

export interface ResourceLease {
    leaseId: string;
    requestId: string;
    workloadKind: ResourceWorkloadKind;
    priority: ResourcePriority;
    decision: "granted" | "granted-degraded";
    budget: ResourceBudget;
    reasons: string[];
    grantedAt: number;
    expiresAt: number;
}

/**
 * Hysteresis-based sustained-pressure classification (item 4: "use
 * hysteresis rather than reacting to every telemetry sample... warn at
 * sustained pressure... pause background work before affecting active
 * chat... reject new heavyweight work before triggering an OOM"). Produced
 * by resource-pressure-monitor.ts, consulted by ResourceOrchestrator.evaluate()
 * to gate admission of background-tier work only — active-inference,
 * user-interactive, explicit-model-load, and scheduled-inference requests
 * are never throttled by this, matching "never silently reduce clinical
 * context or unload an active model."
 */
export type ResourcePressureLevel = "normal" | "warning" | "critical";

/**
 * Item 4: "Default to a Balanced mode." A cross-workload OS-reserve ceiling
 * applied to every hardware snapshot before admission (resource-budget.ts) —
 * distinct from any single backend's own internal memory-sizing config
 * (e.g. llama.cpp's own vramReserveBytes/ramReserveBytes in
 * app/src/settings-store.ts, which only shapes that one backend's context
 * allocation, not what the orchestrator considers "available" for every
 * workload kind).
 */
export type ResourceBudgetMode = "balanced" | "performance" | "efficient" | "manual";

export interface ResourceBudgetSettings {
    mode: ResourceBudgetMode;
    /** Only consulted when mode === "manual"; undefined = no ceiling beyond
     * the small fixed safety floor "manual" still applies. */
    maxRamMB?: number;
    maxVramMB?: number;
    cpuThreadCeiling?: number;
}

export interface ResourceTelemetry {
    capturedAt: number;
    capacity: {
        cpuThreads: number;
        availableCpuThreads: number;
        totalRamMB: number;
        availableRamMB: number;
        gpuCount: number;
        availableGpuCount: number;
    } | null;
    activeLeases: Array<Pick<ResourceLease,
        "leaseId" | "workloadKind" | "priority" | "decision" | "budget" | "reasons" | "grantedAt" | "expiresAt">>;
    queuedRequests: Array<{
        workloadKind: ResourceWorkloadKind;
        priority: ResourcePriority;
        queuedAt: number;
    }>;
    /** Current sustained-pressure classification — "warning"/"critical" mean
     * new background-tier admissions (embedding/indexing, downloads,
     * backup, maintenance) are being queued or rejected; interactive and
     * scheduled inference are never affected by this. */
    pressure: ResourcePressureLevel;
    /** The OS-reserve budget mode currently applied to every admission
     * decision (resource-budget.ts) — reflects AppSettings.resourceBudgetMode
     * live, "balanced" when unset. */
    budgetMode: ResourceBudgetMode;
}
