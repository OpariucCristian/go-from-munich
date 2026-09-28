import pg from 'pg';

let pool: pg.Pool | null = null;

export function getPool(): pg.Pool {
  if (!pool) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) throw new Error('DATABASE_URL is not set');
    pool = new pg.Pool({ connectionString, max: 10 });
  }
  return pool;
}

export async function closePool(): Promise<void> {
  await pool?.end();
  pool = null;
}

export async function withTransaction<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/** Records a job run in `job_runs`; the returned finisher stores the outcome. */
export async function startJob(job: string, cityId: string | null) {
  const { rows } = await getPool().query<{ id: string }>(
    'INSERT INTO job_runs (job, city_id) VALUES ($1, $2) RETURNING id',
    [job, cityId],
  );
  const id = rows[0]!.id;
  return async (status: 'ok' | 'failed', stats: Record<string, unknown> = {}) => {
    await getPool().query('UPDATE job_runs SET finished_at = now(), status = $2, stats = $3 WHERE id = $1', [
      id,
      status,
      stats,
    ]);
  };
}
