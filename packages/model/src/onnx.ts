/**
 * Serves the LightGBM model exported to ONNX. Features come from the same `buildFeatures` used
 * for training export. Falls back to the baseline distribution for any row the model can't score.
 */
import * as ort from 'onnxruntime-node';
import { NUM_BUCKETS, normalize, type CityConfig } from '@gfm/core';
import { getPool } from '@gfm/db';
import { BaselinePredictor, type StopPrediction } from './baseline.ts';
import { FEATURE_NAMES, buildFeatures, originStartToDate, type FeatureContext, type StopExtras } from './features.ts';
import type { StopQuery } from './groups.ts';
import { applyNowcast, loadNowcastStats, loadSightings } from './nowcast.ts';
import { loadWeather, weatherFeatures } from './weather.ts';

export async function loadOnnxSession(modelPath: string): Promise<ort.InferenceSession> {
  return ort.InferenceSession.create(modelPath, { intraOpNumThreads: 2 });
}

/** Run the session on a row-major feature matrix; returns one probability vector per row. */
export async function runOnnx(session: ort.InferenceSession, rows: number[][]): Promise<number[][]> {
  const n = rows.length;
  const width = FEATURE_NAMES.length;
  const data = new Float32Array(n * width);
  rows.forEach((r, i) => data.set(r.map((v) => (Number.isFinite(v) ? v : NaN)), i * width));
  const out = await session.run({ input: new ort.Tensor('float32', data, [n, width]) });
  const probsName = session.outputNames.find((o) => o.includes('prob')) ?? session.outputNames[1]!;
  const probs = out[probsName]!.data as Float32Array;
  return Array.from({ length: n }, (_, i) => Array.from(probs.subarray(i * NUM_BUCKETS, (i + 1) * NUM_BUCKETS)));
}

/** Stop sequence and origin start for the latest known run of each queried train at that station. */
async function loadExtras(queries: StopQuery[], tz: string): Promise<StopExtras[]> {
  const { rows } = await getPool().query<{ i: number; stop_seq: number | null; origin_start: string; service_date: string; planned: Date }>(
    `SELECT DISTINCT ON (q.i) q.i, e.stop_seq, t.origin_start, t.service_date::text,
            COALESCE(e.planned_dep, e.planned_arr) AS planned
     FROM unnest($1::text[], $2::text[], $3::text[]) WITH ORDINALITY AS q(eva, train_type, train_number, i)
     JOIN trips t ON t.train_type = q.train_type AND t.train_number = q.train_number
                 AND t.service_date >= current_date - 90
     JOIN stop_events e ON e.trip_id = t.id AND e.service_date = t.service_date AND e.eva = q.eva
     ORDER BY q.i, t.service_date DESC`,
    [queries.map((q) => q.eva), queries.map((q) => q.trainType), queries.map((q) => q.trainNumber)],
  );
  const byIdx = new Map(rows.map((r) => [Number(r.i) - 1, r]));
  return queries.map((q, i) => {
    const r = byIdx.get(i);
    if (!r) return { stopSeq: null, originStart: null };
    // Project the known run's origin offset onto the queried date.
    const origin = originStartToDate(r.origin_start, tz);
    const offset = origin ? r.planned.getTime() - origin.getTime() : null;
    return {
      stopSeq: r.stop_seq,
      originStart: offset !== null ? new Date(q.planned.getTime() - offset) : null,
    };
  });
}

export class OnnxPredictor {
  readonly kind = 'lgbm';
  /** Live sightings are model inputs (features v3), so no separate nowcast layer on top. */
  readonly usesSightings = true;
  private readonly ctx: FeatureContext;
  private readonly homePoint: string;

  constructor(
    readonly version: string,
    private readonly session: ort.InferenceSession,
    private readonly baseline: BaselinePredictor,
    city: CityConfig,
  ) {
    this.ctx = { trainTypes: city.trainTypes, hubEvas: new Set(city.hubs.map((h) => h.eva)), tz: city.tz };
    this.homePoint = city.weatherPoints[0]?.id ?? '';
  }

  static async load(version: string, modelPath: string, city: CityConfig): Promise<OnnxPredictor> {
    return new OnnxPredictor(version, await loadOnnxSession(modelPath), new BaselinePredictor('baseline-v1', undefined, city.tz), city);
  }

  async predict(queries: StopQuery[], now = new Date()): Promise<StopPrediction[]> {
    if (!queries.length) return [];
    const times = queries.map((q) => q.planned.getTime());
    const [base, extras, sightings, weather] = await Promise.all([
      this.baseline.predict(queries),
      loadExtras(queries, this.ctx.tz),
      loadSightings(queries, now, this.ctx.tz),
      loadWeather(getPool(), new Date(Math.min(...times)), new Date(Math.max(...times))),
    ]);
    // As in the training export: sighted stops start from the baseline with the nowcast applied.
    const sighted = queries.flatMap((q, i) => (sightings[i] ? [{ q, sighting: sightings[i]! }] : []));
    const nowcast = sighted.length ? await loadNowcastStats(sighted) : new Map();
    const stacked = base.map((b, i) =>
      sightings[i] ? { ...b, distribution: applyNowcast(b.distribution, queries[i]!, sightings[i]!, nowcast) } : b,
    );
    try {
      const rows = queries.map((q, i) =>
        buildFeatures(q, stacked[i]!, { ...extras[i]!, sighting: sightings[i], weather: weatherFeatures(q.planned, weather, this.homePoint) }, this.ctx),
      );
      const probs = await runOnnx(this.session, rows);
      return base.map((b, i) => ({ ...b, distribution: normalize(probs[i]!), ...(sightings[i] ? { sighting: sightings[i]! } : {}) }));
    } catch (err) {
      console.error('[onnx] scoring failed, using baseline + nowcast', err);
      return stacked.map((b, i) => (sightings[i] ? { ...b, sighting: sightings[i]! } : b));
    }
  }
}
