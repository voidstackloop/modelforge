from __future__ import annotations

from dataclasses import dataclass

import numpy as np
import pandas as pd
import torch
from torch import nn

from .features import FEATURE_COLUMNS

PLATFORMS = ["windows", "linux", "macos"]
GPU_BACKENDS = ["none", "cuda", "rocm", "metal", "vulkan", "directml"]
FIT_CLASSES = ["Runs comfortably", "May require partial GPU offload", "CPU only", "Insufficient memory"]
RUNTIME_CLASSES = ["llama.cpp-cpu", "llama.cpp-cuda", "llama.cpp-rocm", "llama.cpp-metal", "llama.cpp-vulkan", "mlx", "vllm"]
CONTEXT_CLASSES = [2048, 4096, 8192, 16384, 32768, 65536, 131072]
NUMERIC_FEATURES = ["model_params_b", "quality_score", "is_moe", "quant_bits", "ram_gb", "vram_gb", "cpu_cores"]
INPUT_SIZE = len(NUMERIC_FEATURES) + len(PLATFORMS) + len(GPU_BACKENDS)


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
        self.fit_head = nn.Linear(shared, len(FIT_CLASSES))
        self.runtime_head = nn.Linear(shared, len(RUNTIME_CLASSES))
        self.context_head = nn.Linear(shared, len(CONTEXT_CLASSES))
        self.speed_head = nn.Sequential(nn.Linear(shared, 1), nn.Softplus())

    def forward(self, features: torch.Tensor) -> dict[str, torch.Tensor]:
        hidden = self.backbone(features)
        return {
            "fit": self.fit_head(hidden),
            "runtime": self.runtime_head(hidden),
            "context": self.context_head(hidden),
            "log_speed": self.speed_head(hidden).squeeze(-1),
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


def encode_targets(frame: pd.DataFrame) -> dict[str, torch.Tensor]:
    fit_map = {value: index for index, value in enumerate(FIT_CLASSES)}
    runtime_map = {value: index for index, value in enumerate(RUNTIME_CLASSES)}
    context_map = {value: index for index, value in enumerate(CONTEXT_CLASSES)}
    return {
        "fit": torch.tensor([fit_map[value] for value in frame["fit_status"]], dtype=torch.long),
        "runtime": torch.tensor([runtime_map[value] for value in frame["recommended_runtime"]], dtype=torch.long),
        "context": torch.tensor([context_map[int(value)] for value in frame["context_tokens"]], dtype=torch.long),
        "log_speed": torch.log1p(torch.tensor(frame["tokens_per_second"].to_numpy(), dtype=torch.float32)),
    }

