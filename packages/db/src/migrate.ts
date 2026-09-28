/**
 * Minimal migration runner: applies packages/db/migrations/NNN_*.sql in order, once each,
 * then seeds the station table. Usage: `npm run migrate`.
 */
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { listCities, normalizeEva } from '@gfm/core';
import { closePool, getPool, withTransaction } from './pool.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const migrationsDir = path.join(here, '..', 'migrations');

export async function migrate(): Promise<string[]> {
  const pool = getPool();
  await pool.query(
    'CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())',
  );
  const { rows } = await pool.query<{ name: string }>('SELECT name FROM schema_migrations');
  const applied = new Set(rows.map((r) => r.name));
  const files = (await readdir(migrationsDir)).filter((f) => /^\d+_.*\.sql$/.test(f)).sort();
  const newlyApplied: string[] = [];
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = await readFile(path.join(migrationsDir, file), 'utf8');
    await withTransaction(async (c) => {
      await c.query(sql);
      await c.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
    });
    newlyApplied.push(file);
  }
  return newlyApplied;
}

/** Seeds station names from the dataset's EVA map and tags hubs/corridor stations per city. */
export async function seedStations(): Promise<number> {
  const raw = JSON.parse(
    await readFile(path.join(here, '..', 'seed', 'eva_to_station_name.json'), 'utf8'),
  ) as Record<string, string>;
  const evas = Object.keys(raw).map(normalizeEva);
  const names = Object.values(raw);
  const pool = getPool();
  await pool.query(
    `INSERT INTO stations (eva, name) SELECT * FROM unnest($1::text[], $2::text[])
     ON CONFLICT (eva) DO NOTHING`,
    [evas, names],
  );
  for (const city of listCities()) {
    for (const [role, list] of [['hub', city.hubs], ['corridor', city.corridor]] as const) {
      for (const s of list) {
        await pool.query(
          `INSERT INTO stations (eva, name, city_id, role) VALUES ($1, $2, $3, $4)
           ON CONFLICT (eva) DO UPDATE SET city_id = EXCLUDED.city_id, role = EXCLUDED.role`,
          [s.eva, s.name, city.id, role],
        );
      }
    }
  }
  return evas.length;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const applied = await migrate();
    console.log(applied.length ? `Applied: ${applied.join(', ')}` : 'Schema up to date');
    console.log(`Seeded ${await seedStations()} stations`);
  } finally {
    await closePool();
  }
}
