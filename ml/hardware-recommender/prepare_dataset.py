from __future__ import annotations

import argparse
from pathlib import Path

import pandas as pd

from recommender.data_sources import finalize, normalize_measured, normalize_published, read_table
from recommender.features import build_training_examples, normalize_catalog


def main() -> None:
    parser = argparse.ArgumentParser(description="Build hardware/model training examples.")
    parser.add_argument("--input", type=Path, default=Path("data/raw/open_llm_leaderboard.parquet"))
    parser.add_argument("--output", type=Path, default=Path("data/processed/training.parquet"))
    parser.add_argument("--samples", type=int, default=200_000)
    parser.add_argument("--measured", type=Path, action="append", default=[], help="App-exported CSV/JSON/JSONL/Parquet benchmark rows")
    parser.add_argument("--published", type=Path, action="append", default=[], help="Published benchmark table to normalize")
    parser.add_argument(
        "--published-weight", type=float, action="append", default=[],
        help="Sample weight for the --published table at the same position (paired by order, like -v flags). "
             "Reuses the last value given for any trailing --published without a matching weight; defaults to "
             "0.75 if none given at all. Lower it for sources that don't match this app's runtimes "
             "(llama.cpp/vLLM/MLX) as closely as a direct benchmark would.",
    )
    parser.add_argument("--synthetic-ratio", type=float, default=0.20)
    parser.add_argument("--seed", type=int, default=42)
    args = parser.parse_args()

    if args.samples < 1_000:
        raise SystemExit("--samples must be at least 1000")
    raw = pd.read_parquet(args.input)
    catalog = normalize_catalog(raw)
    if catalog.empty:
        raise SystemExit("No usable model rows found in the source dataset")
    if not 0 <= args.synthetic_ratio <= 1:
        raise SystemExit("--synthetic-ratio must be between 0 and 1")
    has_real_data = bool(args.measured or args.published)
    # --synthetic-ratio is "how much of --samples should be synthetic
    # *relative to the real data being blended in*" — with no --measured/
    # --published given there's no real data to leave room for, so capping
    # synthetic volume at a fraction of --samples just silently shrinks the
    # dataset (this used to produce only 16,000 rows from a "--samples 80000"
    # default). Use the full budget in that case instead.
    synthetic_samples = args.samples if not has_real_data else max(1_000, int(args.samples * args.synthetic_ratio))
    synthetic = build_training_examples(catalog, synthetic_samples, args.seed)
    synthetic["source"], synthetic["provenance"], synthetic["sample_weight"] = "heuristic-v2", "synthetic", 0.25
    frames = [synthetic]
    for path in args.measured:
        frames.append(normalize_measured(read_table(path), path.name))
    for index, path in enumerate(args.published):
        if index < len(args.published_weight):
            weight = args.published_weight[index]
        elif args.published_weight:
            weight = args.published_weight[-1]
        else:
            weight = 0.75
        frames.append(normalize_published(read_table(path), path.name, weight))
    training = finalize(pd.concat(frames, ignore_index=True, sort=False))
    args.output.parent.mkdir(parents=True, exist_ok=True)
    training.to_parquet(args.output, index=False)
    print(f"Wrote {len(training):,} examples from {len(catalog):,} unique models to {args.output}")
    print(training.fit_status.value_counts().to_string())
    print("\nProvenance:\n" + training.provenance.value_counts().to_string())
    if not has_real_data:
        print(
            "\nWarning: no --measured/--published data supplied — this training set is 100% synthetic "
            "(the model will mostly learn to reproduce the deterministic physics baseline, not real-world "
            "behavior). Pass --measured/--published app-exported or leaderboard benchmark files to train on "
            "real data; see data/measured/benchmark-template.csv."
        )


if __name__ == "__main__":
    main()
