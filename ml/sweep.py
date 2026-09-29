"""
Tries a few RPS-objective configurations on one export, loading the data once.

Configurations are ranked on the early-stopping chunks (the newest training weeks), not on the
validation weeks, which stay reserved for the promotion check. Validation RPS is printed for
information only.

    docker run --rm -v "$PWD:/app" -w /app/ml --entrypoint python gfm-trainer sweep.py --data ../data/training/muc
"""
import argparse
import json
from pathlib import Path
from types import SimpleNamespace

import numpy as np

from train import blank_features, load, rps, train_rps

WEATHER = ["wx_temp_c", "wx_precip_3h", "wx_snow_3h", "wx_gust_kmh",
           "wx_region_temp_min", "wx_region_precip_3h_max", "wx_region_snow_3h_max", "wx_region_gust_max"]
TEMPERATURE = ["wx_temp_c", "wx_region_temp_min"]
CALENDAR = ["hour", "weekday", "is_holiday", "is_bridge_day"]

CONFIGS = {
    "default": dict(learning_rate=0.05, num_leaves=31, min_child_samples=1000, reg_lambda=5.0, drop=[]),
    "conservative": dict(learning_rate=0.02, num_leaves=15, min_child_samples=5000, reg_lambda=50.0, drop=[]),
    "no-temperature": dict(learning_rate=0.02, num_leaves=15, min_child_samples=5000, reg_lambda=50.0, drop=TEMPERATURE),
    "no-weather": dict(learning_rate=0.02, num_leaves=15, min_child_samples=5000, reg_lambda=50.0, drop=WEATHER),
    "no-weather-calendar": dict(learning_rate=0.02, num_leaves=15, min_child_samples=5000, reg_lambda=50.0, drop=WEATHER + CALENDAR),
}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", required=True, type=Path)
    ap.add_argument("--only", default="", help="comma-separated config names")
    ap.add_argument("--early-stop-chunks", type=int, default=4)
    args = ap.parse_args()

    meta = json.loads((args.data / "meta.json").read_text())
    features, ref_cols = meta["features"], meta["reference"]["columns"]
    X, y, ref_t = load(args.data / "train.csv", features, ref_cols)
    Xv, yv, ref_v = load(args.data / "valid.csv", features, ref_cols)
    train_chunks = [c for c in meta["chunks"] if c["split"] == "train"]
    split = sum(c["rows"] for c in train_chunks[: -args.early_stop_chunks])
    sighted = ~np.isnan(Xv[:, features.index("seen_gap_min")])
    reference = ref_v / ref_v.sum(axis=1, keepdims=True)
    print(f"valid reference RPS {rps(reference, yv):.5f} (sighted {rps(reference[sighted], yv[sighted]):.5f}, "
          f"unsighted {rps(reference[~sighted], yv[~sighted]):.5f})", flush=True)

    names = [n for n in args.only.split(",") if n] or list(CONFIGS)
    results = []
    for name in names:
        c = CONFIGS[name]
        Xc = X.copy()
        blank_features(Xc, features, c["drop"])
        opts = SimpleNamespace(learning_rate=c["learning_rate"], num_leaves=c["num_leaves"], max_rounds=3000,
                               min_child_samples=c["min_child_samples"], reg_lambda=c["reg_lambda"])
        booster, probs, _, secs = train_rps(opts, Xc, y, ref_t, Xv, ref_v, split)
        r = {
            "config": name,
            "rounds": booster.best_iteration,
            "earlyStopRps": booster.best_score["early_stop"]["rps"],
            "validRps": rps(probs, yv),
            "sighted": rps(probs[sighted], yv[sighted]),
            "unsighted": rps(probs[~sighted], yv[~sighted]),
            "seconds": round(secs),
        }
        results.append(r)
        print(json.dumps(r), flush=True)
    best = min(results, key=lambda r: r["earlyStopRps"])
    print(f"best on early-stop chunks: {best['config']}")


if __name__ == "__main__":
    main()
