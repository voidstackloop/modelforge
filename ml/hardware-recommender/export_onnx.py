from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path

import torch
from torch import nn

from recommender.model import INPUT_SIZE, HardwareRecommender


class _ExportWrapper(nn.Module):
    """torch.onnx.export needs a fixed-order tuple output, not the dict
    HardwareRecommender.forward() returns for training/eval convenience."""

    def __init__(self, model: HardwareRecommender):
        super().__init__()
        self.model = model

    def forward(self, features: torch.Tensor):
        output = self.model(features)
        return output["runtime"], output["residual_mean"], output["residual_log_var"]


def export(checkpoint_path: Path, output_path: Path) -> str:
    checkpoint = torch.load(checkpoint_path, map_location="cpu", weights_only=True)
    model = HardwareRecommender(hidden_size=int(checkpoint["hidden_size"]))
    model.load_state_dict(checkpoint["state_dict"])
    model.eval()
    wrapper = _ExportWrapper(model)

    dummy = torch.zeros(1, INPUT_SIZE, dtype=torch.float32)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    torch.onnx.export(
        wrapper,
        dummy,
        str(output_path),
        input_names=["features"],
        output_names=["runtime_logits", "residual_mean", "residual_log_var"],
        dynamic_axes={
            "features": {0: "batch"},
            "runtime_logits": {0: "batch"},
            "residual_mean": {0: "batch"},
            "residual_log_var": {0: "batch"},
        },
        opset_version=17,
        dynamo=False,
    )

    # ONNX only holds the computational graph + weights — everything the
    # worker needs to turn raw hardware/model numbers into a request (feature
    # normalization, OOD stats, runtime class names) travels in this sidecar
    # instead, mirroring the .pt checkpoint's non-tensor fields.
    meta = {
        "version": checkpoint.get("version", 3),
        "hidden_size": checkpoint["hidden_size"],
        "normalizer": checkpoint["normalizer"],
        "support_counts": checkpoint.get("support_counts", {}),
        "ood_stats": checkpoint.get("ood_stats", {}),
    }
    output_path.with_suffix(".meta.json").write_text(json.dumps(meta, indent=2) + "\n", encoding="utf-8")

    checksum = hashlib.sha256(output_path.read_bytes()).hexdigest()
    output_path.with_suffix(output_path.suffix + ".sha256").write_text(checksum + "\n", encoding="utf-8")
    return checksum


def main() -> None:
    parser = argparse.ArgumentParser(description="Export the trained PyTorch checkpoint to ONNX for lightweight (no-torch) inference.")
    parser.add_argument("--checkpoint", type=Path, default=Path("artifacts/hardware_recommender.pt"))
    parser.add_argument("--output", type=Path, default=Path("artifacts/hardware_recommender.onnx"))
    args = parser.parse_args()
    checksum = export(args.checkpoint, args.output)
    print(f"Exported ONNX model to {args.output} (sha256 {checksum[:16]}...)")


if __name__ == "__main__":
    main()
