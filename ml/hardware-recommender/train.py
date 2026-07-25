from __future__ import annotations

import argparse
import json
import random
from pathlib import Path

import numpy as np
import pandas as pd
import torch
from torch import nn
from torch.utils.data import DataLoader, TensorDataset

from recommender.model import HardwareRecommender, encode_features, encode_targets, fit_normalizer


def seed_everything(seed: int) -> None:
    random.seed(seed)
    np.random.seed(seed)
    torch.manual_seed(seed)
    if torch.cuda.is_available():
        torch.cuda.manual_seed_all(seed)


def evaluate(model, loader, device) -> dict[str, float]:
    model.eval()
    fit_correct = runtime_correct = context_correct = count = 0
    speed_error = 0.0
    with torch.inference_mode():
        for batch in loader:
            features, fit, runtime, context, log_speed, _weight = [item.to(device) for item in batch]
            output = model(features)
            count += features.shape[0]
            fit_correct += (output["fit"].argmax(1) == fit).sum().item()
            runtime_correct += (output["runtime"].argmax(1) == runtime).sum().item()
            context_correct += (output["context"].argmax(1) == context).sum().item()
            speed_error += torch.abs(torch.expm1(output["log_speed"]) - torch.expm1(log_speed)).sum().item()
    return {
        "fit_status_accuracy": fit_correct / count,
        "runtime_accuracy": runtime_correct / count,
        "context_accuracy": context_correct / count,
        "speed_mae_tokens_per_second": speed_error / count,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="Train the PyTorch hardware recommender.")
    parser.add_argument("--input", type=Path, default=Path("data/processed/training.parquet"))
    parser.add_argument("--output", type=Path, default=Path("artifacts/hardware_recommender.pt"))
    parser.add_argument("--epochs", type=int, default=60)
    parser.add_argument("--batch-size", type=int, default=512)
    parser.add_argument("--learning-rate", type=float, default=2e-3)
    parser.add_argument("--hidden-size", type=int, default=64)
    parser.add_argument("--patience", type=int, default=8)
    parser.add_argument("--device", choices=["auto", "cpu", "cuda", "mps"], default="auto")
    parser.add_argument("--seed", type=int, default=42)
    args = parser.parse_args()
    seed_everything(args.seed)

    if args.device == "auto":
        device_name = "cuda" if torch.cuda.is_available() else "mps" if torch.backends.mps.is_available() else "cpu"
    else:
        device_name = args.device
    device = torch.device(device_name)

    data = pd.read_parquet(args.input)
    groups = data["model_id"].astype(str).str.lower().unique()
    rng = np.random.default_rng(args.seed)
    rng.shuffle(groups)
    validation_groups = set(groups[: max(1, int(len(groups) * 0.2))])
    validation_mask = data["model_id"].astype(str).str.lower().isin(validation_groups)
    train_frame, validation_frame = data.loc[~validation_mask].copy(), data.loc[validation_mask].copy()
    if train_frame.empty or validation_frame.empty:
        raise SystemExit("Need at least two distinct model IDs for grouped train/validation splitting")
    normalizer = fit_normalizer(train_frame)

    def dataset(frame: pd.DataFrame) -> TensorDataset:
        targets = encode_targets(frame)
        weights = torch.tensor(frame.get("sample_weight", pd.Series(1.0, index=frame.index)).to_numpy(), dtype=torch.float32)
        return TensorDataset(encode_features(frame, normalizer), targets["fit"], targets["runtime"], targets["context"], targets["log_speed"], weights)

    train_loader = DataLoader(dataset(train_frame), batch_size=args.batch_size, shuffle=True, pin_memory=device.type == "cuda")
    validation_loader = DataLoader(dataset(validation_frame), batch_size=args.batch_size * 2, pin_memory=device.type == "cuda")
    model = HardwareRecommender(args.hidden_size).to(device)
    optimizer = torch.optim.AdamW(model.parameters(), lr=args.learning_rate, weight_decay=1e-4)
    scheduler = torch.optim.lr_scheduler.ReduceLROnPlateau(optimizer, factor=0.5, patience=2)
    classification_loss = nn.CrossEntropyLoss(reduction="none")
    speed_loss = nn.SmoothL1Loss(reduction="none")
    scaler = torch.amp.GradScaler("cuda", enabled=device.type == "cuda")
    best_loss = float("inf")
    best_state = None
    stale_epochs = 0

    for epoch in range(1, args.epochs + 1):
        model.train()
        total_loss = 0.0
        for batch in train_loader:
            features, fit, runtime, context, log_speed, weights = [item.to(device, non_blocking=True) for item in batch]
            optimizer.zero_grad(set_to_none=True)
            with torch.amp.autocast(device_type=device.type, enabled=device.type == "cuda"):
                output = model(features)
                per_example_loss = (
                    classification_loss(output["fit"], fit)
                    + 0.7 * classification_loss(output["runtime"], runtime)
                    + 0.7 * classification_loss(output["context"], context)
                    + 0.6 * speed_loss(output["log_speed"], log_speed)
                )
                loss = (per_example_loss * weights).sum() / weights.sum().clamp_min(1e-6)
            scaler.scale(loss).backward()
            scaler.unscale_(optimizer)
            nn.utils.clip_grad_norm_(model.parameters(), 1.0)
            scaler.step(optimizer)
            scaler.update()
            total_loss += loss.item() * features.shape[0]

        epoch_loss = total_loss / len(train_frame)
        scheduler.step(epoch_loss)
        if epoch_loss < best_loss - 1e-4:
            best_loss = epoch_loss
            best_state = {key: value.detach().cpu().clone() for key, value in model.state_dict().items()}
            stale_epochs = 0
        else:
            stale_epochs += 1
        if epoch == 1 or epoch % 5 == 0:
            print(f"epoch={epoch:03d} loss={epoch_loss:.4f} device={device}")
        if stale_epochs >= args.patience:
            print(f"Early stopping at epoch {epoch}")
            break

    model.load_state_dict(best_state)
    metrics = evaluate(model, validation_loader, device)
    checkpoint = {
        "version": 2,
        "framework": "pytorch",
        "hidden_size": args.hidden_size,
        "normalizer": normalizer.as_dict(),
        "state_dict": {key: value.cpu() for key, value in model.state_dict().items()},
        "metrics": metrics,
        "validation_split": "grouped_by_model_id",
        "provenance_counts": data["provenance"].value_counts().to_dict(),
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    torch.save(checkpoint, args.output)
    args.output.with_suffix(".metrics.json").write_text(json.dumps(metrics, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(metrics, indent=2))
    print(f"Saved PyTorch checkpoint to {args.output}")


if __name__ == "__main__":
    main()
