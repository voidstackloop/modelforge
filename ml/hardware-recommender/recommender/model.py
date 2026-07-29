from __future__ import annotations

from dataclasses import dataclass

import numpy as np
import pandas as pd
import torch
from torch import nn

from . import physics
from .features import FEATURE_COLUMNS, label_example

PLATFORMS = ["windows", "linux", "macos"]
GPU_BACKENDS = ["none", "cuda", "rocm", "metal", "vulkan", "directml"]
RUNTIME_CLASSES = ["llama.cpp-cpu", "llama.cpp-cuda", "llama.cpp-rocm", "llama.cpp-metal", "llama.cpp-vulkan", "mlx", "vllm"]
NUMERIC_FEATURES = ["model_params_b", "quality_score", "is_moe", "quant_bits", "ram_gb", "vram_gb", "cpu_cores", "gpu_count", "aggregate_vram_gb"]
INPUT_SIZE = len(NUMERIC_FEATURES) + len(PLATFORMS) + len(GPU_BACKENDS)

# Order matters: this is the axis order of every (batch, N) regression tensor
# in this module (physics baseline, actual targets, mask, predicted residual).
# Each is predicted as a residual (in log1p-space) on top of the deterministic
# physics.py baseline, rather than as a raw value — see module docstring in
# physics.py for the rationale.
REGRESSION_TARGETS = [
    "peak_vram_gb", "peak_ram_gb", "tokens_per_second", "prompt_tokens_per_second",
    "time_to_first_token_ms", "model_load_time_ms", "energy_per_token_j",
]
# log_variance is clamped to keep exp() numerically stable and to stop the
# model from claiming implausibly tight (var->0) or wide (var->inf) confidence.
LOG_VAR_MIN, LOG_VAR_MAX = -6.0, 6.0


@dataclass
class Normalizer:
    mean: list[float]
    std: list[float]

    def as_dict(self) -> dict[str, list[float]]:
        return {"mean": self.mean, "std": self.std}

    @classmethod
    def from_dict(cls, value: dict) -> "Normalizer":
        return cls(mean=list(value["mean"]), std=list(value["std"]))


class HardwareRecommender(nn.Module):
    def __init__(self, hidden_size: int = 64, dropout: float = 0.10):
        super().__init__()
        self.backbone = nn.Sequential(
            nn.Linear(INPUT_SIZE, hidden_size),
            nn.LayerNorm(hidden_size),
            nn.SiLU(),
            nn.Dropout(dropout),
            nn.Linear(hidden_size, hidden_size),
            nn.SiLU(),
            nn.Dropout(dropout),
            nn.Linear(hidden_size, hidden_size // 2),
            nn.SiLU(),
        )
        shared = hidden_size // 2
        self.runtime_head = nn.Linear(shared, len(RUNTIME_CLASSES))
        # Two outputs per regression target: a residual mean (log1p-space, on
        # top of the physics baseline) and a log-variance (heteroscedastic
        # uncertainty, trained with a Gaussian NLL loss — see train.py).
        self.regression_head = nn.Linear(shared, len(REGRESSION_TARGETS) * 2)

    def forward(self, features: torch.Tensor) -> dict[str, torch.Tensor]:
        hidden = self.backbone(features)
        regression = self.regression_head(hidden).view(-1, len(REGRESSION_TARGETS), 2)
        return {
            "runtime": self.runtime_head(hidden),
            "residual_mean": regression[..., 0],
            "residual_log_var": regression[..., 1].clamp(LOG_VAR_MIN, LOG_VAR_MAX),
        }


def fit_normalizer(frame: pd.DataFrame) -> Normalizer:
    values = frame[NUMERIC_FEATURES].astype(np.float32).to_numpy()
    mean = values.mean(axis=0)
    std = values.std(axis=0)
    std[std < 1e-6] = 1.0
    return Normalizer(mean.tolist(), std.tolist())


def encode_features(frame: pd.DataFrame, normalizer: Normalizer) -> torch.Tensor:
    missing = [column for column in FEATURE_COLUMNS if column not in frame]
    if missing:
        raise ValueError(f"Missing feature columns: {', '.join(missing)}")
    numeric = frame[NUMERIC_FEATURES].astype(np.float32).to_numpy()
    numeric = (numeric - np.asarray(normalizer.mean, dtype=np.float32)) / np.asarray(normalizer.std, dtype=np.float32)
    platform = np.stack([(frame["platform"].astype(str).to_numpy() == value) for value in PLATFORMS], axis=1)
    backend = np.stack([(frame["gpu_backend"].astype(str).to_numpy() == value) for value in GPU_BACKENDS], axis=1)
    encoded = np.concatenate([numeric, platform.astype(np.float32), backend.astype(np.float32)], axis=1)
    return torch.from_numpy(encoded)


def compute_physics_baseline(frame: pd.DataFrame) -> np.ndarray:
    """The deterministic estimate for every REGRESSION_TARGETS column, reusing
    the exact same formulas (physics.py, via features.label_example) that
    generate synthetic labels — so "residual" always means "what real/measured
    data says on top of the same baseline the synthetic rows were built from".
    """
    estimates = [label_example(row) for _, row in frame.iterrows()]
    return np.array(
        [
            [e.peak_vram_gb, e.peak_ram_gb, e.tokens_per_second, e.prefill_tokens_per_second, e.time_to_first_token_ms, e.model_load_time_ms, e.energy_per_token_j]
            for e in estimates
        ],
        dtype=np.float32,
    )


def encode_targets(frame: pd.DataFrame) -> dict[str, torch.Tensor]:
    runtime_map = {value: index for index, value in enumerate(RUNTIME_CLASSES)}
    baseline = compute_physics_baseline(frame)
    actual = frame[REGRESSION_TARGETS].astype(np.float32).to_numpy()
    mask = np.ones_like(actual)
    for index, column in enumerate(REGRESSION_TARGETS):
        known_column = f"{column}_known"
        if known_column in frame:
            mask[:, index] = frame[known_column].astype(bool).to_numpy()
    return {
        "runtime": torch.tensor([runtime_map[value] for value in frame["recommended_runtime"]], dtype=torch.long),
        "baseline_log": torch.from_numpy(np.log1p(np.clip(baseline, 0, None))),
        "actual_log": torch.from_numpy(np.log1p(np.clip(actual, 0, None))),
        "regression_mask": torch.from_numpy(mask),
    }


def decode_predictions(baseline_log: torch.Tensor, residual_mean: torch.Tensor) -> torch.Tensor:
    """Reconstruct raw-scale predictions from a physics baseline + learned residual."""
    return torch.expm1(baseline_log + residual_mean).clamp_min(0)
