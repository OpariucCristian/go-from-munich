import { describe, expect, it } from 'vitest';
import { stackLogitOffset } from '../src/onnx.ts';

const ref = [0.7, 0.15, 0.07, 0.04, 0.02, 0.01, 0.005, 0.005];

describe('stackLogitOffset', () => {
  it('returns the reference when the trees add nothing', () => {
    stackLogitOffset(ref, new Array(8).fill(0)).forEach((p, k) => expect(p).toBeCloseTo(ref[k]!, 12));
    // A constant shift across classes changes nothing either (softmax is shift-invariant).
    stackLogitOffset(ref, new Array(8).fill(3.2)).forEach((p, k) => expect(p).toBeCloseTo(ref[k]!, 12));
  });

  it('is softmax(log ref + raw)', () => {
    const raw = [-0.3, 0.1, 0.2, 0.05, 0.4, -0.1, 0, 0.25];
    const e = ref.map((p, k) => p * Math.exp(raw[k]!));
    const total = e.reduce((a, b) => a + b, 0);
    stackLogitOffset(ref, raw).forEach((p, k) => expect(p).toBeCloseTo(e[k]! / total, 12));
  });

  it('floors zero reference probabilities so the trees can still move mass there', () => {
    const p = stackLogitOffset([1, 0, 0, 0, 0, 0, 0, 0], [0, 0, 0, 0, 0, 0, 0, 5]);
    expect(p[7]).toBeGreaterThan(1e-4);
    expect(p.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 12);
  });
});
