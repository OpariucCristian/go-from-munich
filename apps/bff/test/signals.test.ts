import { describe, expect, it } from 'vitest';
import type { CorePrediction, CoreWeather } from '../src/core/types.ts';
import { timeOf } from '../src/view/format.ts';
import { reasonViews, signalsOf, weatherSignal } from '../src/view/signals.ts';

const pred = (over: Partial<CorePrediction> = {}): CorePrediction => ({
  buckets: [],
  atLeast: {},
  cancelled: 0.01,
  minutes: { expected: 2, median: 1, p10: 0, p80: 4, p90: 7 },
  support: { level: 1, observations: 42 },
  ...over,
});

const calm: CoreWeather = {
  tempC: 14.2, precip3h: 0, snow3h: 0, gustKmh: 22,
  regionTempMin: 9, regionPrecip3hMax: 0.4, regionSnow3hMax: 0, regionGustMax: 30,
};

describe('signalsOf', () => {
  it('lists the live sighting, then weather, then history', () => {
    const s = signalsOf(
      pred({
        sighting: { eva: '8000013', name: 'Augsburg Hbf', delayMin: 12, gapMin: 40, planned: '2026-09-29T15:00:00Z' },
        weather: calm,
      }),
      'RE 4012',
      'RE',
    );
    expect(s.map((x) => [x.kind, x.tone])).toEqual([['live', 'warn'], ['weather', 'neutral'], ['history', 'neutral']]);
    expect(s[0]!.text).toBe('+12 min at Augsburg Hbf, 40 min earlier');
    expect(s[1]!.text).toBe('14 °C, dry, gusts 22 km/h in Munich');
    expect(s[2]!.text).toBe('42 past runs of RE 4012 here');
  });

  it('shows only history when the model used nothing else', () => {
    const s = signalsOf(pred({ support: { level: 6, observations: 3 } }), 'RE 4012', 'RE');
    expect(s).toEqual([{ kind: 'history', title: 'History · low confidence', text: 'Little data for this stop: RE trains overall', tone: 'warn' }]);
  });
});

describe('weatherSignal', () => {
  it('adds the worst along the line when it is notably worse, and flags it', () => {
    const w = weatherSignal({ ...calm, regionGustMax: 85, regionSnow3hMax: 4, regionTempMin: -9 });
    expect(w).toMatchObject({
      text: '14 °C, dry, gusts 22 km/h in Munich; along the line up to 4 cm snow, gusts up to 85 km/h, down to -9 °C',
      tone: 'warn',
    });
  });
});

describe('reasonViews', () => {
  it('capitalizes the reason and says where and when it was last reported', () => {
    const r = reasonViews([
      { kind: 'cause', text: 'delay of a train ahead', station: 'Augsburg Hbf', reportedAt: '2026-09-29T14:40:00Z', stops: 3 },
    ]);
    expect(r).toEqual([
      { kind: 'cause', text: 'Delay of a train ahead', detail: `Augsburg Hbf, ${timeOf('2026-09-29T14:40:00Z')} · 3 stops` },
    ]);
    expect(reasonViews(undefined)).toEqual([]);
  });
});
