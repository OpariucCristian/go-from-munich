-- Hourly weather at a few fixed points per city (see CityConfig.weatherPoints), from Open-Meteo.
-- 'archive' rows (reanalysis, a few days behind) replace 'forecast' rows for the same hour.
CREATE TABLE weather_hourly (
  point_id  text NOT NULL,
  ts        timestamptz NOT NULL,   -- start of the hour, UTC
  temp_c    real,
  precip_mm real,
  snow_cm   real,
  gust_kmh  real,
  code      smallint,               -- WMO weather code
  source    text NOT NULL CHECK (source IN ('archive', 'forecast')),
  fetched_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (point_id, ts)
);
