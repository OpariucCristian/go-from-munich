/**
 * All DB sources (IRIS, piebro dataset) report wall-clock times in Europe/Berlin without an
 * offset. We store UTC instants, so conversions go through here.
 */
const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatters.set(tz, f);
  }
  return f;
}

export interface LocalParts {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number;
  minute: number;
  weekday: number; // 0 = Monday … 6 = Sunday
}

export function toLocalParts(date: Date, tz = 'Europe/Berlin'): LocalParts {
  const parts = Object.fromEntries(formatter(tz).formatToParts(date).map((p) => [p.type, p.value]));
  const year = Number(parts.year);
  const month = Number(parts.month);
  const day = Number(parts.day);
  const weekday = (new Date(Date.UTC(year, month - 1, day)).getUTCDay() + 6) % 7;
  return { year, month, day, hour: Number(parts.hour), minute: Number(parts.minute), weekday };
}

function offsetMs(date: Date, tz: string): number {
  const p = Object.fromEntries(formatter(tz).formatToParts(date).map((x) => [x.type, x.value]));
  const asUtc = Date.UTC(+p.year!, +p.month! - 1, +p.day!, +p.hour!, +p.minute!, +p.second!);
  return asUtc - Math.floor(date.getTime() / 1000) * 1000;
}

/** Convert a wall-clock time in `tz` to a UTC instant (DST gaps resolve forward). */
export function zonedToUtc(
  year: number,
  month: number,
  day: number,
  hour = 0,
  minute = 0,
  tz = 'Europe/Berlin',
): Date {
  const naive = Date.UTC(year, month - 1, day, hour, minute);
  const first = offsetMs(new Date(naive), tz);
  let result = naive - first;
  const second = offsetMs(new Date(result), tz);
  if (second !== first) result = naive - second;
  return new Date(result);
}

/** Parse IRIS compact timestamps `YYMMddHHmm` (Berlin local). */
export function parseIrisTime(s: string | undefined, tz = 'Europe/Berlin'): Date | null {
  if (!s || !/^\d{10}$/.test(s)) return null;
  return zonedToUtc(
    2000 + Number(s.slice(0, 2)),
    Number(s.slice(2, 4)),
    Number(s.slice(4, 6)),
    Number(s.slice(6, 8)),
    Number(s.slice(8, 10)),
    tz,
  );
}

/** Format a date as `YYMMDD` / `HH` in Berlin local time, as the IRIS plan endpoint expects. */
export function irisPlanSlot(date: Date, tz = 'Europe/Berlin'): { date: string; hour: string } {
  const p = toLocalParts(date, tz);
  const pad = (n: number) => String(n).padStart(2, '0');
  return { date: `${pad(p.year % 100)}${pad(p.month)}${pad(p.day)}`, hour: pad(p.hour) };
}

export function isoDate(p: { year: number; month: number; day: number }): string {
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

export function minutesBetween(from: Date, to: Date): number {
  return Math.round((to.getTime() - from.getTime()) / 60000);
}
