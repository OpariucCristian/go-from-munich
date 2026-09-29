-- A run's full planned route (station names in order, origin to destination) from the live
-- timetable feed. The historical dataset only has German stations, and live stop events only
-- the stations the poller watches, so this is the only record of where a train really starts and
-- ends, and of which stops it makes on that day (routes change with timetables and diversions).
ALTER TABLE trips ADD COLUMN route text[];
