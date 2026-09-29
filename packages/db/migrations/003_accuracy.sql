-- Accuracy tracking: predictions frozen before the train runs, scored the day after.

-- One frozen prediction per stop event and source. `live` rows are captured by the hourly
-- snapshot job the first time a stop appears in the live plan (ON CONFLICT DO NOTHING keeps
-- that earliest prediction); `replay` rows come from an honest historical replay.
CREATE TABLE prediction_snapshots (
  service_date    date NOT NULL,
  trip_id         bigint NOT NULL,
  eva             text NOT NULL,
  event           char(1) NOT NULL CHECK (event IN ('a', 'd')),
  source          text NOT NULL CHECK (source IN ('live', 'replay')),
  train_type      text NOT NULL,
  train_number    text NOT NULL,
  planned         timestamptz NOT NULL,
  predicted_at    timestamptz NOT NULL,
  lead_min        int NOT NULL,
  model_id        int REFERENCES models(id),
  model_kind      text NOT NULL,
  model_version   text NOT NULL,
  dist            real[] NOT NULL,
  support_level   smallint,
  -- Outcome, filled in by scoring (NULL until then, or when the stop never got a label).
  observed_bucket smallint,
  observed_delay  int,
  rps             real,
  log_loss        real,
  scored_at       timestamptz,
  PRIMARY KEY (service_date, trip_id, eva, event, source)
);
CREATE INDEX prediction_snapshots_day ON prediction_snapshots (service_date, source);

-- Daily aggregates, recomputed from the snapshots whenever a day is (re)scored.
CREATE TABLE accuracy_daily (
  service_date     date NOT NULL,
  source           text NOT NULL CHECK (source IN ('live', 'replay')),
  model_version    text NOT NULL,
  n                int NOT NULL,
  n_unlabelled     int NOT NULL,
  n_run            int NOT NULL,  -- n minus cancelled: denominator of range80_coverage and mae_min
  rps              double precision NOT NULL,
  log_loss         double precision NOT NULL,
  brier6           double precision NOT NULL,
  climatology_rps  double precision,
  top_bucket_hit   double precision NOT NULL,
  range80_coverage double precision,
  mae_min          double precision,
  pred_late5       double precision NOT NULL,
  obs_late5        double precision NOT NULL,
  calibration      jsonb NOT NULL,
  breakdown        jsonb NOT NULL,
  computed_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (service_date, source, model_version)
);
