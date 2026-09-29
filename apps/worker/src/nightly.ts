/**
 * Nightly pipeline (Europe/Berlin):
 *  02:30  finalise yesterday's live stop events, refresh aggregate stats, backtest the baseline,
 *         then train LightGBM and promote it if it beats the baseline and the active model
 *  3rd of month 06:00  import newly published dataset months
 *  hourly :05  freeze predictions for newly planned stops; 06:30  score finished days (see accuracy.ts)
 */
import cron from 'node-cron';
import type { CityConfig } from '@gfm/core';
import { getPool, startJob } from '@gfm/db';
import { backtestBaseline, labelledDataEnd } from '@gfm/model';
import { scorePending, snapshotPredictions } from './accuracy.ts';
import { importLatestMonth } from './monthlyImport.ts';
import { refreshStats } from './stats.ts';
import { trainAndPromote } from './train.ts';

/**
 * IRIS only reports changes, so a live stop that never showed up in `fchg` ran on time — but
 * only if the poller was actually watching that station then. We treat the poller as "alive"
 * for a stop when it recorded any observation at that station within ±30 min of the planned
 * time; otherwise the stop stays unlabelled (NULL delay) and is ignored by training.
 */
export async function finaliseLiveEvents() {
  const r = await getPool().query(`
    UPDATE stop_events e SET
      changed_arr = CASE WHEN e.changed_arr IS NULL AND e.planned_arr IS NOT NULL AND NOT e.arr_cancelled
                         THEN e.planned_arr ELSE e.changed_arr END,
      changed_dep = CASE WHEN e.changed_dep IS NULL AND e.planned_dep IS NOT NULL AND NOT e.dep_cancelled
                         THEN e.planned_dep ELSE e.changed_dep END,
      arr_delay_min = COALESCE(e.arr_delay_min, CASE WHEN e.planned_arr IS NOT NULL AND NOT e.arr_cancelled THEN 0 END),
      dep_delay_min = COALESCE(e.dep_delay_min, CASE WHEN e.planned_dep IS NOT NULL AND NOT e.dep_cancelled THEN 0 END)
    WHERE e.source = 'live'
      AND e.service_date >= current_date - 3
      AND COALESCE(e.planned_dep, e.planned_arr) < now() - interval '6 hours'
      AND ((e.changed_arr IS NULL AND e.planned_arr IS NOT NULL) OR (e.changed_dep IS NULL AND e.planned_dep IS NOT NULL))
      AND EXISTS (
        SELECT 1 FROM stop_observations o
        WHERE o.eva = e.eva
          AND o.observed_at BETWEEN COALESCE(e.planned_dep, e.planned_arr) - interval '30 minutes'
                                AND COALESCE(e.planned_dep, e.planned_arr) + interval '30 minutes')`);
  return { finalised: r.rowCount ?? 0 };
}

export async function runNightly(city: CityConfig) {
  const finish = await startJob('nightly', city.id);
  const out: Record<string, unknown> = {};
  try {
    out.finalise = await finaliseLiveEvents();
    out.stats = await refreshStats(city);

    // Baseline backtest on the last 28 days, recorded for monitoring.
    const cutoff = new Date((await labelledDataEnd()).getTime() - 28 * 86400_000);
    const bt = await backtestBaseline({ cutoff, tz: city.tz, evas: city.hubs.map((h) => h.eva) });
    out.baseline = { rps: bt.baseline.rps, logLoss: bt.baseline.logLoss, n: bt.baseline.n };

    if (process.env.DISABLE_TRAINING !== '1') out.train = await trainAndPromote(city);
    await finish('ok', out);
    return out;
  } catch (err) {
    await finish('failed', { ...out, error: String(err) });
    throw err;
  }
}

/** Accuracy tracking jobs; also used by `poll` so local runs build up history. */
export function startAccuracySchedule(city: CityConfig) {
  const opts = { timezone: city.tz, noOverlap: true };
  const log = (job: string) => (e: unknown) => console.error(`[${job}]`, e);
  cron.schedule('5 * * * *', () => void snapshotPredictions(city).catch(log('snapshot')), opts);
  cron.schedule('30 6 * * *', () => void scorePending(city, { rescoreDays: 2 }).catch(log('score')), opts);
  // Catch up after downtime: snapshot what's planned now, score any finished days left over.
  setTimeout(() => {
    void snapshotPredictions(city)
      .then(() => scorePending(city))
      .catch(log('accuracy'));
  }, 60_000);
  console.log(`[scheduler] accuracy: snapshots hourly at :05, scoring daily at 06:30 (${city.tz})`);
}

export function startScheduler(city: CityConfig) {
  const opts = { timezone: city.tz, noOverlap: true };
  cron.schedule('30 2 * * *', () => void runNightly(city).catch((e) => console.error('[nightly]', e)), opts);
  cron.schedule('0 6 3 * *', () => void importLatestMonth(city).catch((e) => console.error('[monthly]', e)), opts);
  console.log(`[scheduler] nightly 02:30 and monthly import on the 3rd at 06:00 (${city.tz})`);
  startAccuracySchedule(city);
}
