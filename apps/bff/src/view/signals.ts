/**
 * "Why this forecast": the inputs a stop's prediction used, in plain language, and the delay
 * reasons DB reported for the run. Reasons are shown for context only; the model doesn't use them.
 */
import type { ReasonView, SignalView } from '../contract.ts';
import type { CorePrediction, CoreReason, CoreWeather } from '../core/types.ts';
import { confidenceOf, sightingOf, timeOf } from './format.ts';

const capitalize = (s: string) => s[0]!.toUpperCase() + s.slice(1);

/** Conditions that plausibly slow trains down. */
export function severeWeather(w: CoreWeather): boolean {
  const over = (v: number | null, t: number) => v !== null && v >= t;
  return (
    over(w.regionGustMax, 60) ||
    over(w.regionPrecip3hMax, 5) ||
    over(w.regionSnow3hMax, 0.5) ||
    (w.regionTempMin !== null && w.regionTempMin <= -8) ||
    over(w.tempC, 32)
  );
}

function localWeather(w: CoreWeather): string | null {
  const parts: string[] = [];
  if (w.tempC !== null) parts.push(`${Math.round(w.tempC)} °C`);
  if (w.snow3h !== null && w.snow3h > 0) parts.push(`${w.snow3h} cm snow`);
  else if (w.precip3h !== null) parts.push(w.precip3h >= 0.2 ? `${w.precip3h} mm rain` : 'dry');
  if (w.gustKmh !== null) parts.push(`gusts ${Math.round(w.gustKmh)} km/h`);
  return parts.length ? `${parts.join(', ')} in Munich` : null;
}

/** The worst along the line, only where it is notably worse than in Munich. */
function regionalWeather(w: CoreWeather): string | null {
  const parts: string[] = [];
  if (w.regionSnow3hMax !== null && w.regionSnow3hMax >= 0.5 && w.regionSnow3hMax > (w.snow3h ?? 0))
    parts.push(`up to ${w.regionSnow3hMax} cm snow`);
  if (w.regionPrecip3hMax !== null && w.regionPrecip3hMax >= 2 && w.regionPrecip3hMax > (w.precip3h ?? 0) + 1)
    parts.push(`up to ${w.regionPrecip3hMax} mm rain`);
  if (w.regionGustMax !== null && w.regionGustMax >= 50 && w.regionGustMax > (w.gustKmh ?? 0) + 10)
    parts.push(`gusts up to ${Math.round(w.regionGustMax)} km/h`);
  if (w.regionTempMin !== null && w.regionTempMin <= -5 && w.regionTempMin < (w.tempC ?? 0) - 3)
    parts.push(`down to ${Math.round(w.regionTempMin)} °C`);
  return parts.length ? `along the line ${parts.join(', ')}` : null;
}

export function weatherSignal(w: CoreWeather): SignalView | null {
  const text = [localWeather(w), regionalWeather(w)].filter(Boolean).join('; ');
  if (!text) return null;
  return { kind: 'weather', title: 'Weather', text: capitalize(text), tone: severeWeather(w) ? 'warn' : 'neutral' };
}

/** Most direct evidence first: the train's own running, then conditions, then history. */
export function signalsOf(p: CorePrediction, train: string, trainType: string): SignalView[] {
  const out: SignalView[] = [];
  const s = sightingOf(p);
  if (s) {
    const seen = s.delayMin <= 2 ? 'On time' : `+${s.delayMin} min`;
    out.push({ kind: 'live', title: 'Seen running', text: `${seen} at ${s.name}, ${p.sighting!.gapMin} min earlier`, tone: s.delayMin > 5 ? 'warn' : 'neutral' });
  }
  const w = p.weather ? weatherSignal(p.weather) : null;
  if (w) out.push(w);
  const c = confidenceOf(p, train, trainType);
  out.push({ kind: 'history', title: `History · ${c.level} confidence`, text: historyText(p, train, trainType), tone: c.level === 'low' ? 'warn' : 'neutral' });
  return out;
}

/** confidenceOf's wording, shortened for a signal cell whose title already says it's history. */
function historyText(p: CorePrediction, train: string, trainType: string): string {
  const { level, observations: n } = p.support;
  if (level <= 2 && n >= 30) return `${n} past runs of ${train} here`;
  if (level <= 2) return `${n} past runs of ${train} here, plus similar trains`;
  if (level <= 4) return `${trainType} trains at this station`;
  return `Little data for this stop: ${trainType} trains overall`;
}

export function reasonViews(reasons: CoreReason[] | undefined): ReasonView[] {
  return (reasons ?? []).map((r) => {
    const others = r.stops > 1 ? ` · ${r.stops} stops` : '';
    const where = r.station ? `${r.station}, ` : '';
    return { kind: r.kind, text: capitalize(r.text), detail: `${where}${timeOf(r.reportedAt)}${others}` };
  });
}
