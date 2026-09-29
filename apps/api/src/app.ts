import Fastify from 'fastify';
import { getCity, normalizeEva, type CityConfig } from '@gfm/core';
import { getPool } from '@gfm/db';
import { BaselinePredictor } from '@gfm/model';
import { predictTrip, type LegInput, type Predictor } from './predict/service.ts';
import { resolveShare, shiftSql } from './resolveShare.ts';
import { registerExploreRoutes } from './explore.ts';
import { registerAccuracyRoutes } from './accuracy.ts';
import { registerFeaturedRoutes } from './featured.ts';
import { alignToPartialRun, chooseRun, onRoute, routeEndName, stationKey, type RunSummary } from './trainRun.ts';

const legSchema = {
  type: 'object',
  required: ['trainType', 'trainNumber', 'fromEva', 'toEva', 'plannedDep', 'plannedArr'],
  properties: {
    trainType: { type: 'string', minLength: 1, maxLength: 10 },
    trainNumber: { type: 'string', pattern: '^[0-9]{1,6}$' },
    fromEva: { type: 'string', pattern: '^0?[0-9]{7}$' },
    toEva: { type: 'string', pattern: '^0?[0-9]{7}$' },
    plannedDep: { type: 'string', format: 'date-time' },
    plannedArr: { type: 'string', format: 'date-time' },
  },
} as const;

export interface AppOptions {
  city?: CityConfig;
  predictor?: Predictor;
  logger?: boolean;
}

declare module 'fastify' {
  interface FastifyInstance {
    setPredictor(p: Predictor): void;
  }
}

export function buildApp(opts: AppOptions = {}) {
  const city = opts.city ?? getCity(process.env.CITY ?? 'muc');
  let predictor: Predictor = opts.predictor ?? new BaselinePredictor('baseline-v1', undefined, city.tz);
  const app = Fastify({ logger: opts.logger ?? true });

  app.decorate('setPredictor', (p: Predictor) => {
    predictor = p;
  });

  app.get('/health', async () => {
    await getPool().query('SELECT 1');
    return { ok: true, city: city.id, model: { kind: predictor.kind, version: predictor.version } };
  });

  app.get<{ Querystring: { q: string } }>(
    '/stations',
    { schema: { querystring: { type: 'object', required: ['q'], properties: { q: { type: 'string', minLength: 2 } } } } },
    async (req) => {
      const { rows } = await getPool().query(
        // One row per name: many names have several EVAs, and trains are recorded under one of them.
        // Hub sub-EVAs (München Hbf Gl.27-36) are folded into their station elsewhere, so hide them.
        `SELECT eva, name, role FROM (
           SELECT DISTINCT ON (s.name) s.eva, s.name, s.role,
                  EXISTS (SELECT 1 FROM stop_events e WHERE e.eva = s.eva) AS has_data
           FROM stations s
           WHERE s.name ILIKE $1 AND s.name !~ ' Gl\\.'
           ORDER BY s.name, has_data DESC, (s.role = 'hub') DESC, s.eva
         ) st
         ORDER BY (role = 'hub') DESC, (role = 'corridor') DESC, has_data DESC, length(name) LIMIT 20`,
        [`%${req.query.q.replace(/[%_]/g, '')}%`],
      );
      return rows;
    },
  );

  // Stops of a train on a date. Live runs only cover the stations the poller watches, so that
  // day's run is often a partial copy of the train: the stop list then comes from an earlier run
  // that fits it (see chooseRun), moved to the date and aligned to that day's real times.
  app.get<{ Params: { type: string; number: string }; Querystring: { date?: string } }>(
    '/trains/:type/:number',
    async (req, reply) => {
      const date = req.query.date ?? new Date().toISOString().slice(0, 10);
      const type = req.params.type.toUpperCase();
      const number = req.params.number;
      // Stops are ordered by time, not stop_seq: the dataset sometimes numbers an extra call out
      // of sequence (e.g. München Hbf as stop 101 of a run that ends in Münster).
      const all = await getPool().query<{ id: string; date: string; eva: string; name: string | null; planned_arr: Date | null; planned_dep: Date | null }>(
        `SELECT t.id::text, t.service_date::text AS date, e.eva, s.name, e.planned_arr, e.planned_dep
         FROM trips t
         JOIN stop_events e ON e.trip_id = t.id AND e.service_date = t.service_date
         LEFT JOIN stations s ON s.eva = e.eva
         WHERE t.train_type = $1 AND t.train_number = $2 AND t.service_date BETWEEN $3::date - 90 AND $3::date
         ORDER BY t.service_date, t.id, COALESCE(e.planned_dep, e.planned_arr), e.stop_seq`,
        [type, number, date],
      );
      if (!all.rows.length) return reply.code(404).send({ error: 'unknown train' });
      const runs = new Map<string, RunSummary>();
      for (const r of all.rows) {
        const run = runs.get(r.id) ?? { id: r.id, date: r.date, stations: [] };
        runs.set(r.id, run);
        run.stations.push(stationKey(r.name, r.eva));
      }
      const chosen = chooseRun([...runs.values()], date)!;
      const { rows } = await getPool().query(
        `SELECT e.eva, s.name, e.stop_seq,
                ${shiftSql('e.planned_arr')} AS planned_arr,
                ${shiftSql('e.planned_dep')} AS planned_dep
         FROM (SELECT $1::bigint AS id, $2::date AS service_date) run
         JOIN stop_events e ON e.trip_id = run.id AND e.service_date = run.service_date
         LEFT JOIN stations s ON s.eva = e.eva
         ORDER BY COALESCE(e.planned_dep, e.planned_arr), e.stop_seq`,
        [chosen.id, chosen.date, date],
      );
      let stops = rows;
      let timesFromDate = chosen.date === date;
      if (!timesFromDate) {
        // That date's partial run (live stations only) still has the day's real times.
        const partial = all.rows.filter((r) => r.date === date);
        const aligned = alignToPartialRun(stops, partial);
        timesFromDate = aligned !== stops;
        stops = aligned;
      }
      // The day's full route from the live timetable, when the poller saw the train: it names the
      // real origin and destination (often abroad, outside our data) and which stops it makes.
      const routeRow = await getPool().query<{ route: string[] }>(
        `SELECT route FROM trips
         WHERE train_type = $1 AND train_number = $2 AND service_date = $3 AND route IS NOT NULL LIMIT 1`,
        [type, number, date],
      );
      const route = routeRow.rows[0]?.route ?? null;
      if (route) stops = onRoute(stops, route);
      return {
        train: `${type} ${number}`,
        date,
        basedOnRun: chosen.date,
        timesFromDate,
        origin: route ? routeEndName(route[0]!, stops) : null,
        destination: route ? routeEndName(route.at(-1)!, stops) : null,
        stops,
      };
    },
  );

  app.post<{ Body: { legs: LegInput[] } }>(
    '/predict',
    {
      schema: {
        body: {
          type: 'object',
          required: ['legs'],
          properties: { legs: { type: 'array', minItems: 1, maxItems: 6, items: legSchema } },
        },
      },
    },
    async (req) => {
      const legs = req.body.legs.map((l) => ({
        ...l,
        trainType: l.trainType.toUpperCase(),
        fromEva: normalizeEva(l.fromEva),
        toEva: normalizeEva(l.toEva),
      }));
      const result = await predictTrip(legs, predictor, city);
      await getPool()
        .query('INSERT INTO prediction_log (request, response) VALUES ($1, $2)', [{ legs }, result])
        .catch((err) => req.log.warn({ err }, 'prediction_log insert failed'));
      return result;
    },
  );

  // Share target: DB Navigator "Reise teilen" text/link → legs (+ prediction when resolvable).
  app.post<{ Body: { text?: string; url?: string; title?: string } }>(
    '/resolve-share',
    {
      schema: {
        body: {
          type: 'object',
          properties: {
            text: { type: 'string', maxLength: 5000 },
            url: { type: 'string', maxLength: 2000 },
            title: { type: 'string', maxLength: 500 },
          },
        },
      },
    },
    async (req) => {
      const text = [req.body.title, req.body.text, req.body.url].filter(Boolean).join('\n');
      const resolved = await resolveShare(text);
      const prediction = resolved.legs.length ? await predictTrip(resolved.legs, predictor, city) : null;
      return { ...resolved, prediction };
    },
  );

  registerExploreRoutes(app, city, () => predictor);
  registerAccuracyRoutes(app, city);
  registerFeaturedRoutes(app, city);

  return app;
}
