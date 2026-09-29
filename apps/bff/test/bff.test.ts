import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { CoreApi } from '../src/core/coreApi.ts';
import type { CorePrediction, CoreStopPrediction, CoreTrainStops } from '../src/core/types.ts';
import { EstimateService, parseTrain, timelineQueries } from '../src/estimate/estimate.service.ts';
import { MetaService } from '../src/explore/meta.service.ts';
import { featuredView, headlineOf, tripEstimate } from '../src/view/estimate.ts';
import { accuracyView } from '../src/view/accuracy.ts';
import { patternsView } from '../src/view/explore.ts';
import { confidenceOf, dateLabelOf, distributionOf, durationLabel, timeOf, toneOf } from '../src/view/format.ts';

/** A core prediction from 8 bucket probabilities (≤2, 3–5, 6–10, 11–15, 16–30, 31–60, >60, cancelled). */
function pred(p: number[], median = 1, level = 1, n = 200): CorePrediction {
  const labels = ['≤2', '3–5', '6–10', '11–15', '16–30', '31–60', '>60', 'cancelled'];
  const tail = (from: number) => p.slice(from, 7).reduce((a, b) => a + b, 0);
  return {
    buckets: p.map((x, i) => ({ label: labels[i]!, p: x })),
    atLeast: { '3min': tail(1), '6min': tail(2), '11min': tail(3), '16min': tail(4), '31min': tail(5), '61min': tail(6) },
    cancelled: p[7]!,
    minutes: { expected: median + 2, median, p10: 0, p80: median + 6, p90: median + 10 },
    support: { level, observations: n },
  };
}

const onTime = pred([0.8, 0.1, 0.04, 0.02, 0.01, 0.01, 0, 0.02], 1);
const late = pred([0.2, 0.15, 0.2, 0.15, 0.15, 0.05, 0.02, 0.08], 9);

const stop = (eva: string, event: 'a' | 'd', planned: string, p: CorePrediction): CoreStopPrediction => ({
  eva,
  event,
  planned,
  live: null,
  prediction: p,
});

describe('formatting', () => {
  it('uses Berlin wall-clock time, across DST', () => {
    expect(timeOf('2026-10-26T14:28:00Z')).toBe('15:28'); // CET, day after the change
    expect(timeOf('2026-10-24T14:28:00Z')).toBe('16:28'); // CEST
    expect(dateLabelOf('2026-10-26')).toBe('Mon 26 Oct');
    expect(durationLabel('2026-10-26T14:28:00Z', '2026-10-26T16:43:00Z')).toBe('2h 15m');
  });

  it('merges the tail into six bars and counts cancellations as late', () => {
    const d = distributionOf(late);
    expect(d.bars.map((b) => b.label)).toEqual(['≤2', '3–5', '6–10', '11–15', '16–30', '30+']);
    expect(d.bars[5]!.p).toBeCloseTo(0.07);
    expect(d.bars.reduce((a, b) => a + b.p, 0) + d.cancelled).toBeCloseTo(1);
    expect(d.cumulative.at(-1)).toBeCloseTo(0.92);
    expect(d.lateOver5).toBeCloseTo(0.57 + 0.08);
  });

  it('maps risk to tones on one shared scale', () => {
    expect(toneOf(0.1)).toBe('good');
    expect(toneOf(0.2)).toBe('warn');
    expect(toneOf(0.36)).toBe('bad');
  });

  it('describes how much history backs a prediction', () => {
    expect(confidenceOf(onTime, 'ICE 514', 'ICE').level).toBe('high');
    expect(confidenceOf(pred(onTime.buckets.map((b) => b.p), 1, 4), 'ICE 514', 'ICE')).toEqual({
      level: 'medium',
      text: 'Based on ICE trains at this station',
    });
    expect(confidenceOf(pred(onTime.buckets.map((b) => b.p), 1, 6), 'ICE 514', 'ICE').level).toBe('low');
  });
});

describe('trip estimate view', () => {
  const legs = [
    {
      trainType: 'ICE',
      trainNumber: '514',
      basedOnRun: '2026-08-31',
      stops: [
        { name: 'München Hbf', prediction: stop('8000261', 'd', '2026-10-26T14:28:00Z', onTime) },
        { name: 'Augsburg Hbf', prediction: stop('8000013', 'a', '2026-10-26T14:59:00Z', onTime) },
        { name: 'Stuttgart Hbf', prediction: stop('8000096', 'a', '2026-10-26T16:43:00Z', late) },
      ],
    },
  ];

  it('builds headline, timeline and the stale-timetable note', () => {
    const e = tripEstimate(legs, { model: 'baseline v1', attribution: 'x' });
    expect(e.title).toBe('München Hbf → Stuttgart Hbf');
    expect(e.dateLabel).toBe('Mon 26 Oct');
    expect(e.final).toMatchObject({ name: 'Stuttgart Hbf', time: '17:43', typicalLabel: '+9', tone: 'bad', headline: 'Likely about 9 minutes late' });
    expect(e.final.sentence).toBe(
      "Most likely arrival is 17:52. There's a 20% chance it's on time and a 22% chance it's more than 15 minutes late. Cancellation risk: 8%.",
    );
    expect(e.legs[0]!.timeline.map((s) => s.event)).toEqual(['departure', 'arrival', 'arrival']);
    expect(e.legs[0]!.durationLabel).toBe('2h 15m');
    expect(e.timetableNote).toBe('Stops and times taken from the Mon 31 Aug run of ICE 514');
    expect(e.allConnectionsP).toBeNull();
  });

  it('headlines on-time and cancellation-prone stops', () => {
    expect(headlineOf(distributionOf(onTime))).toBe('Likely on time');
    expect(headlineOf(distributionOf(pred([0.5, 0.1, 0.05, 0, 0, 0, 0, 0.35])))).toBe('High risk of cancellation');
  });
});

describe('timelineQueries', () => {
  const run: CoreTrainStops = {
    train: 'ICE 514',
    date: '2026-10-26',
    basedOnRun: '2026-08-31',
    stops: [
      { eva: '8000261', name: 'München Hbf', stop_seq: 1, planned_arr: null, planned_dep: '2026-10-26T14:28:00Z' },
      { eva: '8004158', name: 'München-Pasing', stop_seq: 2, planned_arr: '2026-10-26T14:35:00Z', planned_dep: '2026-10-26T14:36:00Z' },
      { eva: '8000013', name: 'Augsburg Hbf', stop_seq: 3, planned_arr: '2026-10-26T14:59:00Z', planned_dep: '2026-10-26T15:01:00Z' },
      { eva: '8000096', name: 'Stuttgart Hbf', stop_seq: 4, planned_arr: '2026-10-26T16:43:00Z', planned_dep: null },
    ],
  };

  it('departs from the boarding stop and arrives at every later stop through the destination', () => {
    const { queries, names } = timelineQueries(run, 'ICE', '514', '8004158', '8000013');
    expect(names).toEqual(['München-Pasing', 'Augsburg Hbf']);
    expect(queries).toEqual([
      { eva: '8004158', trainType: 'ICE', trainNumber: '514', event: 'd', planned: '2026-10-26T14:36:00Z' },
      { eva: '8000013', trainType: 'ICE', trainNumber: '514', event: 'a', planned: '2026-10-26T14:59:00Z' },
    ]);
  });

  it('defaults to the whole run and rejects backwards trips', () => {
    expect(timelineQueries(run, 'ICE', '514').names).toHaveLength(4);
    expect(() => timelineQueries(run, 'ICE', '514', '8000013', '8004158')).toThrow(/does not run/);
  });

  it('parses train names', () => {
    expect(parseTrain(' ice514 ')).toEqual({ type: 'ICE', number: '514' });
    expect(() => parseTrain('Berlin')).toThrow();
  });
});

describe('EstimateService.fromShare', () => {
  const meta = { get: async () => ({ model: 'baseline v1', attribution: 'x' }) } as unknown as MetaService;
  const resolved = {
    legs: [{ trainType: 'ICE', trainNumber: '514', fromEva: '8000261', toEva: '8000096', plannedDep: '2026-10-26T14:28:00.000Z', plannedArr: '2026-10-26T16:43:00.000Z' }],
    strategy: 'text',
    vbid: 'abc',
    warnings: ['vbid lookup failed, parsed the text instead'],
    prediction: {
      legs: [
        {
          train: 'ICE 514',
          from: { eva: '8000261', name: 'München Hbf', planned: '2026-10-26T14:28:00.000Z', live: null, departure: onTime },
          to: { eva: '8000096', name: 'Stuttgart Hbf', planned: '2026-10-26T16:43:00.000Z', live: null, arrival: late },
        },
      ],
      transfers: [],
      tripSuccessProbability: 1,
      model: { kind: 'baseline', version: 'baseline-v1' },
      attribution: 'x',
    },
  };

  it('falls back to boarding → alighting when the train run is unknown, and hides the vbid warning', async () => {
    const core = {
      post: async (path: string) => (path === '/resolve-share' ? resolved : []),
      get: async () => {
        throw new Error('404');
      },
    } as unknown as CoreApi;
    const res = await new EstimateService(core, meta).fromShare({ text: 'ICE 514 …' });
    expect(res.warnings).toEqual([]);
    expect(res.estimate!.legs[0]!.timeline.map((s) => s.name)).toEqual(['München Hbf', 'Stuttgart Hbf']);
    expect(res.estimate!.final.typicalLabel).toBe('+9');
  });

  it('returns no estimate when nothing could be resolved', async () => {
    const core = { post: async () => ({ ...resolved, legs: [], prediction: null, warnings: [] }) } as unknown as CoreApi;
    const res = await new EstimateService(core, meta).fromShare({ text: 'hello' });
    expect(res).toEqual({ estimate: null, warnings: ['No train found in the shared text'] });
  });
});

describe('patterns view', () => {
  it('lays out weekday × hour cells and ignores sparse cells for best/worst', () => {
    const v = patternsView({
      from: '2026-07-01',
      to: '2026-09-28',
      departures: 500,
      cells: [
        { dow: 1, hour: 8, avg: 3.24, late: 0.2, cancelled: 0, n: 100 },
        { dow: 5, hour: 17, avg: 7.9, late: 0.5, cancelled: 0.01, n: 100 },
        { dow: 7, hour: 23, avg: 20, late: 0.9, cancelled: 0, n: 3 },
      ],
    });
    expect(v.rangeLabel).toBe('1 Jul – 28 Sept');
    expect(v.rows).toHaveLength(7);
    expect(v.rows[0]!.cells).toHaveLength(19);
    expect(v.rows[0]!.cells.find((c) => c.hour === 8)).toEqual({ hour: 8, avg: 3.2, lateOver5: 0.2, n: 100 });
    expect(v.worst).toEqual({ label: 'Fri 17:00', avg: 7.9 });
    expect(v.best).toEqual({ label: 'Mon 08:00', avg: 3.2 });
  });
});

describe('accuracy view', () => {
  const m = (over: Partial<import('../src/core/types.ts').CoreAccuracyMetrics> = {}) => ({
    n: 1000, nRun: 980, rps: 0.09, logLoss: 1.2, brier6: 0.15, climatologyRps: 0.12, topBucketHit: 0.55,
    within80: 0.82, maeMin: 2.4, predLate5: 0.22, obsLate5: 0.2, ...over,
  });
  const core: import('../src/core/types.ts').CoreAccuracy = {
    source: 'all',
    from: '2026-08-30',
    to: '2026-09-29',
    total: { ...m(), green: 0.88 },
    daily: [
      { ...m(), date: '2026-08-30', source: 'replay', modelVersions: ['baseline-v1'], unlabelled: 0, green: 0.9 },
      { ...m({ climatologyRps: null }), date: '2026-09-29', source: 'live', modelVersions: ['baseline-v1'], unlabelled: 5, green: 0.86 },
    ],
    calibration: [
      { lo: 0, hi: 0.1, n: 500, predicted: 0.06, observed: 0.05 },
      { lo: 0.1, hi: 0.2, n: 5, predicted: 0.15, observed: 0.2 },
    ],
    breakdown: {
      trainType: { RE: m({ n: 300 }), ICE: m({ n: 700 }) },
      station: { hub: m(), corridor: m({ n: 10 }) },
      event: { departure: m() },
      lead: { '6–12h': m(), '0–2h': m() },
    },
    models: [{ version: 'baseline-v1', n: 1000 }],
    misses: [{
      date: '2026-09-29', source: 'live', trainType: 'ICE', trainNumber: '514', eva: '8000261', station: 'München Hbf',
      event: 'd', planned: '2026-09-29T13:28:00Z', predictedMedian: 1, predictedLate5: 0.09, predictedCancelled: 0.01,
      observedBucket: 5, observedDelay: 42, cancelled: false, rps: 0.6,
    }],
    live: { trackingSince: '2026-09-29', pendingSnapshots: 2267, lastScoredAt: '2026-09-30T04:31:00Z' },
    tz: 'Europe/Berlin',
  };

  it('builds plain-language cards with tones', () => {
    const v = accuracyView(core);
    expect(v.empty).toBe(false);
    expect(v.stats.map((s) => [s.key, s.value, s.tone])).toEqual([
      ['green', '88%', 'good'],
      ['within80', '82%', 'good'],
      ['skill', '+25%', 'good'],
      ['miss', '2.4 min', 'neutral'],
    ]);
    expect(v.rangeLabel).toBe('30 Aug – 29 Sept');
    expect(v.models).toBe('baseline v1');
  });

  it('shapes trend, calibration, breakdown and misses', () => {
    const v = accuracyView(core);
    expect(v.trend.map((d) => [d.source, d.skill === null ? null : Math.round(d.skill * 100)])).toEqual([
      ['replay', 25],
      ['live', null],
    ]);
    expect(v.calibration).toHaveLength(1); // the 5-prediction bin is too sparse to plot
    expect(v.breakdown.map((g) => g.title)).toEqual(['Train type', 'Station', 'Arrival or departure', 'How far ahead']);
    expect(v.breakdown[0]!.rows.map((r) => r.label)).toEqual(['ICE', 'RE']);
    expect(v.breakdown[1]!.rows[0]!.label).toBe('Munich hubs');
    expect(v.breakdown[3]!.rows.map((r) => r.label)).toEqual(['0–2h ahead', '6–12h ahead']);
    expect(v.misses[0]).toMatchObject({ train: 'ICE 514', time: '15:28', event: 'dep', predicted: 'Likely +1 · 9% risk', actual: '+42 min' });
    expect(v.note).toMatch(/^1 of these days is replayed:/);
    expect(v.liveStatus).toContain('2,267 predictions are waiting');
  });

  it('reports an empty window', () => {
    const v = accuracyView({ ...core, total: null, daily: [], misses: [], models: [], from: null, to: null,
      live: { trackingSince: null, pendingSnapshots: 0, lastScoredAt: null } });
    expect(v.empty).toBe(true);
    expect(v.stats).toEqual([]);
    expect(v.liveStatus).toMatch(/starts with the next hourly snapshot/);
  });
});

describe('featured view', () => {
  it('describes the featured train and links to the right stop', () => {
    const v = featuredView({
      featured: {
        trainType: 'ICE', trainNumber: '514', serviceDate: '2026-09-29', eva: '8000261', station: 'München Hbf',
        event: 'd', planned: '2026-09-29T13:28:00Z', predictedAt: '2026-09-29T02:05:00Z', expected: 11.6,
        lateOver5: 0.58, candidates: 120, windowHours: 3,
      },
    });
    expect(v).toEqual({
      train: 'ICE 514', date: '2026-09-29', eva: '8000261', station: 'München Hbf', event: 'dep', time: '15:28',
      reason: 'Biggest delay we expect for trains leaving the Munich hubs in the next 3 hours: +12 min on average if it runs, 58% chance of more than 5 minutes late.',
    });
    expect(featuredView({ featured: null })).toBeNull();
  });
});
