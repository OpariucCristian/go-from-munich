-- Concurrent writers (the poller stores several stations in parallel) could race on
-- CREATE TABLE IF NOT EXISTS for a new month. Serialise creation with a transaction-scoped
-- advisory lock and tolerate a table that appeared meanwhile.
CREATE OR REPLACE FUNCTION ensure_stop_events_partition(d date) RETURNS void AS $$
DECLARE
  start_d date := date_trunc('month', d)::date;
  end_d   date := (date_trunc('month', d) + interval '1 month')::date;
  name    text := 'stop_events_' || to_char(start_d, 'YYYY_MM');
BEGIN
  IF to_regclass(name) IS NOT NULL THEN
    RETURN;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('stop_events_partition'));
  EXECUTE format(
    'CREATE TABLE IF NOT EXISTS %I PARTITION OF stop_events FOR VALUES FROM (%L) TO (%L)',
    name, start_d, end_d);
EXCEPTION WHEN duplicate_table THEN
  NULL;
END $$ LANGUAGE plpgsql;
