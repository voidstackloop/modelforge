import pandas as pd
import torch

from recommender.features import estimated_weight_gb, label_example
from recommender.model import INPUT_SIZE, REGRESSION_TARGETS, RUNTIME_CLASSES, HardwareRecommender


def row(**overrides):
    values = {
        "model_params_b": 7,
        "quality_score": 30,
        "is_moe": False,
        "quant_bits": 4.75,
        "ram_gb": 16,
        "vram_gb": 8,
        "cpu_cores": 8,
        "platform": "linux",
        "gpu_backend": "cuda",
    }
    values.update(overrides)
    return pd.Series(values)


def test_small_quantized_model_fits_gpu():
    assert label_example(row()).status == "Runs comfortably"


def test_large_model_is_rejected_on_small_pc():
    assert label_example(row(model_params_b=70, ram_gb=8, vram_gb=3)).status == "Insufficient memory"


def test_weight_estimate_increases_with_precision():
    assert estimated_weight_gb(7, 8.5) > estimated_weight_gb(7, 4.75)


def test_multitask_model_output_shapes():
    output = HardwareRecommender()(torch.zeros(2, INPUT_SIZE))
    assert output["runtime"].shape == (2, len(RUNTIME_CLASSES))
    assert output["residual_mean"].shape == (2, len(REGRESSION_TARGETS))
    assert output["residual_log_var"].shape == (2, len(REGRESSION_TARGETS))
