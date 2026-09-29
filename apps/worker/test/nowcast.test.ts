/**
 * Integration test for the live-delay nowcast tables and sighting lookups. Requires
 * TEST_DATABASE_URL; runs in its own schema. Skipped without it.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';

const url = process.env.TEST_DATABASE_URL;
const SCHEMA = 'nowcast_test';
const DAY = '2026-08-10';
const at = (hhmm: string) => new Date(`${DAY}T${hhmm}:00Z`);

describe.skipIf(!url)('nowcast', () => {
  let model: typeof import('@gfm/model');
  let db: typeof import('@gfm/db');
  let pool: pg.Pool;

  beforeAll(async () => {
    const admin = new pg.Client({ connectionString: url });
    await admin.connect();
    await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE; CREATE SCHEMA ${SCHEMA};`);
    await admin.end();
    process.env.DATABASE_URL = `${url}${url!.includes('?') ? '&' : '?'}options=-c%20search_path%3D${SCHEMA}`;
    db = await import('@gfm/db');
    model = await import('@gfm/model');
    pool = db.getPool();
    await db.migrate();
    await pool.query('SELECT ensure_stop_events_partition($1::date)', [DAY]);
    // Two runs: A → B → C. Run 1 is 20 min late at A and B, 25 at C; run 2 is on time throughout.
    for (const [n, delays] of [['1', [20, 20, 25]], ['2', [0, 0, 0]]] as const) {
      const { rows } = await pool.query<{ id: string }>(
        `INSERT INTO trips (ride_id, origin_start, service_date, train_type, train_number)
         VALUES ($1, '2608101000', $2, 'ICE', $1) RETURNING id`,
        [n, DAY],
      );
      await pool.query(
        `INSERT INTO stop_events (service_date, trip_id, eva, stop_seq, planned_arr, arr_delay_min, planned_dep, dep_delay_min, source)
         VALUES ($1, $2, '8000013', 1, NULL, NULL, $3, $4, 'piebro'),
                ($1, $2, '8004158', 2, $5, $6, $5, $6, 'piebro'),
                ($1, $2, '8000261', 3, $7, $8, NULL, NULL, 'piebro')`,
        [DAY, rows[0]!.id, at('10:00'), delays[0], at('10:30'), delays[1], at('11:00'), delays[2]],
      );
    }
  });
  afterAll(() => db?.closePool());

  it('counts earlier-stop / later-stop pairs per delay and gap band, with rollups', async () => {
    const r = await model.refreshNowcastStats({ asOf: new Date(`${DAY}T23:00:00Z`) });
    expect(r.groups).toBeGreaterThan(0);
    const { rows } = await pool.query<{ key: string; weights: number[]; n: number }>(
      `SELECT key, weights, n FROM agg_nowcast_stats WHERE level = 3 AND event = 'a' ORDER BY key`,
    );
    // Arrivals at Hbf (11:00): seen at A (60 min, band 3) and B (30 min, band 2; dep and arr, both
    // at 10:30). Arrival at Pasing (10:30): seen at A (30 min, band 2). Late run: bucket 4.
    expect(Object.fromEntries(rows.map((r) => [r.key, r.n]))).toEqual({
      '*|2': 6, '*|3': 2, '0|2': 3, '0|3': 1, '4|2': 3, '4|3': 1,
    });
    const late = rows.find((r) => r.key === '4|3')!;
    expect(late.weights[4]).toBe(1);
  });

  it('finds the latest sighting before the cutoff and ignores later stops', async () => {
    const { rows } = await pool.query<{ id: string }>(`SELECT id::text FROM trips WHERE train_number = '1'`);
    const run = { tripId: rows[0]!.id, serviceDate: DAY, planned: at('11:00') };
    const [atB, atA, none] = await model.sightingsForRuns(
      [
        { ...run, cutoff: at('10:45') },
        { ...run, cutoff: at('10:15') }, // B is still in the future
        { ...run, cutoff: at('09:50') },
      ],
      pool,
    );
    expect(atB).toMatchObject({ eva: '8004158', delayMin: 20, gapMin: 30 });
    expect(atA).toMatchObject({ eva: '8000013', delayMin: 20, gapMin: 60 });
    expect(none).toBeNull();
  });

  it('resolves the run of a queried stop and applies the tables when serving', async () => {
    const layer = new model.NowcastLayer(
      { kind: 'test', version: 'v', predict: async (qs) => qs.map(() => ({ distribution: [0.9, 0.05, 0.02, 0.01, 0.01, 0.005, 0.003, 0.002], supportLevel: 6 as const, supportN: 0 })) },
      'Europe/Berlin',
      { mode: 'dirichlet', alpha: 1 },
      () => at('10:40'),
    );
    const [late, onTime] = await layer.predict([
      { eva: '8000261', trainType: 'ICE', trainNumber: '1', event: 'a', planned: at('11:00') },
      { eva: '8000261', trainType: 'ICE', trainNumber: '2', event: 'a', planned: at('11:00') },
    ]);
    expect(late!.sighting).toMatchObject({ eva: '8004158', delayMin: 20 });
    expect(late!.distribution[4]).toBeGreaterThan(0.5);
    expect(onTime!.distribution[0]).toBeGreaterThan(0.9);
    expect(layer.version).toBe('v+nowcast');
  });
});
