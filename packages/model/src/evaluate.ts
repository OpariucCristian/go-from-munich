/**
 * Honest backtest: statistics are built only from events planned before `cutoff`, then
 * predictions are scored on events in [cutoff, cutoff + days).
 */
import { NUM_BUCKETS, normalize, type Distribution } from '@gfm/core';
import { withTransaction } from '@gfm/db';
import { blend, loadStats, DEFAULT_ALPHA } from './baseline.ts';
import type { StopQuery } from './groups.ts';
import { summarize, type EvalSummary } from './metrics.ts';
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
