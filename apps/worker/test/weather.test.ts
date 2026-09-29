import { describe, expect, it } from 'vitest';
import { parseOpenMeteo } from '../src/weather.ts';

describe('parseOpenMeteo', () => {
  it('flattens a multi-point response in request order, as UTC hours', () => {
    const point = (t: number) => ({
      hourly: {
        time: ['2026-09-20T00:00', '2026-09-20T01:00'],
        temperature_2m: [t, null],
        precipitation: [0.2, 0],
        snowfall: [0, 0],
        wind_gusts_10m: [20, 25],
        weather_code: [61, 3],
      },
    });
    const rows = parseOpenMeteo(['muc', 'aug'], [point(10), point(12)]);
    expect(rows).toHaveLength(4);
    expect(rows[0]).toEqual({ pointId: 'muc', ts: new Date('2026-09-20T00:00:00Z'), temp: 10, precip: 0.2, snow: 0, gust: 20, code: 61 });
    expect(rows[3]).toMatchObject({ pointId: 'aug', temp: null, gust: 25 });
    // A single-location response is an object, not an array.
    expect(parseOpenMeteo(['muc'], point(5))).toHaveLength(2);
  });
});
