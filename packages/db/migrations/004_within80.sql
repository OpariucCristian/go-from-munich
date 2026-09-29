-- The accuracy metric is now one-sided: the share of runs at most as late as the predicted 80th
-- percentile ("80% chance it's at most X min late"). A p10–p90 range was misleading for delays
-- because most trains are on time, which pins p10 at 0. Existing rows are rescored with
-- `worker score --all`.
ALTER TABLE accuracy_daily RENAME COLUMN range80_coverage TO within80;
COMMENT ON COLUMN accuracy_daily.n_run IS 'n minus cancelled: denominator of within80 and mae_min';
