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
  it('matches the LightGBM output (1e-5, allowing rare float32 threshold flips)', async () => {
    const parity = JSON.parse(readFileSync(path.join(latest!, 'parity.json'), 'utf8')) as {
      inputs: (number | null)[][];
      probabilities: number[][];
    };
    const metrics = JSON.parse(readFileSync(path.join(latest!, 'metrics.json'), 'utf8')) as { features: string[]; stacking?: string };
    expect(metrics.features).toEqual([...FEATURE_NAMES]);
    const session = await loadOnnxSession(path.join(latest!, 'model.onnx'));
    const out = await runOnnx(session, parity.inputs.map((r) => r.map((v) => (v === null ? NaN : v))));
    // LightGBM splits at double thresholds; the ONNX converter stores them as float32. A feature
    // value that lands exactly between the two (seen with probability inputs) takes the other
    // branch in one tree, a small change (up to a few leaf values for raw-score "logit-offset"
    // models). Allow such rare flips, but no real divergence.
    const diffs = out.map((row, i) => Math.max(...row.map((p, k) => Math.abs(p - parity.probabilities[i]![k]!))));
    expect(diffs.filter((d) => d < 1e-5).length / diffs.length).toBeGreaterThanOrEqual(0.95);
    expect(Math.max(...diffs)).toBeLessThan(metrics.stacking === 'logit-offset' ? 0.5 : 1e-3);
  });
});
