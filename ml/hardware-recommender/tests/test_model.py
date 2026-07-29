import numpy as np
import pandas as pd

from recommender.features import label_example
from recommender.model import REGRESSION_TARGETS, compute_physics_baseline, encode_targets


def row(**overrides):
    values = {
        "model_params_b": 7, "quality_score": 30, "is_moe": False, "quant_bits": 4.75,
        "ram_gb": 16, "vram_gb": 8, "gpu_count": 1, "aggregate_vram_gb": 8, "cpu_cores": 8,
        "platform": "linux", "gpu_backend": "cuda", "recommended_runtime": "llama.cpp-cuda",
        "tokens_per_second": 40.0, "prompt_tokens_per_second": 200.0, "time_to_first_token_ms": 100.0,
        "peak_ram_gb": 1.0, "peak_vram_gb": 6.0, "model_load_time_ms": 1000.0, "energy_per_token_j": 5.0,
        "prompt_tokens_per_second_known": True, "time_to_first_token_ms_known": True,
        "peak_ram_gb_known": True, "peak_vram_gb_known": True,
        "model_load_time_ms_known": False, "energy_per_token_j_known": False,
    }
    values.update(overrides)
    return values


def test_physics_baseline_matches_label_example():
    frame = pd.DataFrame([row()])
    baseline = compute_physics_baseline(frame)
    estimate = label_example(frame.iloc[0])
    expected = [estimate.peak_vram_gb, estimate.peak_ram_gb, estimate.tokens_per_second, estimate.prefill_tokens_per_second, estimate.time_to_first_token_ms, estimate.model_load_time_ms, estimate.energy_per_token_j]
    assert np.allclose(baseline[0], expected)


def test_encode_targets_masks_unknown_regression_columns():
    frame = pd.DataFrame([row()])
    targets = encode_targets(frame)
    mask = targets["regression_mask"][0].numpy()
    known_columns = {"tokens_per_second", "prompt_tokens_per_second", "time_to_first_token_ms", "peak_ram_gb", "peak_vram_gb"}
    for index, name in enumerate(REGRESSION_TARGETS):
        expected = 1.0 if name in known_columns else 0.0
        assert mask[index] == expected, f"{name} mask should be {expected}"
