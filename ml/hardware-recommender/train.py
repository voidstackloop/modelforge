from __future__ import annotations

import argparse
import hashlib
import json
import random
from pathlib import Path

import numpy as np
import pandas as pd
import torch
from torch import nn
from torch.utils.data import DataLoader, TensorDataset

from recommender import physics
from recommender.model import LOG_VAR_MAX, LOG_VAR_MIN, REGRESSION_TARGETS, RUNTIME_CLASSES, HardwareRecommender, decode_predictions, encode_features, encode_targets, fit_normalizer


def seed_everything(seed: int) -> None:
    random.seed(seed)
    np.random.seed(seed)
    torch.manual_seed(seed)
    if torch.cuda.is_available():
        torch.cuda.manual_seed_all(seed)


def unseen_family_mask(frame: pd.DataFrame) -> pd.Series:
    # Combinations deliberately withheld from *all* training/validation so the
    # metrics report an honest "does this generalize to hardware it never saw
    # anything like" number, not just interpolation within the training
    # distribution. Chosen narrowly (not a whole backend) so directml/rocm
    # still get some training signal from smaller models.
    return (frame.model_params_b > 90) | ((frame.gpu_backend == "directml") & (frame.model_params_b > 30))


def gaussian_nll(mean: torch.Tensor, target: torch.Tensor, log_var: torch.Tensor) -> torch.Tensor:
    log_var = log_var.clamp(LOG_VAR_MIN, LOG_VAR_MAX)
    var = torch.exp(log_var)
    return 0.5 * (log_var + (mean - target) ** 2 / var)


def batch_loss(model, batch, device) -> tuple[torch.Tensor, dict[str, torch.Tensor]]:
    features, runtime, baseline_log, actual_log, mask, weights = [item.to(device, non_blocking=True) for item in batch]
    output = model(features)
    runtime_loss = nn.functional.cross_entropy(output["runtime"], runtime, reduction="none")
    residual_target = actual_log - baseline_log
    nll = gaussian_nll(output["residual_mean"], residual_target, output["residual_log_var"])
    masked_nll = (nll * mask).sum(dim=1) / mask.sum(dim=1).clamp_min(1e-6)
    per_example_loss = 0.4 * runtime_loss + masked_nll
    loss = (per_example_loss * weights).sum() / weights.sum().clamp_min(1e-6)
    return loss, output


def confusion_and_scores(y_true: np.ndarray, y_pred: np.ndarray, num_classes: int) -> dict:
    cm = np.zeros((num_classes, num_classes), dtype=int)
    for t, p in zip(y_true, y_pred):
        cm[t, p] += 1
    recall = np.zeros(num_classes)
    f1 = np.zeros(num_classes)
    for c in range(num_classes):
        tp = cm[c, c]
        fn = cm[c, :].sum() - tp
        fp = cm[:, c].sum() - tp
        precision_c = tp / (tp + fp) if (tp + fp) > 0 else 0.0
        recall[c] = tp / (tp + fn) if (tp + fn) > 0 else 0.0
        f1[c] = 2 * precision_c * recall[c] / (precision_c + recall[c]) if (precision_c + recall[c]) > 0 else 0.0
    return {"confusion_matrix": cm.tolist(), "recall": recall.tolist(), "macro_f1": float(f1.mean())}


def error_stats(errors: np.ndarray) -> dict[str, float]:
    if errors.size == 0:
        return {"median_abs_error": 0.0, "p90_abs_error": 0.0}
    return {"median_abs_error": float(np.median(np.abs(errors))), "p90_abs_error": float(np.percentile(np.abs(errors), 90))}


@torch.inference_mode()
def evaluate(model, frame: pd.DataFrame, normalizer, device, label: str) -> dict:
    model.eval()
    if frame.empty:
        return {}
    features = encode_features(frame, normalizer).to(device)
    targets = encode_targets(frame)
    output = model(features)
    runtime_true = targets["runtime"].numpy()
    runtime_pred = output["runtime"].argmax(1).cpu().numpy()
    predicted = decode_predictions(targets["baseline_log"].to(device), output["residual_mean"]).cpu().numpy()
    actual = torch.expm1(targets["actual_log"]).numpy()
    mask = targets["regression_mask"].numpy().astype(bool)
    confidence = torch.exp(-output["residual_log_var"].clamp_min(0)).cpu().numpy()

    result: dict = {"n": int(len(frame)), "runtime": confusion_and_scores(runtime_true, runtime_pred, len(RUNTIME_CLASSES))}

    speed_index = REGRESSION_TARGETS.index("tokens_per_second")
    speed_pred, speed_true = predicted[:, speed_index], actual[:, speed_index]
    speed_error = speed_pred - speed_true
    pct_error = np.abs(speed_error) / np.clip(speed_true, 1.0, None)
    result["speed"] = {
        **error_stats(speed_error),
        "median_pct_error": float(np.median(pct_error)),
        "p90_pct_error": float(np.percentile(pct_error, 90)),
    }

    result["regression_targets"] = {}
    for index, name in enumerate(REGRESSION_TARGETS):
        known = mask[:, index]
        if not known.any():
            continue
        result["regression_targets"][name] = error_stats(predicted[known, index] - actual[known, index])

    # Calibration: for peak_vram_gb and decode tokens/sec, what fraction of
    # true values fall inside the model's own predicted ~90% interval
    # (mean +/- 1.645*std, in log-space)? A well-calibrated model should land
    # close to 90% here, not just report a confident-looking number.
    calibration = {}
    for name in ("peak_vram_gb", "tokens_per_second"):
        index = REGRESSION_TARGETS.index(name)
        known = mask[:, index]
        if not known.any():
            continue
        std = torch.exp(0.5 * output["residual_log_var"][:, index]).cpu().numpy()[known]
        residual_actual = targets["actual_log"][:, index].numpy()[known] - targets["baseline_log"][:, index].numpy()[known]
        residual_mean = output["residual_mean"][:, index].cpu().numpy()[known]
        within_interval = np.abs(residual_actual - residual_mean) <= 1.645 * std
        calibration[name] = {"within_90pct_interval": float(within_interval.mean())}
    result["calibration"] = calibration

    fit_true = frame["fit_status"].to_numpy()
    fit_known = frame["fit_status_known"].to_numpy(dtype=bool)
    context_true = frame["context_tokens"].to_numpy()
    context_known = frame["context_tokens_known"].to_numpy(dtype=bool)
    vram_index, ram_index = REGRESSION_TARGETS.index("peak_vram_gb"), REGRESSION_TARGETS.index("peak_ram_gb")
    derived = [
        physics.derive_fit_and_context(
            float(predicted[i, vram_index]), float(predicted[i, ram_index]),
            float(frame["ram_gb"].iloc[i]), float(frame["aggregate_vram_gb"].iloc[i]),
            str(frame["gpu_backend"].iloc[i]), str(frame["platform"].iloc[i]), float(frame["model_params_b"].iloc[i]),
        )
        for i in range(len(frame))
    ]
    derived_fit = np.array([d[0] for d in derived])
    derived_context = np.array([d[1] for d in derived])
    result["derived_fit_agreement_rate"] = float((derived_fit[fit_known] == fit_true[fit_known]).mean()) if fit_known.any() else None
    result["derived_context_agreement_rate"] = float((derived_context[context_known] == context_true[context_known]).mean()) if context_known.any() else None

    for group_column in ("platform", "gpu_backend", "provenance"):
        breakdown = {}
        for value, group in frame.groupby(group_column):
            idx = frame.index.get_indexer(group.index)
            group_error = np.abs(speed_pred[idx] - speed_true[idx])
            breakdown[str(value)] = {"n": int(len(group)), "speed_median_abs_error": float(np.median(group_error))}
        result[f"by_{group_column}"] = breakdown

    print(f"[{label}] n={result['n']} runtime_macro_f1={result['runtime']['macro_f1']:.3f} speed_median_pct_error={result['speed']['median_pct_error']:.3f}")
    return result


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
    held_out = unseen_family_mask(data)
    trainable = data.loc[~held_out].copy()
    unseen_family_frame = data.loc[held_out].copy()

    groups = trainable["model_id"].astype(str).str.lower().unique()
    rng = np.random.default_rng(args.seed)
    rng.shuffle(groups)
    validation_groups = set(groups[: max(1, int(len(groups) * 0.2))])
    validation_mask = trainable["model_id"].astype(str).str.lower().isin(validation_groups)
    train_frame, validation_frame = trainable.loc[~validation_mask].copy(), trainable.loc[validation_mask].copy()
    if train_frame.empty or validation_frame.empty:
        raise SystemExit("Need at least two distinct model IDs for grouped train/validation splitting")
    normalizer = fit_normalizer(train_frame)

    # Out-of-distribution support: how many training rows back each
    # (platform, gpu_backend) combination — the worker uses this at inference
    # to flag low-confidence predictions for combinations barely represented
    # here, rather than reporting the same confidence everywhere.
    train_frame["_param_bucket"] = train_frame["model_params_b"].map(physics.param_bucket)
    support_counts = train_frame.groupby(["platform", "gpu_backend", "_param_bucket"]).size()
    support_counts_out = {f"{platform}|{backend}|{bucket}": int(count) for (platform, backend, bucket), count in support_counts.items()}

    # A second, continuous OOD signal alongside support_counts: the training
    # feature distribution's mean/covariance, so inference can flag a
    # feature vector that's a poor combination of otherwise-common values
    # (e.g. a parameter count and VRAM figure each individually common, but
    # never paired together) via Mahalanobis distance — see
    # recommender/physics.py's mahalanobis_distance/is_out_of_distribution.
    train_features_np = encode_features(train_frame, normalizer).numpy()
    feature_mean = train_features_np.mean(axis=0)
    feature_cov = np.cov(train_features_np, rowvar=False) + np.eye(train_features_np.shape[1]) * 1e-3
    feature_cov_inv = np.linalg.pinv(feature_cov)
    train_distances = np.array([physics.mahalanobis_distance(row, feature_mean, feature_cov_inv) for row in train_features_np])
    ood_stats_out = {"mean": feature_mean.tolist(), "cov_inv": feature_cov_inv.tolist(), "distance_p99": float(np.percentile(train_distances, 99))}

    def dataset(frame: pd.DataFrame) -> TensorDataset:
        targets = encode_targets(frame)
        weights = torch.tensor(frame.get("sample_weight", pd.Series(1.0, index=frame.index)).to_numpy(), dtype=torch.float32)
        return TensorDataset(encode_features(frame, normalizer), targets["runtime"], targets["baseline_log"], targets["actual_log"], targets["regression_mask"], weights)

    train_loader = DataLoader(dataset(train_frame), batch_size=args.batch_size, shuffle=True, pin_memory=device.type == "cuda")
    validation_loader = DataLoader(dataset(validation_frame), batch_size=args.batch_size * 2, pin_memory=device.type == "cuda")
    model = HardwareRecommender(args.hidden_size).to(device)
    optimizer = torch.optim.AdamW(model.parameters(), lr=args.learning_rate, weight_decay=1e-4)
    scheduler = torch.optim.lr_scheduler.ReduceLROnPlateau(optimizer, factor=0.5, patience=2)
    scaler = torch.amp.GradScaler("cuda", enabled=device.type == "cuda")
    best_val_loss = float("inf")
    best_state = None
    stale_epochs = 0

    def validation_loss() -> float:
        model.eval()
        total, count = 0.0, 0
        with torch.inference_mode():
            for batch in validation_loader:
                loss, _ = batch_loss(model, batch, device)
                total += loss.item() * batch[0].shape[0]
                count += batch[0].shape[0]
        return total / count

    for epoch in range(1, args.epochs + 1):
        model.train()
        for batch in train_loader:
            optimizer.zero_grad(set_to_none=True)
            with torch.amp.autocast(device_type=device.type, enabled=device.type == "cuda"):
                loss, _ = batch_loss(model, batch, device)
            scaler.scale(loss).backward()
            scaler.unscale_(optimizer)
            nn.utils.clip_grad_norm_(model.parameters(), 1.0)
            scaler.step(optimizer)
            scaler.update()

        epoch_val_loss = validation_loss()
        # Validation loss (not training loss) drives both the LR schedule and
        # checkpoint selection — training loss improving while validation
        # loss stalls or worsens is exactly the overfitting this is meant to
        # catch instead of quietly rewarding.
        scheduler.step(epoch_val_loss)
        if epoch_val_loss < best_val_loss - 1e-4:
            best_val_loss = epoch_val_loss
            best_state = {key: value.detach().cpu().clone() for key, value in model.state_dict().items()}
            stale_epochs = 0
        else:
            stale_epochs += 1
        if epoch == 1 or epoch % 5 == 0:
            print(f"epoch={epoch:03d} val_loss={epoch_val_loss:.4f} device={device}")
        if stale_epochs >= args.patience:
            print(f"Early stopping at epoch {epoch}")
            break

    model.load_state_dict(best_state)
    metrics = {
        "validation": evaluate(model, validation_frame, normalizer, device, "validation"),
        "unseen_family": evaluate(model, unseen_family_frame, normalizer, device, "unseen_family"),
    }
    checkpoint = {
        "version": 3,
        "framework": "pytorch",
        "hidden_size": args.hidden_size,
        "normalizer": normalizer.as_dict(),
        "state_dict": {key: value.cpu() for key, value in model.state_dict().items()},
        "metrics": metrics,
        "support_counts": support_counts_out,
        "ood_stats": ood_stats_out,
        "validation_split": "grouped_by_model_id",
        "unseen_family_definition": "model_params_b > 90, or gpu_backend == directml with model_params_b > 30",
        "provenance_counts": data["provenance"].value_counts().to_dict(),
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    torch.save(checkpoint, args.output)
    checksum = hashlib.sha256(args.output.read_bytes()).hexdigest()
    args.output.with_suffix(args.output.suffix + ".sha256").write_text(checksum + "\n", encoding="utf-8")
    args.output.with_suffix(".metrics.json").write_text(json.dumps(metrics, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"validation": {k: v for k, v in metrics["validation"].items() if k in ("n", "speed", "derived_fit_agreement_rate")}}, indent=2))
    print(f"Saved PyTorch checkpoint to {args.output} (sha256 {checksum[:16]}...)")

    # The packaged app doesn't ship torch — it runs the much lighter ONNX
    # export via onnxruntime (see export_onnx.py, app/python/recommender_worker.py).
    # Exporting here keeps the .onnx (and its normalizer/OOD-stats sidecar)
    # in sync with every retrain automatically, instead of relying on a
    # separate manual step someone can forget to run.
    from export_onnx import export as export_onnx

    onnx_path = args.output.with_suffix(".onnx")
    onnx_checksum = export_onnx(args.output, onnx_path)
    print(f"Exported ONNX model to {onnx_path} (sha256 {onnx_checksum[:16]}...)")


if __name__ == "__main__":
    main()
