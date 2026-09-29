/**
 * Accuracy of frozen predictions against what actually happened: per-day metrics, calibration
 * and breakdowns. Pure functions; the worker loads rows and stores the results.
 */
import { CANCELLED_BUCKET, MAX_MODELLED_DELAY, NUM_BUCKETS, delaySummary, type Distribution } from '@gfm/core';
import { logLoss, rps } from './metrics.ts';

export interface OutcomeRow {
  dist: Distribution;
  /** Observed bucket (0..7). */
  bucket: number;
  /** Observed delay in minutes; null when cancelled. */
  delay: number | null;
  trainType: string;
  stationGroup: 'hub' | 'corridor';
  event: 'a' | 'd';
  leadMin: number;
}

export interface AccuracyMetrics {
  n: number;
  /** Rows that ran (not cancelled): denominator of within80 and maeMin. */
  nRun: number;
  rps: number;
  logLoss: number;
  /** Brier score of P(more than 5 min late or cancelled). */
  brier6: number;
  /** RPS of the global (climatology) distribution on the same rows, for a skill score. */
  climatologyRps: number | null;
  /** Share of rows where the most likely bucket was the observed one. */
  topBucketHit: number;
  /** Share of runs that were at most as late as the predicted 80th percentile (target: 80%). */
  within80: number | null;
  /** Mean absolute difference between the predicted median and the actual delay (minutes). */
  maeMin: number | null;
  /** Mean predicted P(>5 min or cancelled) vs the observed share. */
  predLate5: number;
  obsLate5: number;
}

export interface CalibrationBin {
  /** Predicted P(>5 min or cancelled) range [lo, hi). */
  lo: number;
  hi: number;
  n: number;
  predicted: number;
  observed: number;
}

export type BreakdownDim = 'trainType' | 'station' | 'event' | 'lead';
export type Breakdown = Record<BreakdownDim, Record<string, AccuracyMetrics>>;

export interface DayAccuracy extends AccuracyMetrics {
  calibration: CalibrationBin[];
  breakdown: Breakdown;
}

export const CALIBRATION_BINS = 10;

export function lateProbability(dist: Distribution): number {
  let p = 0;
  for (let k = 2; k < NUM_BUCKETS; k++) p += dist[k]!;
  return p;
}

export function leadBand(leadMin: number): string {
  if (leadMin < 120) return '0–2h';
  if (leadMin < 360) return '2–6h';
  if (leadMin < 720) return '6–12h';
  return '12h+';
}

/** Scores one prediction; `within80`/`absErr` are null for cancelled stops. */
export function scoreOne(dist: Distribution, bucket: number, delay: number | null) {
  const cancelled = bucket === CANCELLED_BUCKET;
  let within80: boolean | null = null;
  let absErr: number | null = null;
  if (!cancelled) {
    const s = delaySummary(dist);
    const d = Math.min(MAX_MODELLED_DELAY, Math.max(0, delay ?? 0));
    within80 = d <= s.p80;
    absErr = Math.abs(s.median - d);
  }
  let top = 0;
  for (let k = 1; k < NUM_BUCKETS; k++) if (dist[k]! > dist[top]!) top = k;
  const pLate = lateProbability(dist);
  const late = bucket >= 2;
  return {
    rps: rps(dist, bucket),
    logLoss: logLoss(dist, bucket),
    brier6: (pLate - (late ? 1 : 0)) ** 2,
    topHit: top === bucket,
    within80,
    absErr,
    pLate,
    late,
  };
}

class Acc {
  n = 0;
  nRun = 0;
  rps = 0;
  logLoss = 0;
  brier = 0;
  clim = 0;
  climN = 0;
  top = 0;
  within80 = 0;
  absErr = 0;
  pLate = 0;
  late = 0;

  add(s: ReturnType<typeof scoreOne>, climRps: number | null) {
    this.n++;
    this.rps += s.rps;
    this.logLoss += s.logLoss;
    this.brier += s.brier6;
    if (climRps !== null) {
      this.clim += climRps;
      this.climN++;
    }
    if (s.topHit) this.top++;
    if (s.within80 !== null) {
      this.nRun++;
      if (s.within80) this.within80++;
      this.absErr += s.absErr!;
    }
    this.pLate += s.pLate;
    if (s.late) this.late++;
  }

  metrics(): AccuracyMetrics {
    const n = Math.max(1, this.n);
    return {
      n: this.n,
      nRun: this.nRun,
      rps: this.rps / n,
      logLoss: this.logLoss / n,
      brier6: this.brier / n,
      climatologyRps: this.climN ? this.clim / this.climN : null,
      topBucketHit: this.top / n,
      within80: this.nRun ? this.within80 / this.nRun : null,
      maeMin: this.nRun ? this.absErr / this.nRun : null,
      predLate5: this.pLate / n,
      obsLate5: this.late / n,
    };
  }
}

/**
 * Aggregates scored rows. `climatology` is the global distribution per event type (a reference
 * forecast that ignores train, station and time), used for the skill score.
 */
export function aggregateAccuracy(
  rows: OutcomeRow[],
  climatology?: Partial<Record<'a' | 'd', Distribution>>,
): DayAccuracy {
  const all = new Acc();
  const groups: Record<BreakdownDim, Map<string, Acc>> = {
    trainType: new Map(),
    station: new Map(),
    event: new Map(),
    lead: new Map(),
  };
  const bins = Array.from({ length: CALIBRATION_BINS }, () => ({ n: 0, p: 0, o: 0 }));
  const into = (dim: BreakdownDim, key: string) => {
    let a = groups[dim].get(key);
    if (!a) groups[dim].set(key, (a = new Acc()));
    return a;
  };

  for (const r of rows) {
    const s = scoreOne(r.dist, r.bucket, r.delay);
    const clim = climatology?.[r.event];
    const climRps = clim ? rps(clim, r.bucket) : null;
    all.add(s, climRps);
    into('trainType', r.trainType).add(s, climRps);
    into('station', r.stationGroup).add(s, climRps);
    into('event', r.event === 'a' ? 'arrival' : 'departure').add(s, climRps);
    into('lead', leadBand(r.leadMin)).add(s, climRps);
    const b = bins[Math.min(CALIBRATION_BINS - 1, Math.floor(s.pLate * CALIBRATION_BINS + 1e-9))]!;
    b.n++;
    b.p += s.pLate;
    if (s.late) b.o++;
  }

  const breakdown = Object.fromEntries(
    Object.entries(groups).map(([dim, m]) => [dim, Object.fromEntries([...m].map(([k, a]) => [k, a.metrics()]))]),
  ) as Breakdown;
  return {
    ...all.metrics(),
    calibration: bins.map((b, i) => ({
      lo: i / CALIBRATION_BINS,
      hi: (i + 1) / CALIBRATION_BINS,
      n: b.n,
      predicted: b.n ? b.p / b.n : 0,
      observed: b.n ? b.o / b.n : 0,
    })),
    breakdown,
  };
}

/** Combines per-day metrics into one, weighting each by its row count. */
export function mergeMetrics(parts: AccuracyMetrics[]): AccuracyMetrics {
  const wAvg = (get: (m: AccuracyMetrics) => number | null, weight: (m: AccuracyMetrics) => number) => {
    let s = 0;
    let w = 0;
    for (const m of parts) {
      const v = get(m);
      if (v === null) continue;
      s += v * weight(m);
      w += weight(m);
    }
    return w ? s / w : null;
  };
  const byN = (m: AccuracyMetrics) => m.n;
  const byRun = (m: AccuracyMetrics) => m.nRun;
  return {
    n: parts.reduce((a, m) => a + m.n, 0),
    nRun: parts.reduce((a, m) => a + m.nRun, 0),
    rps: wAvg((m) => m.rps, byN) ?? 0,
    logLoss: wAvg((m) => m.logLoss, byN) ?? 0,
    brier6: wAvg((m) => m.brier6, byN) ?? 0,
    climatologyRps: wAvg((m) => m.climatologyRps, byN),
    topBucketHit: wAvg((m) => m.topBucketHit, byN) ?? 0,
    within80: wAvg((m) => m.within80, byRun),
    maeMin: wAvg((m) => m.maeMin, byRun),
    predLate5: wAvg((m) => m.predLate5, byN) ?? 0,
    obsLate5: wAvg((m) => m.obsLate5, byN) ?? 0,
  };
}

/** Merges calibration bins of several days (bins must share the same edges). */
export function mergeCalibration(parts: CalibrationBin[][]): CalibrationBin[] {
  const out = Array.from({ length: CALIBRATION_BINS }, (_, i) => ({
    lo: i / CALIBRATION_BINS,
    hi: (i + 1) / CALIBRATION_BINS,
    n: 0,
    predicted: 0,
    observed: 0,
  }));
  for (const bins of parts) {
    bins.forEach((b, i) => {
      const o = out[i];
      if (!o || !b.n) return;
      o.predicted = (o.predicted * o.n + b.predicted * b.n) / (o.n + b.n);
      o.observed = (o.observed * o.n + b.observed * b.n) / (o.n + b.n);
      o.n += b.n;
    });
  }
  return out;
}

/** Merges the breakdowns of several days, key by key. */
export function mergeBreakdown(parts: Breakdown[]): Breakdown {
  const dims: BreakdownDim[] = ['trainType', 'station', 'event', 'lead'];
  const out = {} as Breakdown;
  for (const dim of dims) {
    const byKey = new Map<string, AccuracyMetrics[]>();
    for (const p of parts) {
      for (const [k, m] of Object.entries(p[dim] ?? {})) {
        if (!byKey.has(k)) byKey.set(k, []);
        byKey.get(k)!.push(m);
      }
    }
    out[dim] = Object.fromEntries([...byKey].map(([k, ms]) => [k, mergeMetrics(ms)]));
  }
  return out;
}

/** The UI shows risk as green below this chance of >5 min late (see the BFF's toneOf). */
export const GREEN_BELOW = 0.2;

/**
 * Of the predictions shown green (P(>5 min late or cancelled) < 20%), the share that really
 * were at most 5 minutes late. Null when nothing was green.
 */
export function greenCallShare(bins: CalibrationBin[]): number | null {
  let n = 0;
  let late = 0;
  for (const b of bins) {
    if (b.hi > GREEN_BELOW + 1e-9) continue;
    n += b.n;
    late += b.observed * b.n;
  }
  return n ? 1 - late / n : null;
}
