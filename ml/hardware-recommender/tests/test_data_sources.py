import pandas as pd

from recommender.data_sources import finalize, normalize_measured, normalize_published


def test_measured_rows_receive_full_weight():
    source = pd.DataFrame([{
        "model_id": "org/model-7B", "model_params_b": 7, "ram_gb": 16, "vram_gb": 8,
        "cpu_cores": 8, "platform": "linux", "gpu_backend": "cuda", "tokens_per_second": 40,
        "quantization": "Q4_K_M", "runtime": "llama.cpp", "context_tokens": 8192,
    }])
    result = finalize(normalize_measured(source, "app-export"))
    assert result.iloc[0].provenance == "measured"
    assert result.iloc[0].sample_weight == 1.0
    assert result.iloc[0].recommended_runtime == "llama.cpp-cuda"


def test_llm_speed_schema_is_normalized_as_published():
    source = pd.DataFrame([{
        "top_model_name": "org/model-7B-Q4_K_M", "top_backend": "ollama",
        "accelerator_summary": "RTX 4070 (12GB) + Ryzen 9 16-Core Processor (32c) + 64GB", "top_decode_tps": 55.2,
    }])
    result = normalize_published(source, "llm-speed")
    assert result.iloc[0].model_params_b == 7
    assert result.iloc[0].gpu_backend == "cuda"
    assert result.iloc[0].provenance == "published"
    assert result.iloc[0].sample_weight < 1.0
    assert result.iloc[0].vram_gb == 12
    assert result.iloc[0].ram_gb == 64
    assert result.iloc[0].cpu_cores == 32
