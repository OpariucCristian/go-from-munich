/**
 * Integration test for the stop-event merge rules. Requires TEST_DATABASE_URL (a disposable
 * database; the schema is reset). Skipped when it isn't set.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';

const url = process.env.TEST_DATABASE_URL;
const d = (s: string) => new Date(s);

describe.skipIf(!url)('mergeStaging', () => {
  let db: typeof import('../src/index.ts');
  let pool: pg.Pool;

  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    db = await import('../src/index.ts');
    pool = db.getPool();
    await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    await db.migrate();
  });
  afterAll(() => db?.closePool());

  const base: import('../src/index.ts').StopEventInput = {
    rideId: '42', originStart: '2609281000', serviceDate: '2026-09-28',
    trainType: 'ICE', trainNumber: '1000', line: null, finalDestination: 'Berlin Hbf',
    eva: '8000261', stopSeq: 1,
    plannedArr: null, changedArr: null,
    plannedDep: d('2026-09-28T08:00:00Z'), changedDep: d('2026-09-28T08:00:00Z'),
    arrCancelled: false, depCancelled: false, isAdditional: false,
    arrStatus: null, depStatus: null, source: 'piebro', observedAt: null,
  };

  async function load(rows: import('../src/index.ts').StopEventInput[]) {
    return db.withTransaction(async (c) => {
      await db.createStaging(c);
      await db.copyRowsToStaging(c, rows);
      return db.mergeStaging(c);
    });
  }
  const row = async () =>
    (await pool.query('SELECT * FROM stop_events WHERE eva = $1', ['8000261'])).rows[0];

  it('inserts trips and stop events with derived delays', async () => {
    const stats = await load([{ ...base, changedDep: d('2026-09-28T08:07:00Z') }]);
    expect(stats).toMatchObject({ trips: 1, stopEvents: 1, observations: 0 });
    expect(await row()).toMatchObject({ dep_delay_min: 7, source: 'piebro' });
  });

  it('lets partial live changes update without erasing planned data, and records observations', async () => {
    const change = {
      ...base, trainType: null, trainNumber: null, finalDestination: null, stopSeq: null,
      plannedDep: null, changedDep: d('2026-09-28T08:12:00Z'), arrCancelled: null, depCancelled: null,
      isAdditional: null, source: 'live' as const, observedAt: d('2026-09-28T07:55:00Z'),
    };
    const stats = await load([change]);
    expect(stats.observations).toBe(1);
    const r = await row();
    expect(r).toMatchObject({ dep_delay_min: 12, source: 'live', stop_seq: 1 });
    expect(r.planned_dep.toISOString()).toBe('2026-09-28T08:00:00.000Z');
    // The same change again is not a new observation.
    expect((await load([change])).observations).toBe(0);
  });

  it('keeps cancellation state across partial updates and allows revocation', async () => {
    const live = { ...base, trainType: null, trainNumber: null, plannedDep: null, changedDep: null,
      arrCancelled: null, depCancelled: null, isAdditional: null, source: 'live' as const, observedAt: d('2026-09-28T07:56:00Z') };
    await load([{ ...live, depCancelled: true, depStatus: 'c' }]);
    expect(await row()).toMatchObject({ dep_cancelled: true });
    await load([{ ...live, changedDep: d('2026-09-28T08:13:00Z') }]);
    expect(await row()).toMatchObject({ dep_cancelled: true, dep_delay_min: 13 });
    await load([{ ...live, depCancelled: false, depStatus: 'p' }]);
    expect(await row()).toMatchObject({ dep_cancelled: false });
  });

  it('never lets piebro data overwrite live data', async () => {
    await load([{ ...base, changedDep: d('2026-09-28T08:30:00Z') }]);
    expect(await row()).toMatchObject({ dep_delay_min: 13, source: 'live' });
  });

  it('ignores changes for unknown trips', async () => {
    const stats = await load([{ ...base, rideId: '999', trainType: null, trainNumber: null, source: 'live' }]);
    expect(stats).toMatchObject({ trips: 0, stopEvents: 0 });
  });
});

describe.skipIf(!url)('partitions', () => {
  it('survives concurrent creation of the same new month', async () => {
    process.env.DATABASE_URL = url;
    const db = await import('../src/index.ts');
    await db.migrate();
    const pool = db.getPool();
    await pool.query('DROP TABLE IF EXISTS stop_events_2031_01');
    await Promise.all(
      Array.from({ length: 8 }, () =>
        db.withTransaction((c) => c.query("SELECT ensure_stop_events_partition('2031-01-15')")),
      ),
    );
    const { rows } = await pool.query("SELECT to_regclass('stop_events_2031_01') IS NOT NULL AS ok");
    expect(rows[0].ok).toBe(true);
  });
});
