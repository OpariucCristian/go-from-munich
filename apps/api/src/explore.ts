/**
 * Read endpoints behind the web UI's screens: departure boards, direct connections between two
 * stations, weekday × hour delay patterns, per-stop predictions and data/model metadata.
 * Every prediction goes through the active predictor, so the UI never computes probabilities.
 */
import type { FastifyInstance } from 'fastify';
import { normalizeEva, type CityConfig } from '@gfm/core';
import { getPool } from '@gfm/db';
import { ATTRIBUTION, describe, liveStatus, runReasons, type Predictor } from './predict/service.ts';

const LONG_DISTANCE = ['ICE', 'IC', 'EC', 'ECE', 'RJ', 'RJX', 'NJ', 'EN', 'TGV'];

export type TrainGroup = 'all' | 'long' | 'regional';

export function trainTypesFor(city: CityConfig, group: TrainGroup = 'all'): string[] {
  if (group === 'long') return city.trainTypes.filter((t) => LONG_DISTANCE.includes(t));
  if (group === 'regional') return city.trainTypes.filter((t) => !LONG_DISTANCE.includes(t));
  return city.trainTypes;
}

/** München Hbf also reports trains under its "Gl.27-36" EVA; treat hub siblings as one station. */
export function stationGroup(city: CityConfig, eva: string): string[] {
  const base = (name: string) => name.replace(/\s+Gl\..*$/, '');
  const hub = city.hubs.find((h) => h.eva === eva);
  if (!hub) return [eva];
  return city.hubs.filter((h) => base(h.name) === base(hub.name)).map((h) => h.eva);
}

/**
 * Every EVA that denotes the same station: hub siblings plus all EVAs sharing the station's name.
 * The station list has several EVAs for many names (e.g. Stuttgart Hbf 8000096 and 8098096), and
 * trains are recorded under only one of them.
 */
export async function stationEvas(city: CityConfig, eva: string): Promise<string[]> {
  const { rows } = await getPool().query<{ eva: string }>(
    `SELECT s.eva FROM stations s
     WHERE s.name = (SELECT name FROM stations WHERE eva = $1)`,
    [eva],
  );
  return [...new Set([...stationGroup(city, eva), ...rows.map((r) => r.eva)])];
}

const groupSchema = { type: 'string', enum: ['all', 'long', 'regional'] } as const;
const evaSchema = { type: 'string', pattern: '^0?[0-9]{7}$' } as const;

export function registerExploreRoutes(app: FastifyInstance, city: CityConfig, predictor: () => Predictor) {
  app.get('/meta', async () => {
    const p = predictor();
    // Two horizons: the served model's last training day, and the day before the last nightly run
    // that refreshed the stats, which include the poller's days.
    const { rows } = await getPool().query<{ trained_through: string | null; stats_through: string | null; live_at: Date | null }>(
      `SELECT (SELECT max(train_to)::text FROM models WHERE kind = 'lgbm' AND version = $1) AS trained_through,
              (SELECT ((max(started_at) AT TIME ZONE $3)::date - 1)::text
               FROM job_runs WHERE job = 'nightly' AND city_id = $2 AND stats ? 'stats') AS stats_through,
              (SELECT max(last_observed_at) FROM stop_events WHERE source = 'live') AS live_at`,
      [p.version, city.id, city.tz],
    );
    return {
      city: { id: city.id, name: city.name, tz: city.tz },
      hubs: city.hubs.filter((h) => !/Gl\./.test(h.name)),
      model: { kind: p.kind, version: p.version },
      trainedThrough: p.kind === 'lgbm' ? (rows[0]?.trained_through ?? null) : null,
      statsThrough: rows[0]?.stats_through ?? null,
      liveObservedAt: rows[0]?.live_at?.toISOString() ?? null,
      attribution: ATTRIBUTION,
    };
  });

  // Predictions for arbitrary stops of one or more trains (e.g. every stop of a journey).
  app.post<{ Body: { stops: { eva: string; trainType: string; trainNumber: string; event: 'a' | 'd'; planned: string }[] } }>(
    '/predict/stops',
    {
      schema: {
        body: {
          type: 'object',
          required: ['stops'],
          properties: {
            stops: {
              type: 'array',
              minItems: 1,
              maxItems: 80,
              items: {
                type: 'object',
                required: ['eva', 'trainType', 'trainNumber', 'event', 'planned'],
                properties: {
                  eva: evaSchema,
                  trainType: { type: 'string', minLength: 1, maxLength: 10 },
                  trainNumber: { type: 'string', pattern: '^[0-9]{1,6}$' },
                  event: { type: 'string', enum: ['a', 'd'] },
                  planned: { type: 'string', format: 'date-time' },
                },
              },
            },
          },
        },
      },
    },
    async (req) => {
      const queries = req.body.stops.map((s) => ({
        eva: normalizeEva(s.eva),
        trainType: s.trainType.toUpperCase(),
        trainNumber: s.trainNumber,
        event: s.event,
        planned: new Date(s.planned),
      }));
      const [preds, live, reasons] = await Promise.all([
        predictor().predict(queries),
        Promise.all(queries.map((q) => liveStatus(q, q.eva, q.event, q.planned))),
        runReasons(queries),
      ]);
      return queries.map((q, i) => ({
        eva: q.eva,
        event: q.event,
        planned: q.planned.toISOString(),
        live: live[i],
        prediction: describe(preds[i]!),
        reasons: reasons[i],
      }));
    },
  );

  // Departure board: in-scope trains leaving a station in the next `minutes`, with live delays.
  app.get<{ Params: { eva: string }; Querystring: { minutes?: number; at?: string; group?: TrainGroup } }>(
    '/departures/:eva',
    {
      schema: {
        params: { type: 'object', properties: { eva: evaSchema } },
        querystring: {
          type: 'object',
          properties: {
            minutes: { type: 'integer', minimum: 5, maximum: 240, default: 60 },
            at: { type: 'string', format: 'date-time' },
            group: groupSchema,
          },
        },
      },
    },
    async (req) => {
      const eva = normalizeEva(req.params.eva);
      const at = req.query.at ? new Date(req.query.at) : new Date();
      const { rows } = await getPool().query<{
        train_type: string; train_number: string; line: string | null; final_destination: string | null;
        eva: string; planned_dep: Date; dep_delay_min: number | null; dep_cancelled: boolean;
        last_observed_at: Date | null; source: string; route_known: boolean;
      }>(
        `SELECT t.train_type, t.train_number, t.line, t.final_destination, e.eva, e.planned_dep,
                e.dep_delay_min, e.dep_cancelled, e.last_observed_at, e.source,
                EXISTS (
                  SELECT 1 FROM trips t2
                  JOIN stop_events e2 ON e2.service_date = t2.service_date AND e2.trip_id = t2.id
                  WHERE t2.train_type = t.train_type AND t2.train_number = t.train_number
                    AND t2.service_date BETWEEN $2::date - 90 AND $2::date + 1
                    AND e2.eva <> e.eva AND e2.planned_arr IS NOT NULL
                ) AS route_known
         FROM stop_events e JOIN trips t ON t.id = e.trip_id
         WHERE e.eva = ANY($1)
           AND e.service_date BETWEEN ($2::timestamptz - interval '1 day')::date AND ($2::timestamptz + interval '1 day')::date
           AND e.planned_dep BETWEEN $2::timestamptz - interval '90 minutes' AND $2::timestamptz + $3 * interval '1 minute'
           AND COALESCE(e.changed_dep, e.planned_dep) >= $2::timestamptz - interval '1 minute'
           AND t.train_type = ANY($4)
         ORDER BY e.planned_dep, t.train_type, t.train_number
         LIMIT 150`,
        [await stationEvas(city, eva), at, req.query.minutes ?? 60, trainTypesFor(city, req.query.group)],
      );
      const preds = rows.length
        ? await predictor().predict(
            rows.map((r) => ({ eva: r.eva, trainType: r.train_type, trainNumber: r.train_number, event: 'd' as const, planned: r.planned_dep })),
          )
        : [];
      const names = await getPool().query<{ name: string }>('SELECT name FROM stations WHERE eva = $1', [eva]);
      return {
        station: { eva, name: names.rows[0]?.name ?? eva },
        at: at.toISOString(),
        departures: rows.map((r, i) => ({
          // The board can span several EVAs (e.g. Hbf and its Gl.27-36 part); this is the train's own.
          eva: r.eva,
          routeKnown: r.route_known,
          train: `${r.train_type} ${r.train_number}`,
          trainType: r.train_type,
          trainNumber: r.train_number,
          line: r.line,
          destination: r.final_destination,
          planned: r.planned_dep.toISOString(),
          live:
            r.source === 'live' && (r.dep_delay_min !== null || r.dep_cancelled)
              ? { delayMin: r.dep_delay_min, cancelled: r.dep_cancelled, observedAt: r.last_observed_at?.toISOString() ?? null }
              : null,
          prediction: describe(preds[i]!),
        })),
      };
    },
  );

  // Direct trains from A to B on a date. Uses that date's run when we have it, otherwise the
  // same weekday's run from the six weeks before our most recent data (timetables repeat weekly).
  app.get<{ Querystring: { from: string; to: string; date: string; after?: string } }>(
    '/connections',
    {
      schema: {
        querystring: {
          type: 'object',
          required: ['from', 'to', 'date'],
          properties: {
            from: evaSchema,
            to: evaSchema,
            date: { type: 'string', format: 'date' },
            after: { type: 'string', pattern: '^[0-2][0-9]:[0-5][0-9]$' },
          },
        },
      },
    },
    async (req) => {
      const from = normalizeEva(req.query.from);
      const to = normalizeEva(req.query.to);
      const { rows } = await getPool().query<{
        train_type: string; train_number: string; final_destination: string | null;
        from_eva: string; to_eva: string; dep: Date; arr: Date; service_date: string;
      }>(
        `WITH anchor AS (SELECT LEAST($3::date, max(service_date)) AS d FROM trips WHERE service_date <= $3::date),
         cand AS (
           SELECT t.train_type, t.train_number, t.final_destination, t.service_date,
                  a.eva AS from_eva, b.eva AS to_eva, a.planned_dep, b.planned_arr
           FROM stop_events a
           JOIN stop_events b ON b.trip_id = a.trip_id AND b.service_date = a.service_date
           JOIN trips t ON t.id = a.trip_id, anchor
           WHERE a.eva = ANY($1) AND b.eva = ANY($2)
             AND a.planned_dep IS NOT NULL AND b.planned_arr > a.planned_dep
             AND t.train_type = ANY($4)
             AND (a.service_date = $3::date OR (
                  a.service_date BETWEEN anchor.d - 42 AND anchor.d
                  AND extract(isodow FROM a.service_date) = extract(isodow FROM $3::date)))
         ),
         run AS (
           SELECT DISTINCT ON (train_type, train_number) *
           FROM cand
           ORDER BY train_type, train_number, (service_date = $3::date) DESC, service_date DESC
         )
         SELECT train_type, train_number, final_destination, from_eva, to_eva, service_date::text,
                ${shift('planned_dep')} AS dep, ${shift('planned_arr')} AS arr
         FROM run
         ORDER BY dep`,
        [await stationEvas(city, from), await stationEvas(city, to), req.query.date, city.trainTypes],
      );
      const after = req.query.after;
      const list = rows
        .filter((r) => !after || localHm(r.dep, city.tz) >= after)
        .slice(0, 12);
      const preds = list.length
        ? await predictor().predict(
            list.flatMap((r) => [
              { eva: r.from_eva, trainType: r.train_type, trainNumber: r.train_number, event: 'd' as const, planned: r.dep },
              { eva: r.to_eva, trainType: r.train_type, trainNumber: r.train_number, event: 'a' as const, planned: r.arr },
            ]),
          )
        : [];
      return {
        date: req.query.date,
        connections: list.map((r, i) => ({
          train: `${r.train_type} ${r.train_number}`,
          trainType: r.train_type,
          trainNumber: r.train_number,
          destination: r.final_destination,
          fromEva: r.from_eva,
          toEva: r.to_eva,
          plannedDep: r.dep.toISOString(),
          plannedArr: r.arr.toISOString(),
          basedOnRun: r.service_date,
          departure: describe(preds[2 * i]!),
          arrival: describe(preds[2 * i + 1]!),
        })),
      };
    },
  );

  // Average departure delay at the city's hubs by weekday × hour over the last `days` of data.
  app.get<{ Querystring: { group?: TrainGroup; days?: number } }>(
    '/patterns',
    {
      schema: {
        querystring: {
          type: 'object',
          properties: { group: groupSchema, days: { type: 'integer', minimum: 7, maximum: 365, default: 90 } },
        },
      },
    },
    async (req) => {
      const evas = city.hubs.map((h) => h.eva);
      const days = req.query.days ?? 90;
      const { rows } = await getPool().query<{
        dow: number; hour: number; avg: number | null; late: number | null; cancelled: number; n: number; lo: string; hi: string;
      }>(
        `WITH bounds AS (
           SELECT max(service_date) AS hi FROM stop_events
           WHERE eva = ANY($1) AND service_date <= current_date AND (dep_delay_min IS NOT NULL OR dep_cancelled))
         SELECT extract(isodow FROM e.planned_dep AT TIME ZONE $4)::int AS dow,
                extract(hour FROM e.planned_dep AT TIME ZONE $4)::int AS hour,
                avg(LEAST(GREATEST(e.dep_delay_min, 0), 120)) FILTER (WHERE NOT e.dep_cancelled)::float8 AS avg,
                avg((e.dep_delay_min >= 6)::int) FILTER (WHERE NOT e.dep_cancelled)::float8 AS late,
                avg(e.dep_cancelled::int)::float8 AS cancelled,
                count(*)::int AS n,
                (min(bounds.hi) - $2::int + 1)::text AS lo, min(bounds.hi)::text AS hi
         FROM stop_events e JOIN trips t ON t.id = e.trip_id, bounds
         WHERE e.eva = ANY($1) AND e.service_date > bounds.hi - $2::int AND e.service_date <= bounds.hi
           AND e.planned_dep IS NOT NULL AND (e.dep_delay_min IS NOT NULL OR e.dep_cancelled)
           AND t.train_type = ANY($3)
         GROUP BY 1, 2
         ORDER BY 1, 2`,
        [evas, days, trainTypesFor(city, req.query.group), city.tz],
      );
      return {
        from: rows[0]?.lo ?? null,
        to: rows[0]?.hi ?? null,
        departures: rows.reduce((a, r) => a + r.n, 0),
        cells: rows.map(({ lo: _lo, hi: _hi, ...c }) => c),
      };
    },
  );
}

/** Moves a timestamp from the run's service date to $3 in Berlin wall-clock time (DST-safe). */
const shift = (col: string) =>
  `((${col} AT TIME ZONE 'Europe/Berlin') + ($3::date - service_date) * interval '1 day') AT TIME ZONE 'Europe/Berlin'`;

function localHm(d: Date, tz: string): string {
  return new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(d);
}
