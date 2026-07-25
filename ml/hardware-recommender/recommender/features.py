from __future__ import annotations

from dataclasses import dataclass

import numpy as np
import pandas as pd

QUANTIZATIONS: dict[str, float] = {
    "Q2_K": 2.625,
    "Q3_K_M": 3.50,
    "Q4_K_M": 4.75,
    "Q5_K_M": 5.50,
    "Q6_K": 6.56,
    "Q8_0": 8.50,
}

FEATURE_COLUMNS = [
    "model_params_b",
    "quality_score",
    "is_moe",
    "quant_bits",
    "ram_gb",
    "vram_gb",
    "cpu_cores",
    "platform",
    "gpu_backend",
]

TARGET_COLUMNS = ["fit_status", "recommended_runtime", "context_tokens", "tokens_per_second"]


@dataclass(frozen=True)
class Estimate:
    status: str
    runtime: str
    context_tokens: int
    tokens_per_second: float


def estimated_weight_gb(params_b: float, quant_bits: float) -> float:
    # Quantized weights plus tensors/runtime metadata. This deliberately errs
    # slightly high; real GGUF sizes should replace it when available.
    return params_b * quant_bits / 8.0 * 1.12 + 0.35


def label_example(row: pd.Series) -> Estimate:
    params = max(float(row["model_params_b"]), 0.1)
    ram = max(float(row["ram_gb"]), 0.0)
    vram = max(float(row["vram_gb"]), 0.0)
    cores = max(int(row["cpu_cores"]), 1)
    backend = str(row["gpu_backend"])
    platform = str(row["platform"])
    bits = float(row["quant_bits"])
    is_moe = bool(row["is_moe"])

    weight_gb = estimated_weight_gb(params, bits) * (1.08 if is_moe else 1.0)
    os_reserve = max(2.0, ram * 0.12)
    usable_ram = max(0.0, ram - os_reserve)
    usable_vram = max(0.0, vram * 0.88)
    accelerator = backend not in {"none", "cpu"} and vram >= 0.5
    total_usable = usable_ram + (0.0 if platform == "macos" and backend == "metal" else usable_vram)

    if weight_gb > total_usable * 0.94:
        status = "Insufficient memory"
    elif accelerator and weight_gb <= usable_vram * 0.90:
        status = "Runs comfortably"
    elif accelerator and weight_gb <= total_usable * 0.90:
        status = "May require partial GPU offload"
    elif weight_gb <= usable_ram * 0.88:
        status = "CPU only"
    else:
        status = "Insufficient memory"

    if platform == "macos" and backend == "metal":
        runtime = "mlx" if bits >= 4.0 else "llama.cpp-metal"
    elif backend == "rocm":
        runtime = "vllm" if bits >= 8.0 and params >= 7 else "llama.cpp-rocm"
    elif backend == "cuda":
        runtime = "vllm" if bits >= 8.0 and weight_gb <= usable_vram * 0.82 else "llama.cpp-cuda"
    elif backend in {"vulkan", "directml"}:
        runtime = "llama.cpp-vulkan"
    else:
        runtime = "llama.cpp-cpu"

    if status == "Runs comfortably":
        memory_headroom = max(0.0, usable_vram - weight_gb)
    elif status == "May require partial GPU offload":
        memory_headroom = max(0.0, total_usable - weight_gb)
    else:
        memory_headroom = max(0.0, usable_ram - weight_gb)
    # A conservative architecture-agnostic KV estimate. GQA/MQA models can use
    # less, while older full multi-head attention models can use considerably
    # more. Keep 30% of remaining memory for graph/work buffers and batching.
    kv_gb_per_1k = max(0.12, 0.17 * np.sqrt(params / 7.0))
    context = int(np.clip((memory_headroom * 0.70 / kv_gb_per_1k) * 1024, 2048, 131072))
    context = 2 ** int(np.floor(np.log2(max(context, 2048))))

    gpu_factor = {"cuda": 1.0, "metal": 0.82, "rocm": 0.85, "vulkan": 0.62, "directml": 0.42}.get(backend, 0.0)
    if status == "Insufficient memory":
        speed = 0.0
    elif status == "Runs comfortably":
        speed = (42.0 * gpu_factor * (4.75 / bits)) / np.sqrt(params / 7.0)
    elif status == "May require partial GPU offload":
        offload_ratio = min(1.0, usable_vram / max(weight_gb, 0.1))
        speed = (9.0 + 28.0 * gpu_factor * offload_ratio) / np.sqrt(params / 7.0)
    else:
        speed = (1.8 * np.sqrt(cores) * (4.75 / bits)) / np.sqrt(params / 7.0)

    return Estimate(status, runtime, context, round(float(np.clip(speed, 0.0, 250.0)), 2))


def normalize_catalog(raw: pd.DataFrame) -> pd.DataFrame:
    params = pd.to_numeric(raw.get("#Params (B)"), errors="coerce")
    score = pd.to_numeric(raw.get("Average ⬆️"), errors="coerce")
    result = pd.DataFrame(
        {
            "model_id": raw.get("fullname", raw.get("Model", "unknown")).astype(str),
            "model_params_b": params,
            "quality_score": score.fillna(score.median() if score.notna().any() else 0.0),
            "is_moe": raw.get("MoE", False).fillna(False).astype(bool),
        }
    )
    return result[(result.model_params_b > 0.05) & (result.model_params_b <= 200)].drop_duplicates("model_id")


def build_training_examples(catalog: pd.DataFrame, samples: int, seed: int = 42) -> pd.DataFrame:
    rng = np.random.default_rng(seed)
    base = catalog.iloc[rng.integers(0, len(catalog), size=samples)].reset_index(drop=True).copy()
    quant_names = np.array(list(QUANTIZATIONS))
    chosen_quants = rng.choice(quant_names, size=samples)
    base["quantization"] = chosen_quants
    base["quant_bits"] = [QUANTIZATIONS[q] for q in chosen_quants]
    base["ram_gb"] = rng.choice([4, 8, 12, 16, 24, 32, 48, 64, 96, 128], size=samples)
    base["vram_gb"] = rng.choice([0, 2, 3, 4, 6, 8, 12, 16, 20, 24, 32, 48, 80], size=samples)
    base["cpu_cores"] = rng.choice([2, 4, 6, 8, 12, 16, 24, 32], size=samples)
    base["platform"] = rng.choice(["windows", "linux", "macos"], p=[0.48, 0.36, 0.16], size=samples)
    base["gpu_backend"] = rng.choice(
        ["none", "cuda", "rocm", "metal", "vulkan", "directml"],
        p=[0.13, 0.37, 0.13, 0.12, 0.20, 0.05],
        size=samples,
    )
    base.loc[base.gpu_backend == "none", "vram_gb"] = 0
    base.loc[base.gpu_backend == "metal", "platform"] = "macos"

    estimates = [label_example(row) for _, row in base.iterrows()]
    base["fit_status"] = [x.status for x in estimates]
    base["recommended_runtime"] = [x.runtime for x in estimates]
    base["context_tokens"] = [x.context_tokens for x in estimates]
    base["tokens_per_second"] = [x.tokens_per_second for x in estimates]
    return base
