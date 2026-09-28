import Fastify from 'fastify';
import { getCity, normalizeEva, type CityConfig } from '@gfm/core';
import { getPool } from '@gfm/db';
import { BaselinePredictor } from '@gfm/model';
import { predictTrip, type LegInput, type Predictor } from './predict/service.ts';
import { resolveShare, shiftSql } from './resolveShare.ts';

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
        `SELECT eva, name, role FROM stations WHERE name ILIKE $1
         ORDER BY (role = 'hub') DESC, (role = 'corridor') DESC, length(name) LIMIT 20`,
        [`%${req.query.q.replace(/[%_]/g, '')}%`],
      );
      return rows;
    },
  );

  // Stops of a train on a date: exact if we know that run, otherwise the latest known run's pattern.
  app.get<{ Params: { type: string; number: string }; Querystring: { date?: string } }>(
    '/trains/:type/:number',
    async (req, reply) => {
      const date = req.query.date ?? new Date().toISOString().slice(0, 10);
      const { rows } = await getPool().query(
        `WITH run AS (
           SELECT id, service_date FROM trips
           WHERE train_type = $1 AND train_number = $2 AND service_date BETWEEN $3::date - 90 AND $3::date
           ORDER BY (service_date = $3::date) DESC,
                    (extract(isodow FROM service_date) = extract(isodow FROM $3::date)) DESC, service_date DESC
           LIMIT 1)
         SELECT run.service_date::text, e.eva, s.name, e.stop_seq,
                ${shiftSql('e.planned_arr')} AS planned_arr,
                ${shiftSql('e.planned_dep')} AS planned_dep
         FROM run JOIN stop_events e ON e.trip_id = run.id AND e.service_date = run.service_date
         LEFT JOIN stations s ON s.eva = e.eva
         ORDER BY e.stop_seq, COALESCE(e.planned_dep, e.planned_arr)`,
        [req.params.type.toUpperCase(), req.params.number, date],
      );
      if (!rows.length) return reply.code(404).send({ error: 'unknown train' });
      return {
        train: `${req.params.type.toUpperCase()} ${req.params.number}`,
        date,
        basedOnRun: rows[0].service_date,
        stops: rows.map(({ service_date: _, ...r }) => r),
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

  return app;
}
