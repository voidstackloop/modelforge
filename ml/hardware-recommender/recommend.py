from __future__ import annotations

import argparse
import json
from pathlib import Path

import pandas as pd
import torch

from recommender.features import QUANTIZATIONS
from recommender.model import CONTEXT_CLASSES, FIT_CLASSES, RUNTIME_CLASSES, HardwareRecommender, Normalizer, encode_features

STATUS_ORDER = {"Runs comfortably": 3, "May require partial GPU offload": 2, "CPU only": 1, "Insufficient memory": 0}


def load_model(path: Path) -> tuple[HardwareRecommender, Normalizer]:
    checkpoint = torch.load(path, map_location="cpu", weights_only=False)
    model = HardwareRecommender(hidden_size=int(checkpoint["hidden_size"]))
    model.load_state_dict(checkpoint["state_dict"])
    model.eval()
    return model, Normalizer.from_dict(checkpoint["normalizer"])


def predict(model: HardwareRecommender, normalizer: Normalizer, hardware: dict) -> dict:
    rows = [{**hardware, "quant_bits": bits} for bits in QUANTIZATIONS.values()]
    with torch.inference_mode():
        output = model(encode_features(pd.DataFrame(rows), normalizer))
    fit_indices = output["fit"].argmax(1).tolist()
    runtime_indices = output["runtime"].argmax(1).tolist()
    context_indices = output["context"].argmax(1).tolist()
    speeds = torch.expm1(output["log_speed"]).clamp_min(0).tolist()
    candidates = []
    for index, quantization in enumerate(QUANTIZATIONS):
        candidates.append(
            {
                "quantization": quantization,
                "fit": FIT_CLASSES[fit_indices[index]],
                "runtime": RUNTIME_CLASSES[runtime_indices[index]],
                "estimated_context_tokens": CONTEXT_CLASSES[context_indices[index]],
                "estimated_tokens_per_second": round(float(speeds[index]), 1),
            }
        )

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
    selected["warning"] = "Speed and context are learned estimates; benchmark the actual runtime for calibration."
    return selected


def main() -> None:
    parser = argparse.ArgumentParser(description="Run the PyTorch hardware recommender.")
    parser.add_argument("--model", type=Path, default=Path("artifacts/hardware_recommender.pt"))
    parser.add_argument("--model-params-b", type=float, required=True)
    parser.add_argument("--quality-score", type=float, default=30.0)
    parser.add_argument("--moe", action="store_true")
    parser.add_argument("--ram-gb", type=float, required=True)
    parser.add_argument("--vram-gb", type=float, required=True)
    parser.add_argument("--cpu-cores", type=int, required=True)
    parser.add_argument("--platform", choices=["windows", "linux", "macos"], required=True)
    parser.add_argument("--gpu-backend", choices=["none", "cuda", "rocm", "metal", "vulkan", "directml"], required=True)
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()
    model, normalizer = load_model(args.model)
    result = predict(
        model,
        normalizer,
        {
            "model_params_b": args.model_params_b,
            "quality_score": args.quality_score,
            "is_moe": args.moe,
            "ram_gb": args.ram_gb,
            "vram_gb": args.vram_gb,
            "cpu_cores": args.cpu_cores,
            "platform": args.platform,
            "gpu_backend": args.gpu_backend,
        },
    )
    print(json.dumps(result) if args.json else json.dumps(result, indent=2))


if __name__ == "__main__":
    main()

