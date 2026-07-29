"""Deterministic, architecture-agnostic memory/speed formulas.

These are the physics "baseline" the hybrid model corrects with a learned
residual (see model.py) — the same functions also generate synthetic
training labels (features.py's label_example), so the baseline the network
learns to correct and the labels it sees for pure-synthetic rows can never
drift apart. Every formula here is a deliberately rough approximation (noted
inline); real measurements should dominate wherever they're available, which
is exactly what the residual formulation in model.py is for.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

FIT_STATUSES = ["Runs comfortably", "May require partial GPU offload", "CPU only", "Insufficient memory"]

# Rough whole-system power draw while decoding, by backend (Watts) — used only
# as a proxy for the energy_per_token_j baseline.
BACKEND_WATTS = {"cuda": 220.0, "rocm": 200.0, "vulkan": 150.0, "directml": 120.0, "metal": 35.0, "none": 65.0}
# Rough weights-from-disk read throughput used for the load-time baseline.
DISK_READ_GBPS = {"cuda": 2.2, "rocm": 2.0, "vulkan": 1.8, "directml": 1.6, "metal": 3.0, "none": 1.4}
# Assumed prompt length (tokens) for the time-to-first-token baseline — TTFT
# scales with prompt length, but callers only have "recommend a quantization"
# context, not an actual prompt, so a nominal mid-size prompt stands in.
ASSUMED_PROMPT_TOKENS = 256


@dataclass
class MemoryEstimate:
    weight_gb: float
    usable_ram_gb: float
    usable_vram_gb: float
    total_usable_gb: float
    accelerator: bool
    status: str
    headroom_gb: float
    peak_vram_gb: float
    peak_ram_gb: float


def estimated_weight_gb(params_b: float, quant_bits: float, is_moe: bool = False) -> float:
    # Quantized weights plus tensors/runtime metadata. This deliberately errs
    # slightly high; real GGUF sizes should replace it when available.
    base = params_b * quant_bits / 8.0 * 1.12 + 0.35
    return base * (1.08 if is_moe else 1.0)


def usable_memory(ram_gb: float, aggregate_vram_gb: float, backend: str, platform: str) -> tuple[float, float, float, bool]:
    os_reserve = max(2.0, ram_gb * 0.12)
    usable_ram = max(0.0, ram_gb - os_reserve)
    usable_vram = max(0.0, aggregate_vram_gb * 0.88)
    accelerator = backend not in {"none", "cpu"} and aggregate_vram_gb >= 0.5
    # Apple unified memory: VRAM and RAM are the same pool, so don't double-count it.
    total_usable = usable_ram + (0.0 if platform == "macos" and backend == "metal" else usable_vram)
    return usable_ram, usable_vram, total_usable, accelerator


def classify_fit(weight_gb: float, usable_ram: float, usable_vram: float, total_usable: float, accelerator: bool) -> str:
    if weight_gb > total_usable * 0.94:
        return "Insufficient memory"
    if accelerator and weight_gb <= usable_vram * 0.90:
        return "Runs comfortably"
    if accelerator and weight_gb <= total_usable * 0.90:
        return "May require partial GPU offload"
    if weight_gb <= usable_ram * 0.88:
        return "CPU only"
    return "Insufficient memory"


def peak_memory_split(status: str, weight_gb: float, usable_ram: float, usable_vram: float) -> tuple[float, float]:
    # Baseline "idle" OS/driver footprint attributed to RAM even when the
    # model itself lives entirely on the GPU.
    baseline_ram = min(usable_ram, 1.5)
    if status == "Runs comfortably":
        return weight_gb, baseline_ram
    if status == "May require partial GPU offload":
        gpu_part = min(weight_gb, usable_vram * 0.90)
        return gpu_part, max(baseline_ram, weight_gb - gpu_part)
    if status == "CPU only":
        return 0.0, weight_gb + baseline_ram
    # Insufficient memory: report what would be needed, not what fits.
    return min(weight_gb, usable_vram), weight_gb - min(weight_gb, usable_vram)


def memory_headroom_gb(status: str, weight_gb: float, usable_ram: float, usable_vram: float, total_usable: float) -> float:
    if status == "Runs comfortably":
        return max(0.0, usable_vram - weight_gb)
    if status == "May require partial GPU offload":
        return max(0.0, total_usable - weight_gb)
    return max(0.0, usable_ram - weight_gb)


def estimate_memory(params_b: float, quant_bits: float, is_moe: bool, ram_gb: float, aggregate_vram_gb: float, backend: str, platform: str) -> MemoryEstimate:
    weight_gb = estimated_weight_gb(params_b, quant_bits, is_moe)
    usable_ram, usable_vram, total_usable, accelerator = usable_memory(ram_gb, aggregate_vram_gb, backend, platform)
    status = classify_fit(weight_gb, usable_ram, usable_vram, total_usable, accelerator)
    headroom = memory_headroom_gb(status, weight_gb, usable_ram, usable_vram, total_usable)
    peak_vram, peak_ram = peak_memory_split(status, weight_gb, usable_ram, usable_vram)
    return MemoryEstimate(weight_gb, usable_ram, usable_vram, total_usable, accelerator, status, headroom, peak_vram, peak_ram)


def context_tokens_estimate(memory_headroom_gb: float, params_b: float) -> int:
    # A conservative architecture-agnostic KV estimate. GQA/MQA models can use
    # less, while older full multi-head attention models can use considerably
    # more. Keep 30% of remaining memory for graph/work buffers and batching.
    kv_gb_per_1k = max(0.12, 0.17 * np.sqrt(params_b / 7.0))
    context = int(np.clip((memory_headroom_gb * 0.70 / kv_gb_per_1k) * 1024, 2048, 131072))
    return 2 ** int(np.floor(np.log2(max(context, 2048))))


def decode_tokens_per_second(params_b: float, quant_bits: float, status: str, backend: str, usable_vram_gb: float, weight_gb: float, cpu_cores: int) -> float:
    gpu_factor = {"cuda": 1.0, "metal": 0.82, "rocm": 0.85, "vulkan": 0.62, "directml": 0.42}.get(backend, 0.0)
    if status == "Insufficient memory":
        speed = 0.0
    elif status == "Runs comfortably":
        speed = (42.0 * gpu_factor * (4.75 / quant_bits)) / np.sqrt(params_b / 7.0)
    elif status == "May require partial GPU offload":
        offload_ratio = min(1.0, usable_vram_gb / max(weight_gb, 0.1))
        speed = (9.0 + 28.0 * gpu_factor * offload_ratio) / np.sqrt(params_b / 7.0)
    else:
        speed = (1.8 * np.sqrt(max(cpu_cores, 1)) * (4.75 / quant_bits)) / np.sqrt(params_b / 7.0)
    return float(np.clip(speed, 0.0, 250.0))


def prefill_tokens_per_second(decode_tps: float, accelerator: bool) -> float:
    # Prefill is compute-bound and processes the prompt in parallel, unlike
    # memory-bandwidth-bound autoregressive decode — a rough multiplier
    # stands in for a real prefill benchmark.
    return decode_tps * (6.0 if accelerator else 2.5)


def time_to_first_token_ms(prefill_tps: float) -> float:
    return 1000.0 * ASSUMED_PROMPT_TOKENS / max(prefill_tps, 1e-3)


def model_load_time_ms(weight_gb: float, backend: str) -> float:
    read_gbps = DISK_READ_GBPS.get(backend, DISK_READ_GBPS["none"])
    return 1000.0 * weight_gb / read_gbps + 400.0


def energy_per_token_j(decode_tps: float, backend: str) -> float:
    watts = BACKEND_WATTS.get(backend, BACKEND_WATTS["none"])
    return watts / max(decode_tps, 0.1)


def derive_fit_and_context(
    predicted_peak_vram_gb: float,
    predicted_peak_ram_gb: float,
    ram_gb: float,
    aggregate_vram_gb: float,
    backend: str,
    platform: str,
    params_b: float,
) -> tuple[str, int]:
    """Derive fit_status/context_tokens from a *predicted* memory footprint
    (physics baseline + learned residual) instead of a separately-predicted
    classification head — keeps "does it fit" logically tied to the same
    number the model actually predicts, so the two can't disagree."""
    usable_ram, usable_vram, total_usable, accelerator = usable_memory(ram_gb, aggregate_vram_gb, backend, platform)
    total_predicted = predicted_peak_vram_gb + predicted_peak_ram_gb
    on_gpu = predicted_peak_vram_gb > 0.15
    # peak_memory_split() always attributes a baseline OS/driver RAM footprint
    # (up to ~1.5GB) even to a model that lives entirely on the GPU — compare
    # against that floor (plus margin), not zero, or nearly every
    # "Runs comfortably" row misclassifies as partial offload.
    on_cpu = predicted_peak_ram_gb > min(usable_ram, 1.5) + 0.5
    if total_predicted > total_usable * 0.98:
        status = "Insufficient memory"
    elif accelerator and on_gpu and not on_cpu:
        status = "Runs comfortably"
    elif accelerator and on_gpu and on_cpu:
        status = "May require partial GPU offload"
    elif not on_gpu and predicted_peak_ram_gb <= usable_ram:
        status = "CPU only"
    else:
        status = "Insufficient memory"
    headroom = max(0.0, total_usable - total_predicted)
    context = context_tokens_estimate(headroom, params_b)
    return status, context


# Deterministic (non-learned) multi-GPU strategy classification — kept
# separate from classify_fit()/derive_fit_and_context() above rather than
# folded into them, so the trained model's existing feature/label pipeline
# (which only ever sees an aggregate_vram_gb scalar, not a per-device list)
# doesn't need retraining for this to work. This always runs on the
# deterministic path (recommender_worker.py's fallback and the CLI here),
# so multi-GPU-aware fit reasoning is available even with the ML worker
# absent/unhealthy.
GPU_STRATEGY_STATUSES = ["fits-one-gpu", "fits-layer-split", "fits-tensor-parallel", "cpu-offload-only", "insufficient"]


def classify_gpu_strategy(weight_gb: float, per_device_usable_vram_gb: list[float], usable_ram_gb: float) -> str:
    """5-way fit classification across an explicit list of *per-device* usable
    VRAM figures — never treats the sum as one contiguous pool. The smallest
    participating device is the tensor-parallel limiter (an even shard has to
    fit on every device, including the smallest), while layer/pipeline
    splitting only needs the *aggregate* to cover the weights since layers can
    be distributed unevenly."""
    if not per_device_usable_vram_gb:
        return "cpu-offload-only" if weight_gb <= usable_ram_gb * 0.88 else "insufficient"
    largest = max(per_device_usable_vram_gb)
    smallest = min(per_device_usable_vram_gb)
    aggregate = sum(per_device_usable_vram_gb)
    device_count = len(per_device_usable_vram_gb)
    if weight_gb <= largest * 0.90:
        return "fits-one-gpu"
    if device_count > 1 and weight_gb / device_count <= smallest * 0.90:
        return "fits-tensor-parallel"
    if device_count > 1 and weight_gb <= aggregate * 0.90:
        return "fits-layer-split"
    if weight_gb <= aggregate * 0.90 + usable_ram_gb * 0.88:
        return "cpu-offload-only"
    return "insufficient"


def param_bucket(params_b: float) -> str:
    """Coarse size bucket used as part of the OOD support-count key — large
    models are comparatively rare and some sizes are held out of training
    entirely (see train.py's unseen_family_mask), so (platform, backend)
    alone isn't enough to catch a genuinely unsupported request."""
    if params_b > 60:
        return "xlarge"
    if params_b > 20:
        return "large"
    if params_b > 8:
        return "mid"
    return "small"


def mahalanobis_distance(feature_vector: np.ndarray, mean: np.ndarray, cov_inv: np.ndarray) -> float:
    """Distance of an encoded (normalized) feature vector from the training
    distribution, in units of training-set standard deviation along the
    directions the data actually varies in — a single continuous OOD signal
    covering the *whole* feature vector (params, quant, RAM/VRAM, GPU count,
    platform/backend one-hots), not just the (platform, backend, size-bucket)
    support count. Requires cov_inv from train.py's regularized training-set
    covariance (see fit_ood_stats)."""
    diff = feature_vector - mean
    return float(np.sqrt(max(float(diff @ cov_inv @ diff), 0.0)))


def is_out_of_distribution(support_count: int, min_support: int, distance: float, distance_p99: float, distance_buffer: float = 1.3) -> bool:
    """True if either OOD signal fires: a hardware combination barely seen at
    all (support_count), or a feature vector meaningfully farther from the
    training distribution than the 99th-percentile training row itself was
    (distance) — catching cases the coarse bucket count misses, like a
    parameter count that's technically "supported" in bulk but was never
    combined with this specific RAM/VRAM/backend mix."""
    return support_count < min_support or distance > distance_p99 * distance_buffer


def prediction_confidence(mean_log_variance: float, is_ood: bool, ood_penalty: float = 0.35) -> float:
    """A 0-1 confidence score from the model's own predicted uncertainty,
    discounted when is_out_of_distribution() flags the request — near-zero
    learned variance on a row the training data barely covered would
    otherwise be a false "certain" reading, not a real one."""
    variance_confidence = float(np.clip(np.exp(-max(mean_log_variance, 0.0)), 0.0, 1.0))
    return variance_confidence * (ood_penalty if is_ood else 1.0)
