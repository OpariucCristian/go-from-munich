import { getCity } from '@gfm/core';
import { closePool } from '@gfm/db';
import { loadActivePredictor } from '@gfm/model';
import { buildApp } from './app.ts';

const city = getCity(process.env.CITY ?? 'muc');
const app = buildApp({ city });
const port = Number(process.env.API_PORT ?? 8080);

// Serve whichever model the nightly job promoted; re-check every 5 minutes.
let activeId: number | null | undefined;
async function refreshModel() {
  try {
    const p = await loadActivePredictor(city);
    if (p.id !== activeId) {
      activeId = p.id;
      app.setPredictor(p);
      app.log.info({ kind: p.kind, version: p.version }, 'model loaded');
    }
  } catch (err) {
    app.log.error({ err }, 'model refresh failed');
  }
}
await refreshModel();
const timer = setInterval(refreshModel, 5 * 60_000);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, async () => {
    clearInterval(timer);
    await app.close();
    await closePool();
    process.exit(0);
  });
}

await app.listen({ port, host: '0.0.0.0' });
