import { z } from "zod";

const identifierSchema = z.string().min(1).max(200);
const timestampSchema = z.string().datetime({ offset: true });
const labelsSchema = z.record(z.string().min(1).max(100), z.string().max(500));

export const computeNodeStateSchema = z.enum(["online", "offline", "cordoned", "draining", "quarantined"]);
export const computeWorkloadStateSchema = z.enum(["queued", "assigned", "running", "preempting", "completed", "failed", "cancelled"]);
export const acceleratorHealthSchema = z.enum(["healthy", "degraded", "unhealthy", "quarantined"]);
export const acceleratorSharingModeSchema = z.enum(["exclusive", "shared", "partition"]);
export const computeRuntimeSchema = z.enum(["llamacpp", "vllm"]);
export const computePrioritySchema = z.enum(["interactive", "imaging", "scheduled", "background", "maintenance"]);
export const resourceProfileSchema = z.enum(["interactive", "balanced", "throughput", "energy-efficient"]);

export const acceleratorDeviceSchema = z.object({
    id: identifierSchema,
    nodeId: identifierSchema,
    vendor: z.enum(["nvidia", "amd", "intel", "apple", "other"]),
    model: z.string().min(1).max(500),
    totalVramMB: z.number().int().nonnegative(),
    freeVramMB: z.number().int().nonnegative(),
    computeCapability: z.string().max(100).optional(),
    numaNode: z.number().int().nonnegative().optional(),
    pciBusId: z.string().max(100).optional(),
    parentDeviceId: identifierSchema.optional(),
    partitionId: z.string().max(200).optional(),
    sharingMode: acceleratorSharingModeSchema,
    maxConcurrency: z.number().int().positive().max(1_024).default(1),
    health: acceleratorHealthSchema,
    supportedRuntimes: z.array(computeRuntimeSchema).min(1),
    utilizationPercent: z.number().min(0).max(100).optional(),
    temperatureC: z.number().min(-100).max(250).optional(),
    powerWatts: z.number().nonnegative().optional(),
    eccErrorCount: z.number().int().nonnegative().optional(),
    throttled: z.boolean().default(false),
}).strict().superRefine((device, context) => {
    if (device.freeVramMB > device.totalVramMB) {
        context.addIssue({ code: "custom", path: ["freeVramMB"], message: "freeVramMB must not exceed totalVramMB" });
    }
    if (device.sharingMode === "partition" && !device.parentDeviceId) {
        context.addIssue({ code: "custom", path: ["parentDeviceId"], message: "partition devices require parentDeviceId" });
    }
});

const computeNodeInventoryShape = {
    id: identifierSchema,
    name: z.string().min(1).max(500),
    region: z.string().min(1).max(100),
    labels: labelsSchema.default({}),
    operatingSystem: z.enum(["windows", "linux", "macos"]),
    architecture: z.enum(["x64", "arm64"]),
    agentVersion: z.string().min(1).max(100),
    certificateFingerprint: z.string().min(1).max(500),
    cpuThreads: z.number().int().positive(),
    freeCpuThreads: z.number().int().nonnegative(),
    totalRamMB: z.number().int().positive(),
    freeRamMB: z.number().int().nonnegative(),
    numaNodes: z.number().int().positive().default(1),
    supportedRuntimes: z.array(computeRuntimeSchema),
    warmModelIds: z.array(identifierSchema).max(1_000).default([]),
    devices: z.array(acceleratorDeviceSchema),
    inventoryVersion: z.string().min(1).max(200),
};

function validateNodeInventory(node: { id: string; devices: Array<{ nodeId: string }> }, context: z.core.$RefinementCtx): void {
    node.devices.forEach((device, index) => {
        if (device.nodeId !== node.id) context.addIssue({ code: "custom", path: ["devices", index, "nodeId"], message: "device nodeId must match node id", input: device.nodeId });
    });
}

export const computeNodeInventorySchema = z.object(computeNodeInventoryShape).strict().superRefine(validateNodeInventory);

export const computeNodeSchema = z.object({
    ...computeNodeInventoryShape,
    organizationId: identifierSchema,
    state: computeNodeStateSchema,
    lastHeartbeatAt: timestampSchema,
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
}).strict().superRefine((node, context) => {
    if (node.freeCpuThreads > node.cpuThreads) context.addIssue({ code: "custom", path: ["freeCpuThreads"], message: "freeCpuThreads must not exceed cpuThreads" });
    if (node.freeRamMB > node.totalRamMB) context.addIssue({ code: "custom", path: ["freeRamMB"], message: "freeRamMB must not exceed totalRamMB" });
    validateNodeInventory(node, context);
});

export const resourcePoolSchema = z.object({
    id: identifierSchema,
    organizationId: identifierSchema,
    name: z.string().min(1).max(500),
    region: z.string().min(1).max(100),
    labels: labelsSchema.default({}),
    nodeIds: z.array(identifierSchema).max(10_000),
    status: z.enum(["active", "draining", "disabled"]),
    schedulingPolicy: z.enum(["interactive-first", "balanced", "utilization", "energy"]),
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
}).strict();

export const tenantComputeQuotaSchema = z.object({
    organizationId: identifierSchema,
    poolId: identifierSchema,
    reservedCpuThreads: z.number().int().nonnegative(),
    reservedRamMB: z.number().int().nonnegative(),
    reservedAccelerators: z.number().int().nonnegative(),
    burstCpuThreads: z.number().int().nonnegative(),
    burstRamMB: z.number().int().nonnegative(),
    burstAccelerators: z.number().int().nonnegative(),
    weight: z.number().positive().max(1_000).default(1),
    borrowingEnabled: z.boolean().default(true),
    updatedAt: timestampSchema,
}).strict();

export const resourceLimitSchema = z.object({
    maxCpuThreads: z.number().int().positive().optional(),
    maxRamMB: z.number().int().positive().optional(),
    maxPinnedMemoryMB: z.number().int().nonnegative().optional(),
    maxAccelerators: z.number().int().positive().optional(),
    maxVramMBPerDevice: z.number().int().positive().optional(),
    maxConcurrencyPerDevice: z.number().int().positive().max(1_024).optional(),
    maxTemperatureC: z.number().min(1).max(150).optional(),
    maxPowerWatts: z.number().positive().optional(),
    allowCpuFallback: z.boolean().optional(),
    allowedRuntimes: z.array(computeRuntimeSchema).optional(),
    allowedModelIds: z.array(identifierSchema).optional(),
}).strict();

const resourcePolicyInputShape = {
    poolId: identifierSchema.optional(),
    name: z.string().min(1).max(500),
    hardLimits: resourceLimitSchema,
    workloadClassLimits: z.partialRecord(computePrioritySchema, resourceLimitSchema).default({}),
    signature: z.string().min(1).max(10_000),
    issuedAt: timestampSchema,
    expiresAt: timestampSchema,
};

export const resourcePolicyInputSchema = z.object(resourcePolicyInputShape).strict()
    .refine((policy) => policy.expiresAt > policy.issuedAt, { path: ["expiresAt"], message: "expiresAt must follow issuedAt" });

export const resourcePolicySchema = z.object({
    ...resourcePolicyInputShape,
    id: identifierSchema,
    organizationId: identifierSchema,
    version: z.number().int().positive(),
    status: z.enum(["draft", "active", "retired"]),
    createdAt: timestampSchema,
}).strict().refine((policy) => policy.expiresAt > policy.issuedAt, { path: ["expiresAt"], message: "expiresAt must follow issuedAt" });

export const resourceRequirementsSchema = z.object({
    cpuThreads: z.number().int().positive(),
    ramMB: z.number().int().nonnegative(),
    pinnedMemoryMB: z.number().int().nonnegative().default(0),
    acceleratorCount: z.number().int().nonnegative().default(0),
    acceleratorDeviceIds: z.array(identifierSchema).default([]),
    acceleratorVendor: z.enum(["nvidia", "amd", "intel", "apple", "other"]).optional(),
    vramMBPerDevice: z.number().int().nonnegative().default(0),
    computeCapability: z.string().max(100).optional(),
    sameNumaNode: z.boolean().default(false),
    sameVendor: z.boolean().default(true),
    exclusiveAccelerators: z.boolean().default(true),
    runtime: computeRuntimeSchema,
    modelId: identifierSchema.optional(),
    allowCpuFallback: z.boolean().default(false),
}).strict().superRefine((requirements, context) => {
    if (requirements.acceleratorDeviceIds.length > 0 && requirements.acceleratorCount !== requirements.acceleratorDeviceIds.length) {
        context.addIssue({ code: "custom", path: ["acceleratorDeviceIds"], message: "acceleratorCount must match explicit acceleratorDeviceIds" });
    }
    if (requirements.acceleratorCount === 0 && requirements.vramMBPerDevice > 0) {
        context.addIssue({ code: "custom", path: ["vramMBPerDevice"], message: "VRAM cannot be requested without an accelerator" });
    }
});

export const computeResourceRequestSchema = z.object({
    id: identifierSchema,
    organizationId: identifierSchema,
    poolId: identifierSchema,
    workloadKind: z.string().min(1).max(200),
    priority: computePrioritySchema,
    profile: resourceProfileSchema.default("balanced"),
    state: computeWorkloadStateSchema,
    requirements: resourceRequirementsSchema,
    checkpointable: z.boolean().default(false),
    restartable: z.boolean().default(false),
    deadlineAt: timestampSchema.optional(),
    queuedAt: timestampSchema,
    assignedAt: timestampSchema.optional(),
    updatedAt: timestampSchema,
}).strict();

export const allocationExplanationSchema = z.object({
    hardFilterReasons: z.array(z.string().max(2_000)).max(200),
    score: z.number(),
    scoreReasons: z.array(z.string().max(2_000)).max(200),
    degradedToCpu: z.boolean(),
    borrowedCapacity: z.boolean(),
}).strict();

export const computeResourceLeaseSchema = z.object({
    id: identifierSchema,
    requestId: identifierSchema,
    organizationId: identifierSchema,
    poolId: identifierSchema,
    nodeId: identifierSchema,
    acceleratorDeviceIds: z.array(identifierSchema),
    vramMBPerDevice: z.number().int().nonnegative(),
    exclusiveAccelerators: z.boolean(),
    cpuThreads: z.number().int().positive(),
    ramMB: z.number().int().nonnegative(),
    pinnedMemoryMB: z.number().int().nonnegative(),
    fencingToken: z.string().regex(/^\d+$/),
    state: z.enum(["offered", "acknowledged", "running", "released", "expired", "failed"]),
    acknowledgedAt: timestampSchema.optional(),
    acknowledgmentDeadlineAt: timestampSchema,
    renewalDeadlineAt: timestampSchema,
    expiresAt: timestampSchema,
    explanation: allocationExplanationSchema,
    effectivePolicyVersion: z.number().int().positive().optional(),
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
}).strict();

export const nodeHeartbeatSchema = z.object({
    nodeId: identifierSchema,
    inventoryVersion: z.string().min(1).max(200),
    capturedAt: timestampSchema,
    freeCpuThreads: z.number().int().nonnegative(),
    freeRamMB: z.number().int().nonnegative(),
    devices: z.array(acceleratorDeviceSchema),
    runningLeaseIds: z.array(identifierSchema).max(10_000),
}).strict();

export type ComputeNodeState = z.infer<typeof computeNodeStateSchema>;
export type ComputeWorkloadState = z.infer<typeof computeWorkloadStateSchema>;
export type ComputePriority = z.infer<typeof computePrioritySchema>;
export type ResourceProfile = z.infer<typeof resourceProfileSchema>;
export type AcceleratorDevice = z.infer<typeof acceleratorDeviceSchema>;
export type ComputeNode = z.infer<typeof computeNodeSchema>;
export type ComputeNodeInventory = z.infer<typeof computeNodeInventorySchema>;
export type ResourcePool = z.infer<typeof resourcePoolSchema>;
export type TenantComputeQuota = z.infer<typeof tenantComputeQuotaSchema>;
export type ResourceLimit = z.infer<typeof resourceLimitSchema>;
export type ResourcePolicy = z.infer<typeof resourcePolicySchema>;
export type ResourcePolicyInput = z.infer<typeof resourcePolicyInputSchema>;
export type ResourceRequirements = z.infer<typeof resourceRequirementsSchema>;
export type ComputeResourceRequest = z.infer<typeof computeResourceRequestSchema>;
export type AllocationExplanation = z.infer<typeof allocationExplanationSchema>;
export type ComputeResourceLease = z.infer<typeof computeResourceLeaseSchema>;
export type NodeHeartbeat = z.infer<typeof nodeHeartbeatSchema>;
