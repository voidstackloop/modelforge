from __future__ import annotations

import json
import re
from pathlib import Path

import numpy as np
import pandas as pd

from .features import QUANTIZATIONS, label_example

# Regression targets that aren't always available in imported data (a
# published leaderboard row rarely reports peak memory or energy draw). Each
# gets a companion "<name>_known" boolean so encode_targets can mask its loss
# contribution rather than train against a fabricated value.
OPTIONAL_REGRESSION_TARGETS = [
    "prompt_tokens_per_second", "time_to_first_token_ms", "peak_ram_gb",
    "peak_vram_gb", "model_load_time_ms", "energy_per_token_j",
]

CANONICAL_COLUMNS = [
    "model_id", "model_params_b", "quality_score", "is_moe", "quantization", "quant_bits",
    "ram_gb", "vram_gb", "gpu_count", "aggregate_vram_gb", "cpu_cores", "platform", "gpu_backend",
    "fit_status", "fit_status_known", "recommended_runtime", "context_tokens", "context_tokens_known",
    "tokens_per_second",
    *OPTIONAL_REGRESSION_TARGETS, *[f"{name}_known" for name in OPTIONAL_REGRESSION_TARGETS],
    "source", "provenance", "sample_weight",
]

RUNTIME_MAP = {
    "llama.cpp": "llama.cpp-cpu", "llamacpp": "llama.cpp-cpu", "ollama": "llama.cpp-cpu",
    "mlx": "mlx", "vllm": "vllm",
}


def read_table(path: Path) -> pd.DataFrame:
    suffix = path.suffix.lower()
    if suffix == ".parquet":
        return pd.read_parquet(path)
    if suffix == ".csv":
        return pd.read_csv(path)
    if suffix in {".jsonl", ".ndjson"}:
        return pd.read_json(path, lines=True)
    if suffix == ".json":
        value = json.loads(path.read_text(encoding="utf-8"))
        return pd.json_normalize(value if isinstance(value, list) else value.get("records", [value]))
    raise ValueError(f"Unsupported dataset format: {path}")


def quant_bits(value: object) -> float:
    text = str(value or "").upper().replace("-", "_")
    for name, bits in QUANTIZATIONS.items():
        if name in text:
            return bits
    if "FP32" in text:
        return 32.0
    if "FP16" in text or "BF16" in text:
        return 16.0
    if "INT8" in text:
        return 8.0
    if "INT4" in text or "AWQ" in text or "GPTQ" in text:
        return 4.0
    return 4.75


def parameter_count(value: object) -> float:
    match = re.search(r"(?:^|[-_ ])(\d+(?:\.\d+)?)\s*[Bb](?:$|[-_ ])", str(value or ""))
    return float(match.group(1)) if match else np.nan


def parse_hardware_summary(value: object) -> tuple[float, float, float, str]:
    text = str(value or "")
    gb_values = [float(value) for value in re.findall(r"(?:\(|\+\s*)(\d+(?:\.\d+)?)\s*GB", text, re.IGNORECASE)]
    vram = gb_values[0] if gb_values else np.nan
    ram = gb_values[-1] if len(gb_values) >= 2 else np.nan
    logical = re.search(r"\((\d+)c\)", text, re.IGNORECASE)
    physical = re.search(r"(\d+)[-_ ]Core", text, re.IGNORECASE)
    cores = float(logical.group(1) if logical else physical.group(1)) if logical or physical else np.nan
    platform = "macos" if re.search(r"Apple|M[1-9](?:\s|$)", text, re.IGNORECASE) else "linux"
    if platform == "macos" and np.isnan(ram) and not np.isnan(vram):
        ram = vram
    return ram, vram, cores, platform


def normalize_runtime(value: object, backend: str) -> str:
    runtime = str(value or "").lower().strip()
    base = next((mapped for key, mapped in RUNTIME_MAP.items() if key in runtime), "llama.cpp-cpu")
    if base == "llama.cpp-cpu" and backend in {"cuda", "rocm", "metal", "vulkan"}:
        return f"llama.cpp-{backend}"
    return base


def _series(frame: pd.DataFrame, *names: str, default: object = np.nan) -> pd.Series:
    for name in names:
        if name in frame:
            return frame[name]
    return pd.Series([default] * len(frame), index=frame.index)


def normalize_published(frame: pd.DataFrame, source: str, sample_weight: float = 0.75) -> pd.DataFrame:
    model = _series(frame, "top_model_name", "Model", "model", "Model_Name").astype(str)
    accelerator = _series(frame, "accelerator_summary", "GPU_Type", "gpu", default="").astype(str)
    accelerator_device = accelerator.str.split("+").str[0]
    runtime_raw = _series(frame, "top_backend", "Serving_Engine", "Library", "runtime", default="llama.cpp")
    quant = _series(frame, "Quantization", "quantization", "precision", "Precision", default="Q4_K_M").astype(str)
    backend = np.select(
        [accelerator_device.str.contains("apple|m[1-9]", case=False), accelerator_device.str.contains("amd|radeon", case=False), accelerator_device.str.contains("nvidia|rtx|gtx|a100|h100|l4", case=False)],
        ["metal", "rocm", "cuda"], default="none",
    )
    parsed_hardware = accelerator.map(parse_hardware_summary)
    out = pd.DataFrame(index=frame.index)
    out["model_id"] = model
    out["model_params_b"] = _series(frame, "model_params_b", "Size").map(parameter_count).fillna(model.map(parameter_count))
    out["quality_score"] = 0.0
    out["is_moe"] = model.str.contains("mixtral|moe", case=False)
    out["quantization"] = quant
    out["quant_bits"] = quant.map(quant_bits)
    out["ram_gb"] = pd.to_numeric(_series(frame, "ram_gb", "system_ram_gb", default=np.nan), errors="coerce").fillna(parsed_hardware.map(lambda item: item[0]))
    out["vram_gb"] = pd.to_numeric(_series(frame, "vram_gb", "gpu_vram_gb", default=np.nan), errors="coerce").fillna(parsed_hardware.map(lambda item: item[1]))
    # Published tables report a single accelerator, not a rig — assume one GPU
    # unless the source explicitly says otherwise.
    out["gpu_count"] = pd.to_numeric(_series(frame, "gpu_count", default=1), errors="coerce").fillna(1)
    out["aggregate_vram_gb"] = pd.to_numeric(_series(frame, "aggregate_vram_gb", default=np.nan), errors="coerce").fillna(out["vram_gb"])
    out["cpu_cores"] = pd.to_numeric(_series(frame, "cpu_cores", default=np.nan), errors="coerce").fillna(parsed_hardware.map(lambda item: item[2]))
    explicit_platform = _series(frame, "platform", "os", default=np.nan)
    out["platform"] = explicit_platform.fillna(parsed_hardware.map(lambda item: item[3])).astype(str).str.lower().replace({"darwin": "macos"})
    out["gpu_backend"] = backend
    out["recommended_runtime"] = [normalize_runtime(value, str(gpu)) for value, gpu in zip(runtime_raw, backend)]
    out["context_tokens"] = pd.to_numeric(_series(frame, "Context_Window", "context_tokens", "input_length", default=np.nan), errors="coerce")
    out["context_tokens_known"] = out["context_tokens"].notna()
    out["tokens_per_second"] = pd.to_numeric(_series(frame, "top_decode_tps", "Tokens_per_sec", "Tokens-per-Second", "tokens_per_second"), errors="coerce")
    out["prompt_tokens_per_second"] = pd.to_numeric(_series(frame, "prompt_tokens_per_second", "prefill_tps"), errors="coerce")
    out["time_to_first_token_ms"] = pd.to_numeric(_series(frame, "TTFT_ms", "time_to_first_token_ms", "TTFT"), errors="coerce")
    out["peak_ram_gb"] = pd.to_numeric(_series(frame, "peak_ram_gb"), errors="coerce")
    out["peak_vram_gb"] = pd.to_numeric(_series(frame, "peak_vram_gb"), errors="coerce")
    out["model_load_time_ms"] = pd.to_numeric(_series(frame, "model_load_time_ms", "load_time_ms"), errors="coerce")
    out["energy_per_token_j"] = pd.to_numeric(_series(frame, "energy_per_token_j"), errors="coerce")
    for column in OPTIONAL_REGRESSION_TARGETS:
        out[f"{column}_known"] = out[column].notna()
    # Real fit/context labels are rare in published leaderboard exports — leave
    # them unknown (rather than inventing "Runs comfortably" / 2048) and let
    # the *_known mask columns keep unlabeled rows out of those loss terms.
    out["fit_status"] = _series(frame, "fit_status", default=np.nan)
    out["fit_status_known"] = out["fit_status"].notna()
    out["source"], out["provenance"], out["sample_weight"] = source, "published", sample_weight
    return out


def normalize_measured(frame: pd.DataFrame, source: str) -> pd.DataFrame:
    renamed = frame.rename(columns={
        "model": "model_id", "runtime": "recommended_runtime", "decode_tokens_per_second": "tokens_per_second",
        "ttft_ms": "time_to_first_token_ms", "context_length": "context_tokens",
    }).copy()
    required = ["model_id", "model_params_b", "ram_gb", "vram_gb", "cpu_cores", "platform", "gpu_backend", "tokens_per_second"]
    missing = [column for column in required if column not in renamed]
    if missing:
        raise ValueError(f"Measured dataset {source} is missing: {', '.join(missing)}")
    renamed["quantization"] = renamed.get("quantization", "Q4_K_M")
    renamed["quant_bits"] = renamed.get("quant_bits", renamed["quantization"].map(quant_bits))
    renamed["quality_score"] = renamed.get("quality_score", 0.0)
    renamed["is_moe"] = renamed.get("is_moe", False)
    renamed["gpu_count"] = pd.to_numeric(renamed.get("gpu_count", pd.Series(1, index=renamed.index)), errors="coerce").fillna(1)
    renamed["aggregate_vram_gb"] = pd.to_numeric(renamed.get("aggregate_vram_gb", pd.Series(np.nan, index=renamed.index)), errors="coerce").fillna(renamed["vram_gb"])
    # As with normalize_published: a measured benchmark row can be real about
    # speed while still not reporting fit/context — don't invent those.
    renamed["context_tokens"] = renamed.get("context_tokens", np.nan)
    renamed["context_tokens_known"] = renamed["context_tokens"].notna()
    renamed["fit_status"] = renamed.get("fit_status", np.nan)
    renamed["fit_status_known"] = renamed["fit_status"].notna()
    for column in OPTIONAL_REGRESSION_TARGETS:
        if column not in renamed:
            renamed[column] = np.nan
        renamed[f"{column}_known"] = renamed[column].notna()
    runtime_values = renamed["recommended_runtime"] if "recommended_runtime" in renamed else pd.Series("llama.cpp", index=renamed.index)
    renamed["recommended_runtime"] = [normalize_runtime(value, str(gpu)) for value, gpu in zip(runtime_values, renamed["gpu_backend"])]
    renamed["source"], renamed["provenance"], renamed["sample_weight"] = source, "measured", 1.0
    return renamed


def finalize(frame: pd.DataFrame) -> pd.DataFrame:
    for column in CANONICAL_COLUMNS:
        if column not in frame:
            frame[column] = np.nan
    # A row missing these columns entirely (rather than an explicit known/unknown
    # marker set by normalize_*) is unlabeled, same as an explicit NaN.
    frame["fit_status_known"] = frame["fit_status_known"].fillna(False).astype(bool) & frame["fit_status"].notna()
    frame["context_tokens_known"] = frame["context_tokens_known"].fillna(False).astype(bool) & frame["context_tokens"].notna()
    numeric = [
        "model_params_b", "quant_bits", "ram_gb", "vram_gb", "gpu_count", "aggregate_vram_gb",
        "cpu_cores", "context_tokens", "tokens_per_second", "sample_weight", *OPTIONAL_REGRESSION_TARGETS,
    ]
    for column in numeric:
        frame[column] = pd.to_numeric(frame[column], errors="coerce")
    frame = frame.dropna(subset=["model_id", "model_params_b", "ram_gb", "vram_gb", "cpu_cores", "tokens_per_second"])
    frame = frame[(frame.model_params_b > 0) & (frame.tokens_per_second >= 0)]
    frame["gpu_count"] = frame["gpu_count"].fillna(0)
    frame["aggregate_vram_gb"] = frame["aggregate_vram_gb"].fillna(frame["vram_gb"])
    # Placeholder fill for unlabeled rows so downstream encoding never sees NaN —
    # *_known stays False for these, so encode_targets masks their loss contribution
    # regardless of what placeholder value ends up here.
    frame["fit_status"] = frame["fit_status"].fillna("CPU only")
    frame["context_tokens"] = frame.context_tokens.fillna(8192).clip(2048, 131072).map(lambda value: 2 ** int(np.floor(np.log2(value))))
    for column in OPTIONAL_REGRESSION_TARGETS:
        frame[f"{column}_known"] = frame[f"{column}_known"].fillna(False).astype(bool) & frame[column].notna()
        frame[column] = frame[column].fillna(0.0)
    return frame[CANONICAL_COLUMNS].drop_duplicates().reset_index(drop=True)
