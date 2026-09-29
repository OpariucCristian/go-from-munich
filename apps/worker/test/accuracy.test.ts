/**
 * Integration test for accuracy tracking (snapshot → score). Requires TEST_DATABASE_URL; runs in
 * its own schema so it doesn't race other DB tests that reset `public`. Skipped without it.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { getCity } from '@gfm/core';

const url = process.env.TEST_DATABASE_URL;
const SCHEMA = 'accuracy_test';
const city = getCity('muc');
const onTime = [0.75, 0.1, 0.07, 0.03, 0.02, 0.01, 0.01, 0.01];

describe.skipIf(!url)('accuracy tracking', () => {
  let acc: typeof import('../src/accuracy.ts');
  let db: typeof import('@gfm/db');
  let pool: pg.Pool;

  beforeAll(async () => {
    const admin = new pg.Client({ connectionString: url });
    await admin.connect();
    await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE; CREATE SCHEMA ${SCHEMA};`);
    await admin.end();
    process.env.DATABASE_URL = `${url}${url!.includes('?') ? '&' : '?'}options=-c%20search_path%3D${SCHEMA}`;
    db = await import('@gfm/db');
    acc = await import('../src/accuracy.ts');
    pool = db.getPool();
    await db.migrate();
    await pool.query(
      `INSERT INTO agg_delay_stats (level, key, event, weights, n)
       VALUES (6, '*', 'a', '{60,20,10,5,2,1,1,1}', 100), (6, '*', 'd', '{60,20,10,5,2,1,1,1}', 100)`,
    );
  });
  afterAll(() => db?.closePool());

  async function trip(serviceDate: string, number: string) {
    await pool.query('SELECT ensure_stop_events_partition($1::date)', [serviceDate]);
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO trips (ride_id, origin_start, service_date, train_type, train_number)
       VALUES ($1, '2609280900', $2, 'ICE', $3) RETURNING id`,
      [`ride-${number}`, serviceDate, number],
    );
    return rows[0]!.id;
  }

  it('scores finished days only, with unlabelled stops counted separately', async () => {
    const id = await trip('2026-09-28', '1000');
    const corridor = city.corridor[0]!.eva;
    await pool.query(
      `INSERT INTO stop_events (service_date, trip_id, eva, stop_seq, planned_arr, arr_delay_min, planned_dep,
                                dep_delay_min, dep_cancelled, source)
       VALUES ('2026-09-28', $1, '8000261', 1, NULL, NULL, '2026-09-28T10:00:00Z', 8, false, 'live'),
              ('2026-09-28', $1, '8000262', 2, '2026-09-28T10:10:00Z', 1, NULL, NULL, false, 'live'),
              ('2026-09-28', $1, '8004158', 3, NULL, NULL, '2026-09-28T10:20:00Z', NULL, true, 'live'),
              ('2026-09-28', $1, $2, 4, '2026-09-28T11:00:00Z', NULL, NULL, NULL, false, 'live')`,
      [id, corridor],
    );
    await pool.query(
      `INSERT INTO prediction_snapshots (service_date, trip_id, eva, event, source, train_type, train_number,
         planned, predicted_at, lead_min, model_kind, model_version, dist)
       SELECT '2026-09-28', $1, eva, event, 'live', 'ICE', '1000', planned, planned - interval '10 hours', 600,
              'baseline', 'baseline-v1', $2::real[]
       FROM (VALUES ('8000261', 'd', '2026-09-28T10:00:00Z'::timestamptz), ('8000262', 'a', '2026-09-28T10:10:00Z'),
                    ('8004158', 'd', '2026-09-28T10:20:00Z'), ($3, 'a', '2026-09-28T11:00:00Z')) v(eva, event, planned)`,
      [id, `{${onTime.join(',')}}`, corridor],
    );

    // 06:00 Berlin the next morning: too early, the day isn't finished yet.
    const early = await acc.scorePending(city, { now: new Date('2026-09-29T04:00:00Z') });
    expect(early.days).toEqual([]);
    // Rescoring everything must not touch a live day that isn't over either.
    expect(await acc.rescoreAll(city, new Date('2026-09-29T04:00:00Z'))).toEqual([]);

    // 07:00 Berlin: scored.
    const r = await acc.scorePending(city, { now: new Date('2026-09-29T05:00:00Z') });
    expect(r.days).toEqual([
      { date: '2026-09-28', source: 'live', snapshots: 4, labelled: 3, unlabelled: 1 },
    ]);
    const { rows } = await pool.query('SELECT * FROM accuracy_daily');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ n: 3, n_unlabelled: 1, n_run: 2, model_version: 'baseline-v1' });
    expect(rows[0].obs_late5).toBeCloseTo(2 / 3, 6); // 8 min late + cancelled
    expect(rows[0].pred_late5).toBeCloseTo(0.15, 5);
    expect(rows[0].breakdown.station.hub.n).toBe(3);

    const scored = await pool.query(
      `SELECT eva, observed_bucket, observed_delay, rps IS NOT NULL AS has_rps, scored_at IS NOT NULL AS scored
       FROM prediction_snapshots ORDER BY planned`,
    );
    expect(scored.rows.map((x) => [x.observed_bucket, x.has_rps, x.scored])).toEqual([
      [2, true, true],
      [0, true, true],
      [7, true, true],
      [null, false, true],
    ]);

    // Nothing left to score; rescoring recent days rewrites the same aggregate.
    expect((await acc.scorePending(city, { now: new Date('2026-09-29T05:00:00Z') })).days).toEqual([]);
    const again = await acc.scorePending(city, { now: new Date('2026-09-29T05:00:00Z'), rescoreDays: 2 });
    expect(again.days).toHaveLength(1);
    expect((await pool.query('SELECT count(*)::int AS n FROM accuracy_daily')).rows[0].n).toBe(1);
  });

  it('freezes the first prediction for upcoming stops and never overwrites it', async () => {
    const { rows } = await pool.query<{ d: string }>('SELECT current_date::text AS d');
    const today = rows[0]!.d;
    const id = await trip(today, '2000');
    await pool.query(
      `INSERT INTO stop_events (service_date, trip_id, eva, stop_seq, planned_dep, source)
       VALUES ($1, $2, '8000261', 1, now() + interval '2 hours', 'live'),
              ($1, $2, '8000262', 2, now() + interval '20 hours', 'live')`,
      [today, id],
    );
    const first = await acc.snapshotPredictions(city);
    expect(first.live).toBe(1); // the stop 20h ahead is outside the 13h window
    expect((await acc.snapshotPredictions(city)).live).toBe(0);
    const snap = await pool.query(
      `SELECT lead_min, model_kind, dist FROM prediction_snapshots WHERE trip_id = $1`,
      [id],
    );
    expect(snap.rows[0].model_kind).toBe('baseline');
    expect(snap.rows[0].lead_min).toBeGreaterThanOrEqual(119);
    expect(snap.rows[0].lead_min).toBeLessThanOrEqual(120);
    expect(snap.rows[0].dist.reduce((a: number, b: number) => a + b, 0)).toBeCloseTo(1, 5);
  });

  it('snapshots stops 30–90 min away as near, with the live sighting that shaped them', async () => {
    const { rows } = await pool.query<{ d: string }>('SELECT current_date::text AS d');
    const id = await trip(rows[0]!.d, '3000');
    // Seen 20 min late at Pasing 30 min ago; arrives at Ost in 60 min (gap 90 min → band 3).
    await pool.query(
      `INSERT INTO stop_events (service_date, trip_id, eva, stop_seq, planned_dep, dep_delay_min, planned_arr, source)
       VALUES ($1, $2, '8004158', 1, date_trunc('minute', now()) - interval '30 minutes', 20, NULL, 'live'),
              ($1, $2, '8000262', 2, NULL, NULL, date_trunc('minute', now()) + interval '60 minutes', 'live')`,
      [rows[0]!.d, id],
    );
    await pool.query(
      `INSERT INTO agg_nowcast_stats (level, key, event, weights, n)
       VALUES (3, '4|3', 'a', '{5,5,10,20,500,50,5,5}', 600), (3, '*|3', 'a', '{600,200,100,50,30,10,5,5}', 1000)`,
    );
    const out = await acc.snapshotPredictions(city);
    expect(out.near).toBe(1);
    const snap = await pool.query(
      `SELECT source, sighting_eva, sighting_delay, sighting_gap_min, dist FROM prediction_snapshots
       WHERE trip_id = $1 ORDER BY source`,
      [id],
    );
    expect(snap.rows.map((r) => r.source)).toEqual(['live', 'near']);
    for (const r of snap.rows) {
      expect(r).toMatchObject({ sighting_eva: '8004158', sighting_delay: 20, sighting_gap_min: 90 });
      expect(r.dist[4]).toBeGreaterThan(0.5); // mass moved to 16–30 min
    }
  });
});
