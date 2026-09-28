/**
 * Worker entry point.
 *
 *   backfill --from 2024-07 --to 2026-08   import piebro months (default: all available)
 *   import-latest                          import the newest published month not yet imported
 *   poll                                   run the live IRIS poller (forever)
 *   refresh-stats                          rebuild agg_delay_stats
 *   nightly                                run the nightly pipeline once
 *   train                                  export features, train LightGBM, register/promote
 *   backtest [--days 28]                   score the baseline on the last N days
 *   run                                    poller + scheduled jobs (production mode)
 *
 * Global option: --city muc (default from $CITY)
 */
import { parseArgs } from 'node:util';
import { getCity } from '@gfm/core';
import { closePool } from '@gfm/db';
import { backfillMonth, listAvailableMonths, monthRange } from './backfill.ts';
import { importLatestMonth } from './monthlyImport.ts';
import { Poller } from './poller.ts';
import { refreshStats } from './stats.ts';
import { runNightly, startScheduler } from './nightly.ts';
import { trainAndPromote } from './train.ts';
import { backtestBaseline, labelledDataEnd } from '@gfm/model';

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    city: { type: 'string', default: process.env.CITY ?? 'muc' },
    from: { type: 'string' },
    to: { type: 'string' },
    days: { type: 'string', default: '28' },
  },
});

const city = getCity(values.city!);
const command = positionals[0];

async function main() {
  switch (command) {
    case 'backfill': {
      const available = await listAvailableMonths();
      const months = monthRange(values.from ?? available[0]!, values.to ?? available.at(-1)!).filter((m) =>
        available.includes(m),
      );
      for (const month of months) {
        console.log(`[backfill] ${city.id} ${month} …`);
        console.log('[backfill]', JSON.stringify(await backfillMonth(city, month)));
      }
      break;
    }
    case 'import-latest':
      console.log(JSON.stringify(await importLatestMonth(city)));
      break;
    case 'refresh-stats':
      console.log(JSON.stringify(await refreshStats(city)));
      break;
    case 'nightly':
      console.log(JSON.stringify(await runNightly(city)));
      break;
    case 'train':
      console.log(JSON.stringify(await trainAndPromote(city), null, 2));
      break;
    case 'backtest': {
      const days = Number(values.days);
      const r = await backtestBaseline({ cutoff: new Date((await labelledDataEnd()).getTime() - days * 86400_000), days, tz: city.tz, evas: city.hubs.map((h) => h.eva) });
      console.log(JSON.stringify(r, null, 2));
      break;
    }
    case 'poll':
      await new Poller(city).run();
      return; // runs forever
    case 'run':
      startScheduler(city);
      await new Poller(city).run();
      return;
    default:
      console.error('Usage: worker <backfill|import-latest|poll|refresh-stats|nightly|train|backtest|run> [--city muc]');
      process.exitCode = 1;
  }
  await closePool();
}

main().catch(async (err) => {
  console.error(err);
  await closePool();
  process.exit(1);
});
