/**
 * Model registry on top of the `models` table: register trained models, promote the winner,
 * and load whichever model is active for serving.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { CityConfig } from '@gfm/core';
import { getPool, withTransaction } from '@gfm/db';
import { BaselinePredictor, type StopPrediction } from './baseline.ts';
import { NowcastLayer } from './nowcast.ts';
import { OnnxPredictor } from './onnx.ts';
import type { StopQuery } from './groups.ts';

export interface ServingPredictor {
  kind: string;
  version: string;
  predict(queries: StopQuery[]): Promise<StopPrediction[]>;
}

export interface TrainMetrics {
  lgbm: { rps: number; logLoss: number; n: number };
  baseline: { rps: number; logLoss: number; n: number };
  chunks: { start: string; end: string; split: string }[];
}

/**
 * Registers a trained model directory (model.onnx + metrics.json). It becomes active when its
 * validation RPS beats both the baseline on the same rows and the currently active LightGBM
 * model's recorded RPS (by at least `minGain`, relative).
 */
export async function registerAndMaybePromote(modelDir: string, version: string, minGain = 0.002) {
  const metrics = JSON.parse(await readFile(path.join(modelDir, 'metrics.json'), 'utf8')) as TrainMetrics;
  const valid = metrics.chunks.find((c) => c.split === 'valid');
  return withTransaction(async (c) => {
    const active = await c.query<{ id: number; kind: string; metrics: TrainMetrics | null }>(
      'SELECT id, kind, metrics FROM models WHERE is_active',
    );
    const current = active.rows[0];
    const beatsBaseline = metrics.lgbm.rps < metrics.baseline.rps * (1 - minGain);
    // Compare against the active model on its own validation window; both are relative to their
    // baselines, so compare relative improvement over the baseline.
    const gain = (m: TrainMetrics) => 1 - m.lgbm.rps / m.baseline.rps;
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
    return { id: rows[0]!.id, promoted: promote, beatsBaseline, beatsActive, rps: metrics.lgbm.rps, baselineRps: metrics.baseline.rps };
  });
}

/**
 * Loads the active model (the baseline when none is active or the artifact can't be loaded),
 * wrapped in the live-delay nowcast unless NOWCAST=off.
 */
export async function loadActivePredictor(city: CityConfig): Promise<ServingPredictor & { id: number | null }> {
  const { predictor, id } = await loadActiveModel(city);
  const served = process.env.NOWCAST === 'off' ? predictor : new NowcastLayer(predictor, city.tz);
  return Object.assign(served, { id });
}

async function loadActiveModel(city: CityConfig): Promise<{ predictor: ServingPredictor; id: number | null }> {
  const { rows } = await getPool().query<{ id: number; kind: string; version: string; artifact_path: string | null }>(
    'SELECT id, kind, version, artifact_path FROM models WHERE is_active',
  );
  const active = rows[0];
  if (active?.kind === 'lgbm' && active.artifact_path) {
    try {
      return { predictor: await OnnxPredictor.load(active.version, active.artifact_path, city), id: active.id };
    } catch (err) {
      console.error(`[registry] failed to load ${active.artifact_path}, falling back to baseline`, err);
    }
  }
  return { predictor: new BaselinePredictor('baseline-v1', undefined, city.tz), id: null };
}
