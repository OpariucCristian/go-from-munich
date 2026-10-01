-- train_to held the end of the first validation chunk. Make it the last day trained on: the day
-- before the latest (exclusive) chunk end, matching the inclusive train_from.
UPDATE models m
SET train_to = x.last_day
FROM (
  SELECT id, (max((c->>'end')::timestamptz) AT TIME ZONE 'UTC')::date - 1 AS last_day
  FROM models CROSS JOIN LATERAL jsonb_array_elements(metrics->'chunks') c
  GROUP BY id
) x
WHERE m.id = x.id;
