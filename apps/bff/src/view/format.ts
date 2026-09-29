/** Formatting and the shared risk scale. All wall-clock output is Europe/Berlin. */
import type { Confidence, DistributionView, LiveView, Tone } from '../contract.ts';
import type { CoreLive, CorePrediction } from '../core/types.ts';

export const TZ = 'Europe/Berlin';

const hm = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const ymd = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
const dayLabel = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, weekday: 'short', day: 'numeric', month: 'short' });
const shortDate = new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', day: 'numeric', month: 'short' });

export const timeOf = (iso: string | Date) => hm.format(new Date(iso));
export const berlinDate = (iso: string | Date) => ymd.format(new Date(iso));
/** 'Mon 26 Oct' for an instant, or for a YYYY-MM-DD calendar date. */
export const dateLabelOf = (isoOrDate: string | Date) =>
  dayLabel.format(typeof isoOrDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(isoOrDate) ? new Date(`${isoOrDate}T12:00:00Z`) : new Date(isoOrDate)).replace(',', '');
/** '31 Aug' for a YYYY-MM-DD calendar date. */
export const shortDateOf = (date: string) => shortDate.format(new Date(`${date}T00:00:00Z`));

export function durationLabel(fromIso: string, toIso: string): string {
  const min = Math.round((Date.parse(toIso) - Date.parse(fromIso)) / 60_000);
  const h = Math.floor(min / 60);
  return h ? `${h}h ${String(min % 60).padStart(2, '0')}m` : `${min}m`;
}

/** Risk of arriving/departing more than 5 minutes late, counting cancellations as late. */
export function toneOf(lateOver5: number): Tone {
  if (lateOver5 > 0.35) return 'bad';
  if (lateOver5 >= 0.2) return 'warn';
  return 'good';
}

export const signedMin = (m: number) => `+${Math.max(0, Math.round(m))}`;

const r4 = (x: number) => Math.round(x * 10000) / 10000;

export function distributionOf(p: CorePrediction): DistributionView {
  const b = p.buckets.map((x) => x.p);
  const bars = [
    { label: '≤2', p: b[0]! },
    { label: '3–5', p: b[1]! },
    { label: '6–10', p: b[2]! },
    { label: '11–15', p: b[3]! },
    { label: '16–30', p: b[4]! },
    { label: '30+', p: b[5]! + b[6]! },
  ].map((x) => ({ ...x, p: r4(x.p) }));
  let acc = 0;
  const cumulative = bars.map((x) => r4((acc += x.p)));
  return {
    bars,
    cumulative,
    cancelled: r4(p.cancelled),
    onTime: r4(b[0]!),
    lateOver5: r4((p.atLeast['6min'] ?? 0) + p.cancelled),
    lateOver15: r4(p.atLeast['16min'] ?? 0),
    expected: p.minutes.expected,
    median: p.minutes.median,
    upTo80: p.minutes.p80,
  };
}

/** How much history backs a prediction (the most specific grouping level that had data). */
export function confidenceOf(p: CorePrediction, train: string, trainType: string): Confidence {
  const { level, observations: n } = p.support;
  if (level <= 2 && n >= 30) return { level: 'high', text: `Based on ${n} past runs of ${train} here` };
  if (level <= 2) return { level: 'medium', text: `Based on ${n} past runs of ${train} here, plus similar trains` };
  if (level <= 4) return { level: 'medium', text: `Based on ${trainType} trains at this station` };
  return { level: 'low', text: `Little data for this stop: based on ${trainType} trains overall` };
}

export function liveOf(l: CoreLive | null | undefined): LiveView | null {
  if (!l) return null;
  const label = l.cancelled ? 'cancelled' : l.delayMin === null ? 'live' : l.delayMin <= 0 ? 'on time now' : `+${l.delayMin} now`;
  return { delayMin: l.delayMin, cancelled: l.cancelled, label, observedAt: l.observedAt };
}

export const pct = (p: number) => `${Math.round(p * 100)}%`;
