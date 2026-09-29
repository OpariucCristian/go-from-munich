import { describe, expect, it } from 'vitest';
import { applyNowcast, gapBand, nowcastKeys, type NowcastRow } from '../src/nowcast.ts';

const q = { eva: '8000261', trainType: 'ICE', event: 'a' as const };
const model = [0.7, 0.15, 0.07, 0.04, 0.02, 0.01, 0.005, 0.005];

function stats(rows: Omit<NowcastRow, 'event' | 'n'>[]): Map<string, NowcastRow> {
  return new Map(rows.map((r) => [`${r.level}|${r.key}|a`, { ...r, event: 'a', n: r.weights.reduce((a, b) => a + b, 0) }]));
}

describe('gapBand', () => {
  it('bands minutes between the sighting and the target', () => {
    expect(gapBand(4)).toBeNull();
    expect(gapBand(5)).toBe(0);
    expect(gapBand(14.9)).toBe(0);
    expect(gapBand(15)).toBe(1);
    expect(gapBand(119)).toBe(3);
    expect(gapBand(240)).toBe(4);
    expect(gapBand(241)).toBeNull();
    expect(gapBand(NaN)).toBeNull();
  });

  it('builds keys from general to specific, matching the SQL rollup', () => {
    expect(nowcastKeys('8000261', 'ICE', 4, 2).map((k) => `${k.level}:${k.key}`)).toEqual([
      '3:4|2',
      '2:ICE|4|2',
      '1:8000261|ICE|4|2',
    ]);
    expect(nowcastKeys('8000261', 'ICE', '*', 2)[2]!.key).toBe('8000261|ICE|*|2');
  });
});

describe('applyNowcast', () => {
  const late = stats([
    { level: 3, key: '4|1', weights: [2, 2, 5, 20, 150, 15, 3, 3] },
    { level: 3, key: '*|1', weights: [140, 30, 12, 8, 5, 2, 2, 1] },
  ]);

  it('passes the model through without tables, outside the horizon or for too short a gap', () => {
    expect(applyNowcast(model, q, { delayMin: 20, gapMin: 20 }, new Map())).toBe(model);
    expect(applyNowcast(model, q, { delayMin: 20, gapMin: 300 }, late)).toBe(model);
    expect(applyNowcast(model, q, { delayMin: 20, gapMin: 3 }, late)).toBe(model);
  });

  it('moves mass towards the delay seen at the earlier stop', () => {
    for (const mode of ['dirichlet', 'ratio'] as const) {
      const p = applyNowcast(model, q, { delayMin: 20, gapMin: 20 }, late, { mode });
      expect(p.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 9);
      expect(p[4]).toBeGreaterThan(0.4);
      expect(p[0]).toBeLessThan(model[0]!);
    }
  });

  it('ratio mode leaves the model alone when the sighting is typical', () => {
    const typical = stats([
      { level: 3, key: '0|1', weights: [140, 30, 12, 8, 5, 2, 2, 1] },
      { level: 3, key: '*|1', weights: [140, 30, 12, 8, 5, 2, 2, 1] },
    ]);
    const p = applyNowcast(model, q, { delayMin: 1, gapMin: 20 }, typical, { mode: 'ratio' });
    p.forEach((x, i) => expect(x).toBeCloseTo(model[i]!, 9));
  });

  it('lets a specific level refine the general one', () => {
    const s = stats([
      { level: 3, key: '4|1', weights: [2, 2, 5, 20, 150, 15, 3, 3] },
      { level: 1, key: '8000261|ICE|4|1', weights: [0, 0, 0, 0, 0, 400, 0, 0] },
    ]);
    const p = applyNowcast(model, q, { delayMin: 20, gapMin: 20 }, s, { mode: 'dirichlet' });
    expect(p[5]).toBeGreaterThan(0.8);
  });
});

describe('training sighting sampler', () => {
  it('gives about half the rows a stable "now" 5–240 min before the stop', async () => {
    const { sampledCutoff, SIGHTED_SHARE } = await import('../src/trainingData.ts');
    const planned = new Date('2026-08-10T12:00:00Z');
    const gaps = Array.from({ length: 4000 }, (_, i) => sampledCutoff(`${i}|8000261|a`, planned));
    const sighted = gaps.filter((g): g is Date => g !== null);
    expect(sighted.length / gaps.length).toBeGreaterThan(SIGHTED_SHARE - 0.05);
    expect(sighted.length / gaps.length).toBeLessThan(SIGHTED_SHARE + 0.05);
    for (const g of sighted) {
      const min = (planned.getTime() - g.getTime()) / 60_000;
      expect(min).toBeGreaterThanOrEqual(5);
      expect(min).toBeLessThanOrEqual(240);
    }
    expect(sampledCutoff('7|8000261|a', planned)).toEqual(sampledCutoff('7|8000261|a', planned));
  });
});
