/** Accuracy screen: turns the core API's scores into plain-language cards, charts and tables. */
import type {
  AccuracyBreakdownRow,
  AccuracyMiss,
  AccuracyStat,
  AccuracyView,
  CalibrationPoint,
  Tone,
} from '../contract.ts';
import type { CoreAccuracy, CoreAccuracyMetrics } from '../core/types.ts';
import { dateLabelOf, pct, shortDateOf, signedMin, timeOf } from './format.ts';

/** Calibration bins with fewer predictions than this are hidden from the chart. */
export const MIN_CALIBRATION_N = 20;

const skillOf = (m: CoreAccuracyMetrics) => (m.climatologyRps ? 1 - m.rps / m.climatologyRps : null);
const signedPct = (x: number) => `${x >= 0 ? '+' : '−'}${Math.abs(Math.round(x * 100))}%`;
const count = (n: number) => n.toLocaleString('en-GB');
const modelLabel = (v: string) => v.replace(/^(baseline|lgbm)-/, '$1 ').replace(/^lgbm muc-/, 'lgbm ');

function greenTone(x: number): Tone {
  return x >= 0.85 ? 'good' : x >= 0.75 ? 'warn' : 'bad';
}
/** "80% chance of at most X min" should hold about 80% of the time: less is optimistic, more is cautious. */
function within80Tone(x: number): Tone {
  const off = Math.abs(x - 0.8);
  return off <= 0.04 ? 'good' : off <= 0.1 ? 'warn' : 'bad';
}
function skillTone(x: number): Tone {
  return x >= 0.1 ? 'good' : x > 0 ? 'warn' : 'bad';
}

function stats(t: NonNullable<CoreAccuracy['total']>): AccuracyStat[] {
  const skill = skillOf(t);
  return [
    {
      key: 'green',
      label: 'Green calls that held',
      value: t.green === null ? '–' : pct(t.green),
      detail: 'When we showed low risk, the train was at most 5 minutes late.',
      tone: t.green === null ? 'neutral' : greenTone(t.green),
    },
    {
      key: 'within80',
      label: '“80% chance” limits kept',
      value: t.within80 === null ? '–' : pct(t.within80),
      detail:
        t.within80 === null
          ? 'No trains ran in this window.'
          : `We say "80% chance it's at most X min late". ${
              t.within80 < 0.76
                ? 'That held less often than 80%: too optimistic.'
                : t.within80 > 0.84
                  ? 'That held more often than 80%: too cautious.'
                  : 'That held about 80% of the time, as it should.'
            }`,
      tone: t.within80 === null ? 'neutral' : within80Tone(t.within80),
    },
    {
      key: 'skill',
      label: 'Better than average',
      value: skill === null ? '–' : signedPct(skill),
      detail: 'Error compared with one delay spread for every train, ignoring train, station and time.',
      tone: skill === null ? 'neutral' : skillTone(skill),
    },
    {
      key: 'miss',
      label: 'Typical miss',
      value: t.maeMin === null ? '–' : `${t.maeMin.toFixed(1)} min`,
      detail: 'Average gap between the most likely delay we showed and the actual delay.',
      tone: 'neutral',
    },
  ];
}

const BREAKDOWN_LABELS: Record<string, string> = {
  hub: 'Munich hubs',
  corridor: 'Other polled stations',
  arrival: 'Arrivals',
  departure: 'Departures',
};
const LEAD_ORDER = ['0–2h', '2–6h', '6–12h', '12h+'];

function rowOf(label: string, m: CoreAccuracyMetrics): AccuracyBreakdownRow {
  return {
    label,
    n: m.n,
    skill: skillOf(m),
    within80: m.within80,
    maeMin: m.maeMin,
    predLate5: m.predLate5,
    obsLate5: m.obsLate5,
  };
}

function breakdown(b: CoreAccuracy['breakdown']): AccuracyView['breakdown'] {
  const rows = (group: Record<string, CoreAccuracyMetrics> | undefined, order?: string[]) =>
    Object.entries(group ?? {})
      .sort(([ka, a], [kb, b]) => (order ? order.indexOf(ka) - order.indexOf(kb) : b.n - a.n))
      .map(([k, m]) => rowOf(BREAKDOWN_LABELS[k] ?? (order ? `${k} ahead` : k), m));
  return [
    { title: 'Train type', rows: rows(b.trainType).slice(0, 8) },
    { title: 'Station', rows: rows(b.station) },
    { title: 'Arrival or departure', rows: rows(b.event) },
    { title: 'How far ahead', rows: rows(b.lead, LEAD_ORDER) },
  ].filter((g) => g.rows.length);
}

function missOf(m: CoreAccuracy['misses'][number]): AccuracyMiss {
  const risk = m.predictedLate5;
  return {
    train: `${m.trainType} ${m.trainNumber}`,
    trainType: m.trainType,
    trainNumber: m.trainNumber,
    date: m.date,
    dateLabel: dateLabelOf(m.date),
    station: m.station,
    eva: m.eva,
    event: m.event === 'a' ? 'arr' : 'dep',
    time: timeOf(m.planned),
    predicted: m.cancelled
      ? `${pct(m.predictedCancelled)} cancellation risk`
      : `Likely ${signedMin(m.predictedMedian)} · ${pct(risk)} risk`,
    actual: m.cancelled ? 'Cancelled' : `${signedMin(m.observedDelay ?? 0)} min`,
    source: m.source,
  };
}

function liveStatus(core: CoreAccuracy, liveDays: number): string {
  const { trackingSince, pendingSnapshots, lastScoredAt } = core.live;
  if (!trackingSince) return 'Live tracking starts with the next hourly snapshot while the poller runs.';
  const waiting = pendingSnapshots
    ? ` ${count(pendingSnapshots)} predictions are waiting for their trains to run.`
    : '';
  if (!liveDays) {
    return `Tracking live since ${shortDateOf(trackingSince)}.${waiting} The first live scores arrive at 06:30 the morning after.`;
  }
  const scored = lastScoredAt ? ` Last scored ${dateLabelOf(lastScoredAt)}, ${timeOf(lastScoredAt)}.` : '';
  return `Tracking live since ${shortDateOf(trackingSince)}.${scored}${waiting} Scores update daily at 06:30.`;
}

export function accuracyView(core: CoreAccuracy): AccuracyView {
  const liveDays = core.daily.filter((d) => d.source !== 'replay').length;
  const replayDays = core.daily.length - liveDays;
  const calibration: CalibrationPoint[] = core.calibration
    .filter((b) => b.n >= MIN_CALIBRATION_N)
    .map((b) => ({
      label: `${Math.round(b.lo * 100)}–${Math.round(b.hi * 100)}%`,
      predicted: b.predicted,
      observed: b.observed,
      n: b.n,
    }));
  return {
    source: core.source,
    empty: !core.total,
    rangeLabel: core.from && core.to ? `${shortDateOf(core.from)} – ${shortDateOf(core.to)}` : null,
    dayCount: core.daily.length,
    predictions: core.total?.n ?? 0,
    stats: core.total ? stats(core.total) : [],
    trend: core.daily.map((d) => ({
      date: d.date,
      label: shortDateOf(d.date),
      source: d.source,
      n: d.n,
      skill: skillOf(d),
      within80: d.within80,
      green: d.green,
      predLate5: d.predLate5,
      obsLate5: d.obsLate5,
    })),
    calibration,
    breakdown: breakdown(core.breakdown),
    misses: core.misses.map(missOf),
    models: core.models.map((m) => modelLabel(m.version)).join(', ') || '–',
    liveStatus: liveStatus(core, liveDays),
    note: core.source === 'near'
      ? 'Predictions frozen 30–90 minutes before each stop, when a delay already seen at an earlier stop counts.'
      : replayDays
      ? `${replayDays} of these days ${replayDays === 1 ? 'is' : 'are'} replayed: predicted using only data from before that day, then scored like live days.`
      : null,
  };
}
