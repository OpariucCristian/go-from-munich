/**
 * Accuracy of frozen predictions (see apps/worker/src/accuracy.ts): daily scores, calibration,
 * breakdowns and the biggest misses over the most recent scored days, plus predicted vs actual
 * delay per train run.
 */
import type { FastifyInstance } from 'fastify';
import { CANCELLED_BUCKET, delaySummary, type CityConfig } from '@gfm/core';
import { getPool } from '@gfm/db';
import {
  greenCallShare,
  lateProbability,
  mergeBreakdown,
  mergeCalibration,
  mergeMetrics,
  type AccuracyMetrics,
  type Breakdown,
  type CalibrationBin,
} from '@gfm/model';

export type AccuracySource = 'live' | 'replay' | 'all';

interface DailyRow {
  date: string;
  source: 'live' | 'replay';
  model_version: string;
  n: number;
  n_unlabelled: number;
  n_run: number;
  rps: number;
  log_loss: number;
  brier6: number;
  climatology_rps: number | null;
  top_bucket_hit: number;
  within80: number | null;
  mae_min: number | null;
  pred_late5: number;
  obs_late5: number;
  calibration: CalibrationBin[];
  breakdown: Breakdown;
}

const metricsOf = (r: DailyRow): AccuracyMetrics => ({
  n: r.n,
  nRun: r.n_run,
  rps: r.rps,
  logLoss: r.log_loss,
  brier6: r.brier6,
  climatologyRps: r.climatology_rps,
  topBucketHit: r.top_bucket_hit,
  within80: r.within80,
  maeMin: r.mae_min,
  predLate5: r.pred_late5,
  obsLate5: r.obs_late5,
});

type DayPick = [date: string, rows: DailyRow[]];

/**
 * The most recent `days` scored days and their daily rows, one source per date: a live day is
 * never mixed with (or double counted against) a replay. Gaps, e.g. before live tracking started,
 * are skipped.
 */
async function scoredDays(source: AccuracySource, days: number): Promise<DayPick[]> {
  const { rows } = await getPool().query<DailyRow>(
    `SELECT service_date::text AS date, source, model_version, n, n_unlabelled, n_run, rps, log_loss, brier6,
            climatology_rps, top_bucket_hit, within80, mae_min, pred_late5, obs_late5, calibration, breakdown
     FROM accuracy_daily WHERE ($1 = 'all' OR source = $1) ORDER BY service_date`,
    [source],
  );
  const byDate = new Map<string, DailyRow[]>();
  for (const r of rows) {
    const cur = byDate.get(r.date);
    if (!cur || (cur[0]!.source === 'replay' && r.source === 'live')) byDate.set(r.date, [r]);
    else if (cur[0]!.source === r.source) cur.push(r);
  }
  return [...byDate].slice(-days);
}

/** One scored stop event of a run, as read from `prediction_snapshots`. */
export interface RunStopRow {
  date: string;
  source: 'live' | 'replay';
  trip_id: string;
  train_type: string;
  train_number: string;
  planned: Date;
  model_version: string;
  dist: number[];
  observed_bucket: number;
  observed_delay: number | null;
}

export type RunSort = 'miss' | 'recent';

/** Predicted vs actual delay for one train run (one trip on one service date). */
export interface RunSummary {
  date: string;
  source: 'live' | 'replay';
  tripId: string;
  trainType: string;
  trainNumber: string;
  firstPlanned: string;
  stops: number;
  cancelled: number;
  /** Means over the stops that ran (not cancelled); null when none ran. */
  predictedMedian: number | null;
  observedDelay: number | null;
  maeMin: number | null;
  within80: number | null;
  /** Largest |likely − actual| at one stop, in minutes. */
  worstMissMin: number | null;
  modelVersions: string[];
}

/**
 * Groups scored stop events into runs. Early counts as 0 min late. Unlike the daily scores, delays
 * past the modelled range are not clamped: this view shows what really happened to one train.
 */
export function summarizeRuns(rows: RunStopRow[], sort: RunSort = 'miss'): RunSummary[] {
  const runs = new Map<string, { first: RunStopRow; rows: RunStopRow[] }>();
  for (const r of rows) {
    const key = `${r.date}|${r.trip_id}|${r.source}`;
    const run = runs.get(key);
    if (run) run.rows.push(r);
    else runs.set(key, { first: r, rows: [r] });
  }
  const out = [...runs.values()].map(({ first, rows: rs }): RunSummary => {
    let ran = 0, pred = 0, obs = 0, err = 0, within = 0, worst = 0;
    for (const r of rs) {
      if (r.observed_bucket === CANCELLED_BUCKET) continue;
      const { median, p80 } = delaySummary(r.dist);
      const actual = actualDelay(r.observed_delay);
      const miss = Math.abs(actual - median);
      ran++;
      pred += median;
      obs += actual;
      err += miss;
      if (actual <= p80) within++;
      worst = Math.max(worst, miss);
    }
    const planned = rs.reduce((a, r) => (r.planned < a ? r.planned : a), first.planned);
    return {
      date: first.date,
      source: first.source,
      tripId: first.trip_id,
      trainType: first.train_type,
      trainNumber: first.train_number,
      firstPlanned: planned.toISOString(),
      stops: rs.length,
      cancelled: rs.length - ran,
      predictedMedian: ran ? pred / ran : null,
      observedDelay: ran ? obs / ran : null,
      maeMin: ran ? err / ran : null,
      within80: ran ? within / ran : null,
      worstMissMin: ran ? worst : null,
      modelVersions: [...new Set(rs.map((r) => r.model_version))],
    };
  });
  const recent = (a: RunSummary, b: RunSummary) =>
    b.date.localeCompare(a.date) || a.firstPlanned.localeCompare(b.firstPlanned);
  return out.sort(
    sort === 'recent'
      ? recent
      : (a, b) => (b.maeMin ?? -1) - (a.maeMin ?? -1) || b.cancelled - a.cancelled || recent(a, b),
  );
}

const actualDelay = (d: number | null) => Math.max(0, d ?? 0);

export function registerAccuracyRoutes(app: FastifyInstance, city: CityConfig) {
  app.get<{ Querystring: { days?: number; source?: AccuracySource } }>(
    '/accuracy',
    {
      schema: {
        querystring: {
          type: 'object',
          properties: {
            days: { type: 'integer', minimum: 1, maximum: 365, default: 30 },
            source: { type: 'string', enum: ['live', 'replay', 'all'], default: 'all' },
          },
        },
      },
    },
    async (req) => {
      const days = req.query.days ?? 30;
      const source = req.query.source ?? 'all';
      const pool = getPool();
      const picked = await scoredDays(source, days);
      const all = picked.flatMap(([, rs]) => rs);

      const daily = picked.map(([date, rs]) => ({
        date,
        source: rs[0]!.source,
        modelVersions: rs.map((r) => r.model_version),
        unlabelled: rs.reduce((a, r) => a + r.n_unlabelled, 0),
        green: greenCallShare(mergeCalibration(rs.map((r) => r.calibration))),
        ...mergeMetrics(rs.map(metricsOf)),
      }));
      const calibration = mergeCalibration(all.map((r) => r.calibration));
      const models = new Map<string, number>();
      for (const r of all) models.set(r.model_version, (models.get(r.model_version) ?? 0) + r.n);

      const misses = await biggestMisses(picked.map(([date, rs]) => [date, rs[0]!.source]));
      const status = await pool.query<{ pending: number; tracking_since: string | null; last_scored: Date | null }>(
        `SELECT (SELECT count(*)::int FROM prediction_snapshots
                 WHERE source = 'live' AND scored_at IS NULL AND service_date >= current_date - 7) AS pending,
                (SELECT min(service_date)::text FROM prediction_snapshots WHERE source = 'live') AS tracking_since,
                (SELECT max(computed_at) FROM accuracy_daily WHERE source = 'live') AS last_scored`,
      );
      const s = status.rows[0]!;
      return {
        source,
        from: picked[0]?.[0] ?? null,
        to: picked.at(-1)?.[0] ?? null,
        total: all.length ? { ...mergeMetrics(all.map(metricsOf)), green: greenCallShare(calibration) } : null,
        daily,
        calibration,
        breakdown: mergeBreakdown(all.map((r) => r.breakdown)),
        models: [...models].map(([version, n]) => ({ version, n })),
        misses,
        live: {
          trackingSince: s.tracking_since,
          pendingSnapshots: s.pending,
          lastScoredAt: s.last_scored?.toISOString() ?? null,
        },
        tz: city.tz,
      };
    },
  );

  // Runs in the same window as /accuracy, each with its predicted vs actual delay.
  app.get<{ Querystring: { days?: number; source?: AccuracySource; sort?: RunSort; train?: string; limit?: number } }>(
    '/accuracy/runs',
    {
      schema: {
        querystring: {
          type: 'object',
          properties: {
            days: { type: 'integer', minimum: 1, maximum: 365, default: 30 },
            source: { type: 'string', enum: ['live', 'replay', 'all'], default: 'all' },
            sort: { type: 'string', enum: ['miss', 'recent'], default: 'miss' },
            train: { type: 'string', maxLength: 30 },
            limit: { type: 'integer', minimum: 1, maximum: 200, default: 50 },
          },
        },
      },
    },
    async (req) => {
      const { days = 30, source = 'all', sort = 'miss', limit = 50 } = req.query;
      const train = req.query.train?.trim().replace(/\s+/g, ' ') || null;
      const picked = await scoredDays(source, days);
      if (!picked.length) return { runs: [], total: 0, tz: city.tz };
      const { rows } = await getPool().query<RunStopRow>(
        `SELECT p.service_date::text AS date, p.source, p.trip_id::text, p.train_type, p.train_number, p.planned,
                p.model_version, p.dist, p.observed_bucket, p.observed_delay
         FROM prediction_snapshots p
         JOIN unnest($1::date[], $2::text[]) AS d(day, source) ON p.service_date = d.day AND p.source = d.source
         WHERE p.rps IS NOT NULL
           AND ($3::text IS NULL OR (p.train_type || ' ' || p.train_number) ILIKE '%' || $3 || '%')`,
        [picked.map(([d]) => d), picked.map(([, rs]) => rs[0]!.source), train],
      );
      const runs = summarizeRuns(rows, sort);
      return { runs: runs.slice(0, limit), total: runs.length, tz: city.tz };
    },
  );

  // Stop by stop forecast vs outcome for one run.
  app.get<{ Querystring: { date: string; trip: string; source: 'live' | 'replay' } }>(
    '/accuracy/run',
    {
      schema: {
        querystring: {
          type: 'object',
          required: ['date', 'trip', 'source'],
          properties: {
            date: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
            trip: { type: 'string', pattern: '^\\d{1,18}$' },
            source: { type: 'string', enum: ['live', 'replay'] },
          },
        },
      },
    },
    async (req, reply) => {
      const { date, trip, source } = req.query;
      const { rows } = await getPool().query<RunStopRow & {
        eva: string; name: string | null; event: 'a' | 'd'; lead_min: number; rps: number;
      }>(
        `SELECT p.service_date::text AS date, p.source, p.trip_id::text, p.train_type, p.train_number, p.planned,
                p.model_version, p.dist, p.observed_bucket, p.observed_delay, p.eva, s.name, p.event, p.lead_min, p.rps
         FROM prediction_snapshots p
         LEFT JOIN stations s ON s.eva = p.eva
         WHERE p.service_date = $1 AND p.trip_id = $2 AND p.source = $3 AND p.rps IS NOT NULL
         ORDER BY p.planned, p.event`,
        [date, trip, source],
      );
      if (!rows.length) return reply.code(404).send({ message: 'No scored predictions for this run' });
      return {
        run: summarizeRuns(rows)[0]!,
        stops: rows.map((r) => {
          const s = delaySummary(r.dist);
          const cancelled = r.observed_bucket === CANCELLED_BUCKET;
          return {
            eva: r.eva,
            station: r.name ?? r.eva,
            event: r.event,
            planned: r.planned.toISOString(),
            leadMin: r.lead_min,
            modelVersion: r.model_version,
            predictedMedian: s.median,
            predictedP80: s.p80,
            predictedLate5: lateProbability(r.dist),
            predictedCancelled: r.dist[CANCELLED_BUCKET] ?? 0,
            observedDelay: r.observed_delay,
            cancelled,
            within80: cancelled ? null : actualDelay(r.observed_delay) <= s.p80,
            rps: r.rps,
          };
        }),
        tz: city.tz,
      };
    },
  );
}

/**
 * The ten delay forecasts that scored worst (highest RPS) in the window. Cancellations are left
 * out: nearly every one scores as a miss (the model rarely gives them more than a few percent), so
 * they would crowd out the informative cases.
 */
async function biggestMisses(days: [string, 'live' | 'replay'][]) {
  if (!days.length) return [];
  const { rows } = await getPool().query<{
    date: string; source: string; trip_id: string; train_type: string; train_number: string; eva: string;
    name: string | null; event: 'a' | 'd'; planned: Date; dist: number[]; observed_bucket: number;
    observed_delay: number | null; rps: number;
  }>(
    `SELECT p.service_date::text AS date, p.source, p.trip_id::text, p.train_type, p.train_number, p.eva, s.name, p.event,
            p.planned, p.dist, p.observed_bucket, p.observed_delay, p.rps
     FROM prediction_snapshots p
     JOIN unnest($1::date[], $2::text[]) AS d(day, source) ON p.service_date = d.day AND p.source = d.source
     LEFT JOIN stations s ON s.eva = p.eva
     WHERE p.rps IS NOT NULL AND p.observed_bucket <> 7
     ORDER BY p.rps DESC
     LIMIT 10`,
    [days.map((d) => d[0]), days.map((d) => d[1])],
  );
  return rows.map((r) => ({
    date: r.date,
    source: r.source,
    tripId: r.trip_id,
    trainType: r.train_type,
    trainNumber: r.train_number,
    eva: r.eva,
    station: r.name ?? r.eva,
    event: r.event,
    planned: r.planned.toISOString(),
    predictedMedian: delaySummary(r.dist).median,
    predictedLate5: lateProbability(r.dist),
    predictedCancelled: r.dist[7] ?? 0,
    observedBucket: r.observed_bucket,
    observedDelay: r.observed_delay,
    cancelled: r.observed_bucket === 7,
    rps: r.rps,
  }));
}
