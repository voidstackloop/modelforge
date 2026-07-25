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
    parser.add_argument("--samples", type=int, default=80_000)
    parser.add_argument("--measured", type=Path, action="append", default=[], help="App-exported CSV/JSON/JSONL/Parquet benchmark rows")
    parser.add_argument("--published", type=Path, action="append", default=[], help="Published benchmark table to normalize")
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
    synthetic_samples = max(1_000, int(args.samples * args.synthetic_ratio))
    synthetic = build_training_examples(catalog, synthetic_samples, args.seed)
    synthetic["source"], synthetic["provenance"], synthetic["sample_weight"] = "heuristic-v2", "synthetic", 0.25
    frames = [synthetic]
    for path in args.measured:
        frames.append(normalize_measured(read_table(path), path.name))
    for path in args.published:
        frames.append(normalize_published(read_table(path), path.name))
    training = finalize(pd.concat(frames, ignore_index=True, sort=False))
    args.output.parent.mkdir(parents=True, exist_ok=True)
    training.to_parquet(args.output, index=False)
    print(f"Wrote {len(training):,} examples from {len(catalog):,} unique models to {args.output}")
    print(training.fit_status.value_counts().to_string())
    print("\nProvenance:\n" + training.provenance.value_counts().to_string())


if __name__ == "__main__":
    main()
