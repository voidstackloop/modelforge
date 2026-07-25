---
license: cc-by-4.0
language:
- en
pretty_name: llm-speed inference-speed benchmarks
tags:
- llm
- inference
- benchmark
- gpu
- apple-silicon
- tokens-per-second
size_categories:
- n<1K
configs:
- config_name: default
  data_files:
  - split: runs
    path: runs.csv
---

# llm-speed: signed LLM inference-speed benchmarks

Crowdsourced, cryptographically signed measurements of how fast large language models
actually run: decode tokens per second, time to first token, and latency, across consumer
GPUs, Apple Silicon, and hosted APIs, under one reproducible workload suite (suite-v1).

- **Live data and bulk downloads:** https://llm-speed.com/data
- **Per-run permalink:** https://llm-speed.com/r/&lt;id&gt;
- **Methodology:** https://llm-speed.com/methodology
- **DOI:** https://doi.org/10.5281/zenodo.21254813 (Zenodo archive; resolves to the latest version)
- **License:** CC BY 4.0. Reuse freely, including commercially, with attribution and a link back.

## What is in it

Each row is the headline result of one signed benchmark run.

| column | meaning |
| --- | --- |
| `id` | the run id |
| `permalink` | citable page for the run on llm-speed.com |
| `suite_version` | workload suite version (currently suite-v1) |
| `top_model_name` | model that was measured |
| `top_backend` | ollama, llama.cpp, mlx, vllm, exllamav2, and so on |
| `top_workload` | which workload produced the headline number |
| `accelerator_summary` | the GPU or Apple Silicon plus host |
| `top_decode_tps` | headline decode tokens per second |
| `received_at` | when the run was submitted |

Full per-workload detail (prefill tok/s, TTFT, quantization, percentiles) for any run is at
`https://llm-speed.com/r/<id>` and via the live API at
`https://api.llm-speed.com/v1/results/<id>`. Files: `runs.csv`, `runs.jsonl`, `runs.json`,
plus `meta.json` (counts and generation timestamp).

## How it is measured

Every run is produced by the open-source llm-speed CLI under the suite-v1 workload set,
fingerprinted to real hardware, and cryptographically signed on upload (EdDSA/JWS) so a
number cannot be edited after the fact. The values are measured, not modeled. If two rows
disagree for the same model and hardware, both are real submissions from different setups;
open each permalink to see the raw workload detail.

## Citation

```
llm-speed. The llm-speed dataset: signed LLM inference-speed benchmarks.
Zenodo (2026). https://doi.org/10.5281/zenodo.21254813. CC BY 4.0.
```
