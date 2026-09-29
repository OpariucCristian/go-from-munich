/**
 * Rebuilds `agg_delay_stats`: recency-weighted bucket counts per grouping level and event type.
 * An observation's weight halves every `halfLifeDays`, so recent timetable conditions dominate.
 */
import { NUM_BUCKETS } from '@gfm/core';
import { getPool, withTransaction } from '@gfm/db';
import type pg from 'pg';
import { LEVELS, dayTypeSql, groupKeySql, hourBandSql } from './groups.ts';

export const DEFAULT_HALF_LIFE_DAYS = 60;
export const DEFAULT_WINDOW_DAYS = 365;

export interface StatsOptions {
  /** Only events planned before this instant are used (for honest backtests). Default: now. */
  asOf?: Date;
  windowDays?: number;
  halfLifeDays?: number;
  tz?: string;
}

export const bucketSql = (delay: string, cancelled: string) => `CASE
  WHEN ${cancelled} THEN 7
  WHEN ${delay} <= 2 THEN 0 WHEN ${delay} <= 5 THEN 1 WHEN ${delay} <= 10 THEN 2
  WHEN ${delay} <= 15 THEN 3 WHEN ${delay} <= 30 THEN 4 WHEN ${delay} <= 60 THEN 5 ELSE 6 END`;

/** Materialises labelled events (one row per arrival/departure) into temp table `labelled_events`. */
export async function buildLabelledEvents(c: pg.PoolClient, opts: StatsOptions = {}) {
  const asOf = opts.asOf ?? new Date();
  const windowDays = opts.windowDays ?? DEFAULT_WINDOW_DAYS;
  const halfLife = opts.halfLifeDays ?? DEFAULT_HALF_LIFE_DAYS;
  const tz = (opts.tz ?? 'Europe/Berlin').replace(/'/g, '');
  const local = `(pt AT TIME ZONE '${tz}')`;
  await c.query('DROP TABLE IF EXISTS labelled_events');
  await c.query(
    `CREATE TEMP TABLE labelled_events AS
     WITH ev AS (
       SELECT e.eva, t.train_type, t.train_number, e.stop_seq, t.origin_start, 'a'::char(1) AS event, e.planned_arr AS pt,
              e.arr_delay_min AS delay, e.arr_cancelled AS cancelled
       FROM stop_events e JOIN trips t ON t.id = e.trip_id
       WHERE e.planned_arr IS NOT NULL
         AND e.service_date >= ($1::timestamptz - make_interval(days => $2))::date - 1
       UNION ALL
       SELECT e.eva, t.train_type, t.train_number, e.stop_seq, t.origin_start, 'd'::char(1), e.planned_dep,
              e.dep_delay_min, e.dep_cancelled
       FROM stop_events e JOIN trips t ON t.id = e.trip_id
       WHERE e.planned_dep IS NOT NULL
         AND e.service_date >= ($1::timestamptz - make_interval(days => $2))::date - 1
     )
     SELECT eva, train_type, train_number, stop_seq, origin_start, event, pt, delay,
            ${bucketSql('delay', 'cancelled')} AS bucket,
            power(0.5, extract(epoch FROM ($1::timestamptz - pt)) / 86400.0 / $3) AS w,
            ${dayTypeSql(local)} AS day_type,
            ${hourBandSql(local)} AS hour_band
     FROM ev
     WHERE pt < $1::timestamptz AND pt >= $1::timestamptz - make_interval(days => $2)
       AND (cancelled OR delay IS NOT NULL)`,
    [asOf, windowDays, halfLife],
  );
}

/**
 * Restricts an aggregation to events planned in [from, to) and multiplies weights by `scale`.
 * Weights are exponential in (asOf - pt), so stats "as of" an earlier instant equal the stats of a
 * later labelled_events build restricted in time and rescaled by 2^((asOf_build - asOf) / halfLife).
 */
export interface AggregateWindow {
  from: Date;
  to: Date;
  scale: number;
}

/** Aggregates `labelled_events` into `table` (which must have the agg_delay_stats layout). */
export async function aggregateInto(c: pg.PoolClient, table: string, window?: AggregateWindow) {
  const weights = Array.from(
    { length: NUM_BUCKETS },
    (_, b) => `COALESCE(sum(w * $3::float8) FILTER (WHERE bucket = ${b}), 0)`,
  ).join(', ');
  const params: unknown[] = window ? [window.from, window.to, window.scale] : ['-infinity', 'infinity', 1];
  // One GROUP BY per level. (A single GROUPING SETS query gives identical results but measured
  // ~65% slower on Postgres 17, which sorts per grouping set.)
  let total = 0;
  for (const level of LEVELS) {
    const r = await c.query(
      `INSERT INTO ${table} (level, key, event, weights, n, mean_delay)
       SELECT ${level}, ${groupKeySql[level]} AS key, event, ARRAY[${weights}], count(*),
              avg(LEAST(delay, 180)) FILTER (WHERE bucket <> 7)
       FROM labelled_events
       WHERE pt >= $1::timestamptz AND pt < $2::timestamptz
       GROUP BY 2, 3`,
      params,
    );
    total += r.rowCount ?? 0;
  }
  return total;
}

export async function refreshStats(opts: StatsOptions = {}) {
  return withTransaction(async (c) => {
    await buildLabelledEvents(c, opts);
    await c.query('DELETE FROM agg_delay_stats');
    const total = await aggregateInto(c, 'agg_delay_stats');
    const { rows } = await c.query<{ n: string }>('SELECT count(*) n FROM labelled_events');
    return { groups: total, events: Number(rows[0]!.n) };
  });
}

/** Start of the day after the newest labelled stop event: the natural "now" for backtests. */
export async function labelledDataEnd(): Promise<Date> {
  const { rows } = await getPool().query<{ d: string | null }>(
    `SELECT (max(service_date) + 1)::text AS d FROM stop_events
     WHERE service_date >= current_date - 400 AND (dep_delay_min IS NOT NULL OR arr_delay_min IS NOT NULL)`,
  );
  return rows[0]?.d ? new Date(`${rows[0].d}T00:00:00Z`) : new Date();
}
