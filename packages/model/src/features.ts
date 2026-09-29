/**
 * Feature vector for the LightGBM model. Computed ONLY here, both when exporting training
 * data and when serving, so training and serving cannot drift apart. The Python trainer
 * treats columns as opaque numbers in FEATURE_NAMES order.
 *
 * The model is stacked on the baseline: its first inputs are the baseline's smoothed bucket
 * probabilities, and it learns corrections from calendar and route context, the latest live
 * sighting of the train (see nowcast.ts) and the weather (see weather.ts).
 *
 * v3 added the sighting and weather columns; for sighted stops `base_p*` is the baseline with the
 * nowcast tables applied, so the model corrects what is served without it. Training rows get a sighting drawn the same way
 * serving finds one (the latest earlier stop before a sampled "now"), or none, so the model
 * learns both the far-ahead and the train-already-running case.
 */
import Holidays from 'date-holidays';
import { NUM_BUCKETS, isoDate, toLocalParts, zonedToUtc } from '@gfm/core';
import type { StopPrediction } from './baseline.ts';
import type { StopQuery } from './groups.ts';
import type { Sighting } from './nowcast.ts';
import { WEATHER_FEATURE_NAMES } from './weather.ts';

export const FEATURE_VERSION = 3;

export const FEATURE_NAMES = [
  ...Array.from({ length: NUM_BUCKETS }, (_, i) => `base_p${i}`),
  'base_support_log',
  'base_support_level',
  'is_arrival',
  'hour',
  'weekday',
  'is_holiday',
  'is_bridge_day',
  'train_type_code',
  'is_hub',
  'stop_seq',
  'minutes_from_origin',
  'seen_delay_min',
  'seen_gap_min',
  ...WEATHER_FEATURE_NAMES,
] as const;

export interface FeatureContext {
  trainTypes: string[]; // city.trainTypes, defines train_type_code
  hubEvas: Set<string>;
  tz: string;
}

export interface StopExtras {
  stopSeq: number | null;
  /** Planned departure at the train's origin, when known. */
  originStart: Date | null;
  /** Latest live sighting before the stop, if the train is already running. */
  sighting?: Sighting | null;
  /** `weatherFeatures()` for the planned hour; NaNs when unknown. */
  weather?: number[];
}

const holidays = new Holidays('DE', 'BY');
const holidayCache = new Map<string, boolean>();

function isHoliday(dateIso: string): boolean {
  let v = holidayCache.get(dateIso);
  if (v === undefined) {
    const h = holidays.isHoliday(new Date(`${dateIso}T12:00:00Z`));
    v = Array.isArray(h) ? h.some((x) => x.type === 'public') : false;
    holidayCache.set(dateIso, v);
  }
  return v;
}

/** Parse the IRIS origin start `YYMMddHHmm` (Berlin local) into an instant. */
export function originStartToDate(s: string | null, tz = 'Europe/Berlin'): Date | null {
  if (!s || !/^\d{10}$/.test(s)) return null;
  return zonedToUtc(2000 + +s.slice(0, 2), +s.slice(2, 4), +s.slice(4, 6), +s.slice(6, 8), +s.slice(8, 10), tz);
}

export function buildFeatures(q: StopQuery, base: StopPrediction, extras: StopExtras, ctx: FeatureContext): number[] {
  const p = toLocalParts(q.planned, ctx.tz);
  const day = isoDate(p);
  const holiday = isHoliday(day);
  // A working day squeezed between a holiday and the weekend: many people take it off.
  const prevDay = isoDate(toLocalParts(new Date(q.planned.getTime() - 86400_000), ctx.tz));
  const nextDay = isoDate(toLocalParts(new Date(q.planned.getTime() + 86400_000), ctx.tz));
  const bridge =
    !holiday && p.weekday < 5 && ((p.weekday === 4 && isHoliday(prevDay)) || (p.weekday === 0 && isHoliday(nextDay)));
  const typeIdx = ctx.trainTypes.indexOf(q.trainType);
  const fromOrigin = extras.originStart ? (q.planned.getTime() - extras.originStart.getTime()) / 60000 : NaN;

  return [
    ...base.distribution,
    Math.log1p(base.supportN),
    base.supportLevel,
    q.event === 'a' ? 1 : 0,
    p.hour,
    p.weekday,
    holiday ? 1 : 0,
    bridge ? 1 : 0,
    typeIdx >= 0 ? typeIdx : NaN,
    ctx.hubEvas.has(q.eva) ? 1 : 0,
    extras.stopSeq ?? NaN,
    fromOrigin >= 0 && fromOrigin < 48 * 60 ? fromOrigin : NaN,
    extras.sighting ? extras.sighting.delayMin : NaN,
    extras.sighting ? extras.sighting.gapMin : NaN,
    ...(extras.weather ?? WEATHER_FEATURE_NAMES.map(() => NaN)),
  ];
}
