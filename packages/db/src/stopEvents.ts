/**
 * Shared write path for stop events. Both the historical backfill (large CSV files produced by
 * DuckDB) and the live poller (small batches) COPY rows into a temp staging table and then call
 * `mergeStaging`, which upserts trips + stop_events and records live observations.
 *
 * Merge rules:
 *  - live data wins over piebro data; piebro never overwrites a live row
 *  - null fields in an incoming row keep the stored value (IRIS `fchg` only carries changes)
 *  - delays are derived in SQL from planned vs changed times
 */
import { createReadStream } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type pg from 'pg';
import copyStreams from 'pg-copy-streams';

export const STAGING_COLUMNS = [
  'ride_id',
  'origin_start',
  'service_date',
  'train_type',
  'train_number',
  'line',
  'final_destination',
  'eva',
  'stop_seq',
  'planned_arr',
  'changed_arr',
  'planned_dep',
  'changed_dep',
  'arr_cancelled',
  'dep_cancelled',
  'is_additional',
  'arr_status',
  'dep_status',
  'source',
  'observed_at',
] as const;

export interface StopEventInput {
  rideId: string;
  originStart: string;
  serviceDate: string; // YYYY-MM-DD
  trainType: string | null;
  trainNumber: string | null;
  line: string | null;
  finalDestination: string | null;
  eva: string;
  stopSeq: number | null;
  plannedArr: Date | null;
  changedArr: Date | null;
  plannedDep: Date | null;
  changedDep: Date | null;
  arrCancelled: boolean | null;
  depCancelled: boolean | null;
  isAdditional: boolean | null;
  arrStatus: string | null;
  depStatus: string | null;
  source: 'piebro' | 'live';
  observedAt: Date | null;
}

export async function createStaging(client: pg.PoolClient): Promise<void> {
  await client.query(`
    CREATE TEMP TABLE IF NOT EXISTS staging_stop_events (
      ride_id text, origin_start text, service_date date,
      train_type text, train_number text, line text, final_destination text,
      eva text, stop_seq int,
      planned_arr timestamptz, changed_arr timestamptz, planned_dep timestamptz, changed_dep timestamptz,
      arr_cancelled boolean, dep_cancelled boolean, is_additional boolean,
      arr_status text, dep_status text, source text, observed_at timestamptz
    ) ON COMMIT DROP`);
}

/**
 * COPY a CSV file (header row, STAGING_COLUMNS order) into staging. Naive timestamps in the
 * file are interpreted in `tz` — the dataset reports Berlin wall-clock times.
 */
export async function copyCsvFileToStaging(client: pg.PoolClient, file: string, tz = 'Europe/Berlin') {
  await client.query(`SET LOCAL TimeZone = '${tz.replace(/'/g, '')}'`);
  const sink = client.query(
    copyStreams.from(
      `COPY staging_stop_events (${STAGING_COLUMNS.join(', ')}) FROM STDIN WITH (FORMAT csv, HEADER true)`,
    ),
  );
  await pipeline(createReadStream(file), sink);
}

function csvCell(v: unknown): string {
  if (v === null || v === undefined) return '';
  const s = v instanceof Date ? v.toISOString() : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsvLine(r: StopEventInput): string {
  return [
    r.rideId, r.originStart, r.serviceDate, r.trainType, r.trainNumber, r.line, r.finalDestination,
    r.eva, r.stopSeq, r.plannedArr, r.changedArr, r.plannedDep, r.changedDep,
    r.arrCancelled, r.depCancelled, r.isAdditional, r.arrStatus, r.depStatus, r.source, r.observedAt,
  ].map(csvCell).join(',');
}

export async function copyRowsToStaging(client: pg.PoolClient, rows: StopEventInput[]) {
  const sink = client.query(
    copyStreams.from(`COPY staging_stop_events (${STAGING_COLUMNS.join(', ')}) FROM STDIN WITH (FORMAT csv)`),
  );
  await pipeline(Readable.from(rows.map((r) => toCsvLine(r) + '\n')), sink);
}

const delayExpr = (changed: string, planned: string) =>
  `round(extract(epoch FROM (${changed} - ${planned})) / 60)::int`;

export interface MergeStats {
  trips: number;
  stopEvents: number;
  observations: number;
}

export async function mergeStaging(client: pg.PoolClient): Promise<MergeStats> {
  const months = await client.query<{ m: string }>(
    `SELECT DISTINCT date_trunc('month', service_date)::date::text m FROM staging_stop_events`,
  );
  for (const { m } of months.rows) await client.query('SELECT ensure_stop_events_partition($1::date)', [m]);

  const trips = await client.query(`
    INSERT INTO trips (ride_id, origin_start, service_date, train_type, train_number, line, final_destination)
    SELECT ride_id, origin_start, min(service_date), max(train_type), max(train_number), max(line), max(final_destination)
    FROM staging_stop_events
    WHERE train_type IS NOT NULL AND train_number IS NOT NULL
    GROUP BY ride_id, origin_start
    ON CONFLICT (ride_id, origin_start) DO UPDATE SET
      line = COALESCE(EXCLUDED.line, trips.line),
      final_destination = COALESCE(EXCLUDED.final_destination, trips.final_destination)`);

  // Record live changes before the upsert overwrites the previous values.
  const observations = await client.query(`
    INSERT INTO stop_observations (service_date, trip_id, eva, observed_at, changed_arr, changed_dep, arr_status, dep_status)
    SELECT s.service_date, t.id, s.eva, COALESCE(s.observed_at, now()), s.changed_arr, s.changed_dep, s.arr_status, s.dep_status
    FROM staging_stop_events s
    JOIN trips t ON t.ride_id = s.ride_id AND t.origin_start = s.origin_start
    LEFT JOIN stop_events e ON e.service_date = s.service_date AND e.trip_id = t.id AND e.eva = s.eva
    WHERE s.source = 'live'
      AND (s.changed_arr IS NOT NULL OR s.changed_dep IS NOT NULL OR s.arr_status IS NOT NULL OR s.dep_status IS NOT NULL)
      AND (e.trip_id IS NULL
        OR (s.changed_arr IS NOT NULL AND s.changed_arr IS DISTINCT FROM e.changed_arr)
        OR (s.changed_dep IS NOT NULL AND s.changed_dep IS DISTINCT FROM e.changed_dep)
        OR (s.arr_cancelled IS NOT NULL AND s.arr_cancelled IS DISTINCT FROM e.arr_cancelled)
        OR (s.dep_cancelled IS NOT NULL AND s.dep_cancelled IS DISTINCT FROM e.dep_cancelled))`);

  const col = (c: string) => `COALESCE(EXCLUDED.${c}, stop_events.${c})`;
  const stopEvents = await client.query(`
    INSERT INTO stop_events (service_date, trip_id, eva, stop_seq, planned_arr, changed_arr, planned_dep, changed_dep,
                             arr_delay_min, dep_delay_min, arr_cancelled, dep_cancelled, is_additional, source, last_observed_at)
    SELECT DISTINCT ON (s.service_date, t.id, s.eva)
      s.service_date, t.id, s.eva, s.stop_seq, s.planned_arr, s.changed_arr, s.planned_dep, s.changed_dep,
      ${delayExpr('s.changed_arr', 's.planned_arr')}, ${delayExpr('s.changed_dep', 's.planned_dep')},
      COALESCE(s.arr_cancelled, e.arr_cancelled, false), COALESCE(s.dep_cancelled, e.dep_cancelled, false),
      COALESCE(s.is_additional, e.is_additional, false),
      s.source, s.observed_at
    FROM staging_stop_events s
    JOIN trips t ON t.ride_id = s.ride_id AND t.origin_start = s.origin_start
    -- booleans are NOT NULL in the target, so resolve "unknown" against the stored row here
    LEFT JOIN stop_events e ON e.service_date = s.service_date AND e.trip_id = t.id AND e.eva = s.eva
    ORDER BY s.service_date, t.id, s.eva, s.observed_at DESC NULLS LAST
    ON CONFLICT (service_date, trip_id, eva) DO UPDATE SET
      stop_seq = ${col('stop_seq')},
      planned_arr = ${col('planned_arr')},
      changed_arr = ${col('changed_arr')},
      planned_dep = ${col('planned_dep')},
      changed_dep = ${col('changed_dep')},
      arr_delay_min = ${delayExpr(col('changed_arr'), col('planned_arr'))},
      dep_delay_min = ${delayExpr(col('changed_dep'), col('planned_dep'))},
      arr_cancelled = EXCLUDED.arr_cancelled,
      dep_cancelled = EXCLUDED.dep_cancelled,
      is_additional = EXCLUDED.is_additional,
      source = EXCLUDED.source,
      last_observed_at = ${col('last_observed_at')}
    WHERE stop_events.source = 'piebro' OR EXCLUDED.source = 'live'`);

  return {
    trips: trips.rowCount ?? 0,
    stopEvents: stopEvents.rowCount ?? 0,
    observations: observations.rowCount ?? 0,
  };
}
