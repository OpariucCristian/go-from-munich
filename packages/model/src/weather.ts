/**
 * Weather features from `weather_hourly`, computed only here for both the training export and
 * serving. The city's own point describes conditions at the stop; the regional worst case
 * (coldest, wettest, windiest point) catches trouble further along the line.
 */
import type pg from 'pg';

type Db = Pick<pg.Pool, 'query'>;
const HOUR = 3600_000;

export const WEATHER_FEATURE_NAMES = [
  'wx_temp_c',
  'wx_precip_3h',
  'wx_snow_3h',
  'wx_gust_kmh',
  'wx_region_temp_min',
  'wx_region_precip_3h_max',
  'wx_region_snow_3h_max',
  'wx_region_gust_max',
] as const;

export interface WeatherHour {
  temp: number | null;
  precip: number | null;
  snow: number | null;
  gust: number | null;
}

/** point id → hour start (ms) → values. */
export type WeatherTable = Map<string, Map<number, WeatherHour>>;

const hourOf = (t: Date | number) => Math.floor(new Date(t).getTime() / HOUR) * HOUR;

export async function loadWeather(db: Db, from: Date, to: Date): Promise<WeatherTable> {
  const { rows } = await db.query<{ point_id: string; ts: Date; temp_c: number | null; precip_mm: number | null; snow_cm: number | null; gust_kmh: number | null }>(
    `SELECT point_id, ts, temp_c, precip_mm, snow_cm, gust_kmh FROM weather_hourly
     WHERE ts >= $1::timestamptz - interval '3 hours' AND ts <= $2`,
    [from, to],
  );
  const table: WeatherTable = new Map();
  for (const r of rows) {
    let byHour = table.get(r.point_id);
    if (!byHour) table.set(r.point_id, (byHour = new Map()));
    byHour.set(r.ts.getTime(), { temp: r.temp_c, precip: r.precip_mm, snow: r.snow_cm, gust: r.gust_kmh });
  }
  return table;
}

const sum3h = (byHour: Map<number, WeatherHour>, h: number, key: 'precip' | 'snow') => {
  let s = 0;
  let seen = false;
  for (const t of [h, h - HOUR, h - 2 * HOUR]) {
    const v = byHour.get(t)?.[key];
    if (v != null) {
      s += v;
      seen = true;
    }
  }
  return seen ? s : NaN;
};

const finite = (xs: number[]) => xs.filter(Number.isFinite);

/**
 * The weather the model sees for the hour of `planned`, in natural units (°C, mm and cm over the
 * last 3 hours, km/h); NaN where the data is missing. Same order as WEATHER_FEATURE_NAMES.
 */
export interface WeatherSnapshot {
  tempC: number;
  precip3h: number;
  snow3h: number;
  gustKmh: number;
  regionTempMin: number;
  regionPrecip3hMax: number;
  regionSnow3hMax: number;
  regionGustMax: number;
}

export function weatherSnapshot(planned: Date, table: WeatherTable, homeId: string): WeatherSnapshot {
  const h = hourOf(planned);
  const home = table.get(homeId);
  const now = home?.get(h);
  const points = [...table.values()];
  const temps = finite(points.map((p) => p.get(h)?.temp ?? NaN));
  const precips = finite(points.map((p) => sum3h(p, h, 'precip')));
  const snows = finite(points.map((p) => sum3h(p, h, 'snow')));
  const gusts = finite(points.map((p) => p.get(h)?.gust ?? NaN));
  const min = (xs: number[]) => (xs.length ? Math.min(...xs) : NaN);
  const max = (xs: number[]) => (xs.length ? Math.max(...xs) : NaN);
  return {
    tempC: now?.temp ?? NaN,
    precip3h: home ? sum3h(home, h, 'precip') : NaN,
    snow3h: home ? sum3h(home, h, 'snow') : NaN,
    gustKmh: now?.gust ?? NaN,
    regionTempMin: min(temps),
    regionPrecip3hMax: max(precips),
    regionSnow3hMax: max(snows),
    regionGustMax: max(gusts),
  };
}

/** Features for the hour of `planned`, in tenths; NaN where the data is missing (LightGBM handles NaN). */
export function weatherFeatures(planned: Date, table: WeatherTable, homeId: string): number[] {
  return snapshotFeatures(weatherSnapshot(planned, table, homeId));
}

export const snapshotFeatures = (w: WeatherSnapshot): number[] =>
  [
    w.tempC,
    w.precip3h,
    w.snow3h,
    w.gustKmh,
    w.regionTempMin,
    w.regionPrecip3hMax,
    w.regionSnow3hMax,
    w.regionGustMax,
  ].map(tenths);

/**
 * Values in whole tenths (31.7 °C → 317). Integers are exact in float32, so ONNX (float32 split
 * thresholds) and LightGBM (double) route every row the same way; 31.7 itself is not.
 */
const tenths = (x: number) => (Number.isFinite(x) ? Math.round(x * 10) : NaN);
