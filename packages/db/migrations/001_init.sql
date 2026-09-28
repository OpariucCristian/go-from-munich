-- Core schema for delay prediction. Timestamps are UTC instants (timestamptz).

CREATE TABLE stations (
  eva        text PRIMARY KEY,           -- 7 digits, no leading zero
  name       text NOT NULL,
  lat        double precision,
  lon        double precision,
  city_id    text,
  role       text CHECK (role IN ('hub', 'corridor', 'other')) DEFAULT 'other'
);

-- One run of a train. Identity = IRIS ride id + planned origin departure (both stable across stations).
CREATE TABLE trips (
  id                bigserial PRIMARY KEY,
  ride_id           text NOT NULL,
  origin_start      text NOT NULL,       -- YYMMddHHmm, Berlin local
  service_date      date NOT NULL,
  train_type        text NOT NULL,
  train_number      text NOT NULL,
  line              text,
  final_destination text,
  UNIQUE (ride_id, origin_start)
);
CREATE INDEX trips_lookup ON trips (train_type, train_number, service_date);

-- One row per trip x station. Partitioned by month of service_date.
CREATE TABLE stop_events (
  service_date     date NOT NULL,
  trip_id          bigint NOT NULL,
  eva              text NOT NULL,
  stop_seq         int,
  planned_arr      timestamptz,
  changed_arr      timestamptz,
  planned_dep      timestamptz,
  changed_dep      timestamptz,
  arr_delay_min    int,
  dep_delay_min    int,
  arr_cancelled    boolean NOT NULL DEFAULT false,
  dep_cancelled    boolean NOT NULL DEFAULT false,
  is_additional    boolean NOT NULL DEFAULT false,
  source           text NOT NULL CHECK (source IN ('piebro', 'live')),
  last_observed_at timestamptz,
  PRIMARY KEY (service_date, trip_id, eva)
) PARTITION BY RANGE (service_date);
CREATE INDEX stop_events_eva ON stop_events (eva, service_date);

-- Creates the monthly partition for the given date if missing.
CREATE FUNCTION ensure_stop_events_partition(d date) RETURNS void AS $$
DECLARE
  start_d date := date_trunc('month', d)::date;
  end_d   date := (date_trunc('month', d) + interval '1 month')::date;
  name    text := 'stop_events_' || to_char(start_d, 'YYYY_MM');
BEGIN
  EXECUTE format(
    'CREATE TABLE IF NOT EXISTS %I PARTITION OF stop_events FOR VALUES FROM (%L) TO (%L)',
    name, start_d, end_d);
END $$ LANGUAGE plpgsql;

-- Every live change we observe, so we can learn how delays evolve (nowcast features).
CREATE TABLE stop_observations (
  id           bigserial PRIMARY KEY,
  service_date date NOT NULL,
  trip_id      bigint NOT NULL,
  eva          text NOT NULL,
  observed_at  timestamptz NOT NULL,
  changed_arr  timestamptz,
  changed_dep  timestamptz,
  arr_status   text,
  dep_status   text
);
CREATE INDEX stop_observations_trip ON stop_observations (trip_id, eva, observed_at);

-- Bucket counts per grouping key, refreshed nightly; used by the baseline model and as ML features.
CREATE TABLE agg_delay_stats (
  level      smallint NOT NULL,
  key        text NOT NULL,
  event      char(1) NOT NULL CHECK (event IN ('a', 'd')),
  weights    double precision[] NOT NULL,  -- recency-weighted counts per bucket
  n          int NOT NULL,                 -- raw observation count
  mean_delay double precision,
  PRIMARY KEY (level, key, event)
);

CREATE TABLE models (
  id            serial PRIMARY KEY,
  kind          text NOT NULL CHECK (kind IN ('baseline', 'lgbm')),
  version       text NOT NULL,
  trained_at    timestamptz NOT NULL DEFAULT now(),
  train_from    date,
  train_to      date,
  metrics       jsonb,
  artifact_path text,
  is_active     boolean NOT NULL DEFAULT false
);
CREATE UNIQUE INDEX models_one_active ON models (is_active) WHERE is_active;

CREATE TABLE prediction_log (
  id           bigserial PRIMARY KEY,
  created_at   timestamptz NOT NULL DEFAULT now(),
  model_id     int REFERENCES models(id),
  request      jsonb NOT NULL,
  response     jsonb NOT NULL
);

CREATE TABLE job_runs (
  id          bigserial PRIMARY KEY,
  job         text NOT NULL,
  city_id     text,
  started_at  timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  status      text NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'ok', 'failed')),
  stats       jsonb
);
