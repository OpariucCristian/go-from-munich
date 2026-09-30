/**
 * Network state: how the trains around a stop have been running in the hour before the forecast.
 * When a signal fails or a train ahead breaks down, the other trains at that station are late
 * too, before this train has been seen anywhere.
 *
 * Measured over in-scope events planned in the WINDOW_MIN minutes before the cutoff ("now" when
 * serving, a sampled instant when exporting training data): at the stop's own station (only the
 * stations the poller watches, since only those have live data) and across the Munich hubs.
 * Serving and the training export both load events with `loadNetworkEvents` and read them through
 * `NetworkIndex`, so the model sees the same numbers in both.
 */
import { polledStations, type CityConfig } from '@gfm/core';
import { getPool } from '@gfm/db';
import type pg from 'pg';
import { MAX_GAP_MIN, MIN_GAP_MIN } from './nowcast.ts';

type Db = Pick<pg.Pool, 'query'>;

export const NETWORK_WINDOW_MIN = 60;
/** Forecasts further ahead than this get no network state (it says little about hours later). */
export const NETWORK_MAX_LEAD_MIN = MAX_GAP_MIN;
/** Delays are capped here before averaging, so one broken-down train doesn't dominate. */
const DELAY_CAP_MIN = 60;

export const NETWORK_FEATURE_NAMES = [
  'lead_min',
  'net_stn_n',
  'net_stn_delay',
  'net_stn_late5',
  'net_hub_n',
  'net_hub_delay',
  'net_hub_late5',
] as const;

/**
 * Stations with station-level state: the polled ones in Germany. The historical data covers German
 * stations only, so Salzburg or Kufstein would look empty in training but not when serving.
 */
export function networkStations(city: CityConfig): string[] {
  return polledStations(city)
    .map((s) => s.eva)
    .filter((eva) => eva.startsWith('80'));
}

export interface NetEvent {
  eva: string;
  pt: Date;
  /** Null only for cancelled events. */
  delay: number | null;
  cancelled: boolean;
}

export interface NetworkState {
  n: number;
  /** Mean delay of the events that ran, capped at DELAY_CAP_MIN; NaN when none ran. */
  delay: number;
  /** Share of events more than 5 min late or cancelled; NaN when there were none. */
  late5: number;
}

/**
 * The instant a forecast is made for a stop planned at `planned`: now, but never later than
 * MIN_GAP_MIN before the stop (the rule sightings use), so passed stops look like near ones.
 */
export function networkCutoff(planned: Date, now: Date): Date {
  return new Date(Math.min(now.getTime(), planned.getTime() - MIN_GAP_MIN * 60_000));
}

/**
 * In-scope events at `evas` planned in [from, to), with a known delay or cancelled. A passed live
 * event with no reported change counts as on time when the poller was watching then (as for
 * sightings); the historical data records on time as 0.
 */
export async function loadNetworkEvents(
  evas: string[],
  from: Date,
  to: Date,
  trainTypes: string[],
  db: Db = getPool(),
): Promise<NetEvent[]> {
  if (!evas.length || to <= from) return [];
  const { rows } = await db.query<{ eva: string; pt: Date; delay: number | null; cancelled: boolean }>(
    `SELECT e.eva, x.pt, x.cancelled,
            COALESCE(x.delay, CASE WHEN e.source = 'live' AND NOT x.cancelled AND EXISTS (
              SELECT 1 FROM stop_observations o
              WHERE o.eva = e.eva
                AND o.observed_at BETWEEN x.pt - interval '30 minutes' AND x.pt + interval '30 minutes') THEN 0 END) AS delay
     FROM stop_events e
     JOIN trips t ON t.id = e.trip_id AND t.train_type = ANY($4)
     CROSS JOIN LATERAL (VALUES (e.planned_arr, e.arr_delay_min, COALESCE(e.arr_cancelled, false)),
                                (e.planned_dep, e.dep_delay_min, COALESCE(e.dep_cancelled, false))) AS x(pt, delay, cancelled)
     WHERE e.eva = ANY($1)
       AND e.service_date BETWEEN $2::timestamptz::date - 2 AND $3::timestamptz::date + 1
       AND x.pt >= $2 AND x.pt < $3`,
    [evas, from, to, trainTypes],
  );
  return rows
    .filter((r) => r.cancelled || r.delay !== null)
    .map((r) => ({ eva: r.eva, pt: r.pt, delay: r.cancelled ? null : r.delay, cancelled: r.cancelled }));
}

/** Events sorted by time with prefix sums, for O(log n) window lookups. */
class Series {
  private readonly t: number[];
  private readonly n: number[];
  private readonly ran: number[];
  private readonly delay: number[];
  private readonly late: number[];

  constructor(events: NetEvent[]) {
    const sorted = [...events].sort((a, b) => a.pt.getTime() - b.pt.getTime());
    this.t = sorted.map((e) => e.pt.getTime());
    this.n = [0];
    this.ran = [0];
    this.delay = [0];
    this.late = [0];
    for (const e of sorted) {
      const ran = !e.cancelled && e.delay !== null;
      this.n.push(this.n.at(-1)! + 1);
      this.ran.push(this.ran.at(-1)! + (ran ? 1 : 0));
      this.delay.push(this.delay.at(-1)! + (ran ? Math.min(Math.max(e.delay!, 0), DELAY_CAP_MIN) : 0));
      this.late.push(this.late.at(-1)! + (e.cancelled || (e.delay ?? 0) > 5 ? 1 : 0));
    }
  }

  /** Index of the first event at or after `time`. */
  private lower(time: number): number {
    let lo = 0;
    let hi = this.t.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.t[mid]! < time) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  state(from: number, to: number): NetworkState {
    const a = this.lower(from);
    const b = this.lower(to);
    const n = this.n[b]! - this.n[a]!;
    const ran = this.ran[b]! - this.ran[a]!;
    return {
      n,
      delay: ran ? (this.delay[b]! - this.delay[a]!) / ran : NaN,
      late5: n ? (this.late[b]! - this.late[a]!) / n : NaN,
    };
  }
}

export class NetworkIndex {
  private readonly byEva = new Map<string, Series>();
  private readonly hubs: Series;

  constructor(
    events: NetEvent[],
    hubEvas: Set<string>,
    /** Stations with live data; others get no station-level state. */
    private readonly watched: Set<string>,
  ) {
    const groups = new Map<string, NetEvent[]>();
    for (const e of events) {
      if (!groups.has(e.eva)) groups.set(e.eva, []);
      groups.get(e.eva)!.push(e);
    }
    for (const [eva, list] of groups) this.byEva.set(eva, new Series(list));
    this.hubs = new Series(events.filter((e) => hubEvas.has(e.eva)));
  }

  /** The NETWORK_FEATURE_NAMES values for a stop at `eva` planned at `planned`, as of `cutoff`. */
  features(eva: string, planned: Date, cutoff: Date): number[] {
    const lead = (planned.getTime() - cutoff.getTime()) / 60_000;
    if (!(lead >= 0 && lead <= NETWORK_MAX_LEAD_MIN)) return NETWORK_FEATURE_NAMES.map(() => NaN);
    const to = cutoff.getTime();
    const from = to - NETWORK_WINDOW_MIN * 60_000;
    const stn = this.watched.has(eva) ? (this.byEva.get(eva)?.state(from, to) ?? { n: 0, delay: NaN, late5: NaN }) : null;
    const hub = this.hubs.state(from, to);
    return [
      Math.round(lead),
      stn ? stn.n : NaN,
      stn ? stn.delay : NaN,
      stn ? stn.late5 : NaN,
      hub.n,
      hub.delay,
      hub.late5,
    ];
  }
}

/** Loads what a batch of stops needs, cut off at each stop's `networkCutoff`. */
export async function loadNetworkIndex(
  cutoffs: Date[],
  watched: string[],
  hubEvas: string[],
  trainTypes: string[],
  db: Db = getPool(),
): Promise<NetworkIndex> {
  const times = cutoffs.map((c) => c.getTime());
  const events = times.length
    ? await loadNetworkEvents(
        [...new Set([...watched, ...hubEvas])],
        new Date(Math.min(...times) - NETWORK_WINDOW_MIN * 60_000),
        new Date(Math.max(...times)),
        trainTypes,
        db,
      )
    : [];
  return new NetworkIndex(events, new Set(hubEvas), new Set(watched));
}
