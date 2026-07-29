"""Adapter for Hugging Face's optimum-benchmark/llm-perf-leaderboard dataset
(https://huggingface.co/datasets/optimum-benchmark/llm-perf-leaderboard) —
real measured memory/latency/throughput benchmarks across GPUs (T4/A10/A100)
and CPU backends, at several quantization schemes (bnb/gptq/awq/unquantized).

Maps its deeply-nested `config.*`/`report.*` dotted-column schema onto the
flat column names recommender/data_sources.py's normalize_published() already
recognizes (top_model_name, ram_gb, top_decode_tps, etc.), then writes one
adapted CSV per source file into data/raw/published/hf-optimum-benchmark/ (one
subfolder per source, same convention as data/raw/published/llm-speed and
llm-perfdata) so they can be passed to prepare_dataset.py via --published like
any other published benchmark table.

Important caveat, not glossed over: this dataset benchmarks the HF
Transformers/PyTorch/ONNXRuntime/OpenVINO inference stack, not llama.cpp or
vLLM (the runtimes this app actually ships) — unlike data/raw/published/
llm-speed, which measures those runtimes directly. Memory usage for loading a
given model at a given quantization is largely runtime-agnostic and transfers
well; raw decode/prefill throughput numbers do not — Transformers eager-mode
inference is typically slower than llama.cpp's optimized GGUF kernels or
vLLM's continuous batching, especially on the un/lightly-quantized rows. This
data is still real, still useful (particularly for memory-footprint and
relative-scaling signal), but it is not a perfect stand-in for llama.cpp/vLLM
speed — hence the reduced sample_weight passed at the prepare_dataset.py
--published-weight call site, one tier under normalize_published()'s default
0.75 for a source that matches this app's own runtimes directly.
"""

from __future__ import annotations

import argparse
import ast
from pathlib import Path

import numpy as np
import pandas as pd

PUBLISHED_SAMPLE_WEIGHT = 0.6

# bnb reports 8-bit/4-bit via boolean flags rather than a scheme name; gptq/awq
# are effectively always 4-bit in this leaderboard; unquantized runs report
# their dtype instead — quant_bits() in data_sources.py already knows how to
# read these text tokens.
def _quantization_text(row: pd.Series) -> str:
    scheme = str(row.get("config.backend.quantization_scheme") or "").lower()
    if scheme == "bnb":
        if row.get("config.backend.quantization_config.load_in_4bit"):
            return "INT4"
        if row.get("config.backend.quantization_config.load_in_8bit"):
            return "INT8"
        return "INT8"
    if scheme in {"gptq", "awq"}:
        return scheme.upper()
    dtype = str(row.get("config.backend.torch_dtype") or "").lower()
    if "bfloat16" in dtype:
        return "BF16"
    if "float16" in dtype:
        return "FP16"
    if "float32" in dtype:
        return "FP32"
    return "FP16"


def _gpu_text(value: object) -> str:
    if value is None or (isinstance(value, float) and np.isnan(value)):
        return ""
    text = str(value)
    try:
        parsed = ast.literal_eval(text)
        if isinstance(parsed, list) and parsed:
            text = str(parsed[0])
    except (ValueError, SyntaxError):
        pass
    return f"NVIDIA {text}" if text and "nvidia" not in text.lower() else text


def _col(frame: pd.DataFrame, name: str, default: object = np.nan) -> pd.Series:
    """frame.get(name) returns a bare scalar (not a Series) when the column is
    entirely absent — every optimum-benchmark file has a slightly different
    column set depending on backend, so this is the common case, not an edge
    case."""
    if name in frame:
        return frame[name]
    return pd.Series(default, index=frame.index)


def adapt(raw: pd.DataFrame, source_name: str) -> pd.DataFrame:
    out = pd.DataFrame(index=raw.index)
    out["top_model_name"] = raw["config.backend.model"]
    out["GPU_Type"] = _col(raw, "config.environment.gpu", "").map(_gpu_text)
    out["top_backend"] = raw["config.backend.name"].astype(str) + "-" + raw["config.backend.device"].astype(str)
    out["Quantization"] = raw.apply(_quantization_text, axis=1)
    out["ram_gb"] = pd.to_numeric(raw["config.environment.cpu_ram_mb"], errors="coerce") / 1024
    # config.environment.gpu_vram_mb is mislabeled: its values are raw bytes
    # (e.g. 24146608128 for a 24GB A10), not megabytes — confirmed against the
    # known VRAM capacity of every GPU this dataset benchmarks. CPU-backend
    # files (onnxruntime-cpu/openvino-cpu/pytorch-cpu) don't have this column
    # at all — that means "no GPU" (0 VRAM), not "unknown" (NaN), and matters:
    # finalize() requires a known vram_gb, so leaving these as NaN would drop
    # every CPU-backend row instead of correctly recording them as 0.
    has_gpu_vram = "config.environment.gpu_vram_mb" in raw
    out["vram_gb"] = pd.to_numeric(_col(raw, "config.environment.gpu_vram_mb"), errors="coerce") / 1e9 if has_gpu_vram else 0.0
    out["cpu_cores"] = pd.to_numeric(_col(raw, "config.environment.cpu_count"), errors="coerce")
    out["platform"] = "linux"  # every config in this dataset runs on Linux cloud instances
    out["top_decode_tps"] = pd.to_numeric(_col(raw, "report.decode.throughput.value"), errors="coerce")
    out["prompt_tokens_per_second"] = pd.to_numeric(_col(raw, "report.prefill.throughput.value"), errors="coerce")
    out["TTFT_ms"] = pd.to_numeric(_col(raw, "report.prefill.latency.mean"), errors="coerce") * 1000
    out["peak_ram_gb"] = pd.to_numeric(_col(raw, "report.decode.memory.max_ram"), errors="coerce") / 1024
    out["peak_vram_gb"] = (pd.to_numeric(_col(raw, "report.decode.memory.max_global_vram"), errors="coerce") / 1024).fillna(0.0) if has_gpu_vram else 0.0
    # report.load.latency deliberately NOT used for model_load_time_ms: this
    # benchmark's load phase measures a cold cloud-instance load (Python/HF
    # Transformers init, possibly a fresh model download — median ~11.6s, up
    # to 663s observed), not the app's "already-downloaded local GGUF file,
    # mmap'd by llama.cpp/MLX" scenario physics.py's model_load_time_ms
    # baseline models. Left unset (NaN) rather than teaching a residual
    # correction against a different quantity entirely.
    decode_energy_kwh = pd.to_numeric(_col(raw, "report.decode.energy.total"), errors="coerce")
    decode_token_count = pd.to_numeric(_col(raw, "report.decode.latency.count"), errors="coerce")
    out["energy_per_token_j"] = (decode_energy_kwh * 3.6e6) / decode_token_count.replace(0, np.nan)
    # Context_Window is deliberately left unset: this benchmark tests a fixed
    # short prompt/generation length for throughput measurement, not the
    # model's actual maximum supported context — populating it would be
    # exactly the kind of invented label the *_known masking (see
    # data_sources.py normalize_published) exists to avoid.
    out["source"] = source_name
    return out


def main() -> None:
    parser = argparse.ArgumentParser(description="Adapt HF optimum-benchmark/llm-perf-leaderboard CSVs for prepare_dataset.py --published.")
    parser.add_argument("--input-dir", type=Path, default=Path("data/raw/llm_perf_leaderboard"))
    parser.add_argument("--output-dir", type=Path, default=Path("data/raw/published/hf-optimum-benchmark"))
    args = parser.parse_args()

    args.output_dir.mkdir(parents=True, exist_ok=True)
    input_files = sorted(args.input_dir.glob("*.csv"))
    if not input_files:
        raise SystemExit(f"No CSV files found in {args.input_dir}")

    total_written = 0
    for path in input_files:
        raw = pd.read_csv(path, low_memory=False)
        adapted = adapt(raw, path.stem)
        # Drop failed/incomplete benchmark runs up front (missing the metric
        # that matters most) rather than relying solely on finalize()'s
        # downstream dropna to catch them.
        adapted = adapted.dropna(subset=["top_decode_tps", "ram_gb"])
        adapted = adapted[adapted["top_decode_tps"] > 0]
        output_path = args.output_dir / f"{path.stem}.csv"
        adapted.to_csv(output_path, index=False)
        total_written += len(adapted)
        print(f"{path.name}: {len(raw):,} raw rows -> {len(adapted):,} usable rows -> {output_path}")

    print(f"\nTotal usable rows across {len(input_files)} files: {total_written:,}")


if __name__ == "__main__":
    main()
