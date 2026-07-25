from __future__ import annotations

import argparse
import shutil
from pathlib import Path

from huggingface_hub import hf_hub_download, snapshot_download

REPO_ID = "open-llm-leaderboard/contents"
FILENAME = "data/train-00000-of-00001.parquet"
PUBLISHED_DATASETS = {
    "llm-speed": "llmspeed/llm-speed-benchmarks",
    "llm-perfdata": "metrum-ai/llm-perfdata",
}


def main() -> None:
    parser = argparse.ArgumentParser(description="Download the public model metadata catalog.")
    parser.add_argument("--output", type=Path, default=Path("data/raw/open_llm_leaderboard.parquet"))
    parser.add_argument("--revision", default="main")
    parser.add_argument("--include-published", action="store_true", help="Also download permissively licensed measured benchmark datasets")
    args = parser.parse_args()

    args.output.parent.mkdir(parents=True, exist_ok=True)
    cached = hf_hub_download(repo_id=REPO_ID, filename=FILENAME, repo_type="dataset", revision=args.revision)
    shutil.copy2(cached, args.output)
    print(f"Downloaded {REPO_ID}/{FILENAME} to {args.output} ({args.output.stat().st_size:,} bytes)")
    if args.include_published:
        root = args.output.parent / "published"
        for name, repo_id in PUBLISHED_DATASETS.items():
            destination = root / name
            snapshot_download(repo_id=repo_id, repo_type="dataset", revision=args.revision, local_dir=destination)
            print(f"Downloaded {repo_id} to {destination}")


if __name__ == "__main__":
    main()
