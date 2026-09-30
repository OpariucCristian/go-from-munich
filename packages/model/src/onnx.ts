/**
 * Serves the LightGBM model exported to ONNX. Features come from the same `buildFeatures` used
 * for training export. Falls back to the baseline distribution for any row the model can't score.
 *
 * Two kinds of model: standalone ones output probabilities; "logit-offset" ones (trained on RPS
 * starting from the reference, see ml/train.py) output raw tree scores that are added to the log
 * of the served-without-LightGBM distribution (baseline + nowcast).
 */
import * as ort from 'onnxruntime-node';
import { NUM_BUCKETS, normalize, type CityConfig } from '@gfm/core';
import { getPool } from '@gfm/db';
import { BaselinePredictor, type StopPrediction } from './baseline.ts';
import { FEATURE_NAMES, buildFeatures, originStartToDate, type FeatureContext, type StopExtras } from './features.ts';
import type { StopQuery } from './groups.ts';
import { NETWORK_MAX_LEAD_MIN, loadNetworkIndex, networkCutoff, networkStations } from './network.ts';
import { applyNowcast, loadNowcastStats, loadSightings } from './nowcast.ts';
import { loadWeather, snapshotFeatures, weatherSnapshot } from './weather.ts';

export async function loadOnnxSession(modelPath: string): Promise<ort.InferenceSession> {
  return ort.InferenceSession.create(modelPath, { intraOpNumThreads: 2 });
}

/** Run the session on a row-major feature matrix; returns one output vector per row (probabilities or raw scores). */
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

export type Stacking = 'none' | 'logit-offset';

/**
 * Which stops the model corrects: all, only those with a live sighting, or those forecast at most
 * NETWORK_MAX_LEAD_MIN ahead (network state known). The rest keep the reference.
 */
export type AppliesTo = 'all' | 'sighted' | 'near';

/** Passed stops further back than this get no network state (keeps the event lookup small). */
const NETWORK_LOOKBACK_MS = 6 * 3600_000;

export interface OnnxOptions {
  stacking?: Stacking;
  refFloor?: number;
  appliesTo?: AppliesTo;
  /** False when the model was trained with the weather columns blanked: its forecasts then say nothing about weather. */
  usesWeather?: boolean;
}

/** softmax(log ref + raw), with the reference floored and renormalised exactly as in training. */
export function stackLogitOffset(ref: number[], raw: number[], floor = 1e-6): number[] {
  const floored = ref.map((p) => Math.max(p, floor));
  const total = floored.reduce((a, b) => a + b, 0);
  const z = floored.map((p, k) => Math.log(p / total) + raw[k]!);
  const top = Math.max(...z);
  const e = z.map((v) => Math.exp(v - top));
  const sum = e.reduce((a, b) => a + b, 0);
  return e.map((v) => v / sum);
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
  private readonly hubEvas: string[];
  private readonly watched: string[];
  private readonly trainTypes: string[];

  constructor(
    readonly version: string,
    private readonly session: ort.InferenceSession,
    private readonly baseline: BaselinePredictor,
    city: CityConfig,
    private readonly opts: OnnxOptions = {},
  ) {
    this.ctx = { trainTypes: city.trainTypes, hubEvas: new Set(city.hubs.map((h) => h.eva)), tz: city.tz };
    this.homePoint = city.weatherPoints[0]?.id ?? '';
    this.hubEvas = city.hubs.map((h) => h.eva);
    this.watched = networkStations(city);
    this.trainTypes = city.trainTypes;
  }

  static async load(
    version: string,
    modelPath: string,
    city: CityConfig,
    opts: OnnxOptions = {},
  ): Promise<OnnxPredictor> {
    const baseline = new BaselinePredictor('baseline-v1', undefined, city.tz);
    return new OnnxPredictor(version, await loadOnnxSession(modelPath), baseline, city, opts);
  }

  async predict(queries: StopQuery[], now = new Date()): Promise<StopPrediction[]> {
    if (!queries.length) return [];
    const times = queries.map((q) => q.planned.getTime());
    // Network state as of now (or just before a passed stop), for stops within reach of it.
    const cutoffs = queries.map((q) => {
      const t = q.planned.getTime();
      const near = t <= now.getTime() + NETWORK_MAX_LEAD_MIN * 60_000 && t > now.getTime() - NETWORK_LOOKBACK_MS;
      return near ? networkCutoff(q.planned, now) : null;
    });
    const [base, extras, sightings, weather, network] = await Promise.all([
      this.baseline.predict(queries),
      loadExtras(queries, this.ctx.tz),
      loadSightings(queries, now, this.ctx.tz),
      loadWeather(getPool(), new Date(Math.min(...times)), new Date(Math.max(...times))),
      loadNetworkIndex(cutoffs.filter((c) => c !== null), this.watched, this.hubEvas, this.trainTypes),
    ]);
    const net = queries.map((q, i) => (cutoffs[i] ? network.features(q.eva, q.planned, cutoffs[i]!) : undefined));
    // As in the training export: sighted stops start from the baseline with the nowcast applied.
    const sighted = queries.flatMap((q, i) => (sightings[i] ? [{ q, sighting: sightings[i]! }] : []));
    const nowcast = sighted.length ? await loadNowcastStats(sighted) : new Map();
    const stacked = base.map((b, i) =>
      sightings[i] ? { ...b, distribution: applyNowcast(b.distribution, queries[i]!, sightings[i]!, nowcast) } : b,
    );
    const withSighting = (b: StopPrediction, i: number) => (sightings[i] ? { ...b, sighting: sightings[i]! } : b);
    try {
      const applies = (i: number) =>
        this.opts.appliesTo === 'sighted' ? !!sightings[i] : this.opts.appliesTo === 'near' ? Number.isFinite(net[i]?.[0]) : true;
      const scored = queries.flatMap((_, i) => (applies(i) ? [i] : []));
      const wx = new Map(scored.map((i) => [i, weatherSnapshot(queries[i]!.planned, weather, this.homePoint)]));
      const rows = scored.map((i) =>
        buildFeatures(
          queries[i]!,
          stacked[i]!,
          { ...extras[i]!, sighting: sightings[i], weather: snapshotFeatures(wx.get(i)!), network: net[i] },
          this.ctx,
        ),
      );
      const out = rows.length ? await runOnnx(this.session, rows) : [];
      const byIdx = new Map(scored.map((i, n) => [i, out[n]!]));
      return stacked.map((b, i) => {
        const o = byIdx.get(i);
        // Rows the model does not correct keep the reference (baseline + nowcast).
        if (!o) return withSighting(b, i);
        const distribution =
          this.opts.stacking === 'logit-offset' ? stackLogitOffset(b.distribution, o, this.opts.refFloor) : normalize(o);
        const weather = this.opts.usesWeather === false ? {} : { weather: wx.get(i)! };
        return withSighting({ ...base[i]!, distribution, ...weather }, i);
      });
    } catch (err) {
      console.error('[onnx] scoring failed, using baseline + nowcast', err);
      return stacked.map(withSighting);
    }
  }
}
