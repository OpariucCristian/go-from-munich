/**
 * Trip-level prediction: per-leg departure/arrival distributions, connection risk at each
 * transfer, and live status when the poller has seen the train today.
 */
import {
  BUCKET_LABELS,
  connectionFailureProbability,
  cumulative,
  delayCauseText,
  delaySummary,
  minutesBetween,
  type CityConfig,
  type Distribution,
} from '@gfm/core';
import { getPool } from '@gfm/db';
import type { StopPrediction, StopQuery } from '@gfm/model';

export const ATTRIBUTION =
  'Delay data © Deutsche Bahn AG (CC BY 4.0), via piebro/deutsche-bahn-data and the DB Timetables API.';

export interface LegInput {
  trainType: string;
  trainNumber: string;
  fromEva: string;
  toEva: string;
  plannedDep: string;
  plannedArr: string;
}

export interface Predictor {
  kind: string;
  version: string;
  predict(queries: StopQuery[]): Promise<StopPrediction[]>;
}

export interface LiveStatus {
  delayMin: number | null;
  cancelled: boolean;
  observedAt: string | null;
  /** Latest delay cause DB gave for this run, e.g. 'construction work'. */
  cause: string | null;
}

export function describe(p: StopPrediction) {
  const c = cumulative(p.distribution);
  return {
    buckets: p.distribution.map((prob, i) => ({ label: BUCKET_LABELS[i]!, p: round(prob) })),
    atLeast: Object.fromEntries(Object.entries(c.atLeast).map(([k, v]) => [k, round(v)])),
    cancelled: round(c.cancelled),
    minutes: delaySummary(p.distribution),
    support: { level: p.supportLevel, observations: p.supportN },
    // The live sighting that shaped this prediction (see @gfm/model nowcast), if any.
    sighting: p.sighting
      ? { eva: p.sighting.eva, name: p.sighting.name, delayMin: p.sighting.delayMin, gapMin: p.sighting.gapMin, planned: p.sighting.planned.toISOString() }
      : null,
    // The weather a model scored this stop with (null when no model used weather for it).
    weather: p.weather ? mapValues(p.weather, (v) => (Number.isFinite(v) ? Math.round(v * 10) / 10 : null)) : null,
  };
}

const round = (x: number) => Math.round(x * 10000) / 10000;
const mapValues = <K extends string, V, W>(o: Record<K, V>, f: (v: V) => W) =>
  Object.fromEntries(Object.entries(o).map(([k, v]) => [k, f(v as V)])) as Record<K, W>;

/** A delay reason or announcement DB attached to a train's run. */
export interface RunReason {
  kind: 'cause' | 'announcement';
  text: string;
  /** Where it was last reported, and when. */
  station: string | null;
  reportedAt: string;
  /** How many stops of the run carried it. */
  stops: number;
}

export interface MessageRow {
  trip_id: string;
  eva: string;
  name: string | null;
  type: string;
  code: number | null;
  category: string | null;
  at: Date;
}

/** HIM announcement categories worth showing; plain 'Information' says nothing about delays. */
const ANNOUNCEMENTS: Record<string, string> = {
  Störung: 'disruption on the line',
  Bauarbeiten: 'construction work on the line',
};

/**
 * One entry per distinct reason (DB repeats a cause at every stop it affects), latest first.
 * Unknown codes and uninformative announcements are dropped.
 */
export function reasonsOf(rows: MessageRow[]): RunReason[] {
  const byKey = new Map<string, { kind: RunReason['kind']; text: string; last: MessageRow; stops: Set<string> }>();
  for (const r of rows) {
    const kind = r.type === 'd' ? 'cause' : 'announcement';
    const text = kind === 'cause' ? delayCauseText(r.code) : r.category ? ANNOUNCEMENTS[r.category] : undefined;
    if (!text) continue;
    const key = `${kind}|${text}`;
    const cur = byKey.get(key);
    if (!cur) byKey.set(key, { kind, text, last: r, stops: new Set([r.eva]) });
    else {
      cur.stops.add(r.eva);
      if (r.at > cur.last.at) cur.last = r;
    }
  }
  return [...byKey.values()]
    .sort((a, b) => b.last.at.getTime() - a.last.at.getTime())
    .map((x) => ({
      kind: x.kind,
      text: x.text,
      station: x.last.name ?? x.last.eva,
      reportedAt: x.last.at.toISOString(),
      stops: x.stops.size,
    }));
}

/**
 * Reasons for each queried stop's run: the live trip is found by its planned time at that stop
 * (like liveStatus), and every message of the trip counts, whichever stop DB attached it to.
 */
export async function runReasons(queries: StopQuery[]): Promise<RunReason[][]> {
  if (!queries.length) return [];
  const pool = getPool();
  const { rows: trips } = await pool.query<{ i: string; trip_id: string }>(
    `SELECT DISTINCT q.i::text, e.trip_id::text
     FROM unnest($1::text[], $2::text[], $3::text[], $4::timestamptz[]) WITH ORDINALITY AS q(tt, tn, eva, planned, i)
     JOIN stop_events e ON e.eva = q.eva AND e.source = 'live'
      AND e.service_date BETWEEN (q.planned - interval '1 day')::date AND q.planned::date
      AND (e.planned_arr = q.planned OR e.planned_dep = q.planned)
     JOIN trips t ON t.id = e.trip_id AND t.train_type = q.tt AND t.train_number = q.tn`,
    [queries.map((q) => q.trainType), queries.map((q) => q.trainNumber), queries.map((q) => q.eva), queries.map((q) => q.planned)],
  );
  const tripOf = new Map(trips.map((r) => [Number(r.i) - 1, r.trip_id]));
  const ids = [...new Set(tripOf.values())];
  if (!ids.length) return queries.map(() => []);
  const { rows } = await pool.query<MessageRow>(
    `SELECT m.trip_id::text, m.eva, s.name, m.type, m.code, m.category, coalesce(m.ts, m.first_seen) AS at
     FROM stop_messages m LEFT JOIN stations s ON s.eva = m.eva
     WHERE m.trip_id = ANY($1::bigint[])
       AND ((m.type = 'd' AND m.code > 0) OR (m.type = 'h' AND m.category = ANY($2::text[])))`,
    [ids, Object.keys(ANNOUNCEMENTS)],
  );
  const byTrip = new Map<string, RunReason[]>();
  for (const id of ids) byTrip.set(id, reasonsOf(rows.filter((r) => r.trip_id === id)));
  return queries.map((_, i) => byTrip.get(tripOf.get(i) ?? '') ?? []);
}

export async function liveStatus(
  leg: Pick<LegInput, 'trainType' | 'trainNumber'>,
  eva: string,
  event: 'a' | 'd',
  planned: Date,
): Promise<LiveStatus | null> {
  const col = event === 'a' ? 'arr' : 'dep';
  const { rows } = await getPool().query<{ delay: number | null; cancelled: boolean; observed: Date | null; cause: number | null }>(
    `SELECT e.${col}_delay_min AS delay, e.${col}_cancelled AS cancelled, e.last_observed_at AS observed,
            (SELECT m.code FROM stop_messages m
             WHERE m.trip_id = e.trip_id AND m.type = 'd' AND m.code > 0
             ORDER BY m.ts DESC NULLS LAST LIMIT 1) AS cause
     FROM stop_events e JOIN trips t ON t.id = e.trip_id
     WHERE t.train_type = $1 AND t.train_number = $2 AND e.eva = $3 AND e.source = 'live'
       AND e.service_date BETWEEN ($4::timestamptz - interval '1 day')::date AND $4::timestamptz::date
       AND e.planned_${col} = $4
     LIMIT 1`,
    [leg.trainType, leg.trainNumber, eva, planned],
  );
  const r = rows[0];
  if (!r || (r.delay === null && !r.cancelled)) return null;
  return { delayMin: r.delay, cancelled: r.cancelled, observedAt: r.observed?.toISOString() ?? null, cause: delayCauseText(r.cause) };
}

export async function stationNames(evas: string[]): Promise<Map<string, string>> {
  const { rows } = await getPool().query<{ eva: string; name: string }>(
    'SELECT eva, name FROM stations WHERE eva = ANY($1)',
    [evas],
  );
  return new Map(rows.map((r) => [r.eva, r.name]));
}

export async function predictTrip(legs: LegInput[], predictor: Predictor, city: CityConfig) {
  const queries: StopQuery[] = legs.flatMap((l) => [
    { eva: l.fromEva, trainType: l.trainType, trainNumber: l.trainNumber, event: 'd' as const, planned: new Date(l.plannedDep) },
    { eva: l.toEva, trainType: l.trainType, trainNumber: l.trainNumber, event: 'a' as const, planned: new Date(l.plannedArr) },
  ]);
  const [preds, names, live] = await Promise.all([
    predictor.predict(queries),
    stationNames(legs.flatMap((l) => [l.fromEva, l.toEva])),
    Promise.all(queries.map((q, i) => liveStatus(legs[Math.floor(i / 2)]!, q.eva, q.event, q.planned))),
  ]);

  const legOut = legs.map((l, i) => ({
    train: `${l.trainType} ${l.trainNumber}`,
    from: { eva: l.fromEva, name: names.get(l.fromEva) ?? null, planned: l.plannedDep, live: live[2 * i], departure: describe(preds[2 * i]!) },
    to: { eva: l.toEva, name: names.get(l.toEva) ?? null, planned: l.plannedArr, live: live[2 * i + 1], arrival: describe(preds[2 * i + 1]!) },
  }));

  const transfers = legs.slice(1).map((next, i) => {
    const prev = legs[i]!;
    const planned = minutesBetween(new Date(prev.plannedArr), new Date(next.plannedDep));
    const slack = planned - city.minTransferMin;
    const arr: Distribution = preds[2 * i + 1]!.distribution;
    const dep: Distribution = preds[2 * (i + 1)]!.distribution;
    const risk = connectionFailureProbability(arr, dep, slack);
    return {
      at: { eva: next.fromEva, name: names.get(next.fromEva) ?? null },
      plannedTransferMin: planned,
      minTransferMin: city.minTransferMin,
      failureProbability: round(Math.min(1, risk.total)),
      byDelay: round(risk.byDelay),
      byCancellation: round(risk.byCancellation),
    };
  });

  const allConnectionsHold = transfers.reduce((p, t) => p * (1 - t.failureProbability), 1);
  return {
    legs: legOut,
    transfers,
    finalArrival: legOut.at(-1)!.to.arrival,
    tripSuccessProbability: round(allConnectionsHold),
    model: { kind: predictor.kind, version: predictor.version },
    attribution: ATTRIBUTION,
  };
}
