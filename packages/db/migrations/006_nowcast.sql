-- Live-delay nowcast: how a delay seen at an earlier stop of the same run carries forward.
-- Same layout as agg_delay_stats. Keys (see packages/model/src/nowcast.ts):
--   level 1  eva|train_type|prev|gap     level 2  train_type|prev|gap     level 3  prev|gap
-- where prev is the delay bucket seen at the earlier stop ('*' = any, the marginal over prev)
-- and gap the band of minutes between the two planned times.
CREATE TABLE agg_nowcast_stats (
  level   smallint NOT NULL,
  key     text NOT NULL,
  event   char(1) NOT NULL CHECK (event IN ('a', 'd')),
  weights double precision[] NOT NULL,
  n       int NOT NULL,
  PRIMARY KEY (level, key, event)
);

-- Serving treats a passed stop with no reported change as on time when the poller was watching
-- that station (like finaliseLiveEvents), which looks observations up by station and time.
CREATE INDEX stop_observations_eva ON stop_observations (eva, observed_at);

-- Snapshots taken shortly before departure ('near'), and the sighting each prediction used, so
-- live nowcast inputs are kept alongside their outcomes for later training and analysis.
ALTER TABLE prediction_snapshots DROP CONSTRAINT prediction_snapshots_source_check;
ALTER TABLE prediction_snapshots ADD CONSTRAINT prediction_snapshots_source_check
  CHECK (source IN ('live', 'replay', 'near'));
ALTER TABLE prediction_snapshots
  ADD COLUMN sighting_eva     text,
  ADD COLUMN sighting_delay   int,
  ADD COLUMN sighting_gap_min int;
ALTER TABLE accuracy_daily DROP CONSTRAINT accuracy_daily_source_check;
ALTER TABLE accuracy_daily ADD CONSTRAINT accuracy_daily_source_check
  CHECK (source IN ('live', 'replay', 'near'));
