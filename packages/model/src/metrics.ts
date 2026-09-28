import { NUM_BUCKETS, type Distribution } from '@gfm/core';

/**
 * Ranked probability score over the ordered buckets (cancelled treated as the worst outcome).
 * 0 = perfect; lower is better. Penalises predicting "11–15" when "≤2" happened more than
 * predicting "3–5", unlike log loss.
 */
export function rps(dist: Distribution, observed: number): number {
  let cumP = 0;
  let sum = 0;
  for (let k = 0; k < NUM_BUCKETS - 1; k++) {
    cumP += dist[k]!;
    const cumO = observed <= k ? 1 : 0;
    sum += (cumP - cumO) ** 2;
  }
  return sum / (NUM_BUCKETS - 1);
}

export function logLoss(dist: Distribution, observed: number): number {
  return -Math.log(Math.max(1e-6, dist[observed]!));
}

export interface EvalSummary {
  n: number;
  rps: number;
  logLoss: number;
  /** Brier score for the binary question "delayed ≥ 6 min or cancelled?" */
  brier6: number;
  /** Mean predicted probability vs observed frequency per bucket. */
  calibration: { bucket: number; predicted: number; observed: number }[];
}

export function summarize(preds: Distribution[], observed: number[]): EvalSummary {
  const n = preds.length;
  let r = 0;
  let l = 0;
  let b = 0;
  const predSum = new Array<number>(NUM_BUCKETS).fill(0);
  const obsCount = new Array<number>(NUM_BUCKETS).fill(0);
  for (let i = 0; i < n; i++) {
    const p = preds[i]!;
    const y = observed[i]!;
    r += rps(p, y);
    l += logLoss(p, y);
    const p6 = p.slice(2).reduce((a, c) => a + c, 0);
    b += (p6 - (y >= 2 ? 1 : 0)) ** 2;
    for (let k = 0; k < NUM_BUCKETS; k++) predSum[k]! += p[k]!;
    obsCount[y]!++;
  }
  return {
    n,
    rps: r / n,
    logLoss: l / n,
    brier6: b / n,
    calibration: predSum.map((s, k) => ({ bucket: k, predicted: s / n, observed: obsCount[k]! / n })),
  };
}
