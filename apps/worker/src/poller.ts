/**
 * Live poller for the DB Timetables API. Runs forever:
 *  - plan:  planned stops for each polled station, from 2h ago to 12h ahead (each hour slot once)
 *  - fchg:  all current changes; hubs every 2 min, corridor stations every 5 min
 *
 * Rows are filtered to in-scope train types. At corridor stations we keep only trips whose
 * planned route passes one of the city's hubs, so e.g. Augsburg–Ulm regional trains are skipped.
 * `fchg` rows only update trips that a `plan` response already created.
 */
import { polledStations, toLocalParts, type CityConfig, type StationRef } from '@gfm/core';
import { copyRowsToStaging, createStaging, mergeStaging, withTransaction, type MergeStats } from '@gfm/db';
import { IrisClient, parseTimetable, type ParsedStop } from '@gfm/iris';

const HOUR = 3600_000;
const PLAN_BACK_H = 2;
const PLAN_AHEAD_H = 12;

export interface PollerOptions {
  hubChangesEveryMs?: number;
  corridorChangesEveryMs?: number;
  planEveryMs?: number;
}

export class Poller {
  private readonly fetchedSlots = new Set<string>();
  private readonly hubNames: string[];
  private readonly hubEvas: Set<string>;
  private stopped = false;
  private readonly totals = { plan: 0, changes: 0, rows: 0, trips: 0, observations: 0, errors: 0 };

  constructor(
    private readonly city: CityConfig,
    private readonly client: IrisClient = IrisClient.fromEnv(),
    private readonly opts: PollerOptions = {},
  ) {
    this.hubEvas = new Set(city.hubs.map((h) => h.eva));
    this.hubNames = city.hubs.map((h) => h.name.replace(/\s+Gl\..*$/, ''));
  }

  stop() {
    this.stopped = true;
  }

  async run(): Promise<void> {
    const stations = polledStations(this.city);
    const hubs = stations.filter((s) => this.hubEvas.has(s.eva));
    const corridor = stations.filter((s) => !this.hubEvas.has(s.eva));
    console.log(`[poller] ${this.city.id}: ${hubs.length} hubs, ${corridor.length} corridor stations`);
    process.once('SIGTERM', () => this.stop());
    process.once('SIGINT', () => this.stop());

    await Promise.all([
      this.every(this.opts.planEveryMs ?? 15 * 60_000, () => this.pollPlans(stations)),
      this.every(this.opts.hubChangesEveryMs ?? 2 * 60_000, () => this.pollChanges(hubs)),
      this.every(this.opts.corridorChangesEveryMs ?? 5 * 60_000, () => this.pollChanges(corridor)),
      this.every(10 * 60_000, async () => {
        console.log(`[poller] totals ${JSON.stringify(this.totals)} calls=${this.client.calls}`);
      }),
    ]);
  }

  private async every(ms: number, fn: () => Promise<void>) {
    while (!this.stopped) {
      const started = Date.now();
      try {
        await fn();
      } catch (err) {
        this.totals.errors++;
        console.error('[poller]', err);
      }
      const wait = Math.max(1000, ms - (Date.now() - started));
      await new Promise((r) => setTimeout(r, wait));
    }
  }

  /** Fetch plan slots not seen yet in the [-2h, +12h] window. */
  async pollPlans(stations: StationRef[]) {
    const now = Date.now();
    const slots: Date[] = [];
    for (let h = -PLAN_BACK_H; h <= PLAN_AHEAD_H; h++) slots.push(new Date(now + h * HOUR));
    const jobs: Promise<void>[] = [];
    for (const station of stations) {
      for (const at of slots) {
        const p = toLocalParts(at, this.city.tz);
        const key = `${station.eva}:${p.year}-${p.month}-${p.day}T${p.hour}`;
        if (this.fetchedSlots.has(key)) continue;
        jobs.push(
          (async () => {
            const body = await this.client.plan(station.eva, at);
            this.fetchedSlots.add(key);
            this.totals.plan++;
            if (body) await this.store(this.filter(station, parseTimetable(body, { eva: station.eva, observedAt: new Date() })));
          })(),
        );
      }
    }
    this.totals.errors += await settle(jobs);
    // Forget slots older than the window so the set doesn't grow forever.
    if (this.fetchedSlots.size > stations.length * 48) this.fetchedSlots.clear();
  }

  async pollChanges(stations: StationRef[]) {
    this.totals.errors += await settle(
      stations.map(async (station) => {
        const body = await this.client.fullChanges(station.eva);
        this.totals.changes++;
        if (body) await this.store(changesOnly(parseTimetable(body, { eva: station.eva, observedAt: new Date() })));
      }),
    );
  }

  filter(station: StationRef, rows: ParsedStop[]): ParsedStop[] {
    const types = new Set(this.city.trainTypes);
    const atHub = this.hubEvas.has(station.eva);
    return rows.filter(
      (r) =>
        r.trainType !== null &&
        types.has(r.trainType) &&
        (atHub || r.path.some((name) => this.hubNames.some((hub) => name.startsWith(hub)))),
    );
  }

  private async store(rows: ParsedStop[]): Promise<MergeStats | null> {
    if (!rows.length) return null;
    const stats = await withTransaction(async (c) => {
      await createStaging(c);
      await copyRowsToStaging(c, rows);
      return mergeStaging(c);
    });
    this.totals.rows += stats.stopEvents;
    this.totals.trips += stats.trips;
    this.totals.observations += stats.observations;
    return stats;
  }
}

/**
 * Real `fchg` responses often carry trip labels too. Dropping them means change rows can only
 * update trips a (filtered) `plan` response created, so out-of-scope trains (S-Bahn, …) never
 * enter the database through the change feed.
 */
export function changesOnly(rows: ParsedStop[]): ParsedStop[] {
  return rows.map((r) => ({ ...r, trainType: null, trainNumber: null }));
}

/** Like Promise.all but logs failures instead of rejecting, so one bad call doesn't stop a round. */
async function settle(jobs: Promise<unknown>[]): Promise<number> {
  const results = await Promise.allSettled(jobs);
  let failed = 0;
  for (const r of results) {
    if (r.status === 'rejected') {
      failed++;
      console.error('[poller]', r.reason);
    }
  }
  return failed;
}
