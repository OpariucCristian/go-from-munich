/**
 * Worker entry point.
 *
 *   backfill --from 2024-07 --to 2026-08   import piebro months (default: all available)
 *   import-latest                          import the newest published month not yet imported
 *   poll                                   run the live IRIS poller + accuracy jobs (forever)
 *   refresh-stats                          rebuild agg_delay_stats
 *   nightly                                run the nightly pipeline once
 *   train                                  export features, train LightGBM, register/promote
 *   backtest [--days 28]                   score the baseline on the last N days
 *   refresh-nowcast                        rebuild agg_nowcast_stats (live-delay tables)
 *   backtest-nowcast [--days 28] [--date]  score the live-delay nowcast against the baseline, by gap
 *   snapshot                               freeze predictions for stops planned in the next 13h
 *   score [--date YYYY-MM-DD | --all]      score a day's snapshots (default: finished, unscored days; --all rescores everything)
 *   replay-accuracy [--days 28]            seed accuracy history by replaying past days (no look-ahead)
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
import { runNightly, startAccuracySchedule, startScheduler } from './nightly.ts';
import { replayAccuracy, rescoreAll, scoreDay, scorePending, snapshotPredictions } from './accuracy.ts';
import { trainAndPromote } from './train.ts';
import { backtestBaseline, backtestNowcast, labelledDataEnd, refreshNowcastStats } from '@gfm/model';
import { polledStations } from '@gfm/core';

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    city: { type: 'string', default: process.env.CITY ?? 'muc' },
    from: { type: 'string' },
    to: { type: 'string' },
    days: { type: 'string', default: '28' },
    date: { type: 'string' },
    all: { type: 'boolean', default: false },
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
    case 'refresh-nowcast':
      console.log(JSON.stringify(await refreshNowcastStats()));
      break;
    case 'backtest-nowcast': {
      const days = Number(values.days);
      // --date YYYY-MM-DD ends the test window there (e.g. the end of the full-run history).
      const end = values.date ? new Date(`${values.date}T00:00:00Z`) : await labelledDataEnd();
      const cutoff = new Date(end.getTime() - days * 86400_000);
      const r = await backtestNowcast({ cutoff, days, tz: city.tz, evas: polledStations(city).map((s) => s.eva) });
      console.log(JSON.stringify(r, null, 2));
      break;
    }
    case 'snapshot':
      console.log(JSON.stringify(await snapshotPredictions(city)));
      break;
    case 'score': {
      const result = values.all
        ? await rescoreAll(city)
        : values.date
          ? await scoreDay(city, values.date)
          : await scorePending(city);
      console.log(JSON.stringify(result, null, 2));
      break;
    }
    case 'replay-accuracy': {
      const { scored: _, ...summary } = await replayAccuracy(city, Number(values.days));
      console.log(JSON.stringify(summary, null, 2));
      break;
    }
    case 'poll':
      startAccuracySchedule(city);
      await new Poller(city).run();
      return; // runs forever
    case 'run':
      startScheduler(city);
      await new Poller(city).run();
      return;
    default:
      console.error('Usage: worker <backfill|import-latest|poll|refresh-stats|nightly|train|backtest|refresh-nowcast|backtest-nowcast|snapshot|score|replay-accuracy|run> [--city muc]');
      process.exitCode = 1;
  }
  await closePool();
}

main().catch(async (err) => {
  console.error(err);
  await closePool();
  process.exit(1);
});
