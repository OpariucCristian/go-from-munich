/**
 * Accuracy of frozen predictions (see apps/worker/src/accuracy.ts): daily scores, calibration,
 * breakdowns and the biggest misses over the most recent scored days.
 */
import type { FastifyInstance } from 'fastify';
import { delaySummary, type CityConfig } from '@gfm/core';
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

export type AccuracySource = 'live' | 'replay' | 'all' | 'near';

interface DailyRow {
  date: string;
  source: 'live' | 'replay' | 'near';
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

export function registerAccuracyRoutes(app: FastifyInstance, city: CityConfig) {
  app.get<{ Querystring: { days?: number; source?: AccuracySource } }>(
    '/accuracy',
    {
      schema: {
        querystring: {
          type: 'object',
          properties: {
            days: { type: 'integer', minimum: 1, maximum: 365, default: 30 },
            // 'near' = predictions frozen 30–90 min before the stop, when live sightings count.
            source: { type: 'string', enum: ['live', 'replay', 'all', 'near'], default: 'all' },
          },
        },
      },
    },
    async (req) => {
      const days = req.query.days ?? 30;
      const source = req.query.source ?? 'all';
      const pool = getPool();
      const { rows } = await pool.query<DailyRow>(
        `SELECT service_date::text AS date, source, model_version, n, n_unlabelled, n_run, rps, log_loss, brier6,
                climatology_rps, top_bucket_hit, within80, mae_min, pred_late5, obs_late5, calibration, breakdown
         FROM accuracy_daily WHERE ($1 = 'all' AND source <> 'near') OR source = $1 ORDER BY service_date`,
        [source],
      );

      // One source per date: a live day is never mixed with (or double counted against) a replay.
      const byDate = new Map<string, DailyRow[]>();
      for (const r of rows) {
        const cur = byDate.get(r.date);
        if (!cur || (cur[0]!.source === 'replay' && r.source === 'live')) byDate.set(r.date, [r]);
        else if (cur[0]!.source === r.source) cur.push(r);
      }
      // The most recent `days` scored days (gaps, e.g. before live tracking started, are skipped).
      const picked = [...byDate].slice(-days);
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
                 WHERE source = $1 AND scored_at IS NULL AND service_date >= current_date - 7) AS pending,
                (SELECT min(service_date)::text FROM prediction_snapshots WHERE source = $1) AS tracking_since,
                (SELECT max(computed_at) FROM accuracy_daily WHERE source = $1) AS last_scored`,
        [source === 'near' ? 'near' : 'live'],
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
}

/**
 * The ten delay forecasts that scored worst (highest RPS) in the window. Cancellations are left
 * out: nearly every one scores as a miss (the model rarely gives them more than a few percent), so
 * they would crowd out the informative cases.
 */
async function biggestMisses(days: [string, 'live' | 'replay' | 'near'][]) {
  if (!days.length) return [];
  const { rows } = await getPool().query<{
    date: string; source: string; train_type: string; train_number: string; eva: string; name: string | null;
    event: 'a' | 'd'; planned: Date; dist: number[]; observed_bucket: number; observed_delay: number | null;
    rps: number;
  }>(
    `SELECT p.service_date::text AS date, p.source, p.train_type, p.train_number, p.eva, s.name, p.event,
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
