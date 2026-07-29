from __future__ import annotations

from dataclasses import dataclass

import numpy as np
import pandas as pd

from . import physics

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
    "gpu_count",
    "aggregate_vram_gb",
    "platform",
    "gpu_backend",
]

TARGET_COLUMNS = [
    "fit_status", "recommended_runtime", "context_tokens", "tokens_per_second",
    "prompt_tokens_per_second", "time_to_first_token_ms", "model_load_time_ms",
    "energy_per_token_j", "peak_ram_gb", "peak_vram_gb",
]


@dataclass(frozen=True)
class Estimate:
    status: str
    runtime: str
    context_tokens: int
    tokens_per_second: float
    prefill_tokens_per_second: float
    time_to_first_token_ms: float
    model_load_time_ms: float
    energy_per_token_j: float
    peak_vram_gb: float
    peak_ram_gb: float


def estimated_weight_gb(params_b: float, quant_bits: float) -> float:
    return physics.estimated_weight_gb(params_b, quant_bits)


def label_example(row: pd.Series) -> Estimate:
    params = max(float(row["model_params_b"]), 0.1)
    ram = max(float(row["ram_gb"]), 0.0)
    aggregate_vram = max(float(row.get("aggregate_vram_gb", row["vram_gb"])), 0.0)
    vram = max(float(row["vram_gb"]), 0.0)
    cores = max(int(row["cpu_cores"]), 1)
    backend = str(row["gpu_backend"])
    platform = str(row["platform"])
    bits = float(row["quant_bits"])
    is_moe = bool(row["is_moe"])

    memory = physics.estimate_memory(params, bits, is_moe, ram, aggregate_vram, backend, platform)
    context = physics.context_tokens_estimate(memory.headroom_gb, params)
    speed = physics.decode_tokens_per_second(params, bits, memory.status, backend, memory.usable_vram_gb, memory.weight_gb, cores)
    prefill = physics.prefill_tokens_per_second(speed, memory.accelerator)
    ttft = physics.time_to_first_token_ms(prefill)
    load_ms = physics.model_load_time_ms(memory.weight_gb, backend)
    energy = physics.energy_per_token_j(speed, backend)

    if platform == "macos" and backend == "metal":
        runtime = "mlx" if bits >= 4.0 else "llama.cpp-metal"
    elif backend == "rocm":
        runtime = "vllm" if bits >= 8.0 and params >= 7 else "llama.cpp-rocm"
    elif backend == "cuda":
        runtime = "vllm" if bits >= 8.0 and memory.weight_gb <= memory.usable_vram_gb * 0.82 else "llama.cpp-cuda"
    elif backend in {"vulkan", "directml"}:
        runtime = "llama.cpp-vulkan"
    else:
        runtime = "llama.cpp-cpu"

    return Estimate(
        memory.status, runtime, context, round(speed, 2), round(prefill, 2),
        round(ttft, 1), round(load_ms, 1), round(energy, 4),
        round(memory.peak_vram_gb, 2), round(memory.peak_ram_gb, 2),
    )


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

    # Multi-GPU rigs: vram_gb is the primary/largest GPU's usable VRAM;
    # gpu_count/aggregate_vram_gb model pooling extra cards add. Apple's
    # unified-memory "GPU" and single-card machines both stay at count 1.
    base["gpu_count"] = 1
    multi_gpu_eligible = base.gpu_backend.isin(["cuda", "rocm"]) & (base.vram_gb > 0)
    extra_gpu_counts = rng.choice([1, 2, 2, 3, 4], size=samples)
    base.loc[multi_gpu_eligible, "gpu_count"] = extra_gpu_counts[multi_gpu_eligible]
    base.loc[base.gpu_backend == "none", "gpu_count"] = 0
    base["aggregate_vram_gb"] = base.vram_gb * base.gpu_count.clip(lower=1)
    base.loc[base.gpu_backend == "none", "aggregate_vram_gb"] = 0.0

    estimates = [label_example(row) for _, row in base.iterrows()]
    base["fit_status"] = [x.status for x in estimates]
    base["fit_status_known"] = True
    base["recommended_runtime"] = [x.runtime for x in estimates]
    base["context_tokens"] = [x.context_tokens for x in estimates]
    base["context_tokens_known"] = True
    base["tokens_per_second"] = [x.tokens_per_second for x in estimates]
    base["prompt_tokens_per_second"] = [x.prefill_tokens_per_second for x in estimates]
    base["time_to_first_token_ms"] = [x.time_to_first_token_ms for x in estimates]
    base["model_load_time_ms"] = [x.model_load_time_ms for x in estimates]
    base["energy_per_token_j"] = [x.energy_per_token_j for x in estimates]
    base["peak_vram_gb"] = [x.peak_vram_gb for x in estimates]
    base["peak_ram_gb"] = [x.peak_ram_gb for x in estimates]
    for column in ("prompt_tokens_per_second", "time_to_first_token_ms", "model_load_time_ms", "energy_per_token_j", "peak_vram_gb", "peak_ram_gb"):
        base[f"{column}_known"] = True
    return base
