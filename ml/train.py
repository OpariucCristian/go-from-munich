"""
Trains the multiclass LightGBM delay model and exports it to ONNX.

Pure compute: reads train.csv / valid.csv / meta.json written by the Node exporter
(`worker export-training`), writes <out>/model.onnx, metrics.json and parity.json.
Features are opaque here; their meaning lives in packages/model/src/features.ts.

    python train.py --data ../data/training --out ../models/lgbm-20260928
"""
import argparse
import json
import time
from pathlib import Path

import lightgbm as lgb
import numpy as np
import pandas as pd

NUM_BUCKETS = 8


def rps(probs: np.ndarray, labels: np.ndarray) -> float:
    """Ranked probability score over ordered buckets (cancelled = worst). Lower is better."""
    cum_p = np.cumsum(probs, axis=1)[:, : NUM_BUCKETS - 1]
    cum_o = (labels[:, None] <= np.arange(NUM_BUCKETS - 1)[None, :]).astype(float)
    return float(np.mean(np.sum((cum_p - cum_o) ** 2, axis=1) / (NUM_BUCKETS - 1)))


def log_loss(probs: np.ndarray, labels: np.ndarray) -> float:
    return float(-np.mean(np.log(np.clip(probs[np.arange(len(labels)), labels], 1e-6, 1))))


def brier6(probs: np.ndarray, labels: np.ndarray) -> float:
    p6 = probs[:, 2:].sum(axis=1)
    return float(np.mean((p6 - (labels >= 2)) ** 2))


def evaluate(probs: np.ndarray, labels: np.ndarray) -> dict:
    return {
        "n": int(len(labels)),
        "rps": rps(probs, labels),
        "logLoss": log_loss(probs, labels),
        "brier6": brier6(probs, labels),
        "calibration": [
            {"bucket": k, "predicted": float(probs[:, k].mean()), "observed": float((labels == k).mean())}
            for k in range(NUM_BUCKETS)
        ],
    }


def load(path: Path, features: list[str], ref_cols: list[str]) -> tuple[np.ndarray, np.ndarray, np.ndarray | None]:
    df = pd.read_csv(path)
    missing = [f for f in features if f not in df.columns]
    if missing:
        raise SystemExit(f"{path}: missing feature columns {missing}")
    ref = df[ref_cols].to_numpy(dtype=np.float64) if ref_cols and all(c in df.columns for c in ref_cols) else None
    return df[features].to_numpy(dtype=np.float32), df["label"].to_numpy(dtype=np.int64), ref


def export_onnx(model: lgb.LGBMClassifier, n_features: int, path: Path) -> None:
    from onnxmltools import convert_lightgbm
    from onnxmltools.convert.common.data_types import FloatTensorType

    onx = convert_lightgbm(
        model,
        initial_types=[("input", FloatTensorType([None, n_features]))],
        zipmap=False,
        target_opset=15,
    )
    path.write_bytes(onx.SerializeToString())


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", required=True, type=Path)
    ap.add_argument("--out", required=True, type=Path)
    ap.add_argument("--num-leaves", type=int, default=31)
    ap.add_argument("--learning-rate", type=float, default=0.05)
    ap.add_argument("--max-rounds", type=int, default=2000)
    ap.add_argument("--early-stop-chunks", type=int, default=4)
    args = ap.parse_args()

    meta = json.loads((args.data / "meta.json").read_text())
    features: list[str] = meta["features"]
    # Reference columns: what is served without LightGBM (baseline + live nowcast), per row.
    ref_cols: list[str] = meta.get("reference", {}).get("columns", [])
    X, y, _ = load(args.data / "train.csv", features, [])
    Xv, yv, ref_v = load(args.data / "valid.csv", features, ref_cols)
    print(f"train {X.shape}, valid {Xv.shape}")

    # Chunks are written in time order. Early-stop on the newest *whole* training chunks: a row
    # split inside a chunk would share its time period with training rows and reward
    # memorising period-specific effects. The validation chunk stays untouched for promotion.
    train_chunks = [c for c in meta["chunks"] if c["split"] == "train"]
    split = sum(c["rows"] for c in train_chunks[: -args.early_stop_chunks])
    if split == 0 or split >= len(y):
        raise SystemExit("need at least two training chunks")
    model = lgb.LGBMClassifier(
        objective="multiclass",
        num_class=NUM_BUCKETS,
        n_estimators=args.max_rounds,
        learning_rate=args.learning_rate,
        num_leaves=args.num_leaves,
        min_child_samples=1000,
        subsample=0.8,
        subsample_freq=1,
        colsample_bytree=0.8,
        reg_lambda=5.0,
        verbose=-1,
    )
    t0 = time.time()
    model.fit(
        X[:split],
        y[:split],
        eval_set=[(X[split:], y[split:])],
        callbacks=[lgb.early_stopping(50, verbose=False), lgb.log_evaluation(100)],
    )
    train_s = time.time() - t0

    probs = model.predict_proba(Xv)
    # Classes absent from training would shrink the output; guard against silent misalignment.
    if list(model.classes_) != list(range(NUM_BUCKETS)):
        raise SystemExit(f"expected classes 0..{NUM_BUCKETS - 1}, got {model.classes_}")
    base_cols = [features.index(f"base_p{k}") for k in range(NUM_BUCKETS)]
    base_probs = Xv[:, base_cols].astype(np.float64)
    base_probs /= base_probs.sum(axis=1, keepdims=True)

    args.out.mkdir(parents=True, exist_ok=True)
    export_onnx(model, len(features), args.out / "model.onnx")

    # Parity fixture: Node must reproduce these probabilities from the ONNX file.
    idx = np.arange(min(50, len(yv)))
    (args.out / "parity.json").write_text(
        json.dumps({"inputs": [[None if np.isnan(v) else float(v) for v in row] for row in Xv[idx]],
                    "probabilities": probs[idx].tolist()})
    )

    importance = sorted(zip(features, model.booster_.feature_importance("gain").tolist()), key=lambda t: -t[1])
    metrics = {
        "featureVersion": meta["featureVersion"],
        "features": features,
        "bestIteration": int(model.best_iteration_ or args.max_rounds),
        "trainSeconds": round(train_s, 1),
        "trainRows": int(len(y)),
        "chunks": meta["chunks"],
        "lgbm": evaluate(probs, yv),
        "baseline": evaluate(base_probs, yv),
        **({"reference": evaluate(ref_v / ref_v.sum(axis=1, keepdims=True), yv)} if ref_v is not None else {}),
        "featureImportance": [{"feature": f, "gain": round(g, 1)} for f, g in importance],
    }
    (args.out / "metrics.json").write_text(json.dumps(metrics, indent=2))
    print(json.dumps({k: metrics[k] for k in ("bestIteration", "trainSeconds")}))
    ref = metrics.get("reference", metrics["baseline"])
    print(f"valid RPS  lgbm={metrics['lgbm']['rps']:.5f}  baseline={metrics['baseline']['rps']:.5f}  reference={ref['rps']:.5f}")
    print(f"valid LL   lgbm={metrics['lgbm']['logLoss']:.4f}  baseline={metrics['baseline']['logLoss']:.4f}  reference={ref['logLoss']:.4f}")


if __name__ == "__main__":
    main()
