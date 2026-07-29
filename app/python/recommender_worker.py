#!/usr/bin/env python3
# Long-lived JSON-line worker (same protocol as runtime_worker.py) serving
# predictions from the trained hardware-recommender model
# (ml/hardware-recommender/, exported as artifacts/hardware_recommender.onnx
# + hardware_recommender.meta.json alongside this script — see
# ml/hardware-recommender/export_onnx.py). Runs through onnxruntime rather
# than torch: torch is only needed to *train* the model, and installing it
# just to run a ~40KB network at inference time is disproportionate — see
# python-runtime-manager.ts's "hardware-recommender" manifest, which installs
# onnxruntime instead. Physics-baseline logic here is a trimmed copy of
# ml/hardware-recommender/recommender/physics.py — kept separate (rather than
# imported) so the packaged app/python/ directory stays self-contained and
# doesn't need the training project's pandas/pyarrow dependencies.
import hashlib
import json
import math
import os
import sys
import time
from pathlib import Path

import numpy as np
import onnxruntime as ort

# CPUExecutionProvider is all this ever uses (recommend()/load() below), but
# onnxruntime still probes for GPU devices at session-creation time and logs
# a warning when that probe fails — harmless, but python-runtime-manager.ts
# forwards every stderr line from this process into the app's real logs, so
# it's suppressed rather than left to look like a real problem.
ort.set_default_logger_severity(3)

PROTOCOL_VERSION = 1
STARTED = time.monotonic()

PLATFORMS = ["windows", "linux", "macos"]
GPU_BACKENDS = ["none", "cuda", "rocm", "metal", "vulkan", "directml"]
RUNTIME_CLASSES = ["llama.cpp-cpu", "llama.cpp-cuda", "llama.cpp-rocm", "llama.cpp-metal", "llama.cpp-vulkan", "mlx", "vllm"]
NUMERIC_FEATURES = ["model_params_b", "quality_score", "is_moe", "quant_bits", "ram_gb", "vram_gb", "cpu_cores", "gpu_count", "aggregate_vram_gb"]
QUANTIZATIONS = {"Q2_K": 2.625, "Q3_K_M": 3.50, "Q4_K_M": 4.75, "Q5_K_M": 5.50, "Q6_K": 6.56, "Q8_0": 8.50}
STATUS_ORDER = {"Runs comfortably": 3, "May require partial GPU offload": 2, "CPU only": 1, "Insufficient memory": 0}
REGRESSION_TARGETS = ["peak_vram_gb", "peak_ram_gb", "tokens_per_second", "prompt_tokens_per_second", "time_to_first_token_ms", "model_load_time_ms", "energy_per_token_j"]
MIN_SUPPORT_FOR_CONFIDENCE = 25
DISTANCE_BUFFER = 1.3

BACKEND_WATTS = {"cuda": 220.0, "rocm": 200.0, "vulkan": 150.0, "directml": 120.0, "metal": 35.0, "none": 65.0}
DISK_READ_GBPS = {"cuda": 2.2, "rocm": 2.0, "vulkan": 1.8, "directml": 1.6, "metal": 3.0, "none": 1.4}
ASSUMED_PROMPT_TOKENS = 256


# ---- physics baseline (mirrors recommender/physics.py) --------------------

def estimated_weight_gb(params_b, quant_bits, is_moe):
    base = params_b * quant_bits / 8.0 * 1.12 + 0.35
    return base * (1.08 if is_moe else 1.0)


def usable_memory(ram_gb, aggregate_vram_gb, backend, platform):
    os_reserve = max(2.0, ram_gb * 0.12)
    usable_ram = max(0.0, ram_gb - os_reserve)
    usable_vram = max(0.0, aggregate_vram_gb * 0.88)
    accelerator = backend not in {"none", "cpu"} and aggregate_vram_gb >= 0.5
    total_usable = usable_ram + (0.0 if platform == "macos" and backend == "metal" else usable_vram)
    return usable_ram, usable_vram, total_usable, accelerator


def classify_fit(weight_gb, usable_ram, usable_vram, total_usable, accelerator):
    if weight_gb > total_usable * 0.94:
        return "Insufficient memory"
    if accelerator and weight_gb <= usable_vram * 0.90:
        return "Runs comfortably"
    if accelerator and weight_gb <= total_usable * 0.90:
        return "May require partial GPU offload"
    if weight_gb <= usable_ram * 0.88:
        return "CPU only"
    return "Insufficient memory"


def peak_memory_split(status, weight_gb, usable_ram, usable_vram):
    baseline_ram = min(usable_ram, 1.5)
    if status == "Runs comfortably":
        return weight_gb, baseline_ram
    if status == "May require partial GPU offload":
        gpu_part = min(weight_gb, usable_vram * 0.90)
        return gpu_part, max(baseline_ram, weight_gb - gpu_part)
    if status == "CPU only":
        return 0.0, weight_gb + baseline_ram
    return min(weight_gb, usable_vram), weight_gb - min(weight_gb, usable_vram)


def context_tokens_estimate(memory_headroom_gb, params_b):
    kv_gb_per_1k = max(0.12, 0.17 * math.sqrt(params_b / 7.0))
    context = int(min(max((memory_headroom_gb * 0.70 / kv_gb_per_1k) * 1024, 2048), 131072))
    return 2 ** int(math.floor(math.log2(max(context, 2048))))


def decode_tokens_per_second(params_b, quant_bits, status, backend, usable_vram_gb, weight_gb, cpu_cores):
    gpu_factor = {"cuda": 1.0, "metal": 0.82, "rocm": 0.85, "vulkan": 0.62, "directml": 0.42}.get(backend, 0.0)
    if status == "Insufficient memory":
        speed = 0.0
    elif status == "Runs comfortably":
        speed = (42.0 * gpu_factor * (4.75 / quant_bits)) / math.sqrt(params_b / 7.0)
    elif status == "May require partial GPU offload":
        offload_ratio = min(1.0, usable_vram_gb / max(weight_gb, 0.1))
        speed = (9.0 + 28.0 * gpu_factor * offload_ratio) / math.sqrt(params_b / 7.0)
    else:
        speed = (1.8 * math.sqrt(max(cpu_cores, 1)) * (4.75 / quant_bits)) / math.sqrt(params_b / 7.0)
    return max(0.0, min(speed, 250.0))


def physics_baseline_row(hardware, quant_bits):
    params_b = max(float(hardware["model_params_b"]), 0.1)
    ram_gb = max(float(hardware["ram_gb"]), 0.0)
    aggregate_vram_gb = max(float(hardware.get("aggregate_vram_gb", hardware["vram_gb"])), 0.0)
    cpu_cores = max(int(hardware["cpu_cores"]), 1)
    backend = str(hardware["gpu_backend"])
    platform = str(hardware["platform"])
    is_moe = bool(hardware.get("is_moe"))

    weight_gb = estimated_weight_gb(params_b, quant_bits, is_moe)
    usable_ram, usable_vram, total_usable, accelerator = usable_memory(ram_gb, aggregate_vram_gb, backend, platform)
    status = classify_fit(weight_gb, usable_ram, usable_vram, total_usable, accelerator)
    peak_vram, peak_ram = peak_memory_split(status, weight_gb, usable_ram, usable_vram)
    speed = decode_tokens_per_second(params_b, quant_bits, status, backend, usable_vram, weight_gb, cpu_cores)
    prefill = speed * (6.0 if accelerator else 2.5)
    ttft_ms = 1000.0 * ASSUMED_PROMPT_TOKENS / max(prefill, 1e-3)
    load_ms = 1000.0 * weight_gb / DISK_READ_GBPS.get(backend, DISK_READ_GBPS["none"]) + 400.0
    energy_j = BACKEND_WATTS.get(backend, BACKEND_WATTS["none"]) / max(speed, 0.1)
    return [peak_vram, peak_ram, speed, prefill, ttft_ms, load_ms, energy_j]


def derive_fit_and_context(predicted_peak_vram_gb, predicted_peak_ram_gb, ram_gb, aggregate_vram_gb, backend, platform, params_b):
    usable_ram, usable_vram, total_usable, accelerator = usable_memory(ram_gb, aggregate_vram_gb, backend, platform)
    total_predicted = predicted_peak_vram_gb + predicted_peak_ram_gb
    on_gpu = predicted_peak_vram_gb > 0.15
    # peak_memory_split()'s baseline OS/driver RAM footprint (up to ~1.5GB) is
    # attributed even to a model that lives entirely on the GPU — compare
    # against that floor, not zero, or "Runs comfortably" rows misclassify.
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
    return status, context_tokens_estimate(headroom, params_b)


GPU_STRATEGY_STATUSES = ["fits-one-gpu", "fits-layer-split", "fits-tensor-parallel", "cpu-offload-only", "insufficient"]


def classify_gpu_strategy(weight_gb, per_device_usable_vram_gb, usable_ram_gb):
    # Mirrors recommender/physics.py's classify_gpu_strategy — deterministic,
    # never folded into the learned model's feature/label pipeline, so it
    # works even when the ONNX model itself is unavailable.
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


def param_bucket(params_b):
    if params_b > 60:
        return "xlarge"
    if params_b > 20:
        return "large"
    if params_b > 8:
        return "mid"
    return "small"


def mahalanobis_distance(feature_vector, mean, cov_inv):
    diff = feature_vector - mean
    return float(np.sqrt(max(float(diff @ cov_inv @ diff), 0.0)))


def is_out_of_distribution(support_count, min_support, distance, distance_p99, distance_buffer=DISTANCE_BUFFER):
    return support_count < min_support or distance > distance_p99 * distance_buffer


def prediction_confidence(mean_log_variance, is_ood, ood_penalty=0.35):
    variance_confidence = max(0.0, min(1.0, math.exp(-max(mean_log_variance, 0.0))))
    return variance_confidence * (ood_penalty if is_ood else 1.0)


# ---- worker protocol --------------------------------------------------------

def log(level, event, **fields):
    print(json.dumps({"timestamp": time.time(), "level": level, "event": event, **fields}), file=sys.stderr, flush=True)


def response(request_id, ok, result=None, code=None, message=None):
    payload = {"protocol": PROTOCOL_VERSION, "id": request_id, "ok": ok}
    if ok:
        payload["result"] = result
    else:
        payload["error"] = {"code": code, "message": message}
    print(json.dumps(payload), flush=True)


_session = None
_normalizer_mean = None
_normalizer_std = None
_support_counts = {}
_ood_mean = None
_ood_cov_inv = None
_ood_distance_p99 = float("inf")


def _verify_checksum(path):
    sidecar = path.with_suffix(path.suffix + ".sha256")
    if not sidecar.exists():
        log("warning", "checksum_sidecar_missing", path=str(sidecar))
        return
    expected = sidecar.read_text(encoding="utf-8").strip()
    actual = hashlib.sha256(path.read_bytes()).hexdigest()
    if actual != expected:
        raise RuntimeError(f"Checksum mismatch for {path}: possibly corrupted or tampered artifact.")


def load():
    global _session, _normalizer_mean, _normalizer_std, _support_counts, _ood_mean, _ood_cov_inv, _ood_distance_p99
    if _session is not None:
        return
    artifacts_dir = Path(__file__).parent / "artifacts"
    model_path = artifacts_dir / "hardware_recommender.onnx"
    meta_path = artifacts_dir / "hardware_recommender.meta.json"
    _verify_checksum(model_path)
    meta = json.loads(meta_path.read_text(encoding="utf-8"))
    _session = ort.InferenceSession(str(model_path), providers=["CPUExecutionProvider"])
    _normalizer_mean = meta["normalizer"]["mean"]
    _normalizer_std = meta["normalizer"]["std"]
    _support_counts = meta.get("support_counts", {})
    ood_stats = meta.get("ood_stats") or {}
    if ood_stats:
        _ood_mean = np.asarray(ood_stats["mean"], dtype=np.float64)
        _ood_cov_inv = np.asarray(ood_stats["cov_inv"], dtype=np.float64)
        _ood_distance_p99 = float(ood_stats["distance_p99"])


def encode_row(hardware, quant_bits):
    gpu_count = float(hardware.get("gpu_count", 1 if hardware.get("gpu_backend") != "none" else 0))
    aggregate_vram_gb = float(hardware.get("aggregate_vram_gb", hardware["vram_gb"]))
    numeric = [
        float(hardware["model_params_b"]),
        float(hardware.get("quality_score", 30.0)),
        1.0 if hardware.get("is_moe") else 0.0,
        float(quant_bits),
        float(hardware["ram_gb"]),
        float(hardware["vram_gb"]),
        float(hardware["cpu_cores"]),
        gpu_count,
        aggregate_vram_gb,
    ]
    numeric = [(value - mean) / std for value, mean, std in zip(numeric, _normalizer_mean, _normalizer_std)]
    platform_onehot = [1.0 if hardware["platform"] == name else 0.0 for name in PLATFORMS]
    backend_onehot = [1.0 if hardware["gpu_backend"] == name else 0.0 for name in GPU_BACKENDS]
    return numeric + platform_onehot + backend_onehot


def recommend(hardware):
    load()
    rows = [encode_row(hardware, bits) for bits in QUANTIZATIONS.values()]
    features = np.asarray(rows, dtype=np.float32)
    baselines = np.asarray([physics_baseline_row(hardware, bits) for bits in QUANTIZATIONS.values()], dtype=np.float32)
    baseline_log = np.log1p(np.clip(baselines, 0, None))

    runtime_logits, residual_mean, residual_log_var = _session.run(None, {"features": features})
    predicted = np.expm1(baseline_log + residual_mean).clip(min=0)
    runtime_indices = runtime_logits.argmax(axis=1).tolist()
    mean_log_var = residual_log_var.mean(axis=1).tolist()

    aggregate_vram_gb = float(hardware.get("aggregate_vram_gb", hardware["vram_gb"]))
    support = _support_counts.get(f"{hardware['platform']}|{hardware['gpu_backend']}|{param_bucket(float(hardware['model_params_b']))}", 0)
    distance = float("inf")
    if _ood_mean is not None:
        # Same request hardware for every quantization row (only quant_bits
        # varies), so one distance covers all candidates.
        distance = mahalanobis_distance(features[0].astype(np.float64), _ood_mean, _ood_cov_inv)
    is_ood = is_out_of_distribution(support, MIN_SUPPORT_FOR_CONFIDENCE, distance, _ood_distance_p99)

    # Optional: a per-device VRAM list (not just the aggregate scalar used by
    # the learned feature pipeline above) — when the caller has one, every
    # candidate also gets a deterministic gpuStrategy classification that
    # distinguishes single-GPU / layer-split / tensor-parallel / CPU-offload
    # / doesn't-fit, using the smallest participating device as the
    # tensor-parallel limiter rather than treating the aggregate as one pool.
    per_device_vram_gb = hardware.get("per_device_vram_gb")
    per_device_usable_vram_gb = [max(0.0, float(v) * 0.88) for v in per_device_vram_gb] if per_device_vram_gb else None

    candidates = []
    for index, quantization in enumerate(QUANTIZATIONS):
        vram, ram, speed = float(predicted[index, 0]), float(predicted[index, 1]), float(predicted[index, 2])
        status, context = derive_fit_and_context(vram, ram, float(hardware["ram_gb"]), aggregate_vram_gb, str(hardware["gpu_backend"]), str(hardware["platform"]), float(hardware["model_params_b"]))
        confidence = prediction_confidence(mean_log_var[index], is_ood)
        weight_gb = estimated_weight_gb(float(hardware["model_params_b"]), QUANTIZATIONS[quantization], bool(hardware.get("is_moe")))
        gpu_strategy = classify_gpu_strategy(weight_gb, per_device_usable_vram_gb, max(float(hardware["ram_gb"]) - max(2.0, float(hardware["ram_gb"]) * 0.12), 0.0)) if per_device_usable_vram_gb is not None else None
        candidates.append({
            "quantization": quantization,
            "fit": status,
            "runtime": RUNTIME_CLASSES[runtime_indices[index]],
            "estimatedContextTokens": context,
            "estimatedTokensPerSecond": round(speed, 1),
            "estimatedPeakVramGB": round(vram, 2),
            "estimatedPeakRamGB": round(ram, 2),
            "confidence": round(confidence, 2),
            "lowConfidenceReason": "Low confidence — this hardware/model combination is unlike anything the training data covered." if is_ood else None,
            "gpuStrategy": gpu_strategy,
        })

    comfortable = [c for c in candidates if c["fit"] == "Runs comfortably"]
    viable = [c for c in candidates if STATUS_ORDER[c["fit"]] > 0]
    if comfortable:
        choice = comfortable[-1]
    elif viable:
        choice = next((c for c in viable if c["quantization"] == "Q4_K_M"), viable[0])
    else:
        choice = candidates[0]
    selected = dict(choice)
    selected["allQuantizations"] = candidates
    return selected


log("info", "worker_started", protocol=PROTOCOL_VERSION, pid=os.getpid())
for line in sys.stdin:
    request_id = ""
    try:
        request = json.loads(line)
        request_id = str(request.get("id", ""))
        if request.get("protocol") != PROTOCOL_VERSION:
            response(request_id, False, code="protocol_mismatch", message=f"Expected protocol {PROTOCOL_VERSION}")
            continue
        method = request.get("method")
        if method == "health":
            response(request_id, True, {"status": "ok", "protocol": PROTOCOL_VERSION, "pid": os.getpid()})
        elif method == "recommend":
            response(request_id, True, recommend(request.get("params", {})))
        elif method == "shutdown":
            response(request_id, True, {"shuttingDown": True})
            log("info", "worker_shutdown")
            break
        else:
            response(request_id, False, code="method_not_found", message=f"Unknown method: {method}")
    except Exception as error:
        log("error", "request_failed", error=str(error))
        response(request_id, False, code="invalid_request", message=str(error))
