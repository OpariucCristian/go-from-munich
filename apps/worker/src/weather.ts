/**
 * Hourly weather from Open-Meteo (free, no key) for the city's weather points.
 *
 *   weatherBackfill  reanalysis archive for a date range (history for training; a few days behind)
 *   weatherForecast  recent past + next two days, refreshed hourly for serving
 *
 * Archive rows are authoritative: a forecast never overwrites an archive row for the same hour.
 */
import type { CityConfig } from '@gfm/core';
import { getPool, startJob } from '@gfm/db';

const ARCHIVE_URL = 'https://archive-api.open-meteo.com/v1/archive';
const FORECAST_URL = 'https://api.open-meteo.com/v1/forecast';
const HOURLY = 'temperature_2m,precipitation,snowfall,wind_gusts_10m,weather_code';

interface OpenMeteoPoint {
  hourly: {
    time: string[];
    temperature_2m: (number | null)[];
    precipitation: (number | null)[];
    snowfall: (number | null)[];
    wind_gusts_10m: (number | null)[];
    weather_code: (number | null)[];
  };
}

export interface WeatherRow {
  pointId: string;
  ts: Date;
  temp: number | null;
  precip: number | null;
  snow: number | null;
  gust: number | null;
  code: number | null;
}

/** Flattens an Open-Meteo multi-location response (one entry per requested point, in order). */
export function parseOpenMeteo(pointIds: string[], body: OpenMeteoPoint | OpenMeteoPoint[]): WeatherRow[] {
  const list = Array.isArray(body) ? body : [body];
  return list.flatMap((p, i) =>
    p.hourly.time.map((t, k) => ({
      pointId: pointIds[i]!,
      ts: new Date(`${t}:00Z`),
      temp: p.hourly.temperature_2m[k] ?? null,
      precip: p.hourly.precipitation[k] ?? null,
      snow: p.hourly.snowfall[k] ?? null,
      gust: p.hourly.wind_gusts_10m[k] ?? null,
      code: p.hourly.weather_code[k] ?? null,
    })),
  );
}

async function fetchPoints(city: CityConfig, base: string, params: Record<string, string>): Promise<WeatherRow[]> {
  const qs = new URLSearchParams({
    latitude: city.weatherPoints.map((p) => p.lat).join(','),
    longitude: city.weatherPoints.map((p) => p.lon).join(','),
    hourly: HOURLY,
    timezone: 'GMT',
    ...params,
  });
  const res = await fetch(`${base}?${qs}`, { signal: AbortSignal.timeout(120_000) });
  if (!res.ok) throw new Error(`Open-Meteo ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return parseOpenMeteo(city.weatherPoints.map((p) => p.id), (await res.json()) as OpenMeteoPoint[]);
}

export async function storeWeather(rows: WeatherRow[], source: 'archive' | 'forecast'): Promise<number> {
  // Hours the archive hasn't covered yet come back as nulls; don't store empty rows.
  const kept = rows.filter((r) => r.temp !== null || r.precip !== null || r.gust !== null);
  let stored = 0;
  for (let i = 0; i < kept.length; i += 5000) {
    const batch = kept.slice(i, i + 5000);
    const r = await getPool().query(
      `INSERT INTO weather_hourly (point_id, ts, temp_c, precip_mm, snow_cm, gust_kmh, code, source)
       SELECT *, $8 FROM unnest($1::text[], $2::timestamptz[], $3::real[], $4::real[], $5::real[], $6::real[], $7::smallint[])
       ON CONFLICT (point_id, ts) DO UPDATE SET
         temp_c = EXCLUDED.temp_c, precip_mm = EXCLUDED.precip_mm, snow_cm = EXCLUDED.snow_cm,
         gust_kmh = EXCLUDED.gust_kmh, code = EXCLUDED.code, source = EXCLUDED.source, fetched_at = now()
       WHERE EXCLUDED.source = 'archive' OR weather_hourly.source = 'forecast'`,
      [
        batch.map((r) => r.pointId),
        batch.map((r) => r.ts),
        batch.map((r) => r.temp),
        batch.map((r) => r.precip),
        batch.map((r) => r.snow),
        batch.map((r) => r.gust),
        batch.map((r) => r.code),
        source,
      ],
    );
    stored += r.rowCount ?? 0;
  }
  return stored;
}

/** Archive data for [from, to] (YYYY-MM-DD), fetched a year at a time. */
export async function weatherBackfill(city: CityConfig, from: string, to: string) {
  const finish = await startJob('weather-backfill', city.id);
  try {
    let stored = 0;
    for (let start = from; start <= to; ) {
      const next = new Date(`${start}T00:00:00Z`);
      next.setUTCFullYear(next.getUTCFullYear() + 1);
      const end = new Date(Math.min(next.getTime() - 86400_000, Date.parse(`${to}T00:00:00Z`))).toISOString().slice(0, 10);
      stored += await storeWeather(await fetchPoints(city, ARCHIVE_URL, { start_date: start, end_date: end }), 'archive');
      start = next.toISOString().slice(0, 10);
    }
    const out = { from, to, stored };
    await finish('ok', out);
    return out;
  } catch (err) {
    await finish('failed', { error: String(err) });
    throw err;
  }
}

export async function weatherForecast(city: CityConfig) {
  const rows = await fetchPoints(city, FORECAST_URL, { past_days: '2', forecast_days: '2' });
  return { stored: await storeWeather(rows, 'forecast') };
}

/** Daily top-up of the archive for the last `days` days (it lags real time by a few days). */
export function weatherArchiveRecent(city: CityConfig, days = 10, now = new Date()) {
  const iso = (t: number) => new Date(t).toISOString().slice(0, 10);
  return weatherBackfill(city, iso(now.getTime() - days * 86400_000), iso(now.getTime() - 86400_000));
}
