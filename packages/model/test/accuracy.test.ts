import { describe, expect, it } from 'vitest';
import {
  aggregateAccuracy,
  leadBand,
  mergeBreakdown,
  mergeCalibration,
  mergeMetrics,
  scoreOne,
  type OutcomeRow,
} from '../src/index.ts';

// Mostly on time, some small delays.
const onTime = [0.75, 0.1, 0.07, 0.03, 0.02, 0.01, 0.01, 0.01]; // P(>5 min) = 0.15
// Clearly late.
const late = [0.1, 0.05, 0.3, 0.2, 0.2, 0.07, 0.03, 0.05]; // P(>5 min) = 0.85

const row = (over: Partial<OutcomeRow>): OutcomeRow => ({
  dist: onTime, bucket: 0, delay: 1, trainType: 'ICE', stationGroup: 'hub', event: 'd', leadMin: 600, ...over,
});

describe('scoreOne', () => {
  it('scores a confident correct on-time call', () => {
    const s = scoreOne(onTime, 0, 1);
    expect(s.topHit).toBe(true);
    expect(s.within80).toBe(true);
    expect(s.late).toBe(false);
    expect(s.pLate).toBeCloseTo(0.15, 6);
    expect(s.brier6).toBeCloseTo(0.0225, 6);
    expect(s.absErr).toBe(0); // median of the on-time spread is 1 minute
  });

  it('treats a big delay as beyond the 80% limit and early arrivals as minute 0', () => {
    expect(scoreOne(onTime, 4, 25).within80).toBe(false);
    expect(scoreOne(onTime, 0, -3).absErr).toBe(1);
  });

  it('leaves the 80% limit and error empty for cancellations', () => {
    const s = scoreOne(late, 7, null);
    expect(s.within80).toBeNull();
    expect(s.absErr).toBeNull();
    expect(s.late).toBe(true);
  });
});

describe('aggregateAccuracy', () => {
  const rows = [
    row({}),
    row({ bucket: 1, delay: 4 }),
    row({ dist: late, bucket: 2, delay: 8, trainType: 'RE', stationGroup: 'corridor', event: 'a', leadMin: 90 }),
    row({ dist: late, bucket: 7, delay: null, trainType: 'RE', leadMin: 300 }),
  ];
  const clim = { a: [0.5, 0.2, 0.1, 0.05, 0.05, 0.05, 0.03, 0.02], d: [0.5, 0.2, 0.1, 0.05, 0.05, 0.05, 0.03, 0.02] };
  const a = aggregateAccuracy(rows, clim);

  it('computes headline metrics', () => {
    expect(a.n).toBe(4);
    expect(a.nRun).toBe(3);
    expect(a.obsLate5).toBe(0.5);
    expect(a.predLate5).toBeCloseTo((0.15 + 0.15 + 0.85 + 0.85) / 4, 6);
    expect(a.topBucketHit).toBe(0.5); // rows 1 and 3
    expect(a.climatologyRps).not.toBeNull();
    expect(a.rps).toBeLessThan(a.climatologyRps!);
  });

  it('bins calibration by predicted P(>5 min)', () => {
    expect(a.calibration).toHaveLength(10);
    expect(a.calibration[1]).toMatchObject({ n: 2, observed: 0 });
    expect(a.calibration[8]).toMatchObject({ n: 2, observed: 1 });
    expect(a.calibration.reduce((s, b) => s + b.n, 0)).toBe(4);
  });

  it('breaks down by train type, station group, event and lead time', () => {
    expect(a.breakdown.trainType.ICE!.n).toBe(2);
    expect(a.breakdown.trainType.RE!.n).toBe(2);
    expect(a.breakdown.station.corridor!.n).toBe(1);
    expect(a.breakdown.event.arrival!.n).toBe(1);
    expect(Object.keys(a.breakdown.lead).sort()).toEqual(['0–2h', '2–6h', '6–12h']);
  });

  it('merges days weighted by their row counts', () => {
    const b = aggregateAccuracy([row({})], clim);
    const m = mergeMetrics([a, b]);
    expect(m.n).toBe(5);
    expect(m.nRun).toBe(4);
    expect(m.rps).toBeCloseTo((a.rps * 4 + b.rps) / 5, 9);
    expect(m.within80).toBeCloseTo((a.within80! * 3 + b.within80!) / 4, 9);
    expect(mergeCalibration([a.calibration, b.calibration])[1]!.n).toBe(3);
    expect(mergeBreakdown([a.breakdown, b.breakdown]).trainType.ICE!.n).toBe(3);
  });
});

describe('leadBand', () => {
  it('groups lead times', () => {
    expect([30, 119, 120, 400, 719, 800].map(leadBand)).toEqual(['0–2h', '0–2h', '2–6h', '6–12h', '6–12h', '12h+']);
  });
});
