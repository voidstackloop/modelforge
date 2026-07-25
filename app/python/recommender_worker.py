#!/usr/bin/env python3
# Long-lived JSON-line worker (same protocol as runtime_worker.py) serving
# predictions from the trained hardware-recommender model
# (ml/hardware-recommender/, shipped as artifacts/hardware_recommender.pt
# alongside this script). Model/feature-encoding logic here is a trimmed,
# inference-only copy of ml/hardware-recommender/recommender/model.py — kept
# separate (rather than imported) so the packaged app/python/ directory
# stays self-contained and doesn't need the training project's pandas/pyarrow
# dependencies just to run inference.
import json
import os
import sys
import time
from pathlib import Path

import torch
from torch import nn

PROTOCOL_VERSION = 1
STARTED = time.monotonic()

PLATFORMS = ["windows", "linux", "macos"]
GPU_BACKENDS = ["none", "cuda", "rocm", "metal", "vulkan", "directml"]
FIT_CLASSES = ["Runs comfortably", "May require partial GPU offload", "CPU only", "Insufficient memory"]
RUNTIME_CLASSES = ["llama.cpp-cpu", "llama.cpp-cuda", "llama.cpp-rocm", "llama.cpp-metal", "llama.cpp-vulkan", "mlx", "vllm"]
CONTEXT_CLASSES = [2048, 4096, 8192, 16384, 32768, 65536, 131072]
NUMERIC_FEATURES = ["model_params_b", "quality_score", "is_moe", "quant_bits", "ram_gb", "vram_gb", "cpu_cores"]
QUANTIZATIONS = {"Q2_K": 2.625, "Q3_K_M": 3.50, "Q4_K_M": 4.75, "Q5_K_M": 5.50, "Q6_K": 6.56, "Q8_0": 8.50}
STATUS_ORDER = {"Runs comfortably": 3, "May require partial GPU offload": 2, "CPU only": 1, "Insufficient memory": 0}


class HardwareRecommender(nn.Module):
    def __init__(self, hidden_size=64):
        super().__init__()
        input_size = len(NUMERIC_FEATURES) + len(PLATFORMS) + len(GPU_BACKENDS)
        # Dropout layers are no-ops in eval() but their presence still shifts
        # nn.Sequential's positional indices — they have to stay in these
        # exact slots to match the trained checkpoint's state_dict keys
        # (see ml/hardware-recommender/recommender/model.py, the source of
        # truth this architecture is copied from).
        self.backbone = nn.Sequential(
            nn.Linear(input_size, hidden_size),
            nn.LayerNorm(hidden_size),
            nn.SiLU(),
            nn.Dropout(0.10),
            nn.Linear(hidden_size, hidden_size),
            nn.SiLU(),
            nn.Dropout(0.10),
            nn.Linear(hidden_size, hidden_size // 2),
            nn.SiLU(),
        )
        shared = hidden_size // 2
        self.fit_head = nn.Linear(shared, len(FIT_CLASSES))
        self.runtime_head = nn.Linear(shared, len(RUNTIME_CLASSES))
        self.context_head = nn.Linear(shared, len(CONTEXT_CLASSES))
        self.speed_head = nn.Sequential(nn.Linear(shared, 1), nn.Softplus())

    def forward(self, features):
        hidden = self.backbone(features)
        return {
            "fit": self.fit_head(hidden),
            "runtime": self.runtime_head(hidden),
            "context": self.context_head(hidden),
            "log_speed": self.speed_head(hidden).squeeze(-1),
        }


def log(level, event, **fields):
    print(json.dumps({"timestamp": time.time(), "level": level, "event": event, **fields}), file=sys.stderr, flush=True)


def response(request_id, ok, result=None, code=None, message=None):
    payload = {"protocol": PROTOCOL_VERSION, "id": request_id, "ok": ok}
    if ok:
        payload["result"] = result
    else:
        payload["error"] = {"code": code, "message": message}
    print(json.dumps(payload), flush=True)


_model = None
_normalizer_mean = None
_normalizer_std = None


def load():
    global _model, _normalizer_mean, _normalizer_std
    if _model is not None:
        return
    checkpoint_path = Path(__file__).parent / "artifacts" / "hardware_recommender.pt"
    checkpoint = torch.load(checkpoint_path, map_location="cpu", weights_only=False)
    model = HardwareRecommender(hidden_size=int(checkpoint["hidden_size"]))
    model.load_state_dict(checkpoint["state_dict"])
    model.eval()
    _model = model
    _normalizer_mean = checkpoint["normalizer"]["mean"]
    _normalizer_std = checkpoint["normalizer"]["std"]


def encode_row(hardware, quant_bits):
    numeric = [
        float(hardware["model_params_b"]),
        float(hardware.get("quality_score", 30.0)),
        1.0 if hardware.get("is_moe") else 0.0,
        float(quant_bits),
        float(hardware["ram_gb"]),
        float(hardware["vram_gb"]),
        float(hardware["cpu_cores"]),
    ]
    numeric = [(value - mean) / std for value, mean, std in zip(numeric, _normalizer_mean, _normalizer_std)]
    platform_onehot = [1.0 if hardware["platform"] == name else 0.0 for name in PLATFORMS]
    backend_onehot = [1.0 if hardware["gpu_backend"] == name else 0.0 for name in GPU_BACKENDS]
    return numeric + platform_onehot + backend_onehot


def recommend(hardware):
    load()
    rows = [encode_row(hardware, bits) for bits in QUANTIZATIONS.values()]
    features = torch.tensor(rows, dtype=torch.float32)
    with torch.inference_mode():
        output = _model(features)
    fit_indices = output["fit"].argmax(1).tolist()
    runtime_indices = output["runtime"].argmax(1).tolist()
    context_indices = output["context"].argmax(1).tolist()
    speeds = torch.expm1(output["log_speed"]).clamp_min(0).tolist()

    candidates = []
    for index, quantization in enumerate(QUANTIZATIONS):
        candidates.append({
            "quantization": quantization,
            "fit": FIT_CLASSES[fit_indices[index]],
            "runtime": RUNTIME_CLASSES[runtime_indices[index]],
            "estimatedContextTokens": CONTEXT_CLASSES[context_indices[index]],
            "estimatedTokensPerSecond": round(float(speeds[index]), 1),
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
