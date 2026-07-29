// GPU device selection: resolving a persisted, stable-id-based selection to
// the GPUs currently present, and building the runtime-facing artifacts
// (visible-device env vars, tensor-split arrays) from that resolution.
//
// The core rule this file exists to enforce: a saved selection that no
// longer matches reality (missing device, incompatible vendor mixture,
// unsupported parallelism) must never be silently substituted with "some
// other GPU" — callers get a typed error and an explicit "use automatic
// selection instead" recovery path.
import type { GpuInfo } from "./system-specs";

export type GpuSelectionMode = "auto" | "single" | "group" | "all" | "cpu";

export interface GpuSelection {
    mode: GpuSelectionMode;
    // Stable GpuInfo.id values, in the order the user arranged them (order
    // matters for e.g. --main-gpu / first-device conventions). Empty/ignored
    // for "auto"/"all"/"cpu".
    deviceIds: string[];
}

export type GpuSelectionErrorCategory =
    | "selected_gpu_missing"
    | "no_compatible_gpu"
    | "unsupported_backend_device"
    | "unsupported_vendor_mixture"
    | "incompatible_compute_capability"
    | "tensor_parallel_size_mismatch"
    | "invalid_tensor_split"
    | "topology_unsuitable"
    | "device_changed_after_startup";

export class GpuSelectionError extends Error {
    category: GpuSelectionErrorCategory;
    recoveryAction: string;
    // The plain description, before `recoveryAction` is appended into
    // `.message` below — kept so `toIpcMessage()` can re-serialize the three
    // fields independently rather than having to re-split the combined text.
    description: string;
    constructor(category: GpuSelectionErrorCategory, message: string, recoveryAction: string) {
        // Same-process callers (e.g. a unit test, or code in this same
        // Electron main process) get a readable combined message even
        // without knowing about toIpcMessage()/parseGpuSelectionErrorMessage().
        super(`${message} ${recoveryAction}`);
        this.name = "GpuSelectionError";
        this.category = category;
        this.recoveryAction = recoveryAction;
        this.description = message;
    }

    // ipcMain.handle -> ipcRenderer.invoke only carries a plain `.message`
    // string across the process boundary — enumerable custom properties like
    // `category`/`recoveryAction` are dropped by Electron's IPC error
    // serialization. Encoding them into a tagged, parseable message (instead
    // of just relying on the concatenated text) lets a renderer-side catch
    // block recover the structured fields via parseGpuSelectionErrorMessage()
    // and show, say, the recovery action as a distinct call-to-action rather
    // than buried prose.
    toIpcMessage(): string {
        return `${GPU_SELECTION_ERROR_TAG}${JSON.stringify({ category: this.category, recoveryAction: this.recoveryAction, message: this.description })}`;
    }
}

// Printable by design: Electron and log serializers do not preserve NUL
// sentinels consistently, and the renderer may receive an IPC error prefix.
const GPU_SELECTION_ERROR_TAG = " GPU_SELECTION_ERROR ";

export interface ParsedGpuSelectionError {
    category: GpuSelectionErrorCategory;
    recoveryAction: string;
    message: string;
}

// Inverse of toIpcMessage() — returns null for any ordinary error message
// (including one from an older build that didn't tag it), so callers can
// always fall back to displaying the raw message unchanged.
export function parseGpuSelectionErrorMessage(message: string): ParsedGpuSelectionError | null {
    const tagIndex = message.indexOf(GPU_SELECTION_ERROR_TAG);
    if (tagIndex < 0) return null;
    try {
        const parsed = JSON.parse(message.slice(tagIndex + GPU_SELECTION_ERROR_TAG.length));
        if (parsed && typeof parsed.category === "string" && typeof parsed.recoveryAction === "string" && typeof parsed.message === "string") {
            return parsed as ParsedGpuSelectionError;
        }
        return null;
    } catch {
        return null;
    }
}

// Wraps any function that might throw a GpuSelectionError so it crosses an
// ipcMain.handle boundary with its structured fields intact (as a tagged,
// parseable message) instead of losing them to Electron's plain-message-only
// IPC error serialization. Any other error passes through unchanged.
export async function withGpuSelectionErrorEncoding<T>(fn: () => Promise<T>): Promise<T> {
    try {
        return await fn();
    } catch (err) {
        if (err instanceof GpuSelectionError) throw new Error(err.toIpcMessage());
        throw err;
    }
}

export interface ResolvedGpuSelection {
    // Resolved, currently-present devices in selection order (single/group),
    // or the full detected list (auto/all), or [] (cpu).
    gpus: GpuInfo[];
    stale: boolean;
    missingIds: string[];
}

// Maps a saved selection onto the devices actually present right now. Never
// throws by itself for a missing device — it reports `stale`/`missingIds` so
// the caller (IPC layer, UI) can decide whether to hard-fail the startup or
// offer the "use automatic selection instead" repair action, per-mode.
export function resolveGpuSelection(selection: GpuSelection | undefined, availableGpus: GpuInfo[]): ResolvedGpuSelection {
    const mode = selection?.mode ?? "auto";
    if (mode === "cpu") return { gpus: [], stale: false, missingIds: [] };
    if (mode === "auto" || mode === "all") {
        const compatible = availableGpus.filter((gpu) => gpu.computeAvailable !== false && !gpu.displayOnly);
        return { gpus: compatible, stale: false, missingIds: [] };
    }
    const requestedIds = selection?.deviceIds ?? [];
    const byId = new Map(availableGpus.map((gpu, index) => [gpu.id ?? `__index_${index}`, gpu] as const));
    const resolved: GpuInfo[] = [];
    const missingIds: string[] = [];
    for (const id of requestedIds) {
        const gpu = byId.get(id);
        if (gpu) resolved.push(gpu);
        else missingIds.push(id);
    }
    return { gpus: resolved, stale: missingIds.length > 0, missingIds };
}

// Automatic selection must resolve to one compute ecosystem. Passing a mixed
// NVIDIA+AMD set to CUDA/HIP visibility variables or a single vLLM/llama.cpp
// process is invalid. The caller supplies its backend preference order; every
// usable device from the first available vendor is returned, preserving the
// inventory's stable order.
export function selectAutomaticGpuCohort(gpus: GpuInfo[], preferredVendors: string[]): GpuInfo[] {
    const usable = gpus.filter((gpu) => gpu.computeAvailable !== false && !gpu.displayOnly);
    const discoveredVendors = usable
        .map((gpu) => gpu.vendor)
        .filter((vendor, index, vendors) => vendors.indexOf(vendor) === index);
    for (const vendor of [...new Set([...preferredVendors, ...discoveredVendors])]) {
        const cohort = usable.filter((gpu) => gpu.vendor === vendor);
        if (cohort.length > 0) return cohort;
    }
    return [];
}

// vLLM/llama-server multi-GPU support is only meaningful for a single
// compute vendor at a time — mixing NVIDIA and AMD devices in one runtime
// process isn't something either project supports.
export function assertVendorHomogeneity(gpus: GpuInfo[], context: string): void {
    if (gpus.length < 2) return;
    const vendors = new Set(gpus.map((gpu) => gpu.vendor));
    if (vendors.size > 1) {
        throw new GpuSelectionError(
            "unsupported_vendor_mixture",
            `${context} cannot span multiple GPU vendors in one selection (found: ${[...vendors].join(", ")}).`,
            "Select GPUs from a single vendor, or switch to automatic selection.",
        );
    }
}

export function assertTensorParallelSizeMatches(tensorParallelSize: number | undefined, resolvedGpuCount: number): void {
    if (!tensorParallelSize || tensorParallelSize <= 1) return;
    if (tensorParallelSize > resolvedGpuCount) {
        throw new GpuSelectionError(
            "tensor_parallel_size_mismatch",
            `Tensor-parallel size ${tensorParallelSize} exceeds the ${resolvedGpuCount} GPU(s) actually selected/available.`,
            "Lower the tensor-parallel size to match the selected GPU count, or select more GPUs.",
        );
    }
}

const MAX_TENSOR_SPLIT_DEVICES = 16;

// Validates a user-supplied (or auto-generated) tensor-split array before it
// ever reaches a spawned process's argv — count must match the resolved
// device group, every value must be a finite positive number, and nothing
// resembling a shell metacharacter is accepted (values are later
// String()-formatted into argv, never interpolated into a shell string, but
// this keeps the input itself sane regardless).
export function validateTensorSplit(values: number[], deviceCount: number): void {
    if (!Array.isArray(values) || values.length === 0) {
        throw new GpuSelectionError("invalid_tensor_split", "Tensor split requires at least one value.", "Provide one split value per selected GPU, or use automatic splitting.");
    }
    if (values.length !== deviceCount || values.length > MAX_TENSOR_SPLIT_DEVICES) {
        throw new GpuSelectionError("invalid_tensor_split", `Tensor split has ${values.length} value(s) but ${deviceCount} GPU(s) are selected.`, "Match the number of split values to the number of selected GPUs.");
    }
    for (const value of values) {
        if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
            throw new GpuSelectionError("invalid_tensor_split", "Every tensor-split value must be a finite positive number.", "Correct or remove the invalid split value.");
        }
    }
}

// Proportional split by each device's own VRAM — a 24GB+8GB pair gets
// roughly 0.75/0.25, not an even 0.5/0.5 that would overflow the 8GB card.
export function usableDeviceMemoryGB(gpu: GpuInfo, reserveGB = 1): number | null {
    const reported = gpu.freeVramGB ?? gpu.vramGB;
    if (reported == null || !Number.isFinite(reported) || reported <= 0) return null;
    const physical = gpu.vramGB ?? reported;
    const safetyReserve = Math.max(Math.max(0, reserveGB), physical * 0.08);
    return Math.max(0, reported - safetyReserve);
}

export function generateAutoTensorSplit(gpus: GpuInfo[], reserveGB = 1): number[] {
    const weights = gpus.map((gpu) => usableDeviceMemoryGB(gpu, reserveGB) ?? 1);
    if (weights.some((value) => value <= 0)) {
        throw new GpuSelectionError(
            "topology_unsuitable",
            "At least one selected GPU has no usable free VRAM after its safety reserve.",
            "Close other GPU workloads, lower the reserve, or remove the exhausted GPU from the selection.",
        );
    }
    const total = weights.reduce((sum, value) => sum + value, 0);
    return weights.map((value) => +(value / total).toFixed(4));
}

// CUDA_VISIBLE_DEVICES/HIP_VISIBLE_DEVICES/ROCR_VISIBLE_DEVICES filter a
// runtime process's own device enumeration down to the resolved selection.
// Returned as a plain object to be merged into that one child process's env
// at spawn time; nothing here touches process.env for the whole app.
export function buildGpuVisibilityEnv(vendor: string, gpus: GpuInfo[]): Record<string, string> {
    if (gpus.length === 0) return {};
    if (vendor === "nvidia") {
        // CUDA_VISIBLE_DEVICES accepts a GPU's UUID directly (nvidia-smi -L's
        // "GPU-..." / "MIG-..." form), which this app's `id` field already
        // carries as `nvidia:<uuid>` for any device probed via nvidia-smi —
        // preferred over the plain numeric index because it's the *only*
        // correct way to select a specific MIG instance (MIG instances don't
        // have their own standalone index the way physical GPUs do), and it
        // sidesteps index-reordering ambiguity for ordinary GPUs too.
        // Falls back to the numeric index only for detection paths that
        // never got a real UUID (Windows WMI / lspci fallback).
        const selectors = gpus.map((gpu) => (gpu.id?.startsWith("nvidia:") ? gpu.id.slice("nvidia:".length) : String(gpu.index ?? 0)));
        return { CUDA_VISIBLE_DEVICES: selectors.join(",") };
    }
    const indices = gpus.map((gpu) => gpu.index ?? 0).join(",");
    if (vendor === "amd") return { HIP_VISIBLE_DEVICES: indices, ROCR_VISIBLE_DEVICES: indices };
    return {};
}

export function resolveMainGpuIndex(gpus: GpuInfo[], mainGpuId: string | undefined): number | undefined {
    if (!mainGpuId) return undefined;
    const index = gpus.findIndex((gpu) => gpu.id === mainGpuId);
    return index >= 0 ? index : undefined;
}
