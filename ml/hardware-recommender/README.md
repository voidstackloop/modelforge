# Hardware-aware model recommender

This project trains a compact recommender that predicts whether a model will run on a PC and estimates an appropriate runtime, quantization, context capacity, and generation speed.

The public Open LLM Leaderboard supplies real model names, parameter counts, architectures, precisions, and quality scores. It does **not** contain measured PC compatibility labels. `prepare_dataset.py` therefore combines the real catalog with transparent memory and throughput heuristics to create supervised training examples. Replace or augment those generated labels with measured telemetry before treating speed estimates as authoritative.

## Relationship to the Modelforge app

This directory is the *training* project — it is not built or run as part of the app's `npm run
build:all`/CI pipeline, and has no Node/Electron dependency at all. Its trained output is used at
runtime, though, via a committed copy rather than a live link:

- `artifacts/hardware_recommender.pt` (produced by `train.py` below) is manually copied to
  `app/python/artifacts/hardware_recommender.pt` when it's updated.
- `app/python/recommender_worker.py` is a separate, trimmed, inference-only reimplementation of
  `recommender/model.py`'s architecture and feature encoding — deliberately not importing this
  project's code, so the packaged app doesn't need pandas/pyarrow/the training pipeline just to
  run inference. If you change the model architecture or feature set here, that worker script
  needs the equivalent change ported over by hand.
- `app/src/system-specs.ts` spawns that worker as a long-lived JSON-line subprocess
  (`app/src/python-runtime-manager.ts`) and calls it to enhance the app's plain-heuristic hardware
  recommendations with this model's predictions, falling back to the heuristic alone if the worker
  isn't available. See [docs/ARCHITECTURE.md](../../docs/ARCHITECTURE.md#mlhardware-recommender)
  in the repo root for the full runtime picture.

**In short:** edit and retrain here, verify with `recommend.py`, then hand-port the updated
checkpoint and any architecture/feature changes into `app/python/` before they take effect in the
app.

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

## Project layout

```
download_dataset.py    Fetches the Open LLM Leaderboard snapshot (and optionally published benchmark datasets)
prepare_dataset.py      Builds the supervised training set: real catalog + measured/published rows + synthetic boundary rows
train.py                 Trains the multi-task MLP and writes artifacts/hardware_recommender.pt
recommend.py             CLI inference against a trained checkpoint — the reference implementation of the prediction logic
recommender/
  model.py                 HardwareRecommender module, feature/target encoding, Normalizer
  features.py               Feature column definitions, quantization table, memory/throughput heuristics
  data_sources.py           Dataset download/normalization helpers used by download_dataset.py / prepare_dataset.py
data/
  raw/                       Downloaded leaderboard snapshot and published benchmark tables
  measured/                  App-exported or manually collected measured benchmark rows (highest-weight training signal)
  processed/                 Output of prepare_dataset.py — the actual training parquet
artifacts/                Trained checkpoint + metrics (hardware_recommender.pt, hardware_recommender.metrics.json)
tests/                     pytest coverage for feature encoding and data-source normalization
```

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

Use `--json` when scripting against it. This CLI is the reference implementation for manual testing — the app itself doesn't shell out to `recommend.py` per request; it keeps a long-lived worker process alive and exchanges JSON lines over stdin/stdout instead (see [Relationship to the Modelforge app](#relationship-to-the-modelforge-app) above), which is the pattern to follow if you're integrating this model elsewhere. `--device auto` selects CUDA, then Apple MPS, then CPU; use `--device cpu` if the GPU is needed for inference workloads.

## Important limitations

- Speed is an estimate, not a benchmark.
- Context capacity depends on architecture and runtime details not always available in leaderboard metadata.
- MoE models need additional expert-memory information for precise recommendations.
- Unified-memory Apple Silicon systems should pass the usable memory budget as both RAM and VRAM only if the application explicitly accounts for shared memory; do not add them together.
- Collect opt-in, anonymized real measurements and retrain to replace generated labels over time.
