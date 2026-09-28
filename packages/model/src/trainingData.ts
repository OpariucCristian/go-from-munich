/**
 * Exports training/validation CSVs for the Python trainer.
 *
 * Time-ordered chunks avoid target leakage: for each chunk [start, start + chunkDays), baseline
 * statistics are built only from events before `start`, then features are computed for events
 * inside the chunk. The newest `validChunks` chunks form the validation set.
 *
 *   |---- stats ----|w1|              train
 *   |----- stats -----|w2|            train
 *   …
 *   |-------- stats --------|wN|      validation
 *
 * Weekly chunks keep the baseline features at most 7 days stale, close to serving conditions
 * (stats refresh nightly); many chunks keep one unusual month from dominating.
 */
import { createWriteStream } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { once } from 'node:events';
import type { CityConfig } from '@gfm/core';
import { withTransaction } from '@gfm/db';
import { blend, loadStats, DEFAULT_ALPHA } from './baseline.ts';
import { FEATURE_NAMES, FEATURE_VERSION, buildFeatures, originStartToDate, type FeatureContext } from './features.ts';
import type { StopQuery } from './groups.ts';
import { aggregateInto, buildLabelledEvents, labelledDataEnd } from './stats.ts';

export interface ExportOptions {
  outDir: string;
  /** End of the newest chunk (exclusive). Default: the day after the newest labelled data. */
  end?: Date;
  chunkDays?: number;
  trainChunks?: number;
  validChunks?: number;
  windowDays?: number;
  halfLifeDays?: number;
  /** Max events per chunk (random but deterministic sample). */
  maxPerChunk?: number;
}

export interface ExportResult {
  train: { file: string; rows: number };
  valid: { file: string; rows: number };
  meta: string;
  chunks: { start: string; end: string; rows: number; split: 'train' | 'valid' }[];
}

function csvNumber(x: number): string {
  return Number.isFinite(x) ? String(Math.round(x * 1e6) / 1e6) : '';
}

export async function exportTrainingData(city: CityConfig, opts: ExportOptions): Promise<ExportResult> {
  const chunkDays = opts.chunkDays ?? 7;
  const trainChunks = opts.trainChunks ?? 26;
  const validChunks = opts.validChunks ?? 4;
  const maxPerChunk = opts.maxPerChunk ?? 100_000;
  const end = opts.end ?? (await labelledDataEnd());
  await mkdir(opts.outDir, { recursive: true });

  const ctx: FeatureContext = {
    trainTypes: city.trainTypes,
    hubEvas: new Set(city.hubs.map((h) => h.eva)),
    tz: city.tz,
  };
  const header = ['label', ...FEATURE_NAMES].join(',') + '\n';
  const files = {
    train: path.join(opts.outDir, 'train.csv'),
    valid: path.join(opts.outDir, 'valid.csv'),
  };
  const streams = {
    train: createWriteStream(files.train),
    valid: createWriteStream(files.valid),
  };
  streams.train.write(header);
  streams.valid.write(header);
  const counts = { train: 0, valid: 0 };
  const chunks: ExportResult['chunks'] = [];

  const total = trainChunks + validChunks;
  const windowDays = opts.windowDays ?? 365;
  const halfLifeDays = opts.halfLifeDays ?? 60;
  await withTransaction(async (c) => {
    // One labelled-events build covering every chunk's stats window; each chunk then aggregates
    // its own time slice with rescaled weights (see AggregateWindow).
    await buildLabelledEvents(c, { asOf: end, windowDays: windowDays + total * chunkDays, halfLifeDays, tz: city.tz });
    await c.query('CREATE INDEX ON labelled_events (pt)');
    await c.query('ANALYZE labelled_events');
    await c.query('CREATE TEMP TABLE agg_chunk (LIKE agg_delay_stats INCLUDING ALL) ON COMMIT DROP');

    for (let i = 0; i < total; i++) {
      const start = new Date(end.getTime() - (total - i) * chunkDays * 86400_000);
      const stop = new Date(start.getTime() + chunkDays * 86400_000);
      const split = i >= trainChunks ? 'valid' : 'train';
      await c.query('TRUNCATE agg_chunk');
      await aggregateInto(c, 'agg_chunk', {
        from: new Date(start.getTime() - windowDays * 86400_000),
        to: start,
        scale: 2 ** ((end.getTime() - start.getTime()) / 86400_000 / halfLifeDays),
      });

      const { rows } = await c.query<{
        eva: string; train_type: string; train_number: string; event: 'a' | 'd'; pt: Date;
        bucket: number; stop_seq: number | null; origin_start: string;
      }>(
        `SELECT eva, train_type, train_number, stop_seq, origin_start, event, pt, bucket
         FROM labelled_events
         WHERE pt >= $1 AND pt < $2
         ORDER BY md5(eva || train_number || pt::text || event)
         LIMIT $3`,
        [start, stop, maxPerChunk],
      );

      for (let j = 0; j < rows.length; j += 2000) {
        const batch = rows.slice(j, j + 2000);
        const queries: StopQuery[] = batch.map((r) => ({
          eva: r.eva, trainType: r.train_type, trainNumber: r.train_number, event: r.event, planned: r.pt,
        }));
        const stats = await loadStats(queries, city.tz, c, 'agg_chunk');
        let out = '';
        batch.forEach((r, k) => {
          const q = queries[k]!;
          const base = blend(q, stats, DEFAULT_ALPHA, city.tz);
          const f = buildFeatures(q, base, { stopSeq: r.stop_seq, originStart: originStartToDate(r.origin_start, city.tz) }, ctx);
          out += `${r.bucket},${f.map(csvNumber).join(',')}\n`;
        });
        if (!streams[split].write(out)) await once(streams[split], 'drain');
      }
      counts[split] += rows.length;
      chunks.push({ start: start.toISOString(), end: stop.toISOString(), rows: rows.length, split });
    }
  });

  await Promise.all(
    Object.values(streams).map((s) => new Promise<void>((resolve) => s.end(() => resolve()))),
  );
  const meta = path.join(opts.outDir, 'meta.json');
  await writeFile(
    meta,
    JSON.stringify(
      { featureVersion: FEATURE_VERSION, features: FEATURE_NAMES, city: city.id, chunks, trainTypes: city.trainTypes },
      null,
      2,
    ),
  );
  return {
    train: { file: files.train, rows: counts.train },
    valid: { file: files.valid, rows: counts.valid },
    meta,
    chunks,
  };
}
