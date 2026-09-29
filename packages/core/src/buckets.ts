/**
 * Delay buckets are the prediction target: every stop event (arrival or departure)
 * falls into exactly one bucket, and models output a probability per bucket.
 */
export interface Bucket {
  id: number;
  label: string;
  /** inclusive minute range; `max: null` means open-ended */
  min: number;
  max: number | null;
}

export const BUCKETS: readonly Bucket[] = [
  { id: 0, label: '≤2', min: -Infinity, max: 2 },
  { id: 1, label: '3–5', min: 3, max: 5 },
  { id: 2, label: '6–10', min: 6, max: 10 },
  { id: 3, label: '11–15', min: 11, max: 15 },
  { id: 4, label: '16–30', min: 16, max: 30 },
  { id: 5, label: '31–60', min: 31, max: 60 },
  { id: 6, label: '>60', min: 61, max: null },
];

export const CANCELLED_BUCKET = 7;
export const NUM_BUCKETS = 8;
export const BUCKET_LABELS = [...BUCKETS.map((b) => b.label), 'cancelled'];

/** Upper bound used when spreading the open-ended ">60" bucket over minutes. */
export const MAX_MODELLED_DELAY = 120;

export function bucketOf(delayMin: number | null, cancelled: boolean): number | null {
  if (cancelled) return CANCELLED_BUCKET;
  if (delayMin === null || Number.isNaN(delayMin)) return null;
  for (const b of BUCKETS) {
    if (delayMin <= (b.max ?? Infinity)) return b.id;
  }
  return BUCKETS.length - 1;
}

export type Distribution = number[]; // length NUM_BUCKETS, sums to 1

export function normalize(weights: number[]): Distribution {
  const sum = weights.reduce((a, b) => a + b, 0);
  if (sum <= 0) return weights.map(() => 1 / weights.length);
  return weights.map((w) => w / sum);
}

/** P(delay ≥ threshold) for the thresholds users care about (cancellation counted separately). */
export function cumulative(dist: Distribution): { atLeast: Record<string, number>; cancelled: number } {
  const atLeast: Record<string, number> = {};
  for (let i = 1; i < BUCKETS.length; i++) {
    const b = BUCKETS[i]!;
    let p = 0;
    for (let j = i; j < BUCKETS.length; j++) p += dist[j]!;
    atLeast[`${b.min}min`] = p;
  }
  return { atLeast, cancelled: dist[CANCELLED_BUCKET]! };
}

/**
 * Spread a bucket distribution uniformly over whole minutes 0..MAX_MODELLED_DELAY.
 * Returns the per-minute pmf (non-cancelled mass only) and the cancellation mass.
 * Early arrivals are folded into minute 0.
 */
export function toMinutePmf(dist: Distribution): { pmf: number[]; cancelled: number } {
  const pmf = new Array<number>(MAX_MODELLED_DELAY + 1).fill(0);
  for (const b of BUCKETS) {
    const lo = Math.max(0, b.min);
    const hi = b.max ?? MAX_MODELLED_DELAY;
    const width = hi - lo + 1;
    for (let m = lo; m <= hi; m++) pmf[m]! += dist[b.id]! / width;
  }
  return { pmf, cancelled: dist[CANCELLED_BUCKET]! };
}

/**
 * Probability that a connection fails: the arriving train is cancelled, the departing
 * train is cancelled, or arrivalDelay - departureDelay exceeds the slack
 * (planned transfer time minus minimum transfer time). Legs are assumed independent.
 */
export function connectionFailureProbability(
  arrival: Distribution,
  departure: Distribution,
  slackMin: number,
): { total: number; byDelay: number; byCancellation: number } {
  const a = toMinutePmf(arrival);
  const d = toMinutePmf(departure);
  let miss = 0;
  for (let i = 0; i < a.pmf.length; i++) {
    const pa = a.pmf[i]!;
    if (pa === 0) continue;
    for (let j = 0; j < d.pmf.length; j++) {
      if (i - j > slackMin) miss += pa * d.pmf[j]!;
    }
  }
  const byCancellation = 1 - (1 - a.cancelled) * (1 - d.cancelled);
  return { total: byCancellation + miss, byDelay: miss, byCancellation };
}

/**
 * Point summaries of the delay, conditional on the stop not being cancelled: mean and the
 * 10th/50th/80th/90th percentiles in whole minutes (from the uniform-within-bucket minute pmf).
 * `p80` is the "80% chance it's at most this late" limit the app shows; a two-sided p10–p90
 * range doesn't work for delays because most trains are on time, which pins p10 at 0.
 */
export function delaySummary(dist: Distribution): {
  expected: number;
  median: number;
  p10: number;
  p80: number;
  p90: number;
} {
  const { pmf, cancelled } = toMinutePmf(dist);
  const mass = 1 - cancelled;
  if (mass <= 0) return { expected: 0, median: 0, p10: 0, p80: 0, p90: 0 };
  let expected = 0;
  for (let m = 0; m < pmf.length; m++) expected += (m * pmf[m]!) / mass;
  const quantile = (q: number) => {
    let acc = 0;
    for (let m = 0; m < pmf.length; m++) {
      acc += pmf[m]! / mass;
      if (acc >= q - 1e-9) return m;
    }
    return pmf.length - 1;
  };
  return {
    expected: Math.round(expected * 10) / 10,
    median: quantile(0.5),
    p10: quantile(0.1),
    p80: quantile(0.8),
    p90: quantile(0.9),
  };
}
