/**
 * Honest backtest: statistics are built only from events planned before `cutoff`, then
 * predictions are scored on events in [cutoff, cutoff + days).
 */
import { NUM_BUCKETS, bucketOf, normalize, type Distribution } from '@gfm/core';
import { withTransaction } from '@gfm/db';
import { blend, loadStats, DEFAULT_ALPHA } from './baseline.ts';
import type { StopQuery } from './groups.ts';
import { logLoss, rps, summarize, type EvalSummary } from './metrics.ts';
import {
  DEFAULT_NOWCAST,
  GAP_BAND_LABELS,
  MAX_GAP_MIN,
  MIN_GAP_MIN,
  applyNowcast,
  buildNowcastStats,
  gapBand,
  loadNowcastStats,
  sightingsForRuns,
  type NowcastOptions,
} from './nowcast.ts';
import { aggregateInto, buildLabelledEvents } from './stats.ts';

export interface BacktestOptions {
  cutoff: Date;
  days?: number;
  sample?: number;
  alpha?: number;
  halfLifeDays?: number;
  tz?: string;
  /** Restrict scoring to these EVAs (e.g. the city's hubs). */
  evas?: string[];
}

export interface BacktestResult {
  cutoff: string;
  days: number;
  baseline: EvalSummary;
  /** Reference: one global distribution for everything. */
  climatology: EvalSummary;
}

export async function backtestBaseline(opts: BacktestOptions): Promise<BacktestResult> {
  const days = opts.days ?? 28;
  const sample = opts.sample ?? 50_000;
  const alpha = opts.alpha ?? DEFAULT_ALPHA;
  return withTransaction(async (c) => {
    await buildLabelledEvents(c, { asOf: opts.cutoff, halfLifeDays: opts.halfLifeDays, tz: opts.tz });
    await c.query('CREATE TEMP TABLE agg_eval (LIKE agg_delay_stats INCLUDING ALL) ON COMMIT DROP');
    await aggregateInto(c, 'agg_eval');
    await c.query('DROP TABLE labelled_events');

    // Validation events: labelled the same way, planned inside the evaluation window.
    const end = new Date(opts.cutoff.getTime() + days * 86400_000);
    await buildLabelledEvents(c, { asOf: end, windowDays: days, tz: opts.tz });
    const { rows } = await c.query<{
      eva: string; train_type: string; train_number: string; event: 'a' | 'd'; pt: Date; bucket: number;
    }>(
      `SELECT eva, train_type, train_number, event, pt, bucket FROM labelled_events
       WHERE pt >= $1 AND ($3::text[] IS NULL OR eva = ANY($3))
       ORDER BY md5(eva || train_number || pt::text || event) LIMIT $2`,
      [opts.cutoff, sample, opts.evas ?? null],
    );

    const queries: StopQuery[] = rows.map((r) => ({
      eva: r.eva, trainType: r.train_type, trainNumber: r.train_number, event: r.event, planned: r.pt,
    }));
    const observed = rows.map((r) => r.bucket);
    const preds: Distribution[] = [];
    for (let i = 0; i < queries.length; i += 2000) {
      const batch = queries.slice(i, i + 2000);
      const stats = await loadStats(batch, opts.tz, c, 'agg_eval');
      for (const q of batch) preds.push(blend(q, stats, alpha, opts.tz).distribution);
    }
    const global = await c.query<{ event: string; weights: number[] }>(
      'SELECT event, weights FROM agg_eval WHERE level = 6',
    );
    const globalBy = new Map(global.rows.map((r) => [r.event, normalize(r.weights)]));
    const uniform = new Array<number>(NUM_BUCKETS).fill(1 / NUM_BUCKETS);
    const climoPreds = queries.map((q) => globalBy.get(q.event) ?? uniform);

    return {
      cutoff: opts.cutoff.toISOString(),
      days,
      baseline: summarize(preds, observed),
      climatology: summarize(climoPreds, observed),
    };
  });
}

export interface NowcastBacktestOptions {
  cutoff: Date;
  days?: number;
  sample?: number;
  tz?: string;
  evas?: string[];
  variants?: NowcastOptions[];
}

export interface NowcastBacktestRow {
  band: string;
  n: number;
  baseline: number;
  variants: { mode: string; alpha: number; rps: number; logLoss: number }[];
  baselineLogLoss: number;
}

/**
 * Honest nowcast backtest. Baseline and nowcast tables are built from data before `cutoff`;
 * each test stop gets a random "now" 5–240 min before it and the sighting available at that
 * moment (the same lookup serving uses). Scores are split by the sighting's gap band.
 */
export async function backtestNowcast(opts: NowcastBacktestOptions) {
  const days = opts.days ?? 28;
  const sample = opts.sample ?? 60_000;
  const variants = opts.variants ?? [
    { mode: 'ratio' as const, alpha: 8 },
    { mode: 'ratio' as const, alpha: 32 },
    { mode: 'dirichlet' as const, alpha: 8 },
    { mode: 'dirichlet' as const, alpha: 32 },
  ];
  return withTransaction(async (c) => {
    await buildLabelledEvents(c, { asOf: opts.cutoff, tz: opts.tz });
    await c.query('CREATE TEMP TABLE agg_eval (LIKE agg_delay_stats INCLUDING ALL) ON COMMIT DROP');
    await aggregateInto(c, 'agg_eval');
    await c.query('DROP TABLE labelled_events');
    await c.query('CREATE TEMP TABLE agg_nowcast_eval (LIKE agg_nowcast_stats INCLUDING ALL) ON COMMIT DROP');
    await buildNowcastStats(c, 'agg_nowcast_eval', { asOf: opts.cutoff });

    const end = new Date(opts.cutoff.getTime() + days * 86400_000);
    const { rows } = await c.query<{
      trip_id: string; service_date: string; eva: string; train_type: string; train_number: string;
      event: 'a' | 'd'; pt: Date; delay: number | null; cancelled: boolean;
    }>(
      `SELECT e.trip_id::text, e.service_date::text, e.eva, t.train_type, t.train_number, x.event, x.pt, x.delay, x.cancelled
       FROM stop_events e
       JOIN trips t ON t.id = e.trip_id
       CROSS JOIN LATERAL (VALUES ('a'::char(1), e.planned_arr, e.arr_delay_min, e.arr_cancelled),
                                  ('d'::char(1), e.planned_dep, e.dep_delay_min, e.dep_cancelled)) AS x(event, pt, delay, cancelled)
       WHERE e.service_date BETWEEN $1::timestamptz::date - 1 AND $2::timestamptz::date
         AND x.pt >= $1 AND x.pt < $2 AND (x.cancelled OR x.delay IS NOT NULL)
         AND ($4::text[] IS NULL OR e.eva = ANY($4))
       ORDER BY md5(e.trip_id::text || e.eva || x.event) LIMIT $3`,
      [opts.cutoff, end, sample, opts.evas ?? null],
    );

    // Deterministic "now" per row, uniform over the nowcast horizon.
    let seed = 0x9e3779b9;
    const rand = () => {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const runs = rows.map((r) => ({
      tripId: r.trip_id,
      serviceDate: r.service_date,
      planned: r.pt,
      cutoff: new Date(r.pt.getTime() - (MIN_GAP_MIN + rand() * (MAX_GAP_MIN - MIN_GAP_MIN)) * 60_000),
    }));

    const bands = new Map<string, { n: number; base: number; baseLl: number; v: { rps: number; ll: number }[] }>();
    const add = (band: string, base: Distribution, outs: Distribution[], y: number) => {
      const b = bands.get(band) ?? { n: 0, base: 0, baseLl: 0, v: variants.map(() => ({ rps: 0, ll: 0 })) };
      bands.set(band, b);
      b.n++;
      b.base += rps(base, y);
      b.baseLl += logLoss(base, y);
      outs.forEach((o, k) => {
        b.v[k]!.rps += rps(o, y);
        b.v[k]!.ll += logLoss(o, y);
      });
    };
    for (let i = 0; i < rows.length; i += 2000) {
      const batch = rows.slice(i, i + 2000);
      const queries: StopQuery[] = batch.map((r) => ({
        eva: r.eva, trainType: r.train_type, trainNumber: r.train_number, event: r.event, planned: r.pt,
      }));
      const [stats, sightings] = await Promise.all([
        loadStats(queries, opts.tz, c, 'agg_eval'),
        sightingsForRuns(runs.slice(i, i + 2000), c),
      ]);
      const items = queries.flatMap((q, k) => (sightings[k] ? [{ q, sighting: sightings[k]! }] : []));
      const nc = await loadNowcastStats(items, c, 'agg_nowcast_eval');
      batch.forEach((r, k) => {
        const y = bucketOf(r.delay, r.cancelled)!;
        const q = queries[k]!;
        const base = blend(q, stats, DEFAULT_ALPHA, opts.tz).distribution;
        const s = sightings[k];
        const band = s ? GAP_BAND_LABELS[gapBand(s.gapMin)!]! : 'not seen yet';
        const outs = variants.map((v) => (s ? applyNowcast(base, q, s, nc, v) : base));
        add(band, base, outs, y);
        add('all', base, outs, y);
      });
    }
    const order = ['all', ...GAP_BAND_LABELS, 'not seen yet'];
    const result: NowcastBacktestRow[] = order.flatMap((band) => {
      const b = bands.get(band);
      if (!b) return [];
      return [{
        band,
        n: b.n,
        baseline: b.base / b.n,
        baselineLogLoss: b.baseLl / b.n,
        variants: variants.map((v, k) => ({
          mode: v.mode ?? 'ratio',
          alpha: v.alpha ?? DEFAULT_NOWCAST.alpha,
          rps: b.v[k]!.rps / b.n,
          logLoss: b.v[k]!.ll / b.n,
        })),
      }];
    });
    return { cutoff: opts.cutoff.toISOString(), days, bands: result };
  });
}
