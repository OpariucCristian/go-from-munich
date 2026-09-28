import { describe, expect, it } from 'vitest';
import { blend, groupKeys, rps, statKey, summarize, type StatRow, type StopQuery } from '../src/index.ts';

const q: StopQuery = {
  eva: '8000261',
  trainType: 'ICE',
  trainNumber: '618',
  event: 'd',
  planned: new Date('2026-09-28T13:01:00Z'), // Monday 15:01 Berlin
};

function stats(rows: [number, string, number[], number][]): Map<string, StatRow> {
  return new Map(rows.map(([level, key, weights, n]) => [statKey(level, key, 'd'), { level, key, event: 'd', weights, n }]));
}

describe('groupKeys', () => {
  it('builds keys from most specific to global using Berlin local time', () => {
    expect(groupKeys(q).map((g) => g.key)).toEqual([
      '8000261|618|wd|pm',
      '8000261|618',
      '8000261|ICE|wd|pm',
      '8000261|ICE',
      'ICE',
      '*',
    ]);
  });
});

describe('blend', () => {
  it('falls back to the global distribution without specific data', () => {
    const s = stats([[6, '*', [8000, 1000, 500, 200, 100, 100, 50, 50], 1000]]);
    const p = blend(q, s);
    expect(p.supportLevel).toBe(6);
    expect(p.distribution[0]).toBeGreaterThan(0.79);
    expect(p.distribution.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 10);
  });

  it('lets well-supported specific groups dominate', () => {
    const s = stats([
      [6, '*', [8000, 1000, 500, 200, 100, 100, 50, 50], 100000],
      [2, '8000261|618', [10, 10, 30, 30, 10, 5, 5, 0], 400],
    ]);
    const p = blend(q, s);
    expect(p.supportLevel).toBe(2);
    expect(p.supportN).toBe(400);
    expect(p.distribution[2]! + p.distribution[3]!).toBeGreaterThan(0.55);
  });

  it('keeps sparse groups close to their parent', () => {
    const s = stats([
      [6, '*', [8000, 1000, 500, 200, 100, 100, 50, 50], 100000],
      [1, '8000261|618|wd|pm', [0, 0, 0, 0, 0, 0, 1, 0], 1],
    ]);
    const p = blend(q, s);
    expect(p.distribution[6]).toBeLessThan(0.15);
    expect(p.distribution[0]).toBeGreaterThan(0.7);
  });
});

describe('metrics', () => {
  it('rps is 0 for a perfect forecast and penalises distance', () => {
    const perfect = [1, 0, 0, 0, 0, 0, 0, 0];
    expect(rps(perfect, 0)).toBe(0);
    const near = [0, 1, 0, 0, 0, 0, 0, 0];
    const far = [0, 0, 0, 0, 0, 1, 0, 0];
    expect(rps(far, 0)).toBeGreaterThan(rps(near, 0));
  });

  it('summarize reports calibration', () => {
    const s = summarize(
      [
        [0.5, 0.5, 0, 0, 0, 0, 0, 0],
        [0.5, 0.5, 0, 0, 0, 0, 0, 0],
      ],
      [0, 1],
    );
    expect(s.n).toBe(2);
    expect(s.calibration[0]).toEqual({ bucket: 0, predicted: 0.5, observed: 0.5 });
  });
});
