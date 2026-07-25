# Hardware-aware model recommender

This project trains a compact recommender that predicts whether a model will run on a PC and estimates an appropriate runtime, quantization, context capacity, and generation speed.

The public Open LLM Leaderboard supplies real model names, parameter counts, architectures, precisions, and quality scores. It does **not** contain measured PC compatibility labels. `prepare_dataset.py` therefore combines the real catalog with transparent memory and throughput heuristics to create supervised training examples. Replace or augment those generated labels with measured telemetry before treating speed estimates as authoritative.

## Outputs

For a hardware/model combination, inference returns:

- `Runs comfortably`
- `May require partial GPU offload`
- `CPU only`
- `Insufficient memory`
- suggested GGUF quantization
- estimated context capacity
- estimated generation speed
- recommended runtime

The PyTorch model is a compact multi-task MLP with a shared backbone and separate fit, runtime, context, and speed heads. It is normally well below 1 MB. It trains on CPU by default and can optionally use CUDA or Apple MPS. A 2–3 GB GPU is more than sufficient.

## Setup

```bash
cd ml/hardware-recommender
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

On Windows, activate with `.venv\\Scripts\\activate`.

## Download and train

```bash
python download_dataset.py --include-published
python prepare_dataset.py --samples 80000 \
  --measured data/measured/my-app-benchmarks.jsonl \
  --published data/raw/published/llm-speed/runs.csv
python train.py --device auto
```

Run the feature/label checks with:

```bash
python -m pytest
```

The committed `data/raw/open_llm_leaderboard.parquet` snapshot lets you start without downloading again. Run `download_dataset.py` to refresh it.

## Multi-source training data

The trainer distinguishes three provenance levels instead of treating every row as equally authoritative:

- `measured` app exports: weight `1.0`
- `published` benchmark imports: weight `0.75`
- `synthetic` memory/performance boundary rows: weight `0.25`

`download_dataset.py --include-published` downloads the CC BY 4.0 `llmspeed/llm-speed-benchmarks` dataset and the MIT `metrum-ai/llm-perfdata` dataset. Pass the useful CSV, JSONL, JSON, or Parquet files to `prepare_dataset.py --published`. Schema normalization is deliberately conservative: rows without a recoverable model parameter count or throughput measurement are discarded instead of being guessed into training.

Use `data/measured/benchmark-template.csv` as the canonical format for application or manually collected results. Multiple `--measured` and `--published` arguments can be supplied. The final validation set is grouped by model ID, so measurements of a model cannot leak into both training and validation.

## Try a recommendation

```bash
python recommend.py \
  --model-params-b 7 \
  --ram-gb 16 \
  --vram-gb 3 \
  --gpu-backend cuda \
  --platform windows \
  --cpu-cores 8
```

Use `--json` when calling it from Electron. For production, keep a Python worker alive and exchange JSON lines over stdin/stdout instead of starting Python for every recommendation. `--device auto` selects CUDA, then Apple MPS, then CPU; use `--device cpu` if the GPU is needed for inference workloads.

## Important limitations

- Speed is an estimate, not a benchmark.
- Context capacity depends on architecture and runtime details not always available in leaderboard metadata.
- MoE models need additional expert-memory information for precise recommendations.
- Unified-memory Apple Silicon systems should pass the usable memory budget as both RAM and VRAM only if the application explicitly accounts for shared memory; do not add them together.
- Collect opt-in, anonymized real measurements and retrain to replace generated labels over time.
