import type { CityConfig } from '@gfm/core';
import { getPool } from '@gfm/db';
import { backfillMonth, listAvailableMonths } from './backfill.ts';

/**
 * Imports every published month that has no successful backfill run yet, plus the newest
 * month again (the dataset reprocesses history when its schema changes, and the latest month
 * is the one most likely to have been refreshed).
 */
export async function importLatestMonth(city: CityConfig) {
  const available = await listAvailableMonths();
  const { rows } = await getPool().query<{ job: string }>(
    `SELECT DISTINCT job FROM job_runs WHERE city_id = $1 AND status = 'ok' AND job LIKE 'backfill:%'`,
    [city.id],
  );
  const done = new Set(rows.map((r) => r.job.slice('backfill:'.length)));
  const todo = available.filter((m) => !done.has(m));
  const latest = available.at(-1);
  if (latest && !todo.includes(latest)) todo.push(latest);
  const results = [];
  for (const month of todo) results.push(await backfillMonth(city, month));
  return results;
}
