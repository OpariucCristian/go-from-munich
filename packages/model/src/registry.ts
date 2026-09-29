/**
 * Model registry on top of the `models` table: register trained models, promote the winner,
 * and load whichever model is active for serving.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { CityConfig } from '@gfm/core';
import { getPool, withTransaction } from '@gfm/db';
import { BaselinePredictor, type StopPrediction } from './baseline.ts';
import { FEATURE_VERSION } from './features.ts';
import { NowcastLayer } from './nowcast.ts';
import { OnnxPredictor } from './onnx.ts';
import type { StopQuery } from './groups.ts';

export interface ServingPredictor {
  kind: string;
  version: string;
  predict(queries: StopQuery[]): Promise<StopPrediction[]>;
}

export interface TrainMetrics {
  featureVersion?: number;
  lgbm: { rps: number; logLoss: number; n: number };
  baseline: { rps: number; logLoss: number; n: number };
  /** What is served without LightGBM (baseline + live nowcast) on the same rows, when exported. */
  reference?: { rps: number; logLoss: number; n: number };
  chunks: { start: string; end: string; split: string }[];
}

/**
 * Registers a trained model directory (model.onnx + metrics.json). It becomes active when its
 * validation RPS beats what is served without it (baseline + nowcast when the export recorded
 * that reference, else the baseline) on the same rows by at least `minGain` (relative), and the
 * currently active LightGBM model's recorded gain.
 */
export async function registerAndMaybePromote(modelDir: string, version: string, minGain = 0.002) {
  const metrics = JSON.parse(await readFile(path.join(modelDir, 'metrics.json'), 'utf8')) as TrainMetrics;
  const valid = metrics.chunks.find((c) => c.split === 'valid');
  return withTransaction(async (c) => {
    const active = await c.query<{ id: number; kind: string; metrics: TrainMetrics | null }>(
      'SELECT id, kind, metrics FROM models WHERE is_active',
    );
    const current = active.rows[0];
    const bar = (m: TrainMetrics) => m.reference ?? m.baseline;
    const beatsBaseline = metrics.lgbm.rps < bar(metrics).rps * (1 - minGain);
    // Compare against the active model on its own validation window; both are relative to their
    // references, so compare relative improvement.
    const gain = (m: TrainMetrics) => 1 - m.lgbm.rps / bar(m).rps;
    const beatsActive = !current || current.kind !== 'lgbm' || !current.metrics || gain(metrics) >= gain(current.metrics) - 0.01;
    const promote = beatsBaseline && beatsActive;
    if (promote) await c.query('UPDATE models SET is_active = false WHERE is_active');
    const { rows } = await c.query<{ id: number }>(
      `INSERT INTO models (kind, version, train_from, train_to, metrics, artifact_path, is_active)
       VALUES ('lgbm', $1, $2, $3, $4, $5, $6) RETURNING id`,
      [
        version,
        metrics.chunks[0]?.start ?? null,
        valid?.end ?? null,
        metrics,
        path.resolve(modelDir, 'model.onnx'),
        promote,
      ],
    );
    return {
      id: rows[0]!.id,
      promoted: promote,
      beatsBaseline,
      beatsActive,
      rps: metrics.lgbm.rps,
      baselineRps: metrics.baseline.rps,
      referenceRps: metrics.reference?.rps ?? null,
    };
  });
}

/**
 * Loads the active model (the baseline when none is active or the artifact can't be loaded),
 * wrapped in the live-delay nowcast unless NOWCAST=off.
 */
export async function loadActivePredictor(city: CityConfig): Promise<ServingPredictor & { id: number | null }> {
  const { predictor, id } = await loadActiveModel(city);
  // A model trained on sightings uses them itself; the nowcast tables would count them twice.
  const own = 'usesSightings' in predictor && predictor.usesSightings;
  const served = own || process.env.NOWCAST === 'off' ? predictor : new NowcastLayer(predictor, city.tz);
  return Object.assign(served, { id });
}

async function loadActiveModel(city: CityConfig): Promise<{ predictor: ServingPredictor; id: number | null }> {
  const { rows } = await getPool().query<{ id: number; kind: string; version: string; artifact_path: string | null; feature_version: number | null }>(
    `SELECT id, kind, version, artifact_path, (metrics->>'featureVersion')::int AS feature_version
     FROM models WHERE is_active`,
  );
  const active = rows[0];
  if (active?.kind === 'lgbm' && active.feature_version !== FEATURE_VERSION) {
    console.error(`[registry] ${active.version} was trained on features v${active.feature_version}, serving v${FEATURE_VERSION}: using the baseline`);
  } else if (active?.kind === 'lgbm' && active.artifact_path) {
    try {
      return { predictor: await OnnxPredictor.load(active.version, active.artifact_path, city), id: active.id };
    } catch (err) {
      console.error(`[registry] failed to load ${active.artifact_path}, falling back to baseline`, err);
    }
  }
  return { predictor: new BaselinePredictor('baseline-v1', undefined, city.tz), id: null };
}
