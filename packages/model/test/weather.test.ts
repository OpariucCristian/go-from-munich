import { describe, expect, it } from 'vitest';
import { WEATHER_FEATURE_NAMES, snapshotFeatures, weatherFeatures, weatherSnapshot, type WeatherTable } from '../src/weather.ts';

const h = (iso: string) => Date.parse(iso);
const table: WeatherTable = new Map([
  ['muc', new Map([
    [h('2026-01-10T08:00:00Z'), { temp: -2, precip: 1, snow: 0.5, gust: 30 }],
    [h('2026-01-10T09:00:00Z'), { temp: -3, precip: 2, snow: 1, gust: 40 }],
    [h('2026-01-10T10:00:00Z'), { temp: -4, precip: null, snow: 2, gust: 50 }],
  ])],
  ['sbg', new Map([
    [h('2026-01-10T10:00:00Z'), { temp: -9, precip: 6, snow: 4, gust: 85 }],
  ])],
]);

describe('weatherFeatures', () => {
  it('uses the planned hour at home plus the regional worst case', () => {
    const f = weatherFeatures(new Date('2026-01-10T10:37:00Z'), table, 'muc');
    expect(f).toHaveLength(WEATHER_FEATURE_NAMES.length);
    expect(f).toEqual([-40, 30, 35, 500, -90, 60, 40, 850]); // tenths
  });

  it('returns NaN where there is no data', () => {
    const f = weatherFeatures(new Date('2027-01-01T00:00:00Z'), table, 'muc');
    expect(f.every((x) => Number.isNaN(x))).toBe(true);
  });
});

describe('weatherSnapshot', () => {
  it('is what the model sees, in natural units', () => {
    const at = new Date('2026-01-10T10:37:00Z');
    const w = weatherSnapshot(at, table, 'muc');
    expect(w).toEqual({
      tempC: -4, precip3h: 3, snow3h: 3.5, gustKmh: 50,
      regionTempMin: -9, regionPrecip3hMax: 6, regionSnow3hMax: 4, regionGustMax: 85,
    });
    expect(snapshotFeatures(w)).toEqual(weatherFeatures(at, table, 'muc'));
  });
});
