/**
 * Grouping levels for the empirical delay statistics, from most specific (1) to global (6).
 * The same key builders are used in SQL (stats refresh) and in TypeScript (lookups), so both
 * sides must stay in sync — see `groupKeySql` / `groupKeys`.
 */
import { toLocalParts } from '@gfm/core';

export type DayType = 'wd' | 'sat' | 'sun';
export type HourBand = 'night' | 'am' | 'mid' | 'pm' | 'eve';

export function dayTypeOf(weekday: number): DayType {
  return weekday === 5 ? 'sat' : weekday === 6 ? 'sun' : 'wd';
}

export function hourBandOf(hour: number): HourBand {
  if (hour < 6) return 'night';
  if (hour < 10) return 'am';
  if (hour < 15) return 'mid';
  if (hour < 20) return 'pm';
  return 'eve';
}

export interface StopQuery {
  eva: string;
  trainType: string;
  trainNumber: string;
  event: 'a' | 'd';
  planned: Date;
}

export const LEVELS = [1, 2, 3, 4, 5, 6] as const;
export type Level = (typeof LEVELS)[number];

/** Keys for every level, most specific first. */
export function groupKeys(q: StopQuery, tz = 'Europe/Berlin'): { level: Level; key: string }[] {
  const p = toLocalParts(q.planned, tz);
  const dt = dayTypeOf(p.weekday);
  const hb = hourBandOf(p.hour);
  return [
    { level: 1, key: `${q.eva}|${q.trainNumber}|${dt}|${hb}` },
    { level: 2, key: `${q.eva}|${q.trainNumber}` },
    { level: 3, key: `${q.eva}|${q.trainType}|${dt}|${hb}` },
    { level: 4, key: `${q.eva}|${q.trainType}` },
    { level: 5, key: q.trainType },
    { level: 6, key: '*' },
  ];
}

/** SQL expressions over columns (eva, train_type, train_number, day_type, hour_band). */
export const groupKeySql: Record<Level, string> = {
  1: `eva || '|' || train_number || '|' || day_type || '|' || hour_band`,
  2: `eva || '|' || train_number`,
  3: `eva || '|' || train_type || '|' || day_type || '|' || hour_band`,
  4: `eva || '|' || train_type`,
  5: `train_type`,
  6: `'*'`,
};

export const dayTypeSql = (localTs: string) =>
  `CASE extract(isodow FROM ${localTs}) WHEN 6 THEN 'sat' WHEN 7 THEN 'sun' ELSE 'wd' END`;

export const hourBandSql = (localTs: string) => `CASE
  WHEN extract(hour FROM ${localTs}) < 6 THEN 'night'
  WHEN extract(hour FROM ${localTs}) < 10 THEN 'am'
  WHEN extract(hour FROM ${localTs}) < 15 THEN 'mid'
  WHEN extract(hour FROM ${localTs}) < 20 THEN 'pm'
  ELSE 'eve' END`;
