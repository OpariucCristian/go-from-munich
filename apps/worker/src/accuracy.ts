/**
 * Accuracy tracking.
 *
 *  snapshotPredictions  hourly: freeze the active model's prediction for every in-scope stop the
 *                       first time it appears in the live plan (~12h ahead)
 *  scoreDay             compare a day's frozen predictions with the observed delays and store
 *                       per-row outcomes plus a daily aggregate in `accuracy_daily`
 *  scorePending         score every finished day that still has unscored live snapshots
 *  replayAccuracy       seed history: predict past days with statistics as of that morning
 *                       (no look-ahead) and score them as source = 'replay'
 */
import {
  CANCELLED_BUCKET,
  bucketOf,
  normalize,
  polledStations,
  toLocalParts,
  type CityConfig,
  type Distribution,
} from '@gfm/core';
import { getPool, startJob, withTransaction } from '@gfm/db';
import {
  DEFAULT_ALPHA,
  DEFAULT_HALF_LIFE_DAYS,
  DEFAULT_WINDOW_DAYS,
  aggregateAccuracy,
  aggregateInto,
  blend,
  buildLabelledEvents,
  loadActivePredictor,
  loadStats,
  logLoss,
  rps,
  type OutcomeRow,
  type StopPrediction,
  type StopQuery,
} from '@gfm/model';
import type pg from 'pg';
import { finaliseLiveEvents } from './nightly.ts';

type Db = Pick<pg.Pool, 'query'>;
type Source = 'live' | 'replay';

const BATCH = 2000;
const DAY_MS = 86400_000;
/** Scoring waits until 06:30 local, when every stop of the previous service day is >6h old. */
const SCORE_AFTER = { hour: 6, minute: 30 };

interface StopRow {
  service_date: string;
  trip_id: string;
  eva: string;
  event: 'a' | 'd';
  train_type: string;
  train_number: string;
  planned: Date;
}

/** One row per planned arrival/departure at the polled stations, for in-scope trains. */
const stopsSql = (where: string) => `
  SELECT e.service_date::text AS service_date, e.trip_id::text AS trip_id, e.eva, ev.event,
         t.train_type, t.train_number, ev.planned
  FROM stop_events e
  JOIN trips t ON t.id = e.trip_id
  CROSS JOIN LATERAL (VALUES ('a', e.planned_arr, e.arr_delay_min, e.arr_cancelled),
                             ('d', e.planned_dep, e.dep_delay_min, e.dep_cancelled))
       AS ev(event, planned, delay, cancelled)
  WHERE ev.planned IS NOT NULL AND e.eva = ANY($1) AND t.train_type = ANY($2) AND ${where}`;

const toQuery = (r: StopRow): StopQuery => ({
  eva: r.eva,
  trainType: r.train_type,
  trainNumber: r.train_number,
  event: r.event,
  planned: r.planned,
});

interface SnapshotMeta {
  source: Source;
  predictedAt: Date;
  modelId: number | null;
  modelKind: string;
  modelVersion: string;
}

async function insertSnapshots(db: Db, rows: StopRow[], preds: StopPrediction[], meta: SnapshotMeta) {
  if (!rows.length) return 0;
  const r = await db.query(
    `INSERT INTO prediction_snapshots
       (service_date, trip_id, eva, event, train_type, train_number, planned, lead_min, dist, support_level,
        source, predicted_at, model_id, model_kind, model_version)
     SELECT u.service_date, u.trip_id, u.eva, u.event, u.train_type, u.train_number, u.planned, u.lead_min,
            u.dist::real[], u.support_level, $11, $12, $13, $14, $15
     FROM unnest($1::date[], $2::bigint[], $3::text[], $4::char(1)[], $5::text[], $6::text[],
                 $7::timestamptz[], $8::int[], $9::text[], $10::smallint[])
          AS u(service_date, trip_id, eva, event, train_type, train_number, planned, lead_min, dist, support_level)
     ON CONFLICT DO NOTHING`,
    [
      rows.map((r) => r.service_date),
      rows.map((r) => r.trip_id),
      rows.map((r) => r.eva),
      rows.map((r) => r.event),
      rows.map((r) => r.train_type),
      rows.map((r) => r.train_number),
      rows.map((r) => r.planned),
      rows.map((r) => Math.round((r.planned.getTime() - meta.predictedAt.getTime()) / 60_000)),
      preds.map((p) => `{${p.distribution.join(',')}}`),
      preds.map((p) => p.supportLevel),
      meta.source,
      meta.predictedAt,
      meta.modelId,
      meta.modelKind,
      meta.modelVersion,
    ],
  );
  return r.rowCount ?? 0;
}

export async function snapshotPredictions(city: CityConfig) {
  const finish = await startJob('snapshot', city.id);
  try {
    const predictor = await loadActivePredictor(city);
    const { rows } = await getPool().query<StopRow>(
      stopsSql(`
        e.service_date BETWEEN current_date - 1 AND current_date + 1
        AND ev.planned > now() AND ev.planned <= now() + interval '13 hours'
        AND NOT EXISTS (SELECT 1 FROM prediction_snapshots p
                        WHERE p.service_date = e.service_date AND p.trip_id = e.trip_id AND p.eva = e.eva
                          AND p.event = ev.event AND p.source = 'live')`),
      [polledStations(city).map((s) => s.eva), city.trainTypes],
    );
    let inserted = 0;
    for (let i = 0; i < rows.length; i += BATCH) {
      const batch = rows.slice(i, i + BATCH);
      const preds = await predictor.predict(batch.map(toQuery));
      inserted += await insertSnapshots(getPool(), batch, preds, {
        source: 'live',
        predictedAt: new Date(),
        modelId: predictor.id,
        modelKind: predictor.kind,
        modelVersion: predictor.version,
      });
    }
    const out = { snapshots: inserted, model: predictor.version };
    await finish('ok', out);
    return out;
  } catch (err) {
    await finish('failed', { error: String(err) });
    throw err;
  }
}

async function climatology(db: Db): Promise<Partial<Record<'a' | 'd', Distribution>>> {
  const { rows } = await db.query<{ event: 'a' | 'd'; weights: number[] }>(
    'SELECT event, weights FROM agg_delay_stats WHERE level = 6',
  );
  return Object.fromEntries(rows.map((r) => [r.event, normalize(r.weights)]));
}

/**
 * Labels one day's snapshots from `stop_events` and (re)writes its `accuracy_daily` rows.
 * Stops without a label (the poller wasn't watching) stay unscored and count as unlabelled.
 */
export async function scoreDay(city: CityConfig, date: string, source: Source = 'live') {
  const pool = getPool();
  const { rows } = await pool.query<{
    trip_id: string; eva: string; event: 'a' | 'd'; dist: number[]; train_type: string; lead_min: number;
    model_version: string; delay: number | null; cancelled: boolean | null;
  }>(
    `SELECT p.trip_id::text, p.eva, p.event, p.dist, p.train_type, p.lead_min, p.model_version,
            CASE p.event WHEN 'a' THEN e.arr_delay_min ELSE e.dep_delay_min END AS delay,
            CASE p.event WHEN 'a' THEN e.arr_cancelled ELSE e.dep_cancelled END AS cancelled
     FROM prediction_snapshots p
     LEFT JOIN stop_events e ON e.service_date = p.service_date AND e.trip_id = p.trip_id AND e.eva = p.eva
     WHERE p.service_date = $1 AND p.source = $2`,
    [date, source],
  );
  if (!rows.length) return { date, source, snapshots: 0 };

  const hubs = new Set(city.hubs.map((h) => h.eva));
  const buckets = rows.map((r) => bucketOf(r.delay, r.cancelled ?? false));
  const byVersion = new Map<string, { rows: OutcomeRow[]; unlabelled: number }>();
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]!;
    const v = byVersion.get(r.model_version) ?? { rows: [], unlabelled: 0 };
    byVersion.set(r.model_version, v);
    const bucket = buckets[i];
    if (bucket === null || bucket === undefined) {
      v.unlabelled++;
      continue;
    }
    v.rows.push({
      dist: r.dist,
      bucket,
      delay: bucket === CANCELLED_BUCKET ? null : r.delay,
      trainType: r.train_type,
      stationGroup: hubs.has(r.eva) ? 'hub' : 'corridor',
      event: r.event,
      leadMin: r.lead_min,
    });
  }
  const clim = await climatology(pool);

  await withTransaction(async (c) => {
    await c.query(
      `UPDATE prediction_snapshots p SET
         observed_bucket = u.bucket, observed_delay = u.delay, rps = u.rps, log_loss = u.log_loss, scored_at = now()
       FROM unnest($3::bigint[], $4::text[], $5::char(1)[], $6::smallint[], $7::int[], $8::real[], $9::real[])
            AS u(trip_id, eva, event, bucket, delay, rps, log_loss)
       WHERE p.service_date = $1 AND p.source = $2
         AND p.trip_id = u.trip_id AND p.eva = u.eva AND p.event = u.event`,
      [
        date,
        source,
        rows.map((r) => r.trip_id),
        rows.map((r) => r.eva),
        rows.map((r) => r.event),
        buckets,
        rows.map((r) => r.delay),
        rows.map((r, i) => (buckets[i] == null ? null : rps(r.dist, buckets[i]!))),
        rows.map((r, i) => (buckets[i] == null ? null : logLoss(r.dist, buckets[i]!))),
      ],
    );
    await c.query('DELETE FROM accuracy_daily WHERE service_date = $1 AND source = $2', [date, source]);
    for (const [version, v] of byVersion) {
      if (!v.rows.length) continue;
      const a = aggregateAccuracy(v.rows, clim);
      await c.query(
        `INSERT INTO accuracy_daily (service_date, source, model_version, n, n_unlabelled, n_run, rps, log_loss,
           brier6, climatology_rps, top_bucket_hit, within80, mae_min, pred_late5, obs_late5,
           calibration, breakdown)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)`,
        [
          date, source, version, a.n, v.unlabelled, a.nRun, a.rps, a.logLoss, a.brier6, a.climatologyRps,
          a.topBucketHit, a.within80, a.maeMin, a.predLate5, a.obsLate5,
          JSON.stringify(a.calibration), JSON.stringify(a.breakdown),
        ],
      );
    }
  });
  const labelled = [...byVersion.values()].reduce((s, v) => s + v.rows.length, 0);
  return { date, source, snapshots: rows.length, labelled, unlabelled: rows.length - labelled };
}

/** Local calendar date (YYYY-MM-DD) `offsetDays` from today in `tz`. */
function localDate(tz: string, offsetDays = 0, now = new Date()): string {
  const p = toLocalParts(now, tz);
  return new Date(Date.UTC(p.year, p.month - 1, p.day) + offsetDays * DAY_MS).toISOString().slice(0, 10);
}

/** The most recent service day that is over: yesterday from 06:30 local, otherwise the day before. */
export function lastFinishedDay(tz: string, now = new Date()): string {
  const p = toLocalParts(now, tz);
  const pastCutoff = p.hour > SCORE_AFTER.hour || (p.hour === SCORE_AFTER.hour && p.minute >= SCORE_AFTER.minute);
  return localDate(tz, pastCutoff ? -1 : -2, now);
}

/**
 * Scores every finished day that still has unscored live snapshots. A service day counts as
 * finished from 06:30 local the next morning. `rescoreDays` also rescores the most recent
 * finished days to pick up labels that arrived late.
 */
export async function scorePending(city: CityConfig, opts: { rescoreDays?: number; now?: Date } = {}) {
  const now = opts.now ?? new Date();
  const finish = await startJob('score', city.id);
  try {
    const finalise = await finaliseLiveEvents();
    const lastFinished = lastFinishedDay(city.tz, now);
    const { rows } = await getPool().query<{ d: string }>(
      `SELECT DISTINCT service_date::text AS d FROM prediction_snapshots
       WHERE source = 'live' AND service_date <= $1
         AND (scored_at IS NULL OR service_date > $1::date - $2::int)
       ORDER BY 1`,
      [lastFinished, opts.rescoreDays ?? 0],
    );
    const days = [];
    for (const { d } of rows) days.push(await scoreDay(city, d, 'live'));
    const out = { finalise, days };
    await finish('ok', out);
    return out;
  } catch (err) {
    await finish('failed', { error: String(err) });
    throw err;
  }
}

/**
 * Replays the last `days` service days that have labelled data: for each day D the baseline is
 * rebuilt from events planned before D 00:00 local (so nothing from D itself leaks in), every
 * labelled stop of D at the polled stations is predicted and stored as source = 'replay', and
 * the day is scored like a live one.
 */
export async function replayAccuracy(city: CityConfig, days = 28) {
  const finish = await startJob('replay-accuracy', city.id);
  try {
    const evas = polledStations(city).map((s) => s.eva);
    const pool = getPool();
    const { rows: dayRows } = await pool.query<{ d: string; start: Date }>(
      `SELECT d::text, (d::timestamp AT TIME ZONE $3) AS start FROM (
         SELECT service_date AS d FROM stop_events
         WHERE service_date >= current_date - 180 AND service_date < current_date AND eva = ANY($1)
           AND (arr_delay_min IS NOT NULL OR dep_delay_min IS NOT NULL)
         GROUP BY 1 HAVING count(*) >= 200
         ORDER BY 1 DESC LIMIT $2) x
       ORDER BY d`,
      [evas, days, city.tz],
    );
    if (!dayRows.length) {
      await finish('ok', { days: 0 });
      return { days: 0, scored: [] };
    }
    const last = dayRows.at(-1)!.start;
    const asOf = new Date(last.getTime() + DAY_MS + 3 * 3600_000); // safely past the last day (DST)
    const spanDays = Math.ceil((asOf.getTime() - dayRows[0]!.start.getTime()) / DAY_MS);
    let predicted = 0;

    await withTransaction(async (c) => {
      await buildLabelledEvents(c, { asOf, windowDays: DEFAULT_WINDOW_DAYS + spanDays + 1, tz: city.tz });
      await c.query('CREATE TEMP TABLE agg_replay (LIKE agg_delay_stats INCLUDING ALL) ON COMMIT DROP');
      await c.query(`DELETE FROM prediction_snapshots WHERE source = 'replay' AND service_date = ANY($1::date[])`, [
        dayRows.map((r) => r.d),
      ]);
      for (const { d, start } of dayRows) {
        const t0 = Date.now();
        await c.query('TRUNCATE agg_replay');
        // Weights decay from the build's asOf; rescale so they decay from `start` instead.
        await aggregateInto(c, 'agg_replay', {
          from: new Date(start.getTime() - DEFAULT_WINDOW_DAYS * DAY_MS),
          to: start,
          scale: 2 ** ((asOf.getTime() - start.getTime()) / DAY_MS / DEFAULT_HALF_LIFE_DAYS),
        });
        const { rows } = await c.query<StopRow>(
          stopsSql(`e.service_date = $3 AND (ev.cancelled OR ev.delay IS NOT NULL)`),
          [evas, city.trainTypes, d],
        );
        let n = 0;
        for (let i = 0; i < rows.length; i += BATCH) {
          const batch = rows.slice(i, i + BATCH);
          const queries = batch.map(toQuery);
          const stats = await loadStats(queries, city.tz, c, 'agg_replay');
          const preds = queries.map((q) => blend(q, stats, DEFAULT_ALPHA, city.tz));
          n += await insertSnapshots(c, batch, preds, {
            source: 'replay',
            predictedAt: start,
            modelId: null,
            modelKind: 'baseline',
            modelVersion: 'baseline-v1',
          });
        }
        predicted += n;
        console.log(`[replay] ${d}: ${n} predictions (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
      }
    });

    const scored = [];
    for (const { d } of dayRows) scored.push(await scoreDay(city, d, 'replay'));
    const out = { days: dayRows.length, from: dayRows[0]!.d, to: dayRows.at(-1)!.d, predicted };
    await finish('ok', out);
    return { ...out, scored };
  } catch (err) {
    await finish('failed', { error: String(err) });
    throw err;
  }
}

/**
 * Rescores every stored day (replay, and live days that are over), e.g. after a metric
 * definition changes. Live days still in progress are left for the daily job.
 */
export async function rescoreAll(city: CityConfig, now = new Date()) {
  const { rows } = await getPool().query<{ d: string; source: Source }>(
    `SELECT DISTINCT service_date::text AS d, source FROM prediction_snapshots
     WHERE source = 'replay' OR service_date <= $1
     ORDER BY 1, 2`,
    [lastFinishedDay(city.tz, now)],
  );
  const days = [];
  for (const { d, source } of rows) days.push(await scoreDay(city, d, source));
  return days;
}
