import { describe, expect, it } from 'vitest';
import { delaySummary } from '@gfm/core';
import { summarizeRuns, type RunStopRow } from '../src/accuracy.ts';

const onTime = [0.8, 0.1, 0.05, 0.02, 0.01, 0.01, 0, 0.01];
const late = [0.1, 0.1, 0.2, 0.2, 0.2, 0.1, 0.08, 0.02];

const row = (over: Partial<RunStopRow>): RunStopRow => ({
  date: '2026-09-28',
  source: 'live',
  trip_id: '1',
  train_type: 'RE',
  train_number: '4012',
  planned: new Date('2026-09-28T06:00:00Z'),
  model_version: 'baseline-v1',
  dist: onTime,
  observed_bucket: 0,
  observed_delay: 0,
  ...over,
});

describe('summarizeRuns', () => {
  it('groups stops by date, trip and source', () => {
    const runs = summarizeRuns([
      row({}),
      row({ planned: new Date('2026-09-28T05:50:00Z') }),
      row({ trip_id: '2' }),
      row({ source: 'replay' }),
      row({ date: '2026-09-27' }),
    ]);
    expect(runs).toHaveLength(4);
    const first = runs.find((r) => r.tripId === '1' && r.source === 'live' && r.date === '2026-09-28')!;
    expect(first.stops).toBe(2);
    expect(first.firstPlanned).toBe('2026-09-28T05:50:00.000Z');
  });

  it('averages predicted vs actual over the stops that ran, leaving cancellations out', () => {
    const { median, p80 } = delaySummary(late);
    const [run] = summarizeRuns([
      row({ dist: late, observed_bucket: 5, observed_delay: 40 }),
      row({ dist: late, observed_bucket: 0, observed_delay: -2 }), // early counts as 0
      row({ dist: late, observed_bucket: 7, observed_delay: null }),
    ]);
    expect(run!.stops).toBe(3);
    expect(run!.cancelled).toBe(1);
    expect(run!.predictedMedian).toBe(median);
    expect(run!.observedDelay).toBe(20);
    expect(run!.maeMin).toBeCloseTo((Math.abs(40 - median) + median) / 2, 6);
    expect(run!.worstMissMin).toBe(Math.abs(40 - median));
    expect(run!.within80).toBe(((40 <= p80 ? 1 : 0) + 1) / 2);
  });

  it('keeps delays past the modelled range as they happened', () => {
    const [run] = summarizeRuns([row({ observed_bucket: 6, observed_delay: 165 })]);
    expect(run!.observedDelay).toBe(165);
    expect(run!.worstMissMin).toBe(165 - delaySummary(onTime).median);
  });

  it('reports nulls for a fully cancelled run', () => {
    const [run] = summarizeRuns([row({ observed_bucket: 7, observed_delay: null })]);
    expect(run).toMatchObject({ stops: 1, cancelled: 1, maeMin: null, within80: null, predictedMedian: null });
  });

  it('sorts by biggest miss or by most recent', () => {
    const rows = [
      row({ trip_id: 'a', date: '2026-09-28' }),
      row({ trip_id: 'b', date: '2026-09-27', observed_bucket: 5, observed_delay: 45 }),
      row({ trip_id: 'c', date: '2026-09-28', planned: new Date('2026-09-28T04:00:00Z') }),
    ];
    expect(summarizeRuns(rows, 'miss').map((r) => r.tripId)[0]).toBe('b');
    expect(summarizeRuns(rows, 'recent').map((r) => r.tripId)).toEqual(['c', 'a', 'b']);
  });
});
