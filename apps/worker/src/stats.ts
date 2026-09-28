import type { CityConfig } from '@gfm/core';
import { startJob } from '@gfm/db';
import { refreshStats as refresh } from '@gfm/model';

export async function refreshStats(city: CityConfig) {
  const finish = await startJob('refresh-stats', city.id);
  try {
    const stats = await refresh({ tz: city.tz });
    await finish('ok', stats);
    return stats;
  } catch (err) {
    await finish('failed', { error: String(err) });
    throw err;
  }
}
