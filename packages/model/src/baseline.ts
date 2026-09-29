/**
 * Baseline model: hierarchical Dirichlet smoothing over empirical bucket counts.
 *
 * Starting from the global distribution, each more specific level is blended with its parent:
 *     p_level = (w_level + α · p_parent) / (Σw_level + α)
 * so a group with few observations stays close to its parent, and one with many dominates.
 */
import { NUM_BUCKETS, normalize, type Distribution } from '@gfm/core';
import { getPool } from '@gfm/db';
import type pg from 'pg';
import { groupKeys, type Level, type StopQuery } from './groups.ts';
import type { Sighting } from './nowcast.ts';

export interface StatRow {
  level: number;
  key: string;
  event: string;
  weights: number[];
  n: number;
}

export interface StopPrediction {
  distribution: Distribution;
  /** Most specific level with any data, and how many raw observations it had. */
  supportLevel: Level;
  supportN: number;
  /** Set when a live sighting of the train changed the distribution (see nowcast.ts). */
  sighting?: Sighting;
}

export const DEFAULT_ALPHA = 8;

/** One Dirichlet smoothing step: a group's weights plus `alpha` pseudo-observations of its parent. */
export function dirichletStep(parent: Distribution, weights: number[], alpha: number): Distribution {
  return normalize(weights.map((w, i) => w + alpha * parent[i]!));
}

/** Pure blending step, separated from DB access so it can be unit tested. */
export function blend(
  q: StopQuery,
  stats: Map<string, StatRow>,
  alpha = DEFAULT_ALPHA,
  tz?: string,
): StopPrediction {
  const levels = groupKeys(q, tz).reverse(); // global first
  let p: Distribution = new Array(NUM_BUCKETS).fill(1 / NUM_BUCKETS);
  let supportLevel: Level = 6;
  let supportN = 0;
  for (const { level, key } of levels) {
    const row = stats.get(`${level}|${key}|${q.event}`);
    if (!row) continue;
    const sum = row.weights.reduce((a, b) => a + b, 0);
    p = dirichletStep(p, row.weights, alpha);
    if (sum > 0) {
      supportLevel = level;
      supportN = row.n;
    }
  }
  return { distribution: p, supportLevel, supportN };
}

export const statKey = (level: number, key: string, event: string) => `${level}|${key}|${event}`;

export async function loadStats(
  queries: StopQuery[],
  tz?: string,
  db: Pick<pg.Pool, 'query'> = getPool(),
  table = 'agg_delay_stats',
): Promise<Map<string, StatRow>> {
  const levels: number[] = [];
  const keys: string[] = [];
  const events: string[] = [];
  for (const q of queries) {
    for (const g of groupKeys(q, tz)) {
      levels.push(g.level);
      keys.push(g.key);
      events.push(q.event);
    }
  }
  const { rows } = await db.query<StatRow>(
    `SELECT s.level, s.key, s.event, s.weights, s.n
     FROM ${table} s
     JOIN unnest($1::smallint[], $2::text[], $3::char(1)[]) AS q(level, key, event)
       ON s.level = q.level AND s.key = q.key AND s.event = q.event`,
    [levels, keys, events],
  );
  return new Map(rows.map((r) => [statKey(r.level, r.key, r.event), r]));
}

export class BaselinePredictor {
  readonly kind = 'baseline';
  constructor(
    readonly version = 'baseline-v1',
    private readonly alpha = DEFAULT_ALPHA,
    private readonly tz = 'Europe/Berlin',
  ) {}

  async predict(queries: StopQuery[]): Promise<StopPrediction[]> {
    const stats = await loadStats(queries, this.tz);
    return queries.map((q) => blend(q, stats, this.alpha, this.tz));
  }
}
