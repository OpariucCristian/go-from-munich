/**
 * Node must reproduce the Python/LightGBM probabilities from the exported ONNX file.
 * Runs against the newest models/<version>/ that has a parity.json; skipped if none exists.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { FEATURE_NAMES, loadOnnxSession, runOnnx } from '../src/index.ts';

const modelsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../models');
const latest = existsSync(modelsDir)
  ? readdirSync(modelsDir)
      .map((d) => path.join(modelsDir, d))
      .filter((d) => existsSync(path.join(d, 'parity.json')))
      .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0]
  : undefined;

describe.skipIf(!latest)('ONNX parity', () => {
  it('matches LightGBM probabilities within 1e-5', async () => {
    const parity = JSON.parse(readFileSync(path.join(latest!, 'parity.json'), 'utf8')) as {
      inputs: (number | null)[][];
      probabilities: number[][];
    };
    const metrics = JSON.parse(readFileSync(path.join(latest!, 'metrics.json'), 'utf8')) as { features: string[] };
    expect(metrics.features).toEqual([...FEATURE_NAMES]);
    const session = await loadOnnxSession(path.join(latest!, 'model.onnx'));
    const out = await runOnnx(session, parity.inputs.map((r) => r.map((v) => (v === null ? NaN : v))));
    out.forEach((row, i) => row.forEach((p, k) => expect(Math.abs(p - parity.probabilities[i]![k]!)).toBeLessThan(1e-5)));
  });
});
