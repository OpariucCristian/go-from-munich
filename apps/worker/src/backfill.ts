/**
 * Imports monthly parquet files from the piebro/deutsche-bahn-data dataset (CC BY 4.0,
 * data © Deutsche Bahn) into Postgres. The files are queried remotely with DuckDB, so only the
 * needed columns and row groups are downloaded.
 *
 * For each month: find every run of an in-scope train type that stops at one of the city's hubs,
 * then import *all* stops of those runs (so destinations outside the city are covered too).
 */
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DuckDBInstance } from '@duckdb/node-api';
import type { CityConfig } from '@gfm/core';
import { copyCsvFileToStaging, createStaging, mergeStaging, startJob, withTransaction } from '@gfm/db';

const HF_BASE = 'https://huggingface.co/datasets/piebro/deutsche-bahn-data/resolve/main/monthly_processed_data';
const HF_TREE = 'https://huggingface.co/api/datasets/piebro/deutsche-bahn-data/tree/main/monthly_processed_data';

export const monthUrl = (month: string) => `${HF_BASE}/data-${month}.parquet`;

/** Months (YYYY-MM) currently published in the dataset. */
export async function listAvailableMonths(): Promise<string[]> {
  const res = await fetch(HF_TREE);
  if (!res.ok) throw new Error(`HF listing failed: ${res.status}`);
  const entries = (await res.json()) as { path: string }[];
  return entries
    .map((e) => /data-(\d{4}-\d{2})\.parquet$/.exec(e.path)?.[1])
    .filter((m): m is string => !!m)
    .sort();
}

export function monthRange(from: string, to: string): string[] {
  const out: string[] = [];
  let [y, m] = from.split('-').map(Number) as [number, number];
  const [ty, tm] = to.split('-').map(Number) as [number, number];
  while (y < ty || (y === ty && m <= tm)) {
    out.push(`${y}-${String(m).padStart(2, '0')}`);
    m++;
    if (m > 12) { m = 1; y++; }
  }
  return out;
}

const sqlList = (xs: string[]) => xs.map((x) => `'${x.replace(/'/g, "''")}'`).join(', ');

/** Columns we read; ones missing from older files are replaced by NULL. */
const WANTED = [
  'id', 'eva', 'train_type', 'train_number', 'line_number', 'final_destination_station',
  'train_line_ride_id', 'train_line_station_num', 'arrival_planned_time', 'arrival_change_time',
  'departure_planned_time', 'departure_change_time', 'arrival_is_canceled', 'departure_is_canceled',
  'is_additional_stop',
];

export async function extractMonthCsv(city: CityConfig, month: string, outFile: string): Promise<number> {
  const db = await DuckDBInstance.create(':memory:', { memory_limit: '3GB', threads: '4' });
  const c = await db.connect();
  try {
    await c.run('INSTALL httpfs; LOAD httpfs;');
    const url = monthUrl(month);
    const described = await c.runAndReadAll(`DESCRIBE SELECT * FROM '${url}'`);
    const present = new Set(described.getRowObjectsJson().map((r) => String(r.column_name)));
    const select = WANTED.map((col) => (present.has(col) ? col : `NULL AS ${col}`)).join(', ');
    // The dataset pads EVAs to 8 digits ("08000261").
    const hubEvas = city.hubs.flatMap((h) => [h.eva, h.eva.padStart(8, '0')]);

    await c.run(`CREATE TABLE src AS SELECT ${select} FROM '${url}' WHERE train_type IN (${sqlList(city.trainTypes)})`);
    await c.run(`
      CREATE TABLE hub AS
      SELECT DISTINCT train_line_ride_id AS rid, split_part(id, '-', -2) AS st
      FROM src WHERE eva IN (${sqlList(hubEvas)})`);
    await c.run(`
      COPY (
        SELECT
          s.train_line_ride_id AS ride_id,
          split_part(s.id, '-', -2) AS origin_start,
          strptime(substr(split_part(s.id, '-', -2), 1, 6), '%y%m%d')::date AS service_date,
          s.train_type, s.train_number, s.line_number AS line,
          s.final_destination_station AS final_destination,
          ltrim(s.eva, '0') AS eva,
          s.train_line_station_num AS stop_seq,
          s.arrival_planned_time AS planned_arr, s.arrival_change_time AS changed_arr,
          s.departure_planned_time AS planned_dep, s.departure_change_time AS changed_dep,
          s.arrival_is_canceled AS arr_cancelled, s.departure_is_canceled AS dep_cancelled,
          s.is_additional_stop AS is_additional,
          NULL AS arr_status, NULL AS dep_status, 'piebro' AS source, NULL AS observed_at
        FROM src s
        SEMI JOIN hub h ON s.train_line_ride_id = h.rid AND split_part(s.id, '-', -2) = h.st
        WHERE s.train_line_ride_id IS NOT NULL
      ) TO '${outFile.replace(/\\/g, '/')}' (HEADER, DELIMITER ',')`);
    const n = await c.runAndReadAll(`SELECT count(*)::int AS n FROM read_csv('${outFile.replace(/\\/g, '/')}')`);
    return Number(n.getRowObjectsJson()[0]!.n);
  } finally {
    c.closeSync();
    db.closeSync();
  }
}

export async function backfillMonth(city: CityConfig, month: string) {
  const finish = await startJob(`backfill:${month}`, city.id);
  const dir = await mkdtemp(path.join(os.tmpdir(), 'gfm-backfill-'));
  const file = path.join(dir, `${city.id}-${month}.csv`);
  try {
    const t0 = Date.now();
    const extracted = await extractMonthCsv(city, month, file);
    const t1 = Date.now();
    const stats = await withTransaction(async (client) => {
      await createStaging(client);
      await copyCsvFileToStaging(client, file, city.tz);
      return mergeStaging(client);
    });
    const result = { month, extracted, ...stats, extractMs: t1 - t0, loadMs: Date.now() - t1 };
    await finish('ok', result);
    return result;
  } catch (err) {
    await finish('failed', { month, error: String(err) });
    throw err;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
