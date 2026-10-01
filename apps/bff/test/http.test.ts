/** The BFF through Nest's HTTP stack, with the core API stubbed at the fetch level. */
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { AppModule } from '../src/app.module.ts';

const prediction = {
  buckets: [0.7, 0.1, 0.08, 0.04, 0.03, 0.02, 0.01, 0.02].map((p) => ({ label: '', p })),
  atLeast: { '6min': 0.18, '16min': 0.06 },
  cancelled: 0.02,
  minutes: { expected: 3.1, median: 1, p10: 0, p80: 6, p90: 9 },
  support: { level: 1, observations: 120 },
};

const coreCalls: string[] = [];
vi.stubGlobal('fetch', async (url: URL) => {
  coreCalls.push(`${url.pathname}${url.search}`);
  if (url.pathname === '/departures/8000261') {
    return Response.json({
      station: { eva: '8000261', name: 'München Hbf' },
      at: '2026-09-28T20:40:00Z',
      departures: [
        {
          eva: '8098261', routeKnown: true, train: 'ICE 1080', trainType: 'ICE', trainNumber: '1080', line: null, destination: 'Hamburg Hbf',
          planned: '2026-09-28T20:52:00Z', live: { delayMin: 4, cancelled: false, observedAt: null }, prediction,
        },
      ],
    });
  }
  return Response.json({ message: 'unknown train' }, { status: 404 });
});

describe('BFF over HTTP', () => {
  let app: NestFastifyApplication;
  beforeAll(async () => {
    app = await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter(), { logger: false });
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });
  afterAll(() => app?.close());

  it('shapes departures for the board', async () => {
    const res = await app.inject({ method: 'GET', url: '/bff/departures?station=8000261&group=long' });
    expect(res.statusCode).toBe(200);
    expect(coreCalls.at(-1)).toBe('/departures/8000261?group=long&minutes=60');
    expect(res.json().rows[0]).toMatchObject({
      linkable: true,
      eva: '8098261', // the train's own station, not the board's: estimate links depend on it
      time: '22:52',
      train: 'ICE 1080',
      destination: 'Hamburg Hbf',
      split: [0.7, 0.18, 0.1],
      typicalLabel: '+1',
      tone: 'warn', // 18% late + 2% cancelled = 20%
      live: { label: '+4 now' },
    });
  });

  it('validates input and passes core 404s through', async () => {
    expect((await app.inject({ method: 'GET', url: '/bff/departures?group=everything' })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/bff/share', payload: {} })).statusCode).toBe(400);
    const missing = await app.inject({ method: 'GET', url: '/bff/estimate?train=ICE%209999&date=2026-10-26' });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().message).toBe('unknown train');
  });
});
