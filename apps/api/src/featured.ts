/**
 * The train the Estimate screen opens with: among the latest frozen predictions (the hourly
 * snapshots) for departures from the hubs in the next few hours, the one with the largest expected
 * delay. Only trains with a real onward journey count: a train ending ten minutes later at another
 * Munich station (e.g. EC 1216 Wien → München, whose earlier stops are abroad and outside our data)
 * is a confusing first example.
 */
import type { FastifyInstance } from 'fastify';
import { delaySummary, type CityConfig } from '@gfm/core';
import { getPool } from '@gfm/db';
import { lateProbability } from '@gfm/model';

/** How far ahead to look for the featured train. */
export const FEATURED_WINDOW_H = 3;
/** Minimum known journey after the departure, from the train's recent runs. */
export const MIN_ONWARD_MIN = 30;

interface Candidate {
  service_date: string;
  train_type: string;
  train_number: string;
  eva: string;
  name: string | null;
  event: 'a' | 'd';
  planned: Date;
  predicted_at: Date;
  dist: number[];
}

/** Largest expected delay if it runs; ties go to the higher chance of being >5 min late. */
export function pickFeatured<T extends { dist: number[] }>(rows: T[]): (T & { expected: number; lateOver5: number }) | null {
  let best: (T & { expected: number; lateOver5: number }) | null = null;
  for (const r of rows) {
    const c = { ...r, expected: delaySummary(r.dist).expected, lateOver5: lateProbability(r.dist) };
    if (!best || c.expected > best.expected || (c.expected === best.expected && c.lateOver5 > best.lateOver5)) best = c;
  }
  return best;
}

export function registerFeaturedRoutes(app: FastifyInstance, city: CityConfig) {
  app.get('/featured', async () => {
    const { rows } = await getPool().query<Candidate>(
      `WITH cand AS (
         SELECT p.service_date, p.train_type, p.train_number, p.eva, p.event, p.planned, p.predicted_at, p.dist
         FROM prediction_snapshots p
         LEFT JOIN stop_events e ON e.service_date = p.service_date AND e.trip_id = p.trip_id AND e.eva = p.eva
         WHERE p.source = 'live' AND p.event = 'd' AND p.eva = ANY($1)
           AND p.service_date BETWEEN current_date - 1 AND current_date + 1
           AND p.planned > now() AND p.planned <= now() + make_interval(hours => $2)
           -- skip departures already known to be cancelled: they have no delay to forecast
           AND NOT COALESCE(e.dep_cancelled, false))
       SELECT c.service_date::text, c.train_type, c.train_number, c.eva, s.name, c.event, c.planned, c.predicted_at, c.dist
       FROM cand c
       LEFT JOIN stations s ON s.eva = c.eva
       -- Longest journey after this station in any run of the last 60 days (live runs are partial).
       CROSS JOIN LATERAL (
         SELECT max(extract(epoch FROM (last.arr - e.planned_dep)) / 60) AS minutes
         FROM trips t
         JOIN stop_events e ON e.trip_id = t.id AND e.service_date = t.service_date
                           AND e.eva = c.eva AND e.planned_dep IS NOT NULL
         CROSS JOIN LATERAL (SELECT max(x.planned_arr) AS arr FROM stop_events x
                             WHERE x.trip_id = t.id AND x.service_date = t.service_date) last
         WHERE t.train_type = c.train_type AND t.train_number = c.train_number
           AND t.service_date BETWEEN c.service_date - 60 AND c.service_date) onward
       WHERE onward.minutes >= $3`,
      [city.hubs.map((h) => h.eva), FEATURED_WINDOW_H, MIN_ONWARD_MIN],
    );
    const best = pickFeatured(rows);
    if (!best) return { featured: null };
    return {
      featured: {
        trainType: best.train_type,
        trainNumber: best.train_number,
        serviceDate: best.service_date,
        eva: best.eva,
        station: (best.name ?? best.eva).replace(/\s+Gl\..*$/, ''),
        event: best.event,
        planned: best.planned.toISOString(),
        predictedAt: best.predicted_at.toISOString(),
        expected: best.expected,
        lateOver5: best.lateOver5,
        candidates: rows.length,
        windowHours: FEATURED_WINDOW_H,
      },
    };
  });
}
