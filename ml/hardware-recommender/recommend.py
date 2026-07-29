from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path

import numpy as np
import pandas as pd
import torch

from recommender import physics
from recommender.features import QUANTIZATIONS
from recommender.model import REGRESSION_TARGETS, RUNTIME_CLASSES, HardwareRecommender, Normalizer, compute_physics_baseline, decode_predictions, encode_features

STATUS_ORDER = {"Runs comfortably": 3, "May require partial GPU offload": 2, "CPU only": 1, "Insufficient memory": 0}
MIN_SUPPORT_FOR_CONFIDENCE = 25
DISTANCE_BUFFER = 1.3


def verify_checksum(path: Path) -> None:
    sidecar = path.with_suffix(path.suffix + ".sha256")
    if not sidecar.exists():
        print(f"Warning: no checksum sidecar at {sidecar}; skipping integrity check.")
        return
    expected = sidecar.read_text(encoding="utf-8").strip()
    actual = hashlib.sha256(path.read_bytes()).hexdigest()
    if actual != expected:
        raise SystemExit(f"Checksum mismatch for {path}: expected {expected}, got {actual}. Refusing to load a possibly corrupted/tampered checkpoint.")


def load_model(path: Path) -> tuple[HardwareRecommender, Normalizer, dict[str, int], dict]:
    verify_checksum(path)
    # weights_only=True is safe here: the checkpoint only ever contains
    # tensors plus plain dict/list/str/float/int (see the `checkpoint = {...}`
    # literal in train.py) — no custom classes need allowlisting.
    checkpoint = torch.load(path, map_location="cpu", weights_only=True)
    model = HardwareRecommender(hidden_size=int(checkpoint["hidden_size"]))
    model.load_state_dict(checkpoint["state_dict"])
    model.eval()
    return model, Normalizer.from_dict(checkpoint["normalizer"]), checkpoint.get("support_counts", {}), checkpoint.get("ood_stats", {})


def predict(model: HardwareRecommender, normalizer: Normalizer, support_counts: dict[str, int], ood_stats: dict, hardware: dict) -> dict:
    rows = [{**hardware, "quant_bits": bits} for bits in QUANTIZATIONS.values()]
    frame = pd.DataFrame(rows)
    encoded = encode_features(frame, normalizer)
    with torch.inference_mode():
        output = model(encoded)
    baseline_log = torch.log1p(torch.from_numpy(compute_physics_baseline(frame)).clamp_min(0))
    predicted = decode_predictions(baseline_log, output["residual_mean"]).numpy()
    runtime_indices = output["runtime"].argmax(1).tolist()
    mean_log_var = output["residual_log_var"].mean(dim=1).tolist()
    support = support_counts.get(f"{hardware['platform']}|{hardware['gpu_backend']}|{physics.param_bucket(float(hardware['model_params_b']))}", 0)

    distance = float("inf")
    if ood_stats:
        ood_mean = np.asarray(ood_stats["mean"], dtype=np.float64)
        ood_cov_inv = np.asarray(ood_stats["cov_inv"], dtype=np.float64)
        # Same request hardware for every quantization row (only quant_bits
        # varies), so one distance covers all candidates.
        distance = physics.mahalanobis_distance(encoded[0].numpy().astype(np.float64), ood_mean, ood_cov_inv)
    is_ood = physics.is_out_of_distribution(support, MIN_SUPPORT_FOR_CONFIDENCE, distance, ood_stats.get("distance_p99", float("inf")), DISTANCE_BUFFER)

    per_device_vram_gb = hardware.get("per_device_vram_gb")
    per_device_usable_vram_gb = [max(0.0, float(v) * 0.88) for v in per_device_vram_gb] if per_device_vram_gb else None
    usable_ram_gb = max(float(hardware["ram_gb"]) - max(2.0, float(hardware["ram_gb"]) * 0.12), 0.0)

    candidates = []
    for index, quantization in enumerate(QUANTIZATIONS):
        vram = float(predicted[index, REGRESSION_TARGETS.index("peak_vram_gb")])
        ram = float(predicted[index, REGRESSION_TARGETS.index("peak_ram_gb")])
        speed = float(predicted[index, REGRESSION_TARGETS.index("tokens_per_second")])
        status, context = physics.derive_fit_and_context(
            vram, ram, float(hardware["ram_gb"]), float(frame["aggregate_vram_gb"].iloc[index]),
            str(hardware["gpu_backend"]), str(hardware["platform"]), float(hardware["model_params_b"]),
        )
        confidence = physics.prediction_confidence(mean_log_var[index], is_ood)
        weight_gb = physics.estimated_weight_gb(float(hardware["model_params_b"]), QUANTIZATIONS[quantization], bool(hardware.get("is_moe")))
        gpu_strategy = physics.classify_gpu_strategy(weight_gb, per_device_usable_vram_gb, usable_ram_gb) if per_device_usable_vram_gb is not None else None
        candidates.append({
            "quantization": quantization,
            "fit": status,
            "runtime": RUNTIME_CLASSES[runtime_indices[index]],
            "estimated_context_tokens": context,
            "estimated_tokens_per_second": round(speed, 1),
            "estimated_peak_vram_gb": round(vram, 2),
            "estimated_peak_ram_gb": round(ram, 2),
            "confidence": round(confidence, 2),
            "low_confidence_reason": ("Low confidence — this hardware/model combination is unlike anything the training data covered." if is_ood else None),
            "gpu_strategy": gpu_strategy,
        })

    comfortable = [item for item in candidates if item["fit"] == "Runs comfortably"]
    viable = [item for item in candidates if STATUS_ORDER[item["fit"]] > 0]
    if comfortable:
        choice = comfortable[-1]
    elif viable:
        choice = next((item for item in viable if item["quantization"] == "Q4_K_M"), viable[0])
    else:
        choice = candidates[0]
    selected = dict(choice)
    selected["all_quantizations"] = candidates
    selected["warning"] = "Speed and context are learned estimates on top of a deterministic physics baseline; benchmark the actual runtime for calibration."
    return selected


def main() -> None:
    parser = argparse.ArgumentParser(description="Run the PyTorch hardware recommender.")
    parser.add_argument("--model", type=Path, default=Path("artifacts/hardware_recommender.pt"))
    parser.add_argument("--model-params-b", type=float, required=True)
    parser.add_argument("--quality-score", type=float, default=30.0)
    parser.add_argument("--moe", action="store_true")
    parser.add_argument("--ram-gb", type=float, required=True)
    parser.add_argument("--vram-gb", type=float, required=True)
    parser.add_argument("--gpu-count", type=int, default=1)
    parser.add_argument("--per-device-vram-gb", type=float, nargs="*", default=None, help="Individual VRAM per GPU (GB) — enables gpu_strategy classification instead of --vram-gb's flat aggregate assumption.")
    parser.add_argument("--cpu-cores", type=int, required=True)
    parser.add_argument("--platform", choices=["windows", "linux", "macos"], required=True)
    parser.add_argument("--gpu-backend", choices=["none", "cuda", "rocm", "metal", "vulkan", "directml"], required=True)
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()
    model, normalizer, support_counts, ood_stats = load_model(args.model)
    gpu_count = args.gpu_count if args.gpu_backend != "none" else 0
    result = predict(
        model,
        normalizer,
        support_counts,
        ood_stats,
        {
            "model_params_b": args.model_params_b,
            "quality_score": args.quality_score,
            "is_moe": args.moe,
            "ram_gb": args.ram_gb,
            "vram_gb": args.vram_gb,
            "gpu_count": gpu_count,
            "aggregate_vram_gb": args.vram_gb * max(gpu_count, 1),
            "per_device_vram_gb": args.per_device_vram_gb,
            "cpu_cores": args.cpu_cores,
            "platform": args.platform,
            "gpu_backend": args.gpu_backend,
        },
    )
    print(json.dumps(result) if args.json else json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
