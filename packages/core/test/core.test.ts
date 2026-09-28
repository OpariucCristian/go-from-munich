import { describe, expect, it } from 'vitest';
import {
  CANCELLED_BUCKET,
  bucketOf,
  connectionFailureProbability,
  cumulative,
  irisPlanSlot,
  normalize,
  normalizeEva,
  parseIrisStopId,
  parseIrisTime,
  toLocalParts,
  toMinutePmf,
  zonedToUtc,
} from '../src/index.ts';

describe('buckets', () => {
  it('assigns delays to buckets', () => {
    expect(bucketOf(-3, false)).toBe(0);
    expect(bucketOf(2, false)).toBe(0);
    expect(bucketOf(3, false)).toBe(1);
    expect(bucketOf(15, false)).toBe(3);
    expect(bucketOf(16, false)).toBe(4);
    expect(bucketOf(61, false)).toBe(6);
    expect(bucketOf(500, false)).toBe(6);
    expect(bucketOf(null, true)).toBe(CANCELLED_BUCKET);
    expect(bucketOf(null, false)).toBeNull();
  });

  it('minute pmf preserves mass', () => {
    const dist = normalize([5, 4, 3, 2, 1, 1, 1, 1]);
    const { pmf, cancelled } = toMinutePmf(dist);
    expect(pmf.reduce((a, b) => a + b, 0) + cancelled).toBeCloseTo(1, 10);
  });

  it('cumulative sums tail buckets', () => {
    const dist = [0.5, 0.2, 0.1, 0.05, 0.05, 0.04, 0.02, 0.04];
    const c = cumulative(dist);
    expect(c.atLeast['3min']).toBeCloseTo(0.46);
    expect(c.atLeast['16min']).toBeCloseTo(0.11);
    expect(c.cancelled).toBe(0.04);
  });

  it('connection failure grows as slack shrinks', () => {
    const arr = normalize([60, 15, 10, 6, 5, 2, 1, 1]);
    const dep = normalize([80, 10, 5, 2, 1, 1, 0, 1]);
    const loose = connectionFailureProbability(arr, dep, 20);
    const tight = connectionFailureProbability(arr, dep, 1);
    expect(tight.total).toBeGreaterThan(loose.total);
    expect(loose.byCancellation).toBeCloseTo(1 - (1 - arr[7]!) * (1 - dep[7]!));
    expect(tight.total).toBeLessThanOrEqual(1);
  });

  it('on-time trains with big slack almost never miss', () => {
    const onTime = [1, 0, 0, 0, 0, 0, 0, 0];
    expect(connectionFailureProbability(onTime, onTime, 10).total).toBe(0);
  });
});

describe('time', () => {
  it('converts Berlin wall clock to UTC across DST', () => {
    expect(zonedToUtc(2026, 1, 15, 12, 0).toISOString()).toBe('2026-01-15T11:00:00.000Z');
    expect(zonedToUtc(2026, 7, 15, 12, 0).toISOString()).toBe('2026-07-15T10:00:00.000Z');
  });

  it('parses IRIS compact timestamps', () => {
    expect(parseIrisTime('2609281522')?.toISOString()).toBe('2026-09-28T13:22:00.000Z');
    expect(parseIrisTime('bogus')).toBeNull();
    expect(parseIrisTime(undefined)).toBeNull();
  });

  it('computes local parts and plan slots', () => {
    const d = new Date('2026-09-27T22:30:00Z'); // 00:30 Monday in Berlin
    expect(toLocalParts(d)).toMatchObject({ year: 2026, month: 9, day: 28, hour: 0, weekday: 0 });
    expect(irisPlanSlot(d)).toEqual({ date: '260928', hour: '00' });
  });
});

describe('trip keys', () => {
  it('parses stop ids with negative ride ids', () => {
    expect(parseIrisStopId('-7033045110854920488-2607311545-17')).toEqual({
      rideId: '-7033045110854920488',
      originStart: '2607311545',
      stopIndex: 17,
      serviceDate: '2026-07-31',
    });
  });

  it('uses the origin date as service date for trains running past midnight', () => {
    expect(parseIrisStopId('3201207977925592989-2607311327-18')?.serviceDate).toBe('2026-07-31');
  });

  it('normalizes EVA numbers', () => {
    expect(normalizeEva('08000261')).toBe('8000261');
    expect(normalizeEva(8000261)).toBe('8000261');
  });
});
