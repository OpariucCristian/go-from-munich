"""
Trains the LightGBM delay model and exports it to ONNX.

Pure compute: reads train.csv / valid.csv / meta.json written by the Node exporter
(`worker export-training`), writes <out>/model.onnx, metrics.json and parity.json.
Features are opaque here; their meaning lives in packages/model/src/features.ts.

Default objective "rps": boosting starts from the reference distribution (init_score =
log ref_p, the baseline + nowcast that is served without LightGBM) and minimises the ranked
probability score directly, early-stopping on RPS. The trees only learn a correction, so round 0
is exactly the reference. Serving adds the ONNX output (raw tree scores) to the same log reference:
softmax(log ref + trees), recorded as metrics.stacking = "logit-offset".
"--objective multiclass --rows all" trains the older standalone softmax model.

Defaults are the best configuration found so far (2026-09-29 sweep, ml/sweep.py): the trees only
correct stops with a live sighting (--rows sighted), weather is left out (it learned
period-specific shifts that did not carry over), and conservative tree settings.

    python train.py --data ../data/training --out ../models/lgbm-20260928
"""
import argparse
import json
import time
from pathlib import Path

import lightgbm as lgb
import numpy as np
import pandas as pd

from rps_objective import lgb_objective, lgb_rps_metric, softmax

NUM_BUCKETS = 8
# Floor for reference probabilities before taking logs; serving applies the same (onnx.ts).
REF_FLOOR = 1e-6
WEATHER_FEATURES = ["wx_temp_c", "wx_precip_3h", "wx_snow_3h", "wx_gust_kmh",
                    "wx_region_temp_min", "wx_region_precip_3h_max", "wx_region_snow_3h_max", "wx_region_gust_max"]


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


def export_onnx(model, n_features: int, path: Path) -> None:
    from onnxmltools import convert_lightgbm
    from onnxmltools.convert.common.data_types import FloatTensorType

    onx = convert_lightgbm(
        model,
        initial_types=[("input", FloatTensorType([None, n_features]))],
        zipmap=False,
        target_opset=15,
    )
    path.write_bytes(onx.SerializeToString())


def blank_features(X: np.ndarray, features: list[str], names: list[str]) -> None:
    """Constant (NaN) training columns never get a split, so the model ignores them; the ONNX input stays the same."""
    unknown = [n for n in names if n not in features]
    if unknown:
        raise SystemExit(f"unknown features {unknown}")
    for n in names:
        X[:, features.index(n)] = np.nan


def log_ref(ref: np.ndarray) -> np.ndarray:
    ref = np.maximum(ref, REF_FLOOR)
    return np.log(ref / ref.sum(axis=1, keepdims=True))


def log_ref_probs(ref: np.ndarray) -> np.ndarray:
    """The reference as served when the trees are not applied (floored and renormalised)."""
    return softmax(log_ref(ref))


def train_rps(args, X, y, ref_t, Xv, ref_v, split):
    """Returns the booster, final validation probabilities, the raw tree scores (the ONNX output) and seconds."""
    params = {
        "objective": lgb_objective,
        "num_class": NUM_BUCKETS,
        "metric": "None",
        "learning_rate": args.learning_rate,
        "num_leaves": args.num_leaves,
        "min_child_samples": args.min_child_samples,
        "bagging_fraction": 0.8,
        "bagging_freq": 1,
        "feature_fraction": 0.8,
        "lambda_l2": args.reg_lambda,
        "verbose": -1,
    }
    offset = log_ref(ref_t)
    train_set = lgb.Dataset(X[:split], y[:split], init_score=offset[:split])
    stop_set = lgb.Dataset(X[split:], y[split:], init_score=offset[split:], reference=train_set)
    print(f"early-stop rows: reference RPS {rps(softmax(offset[split:]), y[split:]):.5f}")
    t0 = time.time()
    booster = lgb.train(
        params,
        train_set,
        num_boost_round=args.max_rounds,
        valid_sets=[stop_set],
        valid_names=["early_stop"],
        feval=lgb_rps_metric,
        callbacks=[lgb.early_stopping(100, verbose=False), lgb.log_evaluation(50)],
    )
    train_s = time.time() - t0
    # predict() leaves out init_score: add the reference back.
    trees_v = booster.predict(Xv, raw_score=True, num_iteration=booster.best_iteration)
    return booster, softmax(log_ref(ref_v) + trees_v), trees_v, train_s


def as_multiclass(booster: lgb.Booster) -> lgb.Booster:
    """Same trees, labelled multiclass so the ONNX converter accepts them; it emits raw scores (checked after export)."""
    out = lgb.Booster(model_str=booster.model_to_string(num_iteration=booster.best_iteration))
    # A custom objective leaves no objective in the model; the converter falls back to params.
    out.params.update(objective="multiclass", num_class=NUM_BUCKETS)
    return out


def train_multiclass(args, X, y, Xv, split):
    model = lgb.LGBMClassifier(
        objective="multiclass",
        num_class=NUM_BUCKETS,
        n_estimators=args.max_rounds,
        learning_rate=args.learning_rate,
        num_leaves=args.num_leaves,
        min_child_samples=args.min_child_samples,
        subsample=0.8,
        subsample_freq=1,
        colsample_bytree=0.8,
        reg_lambda=args.reg_lambda,
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
    return model, probs, train_s


def check_onnx(path: Path, X: np.ndarray, expected: np.ndarray) -> None:
    """The exported model must reproduce what serving assumes (raw scores for rps, probabilities otherwise)."""
    import onnxruntime as rt

    session = rt.InferenceSession(str(path))
    out = session.run([session.get_outputs()[1].name], {"input": X})[0]
    # ONNX stores split thresholds as float32; a feature value between the double threshold and
    # its float32 rounding takes the other branch of one tree. Either branch is valid for a value
    # on the boundary, so allow rare flips (bounded by a few leaf values), not a real divergence.
    rows = np.abs(out - expected).max(axis=1)
    exact = float((rows < 1e-5).mean())
    print(f"onnx check: {exact:.3f} of rows exact, max diff {rows.max():.2e}")
    if exact < 0.98 or rows.max() > 0.5:
        raise SystemExit(f"ONNX output differs from the trained model ({exact:.3f} exact, max {rows.max()})")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", required=True, type=Path)
    ap.add_argument("--out", required=True, type=Path)
    ap.add_argument("--objective", choices=["rps", "multiclass"], default="rps")
    ap.add_argument("--num-leaves", type=int, default=15)
    ap.add_argument("--learning-rate", type=float, default=0.02)
    ap.add_argument("--max-rounds", type=int, default=3000)
    ap.add_argument("--min-child-samples", type=int, default=5000)
    ap.add_argument("--reg-lambda", type=float, default=50.0)
    ap.add_argument("--early-stop-chunks", type=int, default=4)
    ap.add_argument("--drop-features", default=",".join(WEATHER_FEATURES),
                    help='comma-separated features the trees may not use ("" for none)')
    ap.add_argument("--rows", choices=["all", "sighted"], default="sighted",
                    help="sighted: train on, and correct, only rows with a live sighting; others keep the reference")
    args = ap.parse_args()

    meta = json.loads((args.data / "meta.json").read_text())
    features: list[str] = meta["features"]
    # Reference columns: what is served without LightGBM (baseline + live nowcast), per row.
    ref_cols: list[str] = meta.get("reference", {}).get("columns", [])
    X, y, ref_t = load(args.data / "train.csv", features, ref_cols if args.objective == "rps" else [])
    Xv, yv, ref_v = load(args.data / "valid.csv", features, ref_cols)
    # Rows with a live sighting (seen_gap_min set) versus those predicted far ahead.
    gap_col = features.index("seen_gap_min") if "seen_gap_min" in features else None
    sighted_t = ~np.isnan(X[:, gap_col]) if gap_col is not None else np.zeros(len(y), bool)
    sighted = ~np.isnan(Xv[:, gap_col]) if gap_col is not None else np.zeros(len(yv), bool)
    dropped = [f for f in args.drop_features.split(",") if f and (f in features or f not in WEATHER_FEATURES)]
    blank_features(X, features, dropped)
    print(f"train {X.shape}, valid {Xv.shape}, objective {args.objective}")

    # Chunks are written in time order. Early-stop on the newest *whole* training chunks: a row
    # split inside a chunk would share its time period with training rows and reward
    # memorising period-specific effects. The validation chunk stays untouched for promotion.
    train_chunks = [c for c in meta["chunks"] if c["split"] == "train"]
    split = sum(c["rows"] for c in train_chunks[: -args.early_stop_chunks])
    if split == 0 or split >= len(y):
        raise SystemExit("need at least two training chunks")
    if args.rows == "sighted":
        if args.objective != "rps" or gap_col is None:
            raise SystemExit("--rows sighted needs --objective rps and sighting features")
        split = int(sighted_t[:split].sum())
        X, y, ref_t = X[sighted_t], y[sighted_t], ref_t[sighted_t]
        print(f"sighted rows only: train {X.shape}")

    if args.objective == "rps":
        if ref_t is None or ref_v is None:
            raise SystemExit("objective rps needs ref_p* columns in the export")
        booster, probs, onnx_out, train_s = train_rps(args, X, y, ref_t, Xv, ref_v, split)
        if args.rows == "sighted":
            # Serving leaves stops without a sighting at the reference.
            probs[~sighted] = log_ref_probs(ref_v[~sighted])
        onnx_model = as_multiclass(booster)
        best_iteration = booster.best_iteration
        gains = booster.feature_importance("gain", iteration=booster.best_iteration).tolist()
    else:
        model, probs, train_s = train_multiclass(args, X, y, Xv, split)
        onnx_model, onnx_out = model, probs
        best_iteration = model.best_iteration_
        gains = model.booster_.feature_importance("gain").tolist()

    base_cols = [features.index(f"base_p{k}") for k in range(NUM_BUCKETS)]
    base_probs = Xv[:, base_cols].astype(np.float64)
    base_probs /= base_probs.sum(axis=1, keepdims=True)
    reference = ref_v / ref_v.sum(axis=1, keepdims=True) if ref_v is not None else None

    args.out.mkdir(parents=True, exist_ok=True)
    export_onnx(onnx_model, len(features), args.out / "model.onnx")
    check_onnx(args.out / "model.onnx", Xv[:500], onnx_out[:500])

    # Parity fixture: Node must reproduce the ONNX output from these inputs (for "rps" that is
    # the raw tree scores, before the reference is added).
    idx = np.arange(min(50, len(yv)))
    (args.out / "parity.json").write_text(
        json.dumps({"inputs": [[None if np.isnan(v) else float(v) for v in row] for row in Xv[idx]],
                    "probabilities": onnx_out[idx].tolist()})
    )

    slices = {}
    if gap_col is not None:
        for name, mask in (("sighted", sighted), ("unsighted", ~sighted)):
            if mask.any():
                slices[name] = {
                    "n": int(mask.sum()),
                    "lgbm": rps(probs[mask], yv[mask]),
                    **({"reference": rps(reference[mask], yv[mask])} if reference is not None else {}),
                }

    importance = sorted(zip(features, gains), key=lambda t: -t[1])
    metrics = {
        "featureVersion": meta["featureVersion"],
        "features": features,
        "objective": args.objective,
        "droppedFeatures": dropped,
        "appliesTo": args.rows,
        **({"stacking": "logit-offset", "refFloor": REF_FLOOR} if args.objective == "rps" else {}),
        "bestIteration": int(best_iteration or args.max_rounds),
        "trainSeconds": round(train_s, 1),
        "trainRows": int(len(y)),
        "chunks": meta["chunks"],
        "lgbm": evaluate(probs, yv),
        "baseline": evaluate(base_probs, yv),
        **({"reference": evaluate(reference, yv)} if reference is not None else {}),
        "slices": slices,
        "featureImportance": [{"feature": f, "gain": round(g, 1)} for f, g in importance],
    }
    (args.out / "metrics.json").write_text(json.dumps(metrics, indent=2))
    print(json.dumps({k: metrics[k] for k in ("bestIteration", "trainSeconds")}))
    ref = metrics.get("reference", metrics["baseline"])
    print(f"valid RPS  lgbm={metrics['lgbm']['rps']:.5f}  baseline={metrics['baseline']['rps']:.5f}  reference={ref['rps']:.5f}")
    for name, sl in slices.items():
        print(f"  {name:9s} n={sl['n']}  lgbm={sl['lgbm']:.5f}  reference={sl.get('reference', float('nan')):.5f}")
    print(f"valid LL   lgbm={metrics['lgbm']['logLoss']:.4f}  baseline={metrics['baseline']['logLoss']:.4f}  reference={ref['logLoss']:.4f}")


if __name__ == "__main__":
    main()
