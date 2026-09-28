/**
 * Trip-level prediction: per-leg departure/arrival distributions, connection risk at each
 * transfer, and live status when the poller has seen the train today.
 */
import {
  BUCKET_LABELS,
  connectionFailureProbability,
  cumulative,
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
}

function describe(p: StopPrediction) {
  const c = cumulative(p.distribution);
  return {
    buckets: p.distribution.map((prob, i) => ({ label: BUCKET_LABELS[i]!, p: round(prob) })),
    atLeast: Object.fromEntries(Object.entries(c.atLeast).map(([k, v]) => [k, round(v)])),
    cancelled: round(c.cancelled),
    support: { level: p.supportLevel, observations: p.supportN },
  };
}

const round = (x: number) => Math.round(x * 10000) / 10000;

async function liveStatus(leg: LegInput, eva: string, event: 'a' | 'd', planned: Date): Promise<LiveStatus | null> {
  const col = event === 'a' ? 'arr' : 'dep';
  const { rows } = await getPool().query<{ delay: number | null; cancelled: boolean; observed: Date | null }>(
    `SELECT e.${col}_delay_min AS delay, e.${col}_cancelled AS cancelled, e.last_observed_at AS observed
     FROM stop_events e JOIN trips t ON t.id = e.trip_id
     WHERE t.train_type = $1 AND t.train_number = $2 AND e.eva = $3 AND e.source = 'live'
       AND e.service_date BETWEEN ($4::timestamptz - interval '1 day')::date AND $4::timestamptz::date
       AND e.planned_${col} = $4
     LIMIT 1`,
    [leg.trainType, leg.trainNumber, eva, planned],
  );
  const r = rows[0];
  if (!r || (r.delay === null && !r.cancelled)) return null;
  return { delayMin: r.delay, cancelled: r.cancelled, observedAt: r.observed?.toISOString() ?? null };
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
