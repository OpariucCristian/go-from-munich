/**
 * Live-delay nowcast: once a train has been seen running late (or on time) at an earlier stop,
 * that delay says more about the next stops than any history of the train does.
 *
 * `agg_nowcast_stats` counts, from history, the delay bucket at a target stop given the delay
 * bucket seen at an earlier stop of the same run and the gap between their planned times:
 *
 *     level 1  eva|train_type|prev|gap      level 2  train_type|prev|gap      level 3  prev|gap
 *
 * `prev = '*'` rows hold the same counts summed over every earlier delay (the marginal).
 *
 * A "sighting" is the latest stop of the run, planned 5–240 min before the target and no later
 * than the cutoff (now, when serving), with a known delay. The same SQL finds sightings for live
 * serving and for historical rows with a chosen cutoff (backtests, and the training export for
 * LightGBM), so a model trained on historical sightings sees exactly what serving will give it.
 */
import { bucketOf, normalize, NUM_BUCKETS, type Distribution } from '@gfm/core';
import { getPool, withTransaction } from '@gfm/db';
import type pg from 'pg';
import { dirichletStep, type StopPrediction } from './baseline.ts';
import type { StopQuery } from './groups.ts';
import { bucketSql } from './stats.ts';

type Db = Pick<pg.Pool, 'query'>;

export const MIN_GAP_MIN = 5;
export const MAX_GAP_MIN = 240;
/** Exclusive upper bounds of the gap bands, in minutes. */
export const GAP_BANDS = [15, 30, 60, 120, MAX_GAP_MIN] as const;
export const GAP_BAND_LABELS = ['5–15', '15–30', '30–60', '60–120', '120–240'] as const;
export const DEFAULT_NOWCAST_WINDOW_DAYS = 180;

export function gapBand(gapMin: number): number | null {
  if (!(gapMin >= MIN_GAP_MIN) || gapMin > MAX_GAP_MIN) return null;
  const i = GAP_BANDS.findIndex((b) => gapMin < b);
  return i === -1 ? GAP_BANDS.length - 1 : i;
}

const gapBandSql = (gap: string) =>
  `CASE ${GAP_BANDS.slice(0, -1).map((b, i) => `WHEN ${gap} < ${b} THEN ${i}`).join(' ')} ELSE ${GAP_BANDS.length - 1} END`;

/** Where and how late the train was last seen before a target stop. */
export interface Sighting {
  eva: string;
  name: string | null;
  delayMin: number;
  /** Planned time of the sighted arrival/departure. */
  planned: Date;
  /** Minutes between the sighting's and the target's planned times. */
  gapMin: number;
}

export type NowcastMode = 'ratio' | 'dirichlet';

export interface NowcastOptions {
  /**
   * `dirichlet` (default) smooths the sighting-conditional tables with the model's distribution as
   * the prior. `ratio` keeps the model's view of this particular train and scales it by how much
   * the sighting changes the odds: p ∝ p_model · P(bucket | sighting) / P(bucket | any sighting).
   * Backtest on Aug 2026 (60k stops, RPS baseline → dirichlet α=32): gap 5–15 min 0.103 → 0.040,
   * 30–60 0.117 → 0.070, 120–240 0.162 → 0.132; ratio was within 0.003 RPS but worse on log loss.
   */
  mode?: NowcastMode;
  alpha?: number;
}

export const DEFAULT_NOWCAST: Required<NowcastOptions> = { mode: 'dirichlet', alpha: 32 };

export interface NowcastKey {
  level: 1 | 2 | 3;
  key: string;
}

/** Keys from the most general level (3) to the most specific (1). */
export function nowcastKeys(eva: string, trainType: string, prev: number | '*', gap: number): NowcastKey[] {
  return [
    { level: 3, key: `${prev}|${gap}` },
    { level: 2, key: `${trainType}|${prev}|${gap}` },
    { level: 1, key: `${eva}|${trainType}|${prev}|${gap}` },
  ];
}

export interface NowcastRow {
  level: number;
  key: string;
  event: string;
  weights: number[];
  n: number;
}

const rowKey = (level: number, key: string, event: string) => `${level}|${key}|${event}`;

/** Smooths from the general level down to the specific one; null when no level has data. */
function walk(start: Distribution, keys: NowcastKey[], event: string, stats: Map<string, NowcastRow>, alpha: number) {
  let p = start;
  let found = false;
  for (const { level, key } of keys) {
    const row = stats.get(rowKey(level, key, event));
    if (!row) continue;
    p = dirichletStep(p, row.weights, alpha);
    found = true;
  }
  return found ? p : null;
}

/** Applies a sighting to a model distribution. Pure; returns the input when the tables have nothing. */
export function applyNowcast(
  dist: Distribution,
  q: Pick<StopQuery, 'eva' | 'trainType' | 'event'>,
  sighting: Pick<Sighting, 'delayMin' | 'gapMin'>,
  stats: Map<string, NowcastRow>,
  opts: NowcastOptions = {},
): Distribution {
  const { mode, alpha } = { ...DEFAULT_NOWCAST, ...opts };
  const gap = gapBand(sighting.gapMin);
  const prev = bucketOf(sighting.delayMin, false);
  if (gap === null || prev === null) return dist;
  const keys = nowcastKeys(q.eva, q.trainType, prev, gap);
  if (mode === 'dirichlet') return walk(dist, keys, q.event, stats, alpha) ?? dist;

  const uniform = new Array<number>(NUM_BUCKETS).fill(1 / NUM_BUCKETS);
  const conditional = walk(uniform, keys, q.event, stats, alpha);
  const marginal = walk(uniform, nowcastKeys(q.eva, q.trainType, '*', gap), q.event, stats, alpha);
  if (!conditional || !marginal) return dist;
  return normalize(dist.map((p, i) => (p * conditional[i]!) / Math.max(marginal[i]!, 1e-9)));
}

export async function loadNowcastStats(
  items: { q: Pick<StopQuery, 'eva' | 'trainType' | 'event'>; sighting: Pick<Sighting, 'delayMin' | 'gapMin'> }[],
  db: Db = getPool(),
  table = 'agg_nowcast_stats',
): Promise<Map<string, NowcastRow>> {
  const levels: number[] = [];
  const keys: string[] = [];
  const events: string[] = [];
  for (const { q, sighting } of items) {
    const gap = gapBand(sighting.gapMin);
    const prev = bucketOf(sighting.delayMin, false);
    if (gap === null || prev === null) continue;
    for (const k of [...nowcastKeys(q.eva, q.trainType, prev, gap), ...nowcastKeys(q.eva, q.trainType, '*', gap)]) {
      levels.push(k.level);
      keys.push(k.key);
      events.push(q.event);
    }
  }
  if (!levels.length) return new Map();
  const { rows } = await db.query<NowcastRow>(
    `SELECT DISTINCT s.level, s.key, s.event, s.weights, s.n
     FROM ${table} s
     JOIN unnest($1::smallint[], $2::text[], $3::char(1)[]) AS q(level, key, event)
       ON s.level = q.level AND s.key = q.key AND s.event = q.event`,
    [levels, keys, events],
  );
  return new Map(rows.map((r) => [rowKey(r.level, r.key, r.event), r]));
}

export interface NowcastStatsOptions {
  /** Only target stops planned before this instant are counted. Default: now. */
  asOf?: Date;
  windowDays?: number;
}

/** Counts (sighting, target) pairs of the same runs into `table` (agg_nowcast_stats layout). */
export async function buildNowcastStats(c: pg.PoolClient, table: string, opts: NowcastStatsOptions = {}) {
  const asOf = opts.asOf ?? new Date();
  const windowDays = opts.windowDays ?? DEFAULT_NOWCAST_WINDOW_DAYS;
  await c.query('DROP TABLE IF EXISTS nowcast_ev');
  await c.query(
    `CREATE TEMP TABLE nowcast_ev AS
     SELECT e.trip_id, e.service_date, e.eva, t.train_type, x.event, x.pt, x.delay, x.cancelled
     FROM stop_events e
     JOIN trips t ON t.id = e.trip_id
     CROSS JOIN LATERAL (VALUES ('a'::char(1), e.planned_arr, e.arr_delay_min, e.arr_cancelled),
                                ('d'::char(1), e.planned_dep, e.dep_delay_min, e.dep_cancelled))
          AS x(event, pt, delay, cancelled)
     WHERE e.service_date BETWEEN ($1::timestamptz - make_interval(days => $2))::date - 1 AND $1::timestamptz::date + 1
       AND x.pt < $1::timestamptz
       AND x.pt >= $1::timestamptz - make_interval(days => $2) - make_interval(mins => ${MAX_GAP_MIN})
       AND (x.cancelled OR x.delay IS NOT NULL)`,
    [asOf, windowDays],
  );
  await c.query('CREATE INDEX ON nowcast_ev (trip_id, service_date, pt)');
  await c.query('ANALYZE nowcast_ev');

  const counts = Array.from({ length: NUM_BUCKETS }, (_, b) => `count(*) FILTER (WHERE bucket = ${b}) AS c${b}`).join(', ');
  const sums = Array.from({ length: NUM_BUCKETS }, (_, b) => `sum(c${b})`).join(', ');
  const g = (col: string) => `GROUPING(${col}) = 0`;
  // Aggregate at the most specific level once, then roll the small result up to the others.
  const r = await c.query(
    `INSERT INTO ${table} (level, key, event, weights, n)
     WITH pairs AS (
       SELECT tg.eva, tg.train_type, tg.event,
              ${bucketSql('tg.delay', 'tg.cancelled')} AS bucket,
              ${bucketSql('s.delay', 'false')} AS prev,
              ${gapBandSql('extract(epoch FROM tg.pt - s.pt) / 60')} AS gap
       FROM nowcast_ev tg
       JOIN nowcast_ev s ON s.trip_id = tg.trip_id AND s.service_date = tg.service_date
        AND s.pt BETWEEN tg.pt - make_interval(mins => ${MAX_GAP_MIN}) AND tg.pt - make_interval(mins => ${MIN_GAP_MIN})
        AND NOT s.cancelled
       WHERE tg.pt >= $1::timestamptz - make_interval(days => $2)
     ),
     l1 AS (
       SELECT eva, train_type, event, prev, gap, ${counts}, count(*) AS n
       FROM pairs GROUP BY eva, train_type, event, prev, gap
     )
     SELECT CASE WHEN ${g('eva')} THEN 1 WHEN ${g('train_type')} THEN 2 ELSE 3 END,
            concat_ws('|', CASE WHEN ${g('eva')} THEN eva END, CASE WHEN ${g('train_type')} THEN train_type END,
                      CASE WHEN ${g('prev')} THEN prev::text ELSE '*' END, gap::text),
            event, ARRAY[${sums}]::float8[], sum(n)::int
     FROM l1
     GROUP BY GROUPING SETS ((eva, train_type, prev, gap, event), (train_type, prev, gap, event), (prev, gap, event),
                             (eva, train_type, gap, event), (train_type, gap, event), (gap, event))`,
    [asOf, windowDays],
  );
  await c.query('DROP TABLE nowcast_ev');
  return r.rowCount ?? 0;
}

export async function refreshNowcastStats(opts: NowcastStatsOptions = {}) {
  return withTransaction(async (c) => {
    await c.query('DELETE FROM agg_nowcast_stats');
    const groups = await buildNowcastStats(c, 'agg_nowcast_stats', opts);
    return { groups };
  });
}

/**
 * Lateral subquery: the sighting for run `r` (columns trip_id, service_date, planned, cutoff).
 * A passed live stop with no reported change counts as on time when the poller was watching the
 * station then, the same rule the nightly finalisation applies.
 */
const sightingLateral = (r: string) => `
  CROSS JOIN LATERAL (
    SELECT s.eva, st.name, s.pt, s.delay FROM (
      SELECT e.eva, x.pt, x.cancelled,
             COALESCE(x.delay, CASE WHEN e.source = 'live' AND NOT x.cancelled AND EXISTS (
               SELECT 1 FROM stop_observations o
               WHERE o.eva = e.eva
                 AND o.observed_at BETWEEN x.pt - interval '30 minutes' AND x.pt + interval '30 minutes') THEN 0 END) AS delay
      FROM stop_events e
      CROSS JOIN LATERAL (VALUES (e.planned_arr, e.arr_delay_min, e.arr_cancelled),
                                 (e.planned_dep, e.dep_delay_min, e.dep_cancelled)) AS x(pt, delay, cancelled)
      WHERE e.trip_id = ${r}.trip_id AND e.service_date = ${r}.service_date
        AND x.pt <= LEAST(${r}.cutoff, ${r}.planned - make_interval(mins => ${MIN_GAP_MIN}))
        AND x.pt >= ${r}.planned - make_interval(mins => ${MAX_GAP_MIN})
    ) s
    LEFT JOIN stations st ON st.eva = s.eva
    WHERE s.delay IS NOT NULL AND NOT s.cancelled
    ORDER BY s.pt DESC LIMIT 1
  ) s`;

interface SightingRow {
  i: string;
  eva: string;
  name: string | null;
  pt: Date;
  delay: number;
}

function toSighting(r: SightingRow, planned: Date): Sighting {
  return { eva: r.eva, name: r.name, delayMin: r.delay, planned: r.pt, gapMin: Math.round((planned.getTime() - r.pt.getTime()) / 60_000) };
}

/**
 * Sightings for known runs as of a cutoff each: live serving passes now; backtests and the
 * training export pass a historical instant, so both see the same kind of input.
 */
export async function sightingsForRuns(
  runs: { tripId: string; serviceDate: string; planned: Date; cutoff: Date }[],
  db: Db = getPool(),
): Promise<(Sighting | null)[]> {
  if (!runs.length) return [];
  const { rows } = await db.query<SightingRow>(
    `SELECT r.i, s.eva, s.name, s.pt, s.delay
     FROM unnest($1::bigint[], $2::date[], $3::timestamptz[], $4::timestamptz[]) WITH ORDINALITY
          AS r(trip_id, service_date, planned, cutoff, i)
     ${sightingLateral('r')}`,
    [runs.map((r) => r.tripId), runs.map((r) => r.serviceDate), runs.map((r) => r.planned), runs.map((r) => r.cutoff)],
  );
  const byIdx = new Map(rows.map((r) => [Number(r.i) - 1, r]));
  return runs.map((run, i) => {
    const r = byIdx.get(i);
    return r ? toSighting(r, run.planned) : null;
  });
}

/** Sightings for queried stops (train + station + planned time) as of `now`. */
export async function loadSightings(
  queries: StopQuery[],
  now = new Date(),
  tz = 'Europe/Berlin',
  db: Db = getPool(),
): Promise<(Sighting | null)[]> {
  // Only stops close enough that the train may already be running are worth a lookup.
  const idx = queries.flatMap((q, i) =>
    q.planned.getTime() - MAX_GAP_MIN * 60_000 <= now.getTime() && q.planned.getTime() > now.getTime() - 3600_000 ? [i] : [],
  );
  const out: (Sighting | null)[] = queries.map(() => null);
  if (!idx.length) return out;
  const sel = idx.map((i) => queries[i]!);
  const { rows } = await db.query<SightingRow>(
    `WITH q AS (
       SELECT * FROM unnest($1::text[], $2::text[], $3::text[], $4::char(1)[], $5::timestamptz[]) WITH ORDINALITY
              AS q(train_type, train_number, eva, event, planned, i)
     ),
     r AS (
       SELECT DISTINCT ON (q.i) q.i, e.trip_id, e.service_date, q.planned, $6::timestamptz AS cutoff
       FROM q
       JOIN trips t ON t.train_type = q.train_type AND t.train_number = q.train_number
        AND t.service_date BETWEEN (q.planned AT TIME ZONE $7)::date - 1 AND (q.planned AT TIME ZONE $7)::date
       JOIN stop_events e ON e.trip_id = t.id AND e.service_date = t.service_date AND e.eva = q.eva
        AND CASE q.event WHEN 'a' THEN e.planned_arr ELSE e.planned_dep END = q.planned
       ORDER BY q.i, (e.source = 'live') DESC
     )
     SELECT r.i, s.eva, s.name, s.pt, s.delay FROM r ${sightingLateral('r')}`,
    [
      sel.map((q) => q.trainType),
      sel.map((q) => q.trainNumber),
      sel.map((q) => q.eva),
      sel.map((q) => q.event),
      sel.map((q) => q.planned),
      now,
      tz,
    ],
  );
  for (const r of rows) {
    const i = idx[Number(r.i) - 1]!;
    out[i] = toSighting(r, queries[i]!.planned);
  }
  return out;
}

export interface NowcastPredictor {
  kind: string;
  version: string;
  predict(queries: StopQuery[]): Promise<StopPrediction[]>;
}

/**
 * Wraps any predictor: stops of trains already seen running get the sighting applied, the rest
 * pass through. `sighting` on the result records what was used.
 */
export class NowcastLayer<P extends NowcastPredictor> {
  readonly kind: string;
  readonly version: string;

  constructor(
    readonly inner: P,
    private readonly tz = 'Europe/Berlin',
    private readonly opts: NowcastOptions = {},
    private readonly clock: () => Date = () => new Date(),
  ) {
    this.kind = inner.kind;
    this.version = `${inner.version}+nowcast`;
  }

  async predict(queries: StopQuery[]): Promise<StopPrediction[]> {
    const [preds, sightings] = await Promise.all([this.inner.predict(queries), loadSightings(queries, this.clock(), this.tz)]);
    const items = queries.flatMap((q, i) => (sightings[i] ? [{ q, sighting: sightings[i]! }] : []));
    if (!items.length) return preds;
    const stats = await loadNowcastStats(items);
    return preds.map((p, i) => {
      const s = sightings[i];
      if (!s) return p;
      const distribution = applyNowcast(p.distribution, queries[i]!, s, stats, this.opts);
      return distribution === p.distribution ? p : { ...p, distribution, sighting: s };
    });
  }
}
