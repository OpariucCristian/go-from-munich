import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { IrisClient, RateLimiter, parseTimetable } from '../src/index.ts';

const fixture = (name: string) =>
  readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', name), 'utf8');
const observedAt = new Date('2026-09-28T13:00:00Z');

describe('parseTimetable', () => {
  it('parses plan responses', () => {
    const rows = parseTimetable(fixture('plan-8000261.xml'), { eva: '8000261', observedAt });
    expect(rows).toHaveLength(5);
    const ice = rows[0]!;
    expect(ice).toMatchObject({
      rideId: '2686007473625185344',
      originStart: '2609281501',
      serviceDate: '2026-09-28',
      trainType: 'ICE',
      trainNumber: '618',
      eva: '8000261',
      stopSeq: 1,
      plannedArr: null,
      finalDestination: 'Hamburg Hbf',
      changedDep: null,
      arrCancelled: null,
      depCancelled: null,
      source: 'live',
    });
    expect(ice.plannedDep?.toISOString()).toBe('2026-09-28T13:01:00.000Z');
    expect(ice.path).toContain('Augsburg Hbf');
    expect(ice.route).toEqual(['München Hbf', 'München-Pasing', 'Augsburg Hbf', 'Ulm Hbf', 'Stuttgart Hbf', 'Hamburg Hbf']);
  });

  it('handles terminating trains, lines and added stops', () => {
    const rows = parseTimetable(fixture('plan-8000261.xml'), { eva: '8000261', observedAt });
    expect(rows[1]).toMatchObject({ trainNumber: '615', plannedDep: null, finalDestination: null });
    expect(rows[2]).toMatchObject({ line: 'RE2', finalDestination: 'München Hbf Gl.27-36' });
    expect(rows[4]).toMatchObject({ isAdditional: true });
  });

  it('parses change responses without trip labels', () => {
    const rows = parseTimetable(fixture('fchg-8000261.xml'), { eva: '0', observedAt });
    expect(rows).toHaveLength(4);
    expect(rows[0]).toMatchObject({ trainType: null, plannedDep: null, eva: '8000261' });
    expect(rows[0]!.changedDep?.toISOString()).toBe('2026-09-28T13:09:00.000Z');
    expect(rows[1]!.changedArr?.toISOString()).toBe('2026-09-28T14:01:00.000Z');
    expect(rows[2]).toMatchObject({ arrCancelled: true, depCancelled: true, arrStatus: 'c' });
    expect(rows[3]).toMatchObject({ depCancelled: false, depStatus: 'p' });
  });

  it('keeps delay causes, quality notes and announcements, dropping free text and connections', () => {
    const xml = `<timetable station="München Hbf" eva="8000261">
      <s id="-1234-2609281300-5" eva="8000261">
        <m id="r1" t="h" from="2609010000" to="2612122359" cat="Information" ts="2608312305" pr="1"/>
        <ar ct="2609281420">
          <m id="r2" t="d" c="24" ts="2609281019"/>
          <m id="r3" t="f" c="0" ts="2609281023"/>
        </ar>
        <dp ct="2609281425"><m id="r4" t="q" c="83" ts="2609280334"/><m id="r5" t="c" ts="2609281502"/></dp>
      </s>
    </timetable>`;
    const [row] = parseTimetable(xml, { eva: '8000261', observedAt });
    expect(row!.messages.map((m) => [m.id, m.event, m.type, m.code])).toEqual([
      ['r1', null, 'h', null],
      ['r2', 'a', 'd', 24],
      ['r4', 'd', 'q', 83],
    ]);
    expect(row!.messages[0]).toMatchObject({ category: 'Information' });
    expect(row!.messages[0]!.validTo?.toISOString()).toBe('2026-12-12T22:59:00.000Z');
    expect(row!.messages[1]!.ts?.toISOString()).toBe('2026-09-28T08:19:00.000Z');
  });

  it('returns nothing for empty timetables', () => {
    expect(parseTimetable("<timetable station='X'/>", { eva: '1', observedAt })).toEqual([]);
  });
});

describe('RateLimiter', () => {
  it('allows a burst up to the limit, then refills over time', () => {
    let t = 0;
    const rl = new RateLimiter(60, () => t);
    for (let i = 0; i < 60; i++) expect(rl.tryAcquire()).toBe(true);
    expect(rl.tryAcquire()).toBe(false);
    t += 1000; // one token per second at 60/min
    expect(rl.tryAcquire()).toBe(true);
    expect(rl.tryAcquire()).toBe(false);
  });
});

describe('IrisClient', () => {
  it('sends auth headers, builds plan URLs and retries on 429', async () => {
    const calls: { url: string; headers: Record<string, string> }[] = [];
    let first = true;
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), headers: init?.headers as Record<string, string> });
      if (first) {
        first = false;
        return new Response('slow down', { status: 429 });
      }
      return new Response('<timetable/>', { status: 200 });
    }) as unknown as typeof fetch;
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    const client = new IrisClient({ clientId: 'id', apiKey: 'key', fetchImpl, baseUrl: 'https://x' });
    const p = client.plan('8000261', new Date('2026-09-28T13:30:00Z'));
    await vi.runAllTimersAsync();
    expect(await p).toBe('<timetable/>');
    vi.useRealTimers();
    expect(calls).toHaveLength(2);
    expect(calls[0]!.url).toBe('https://x/plan/8000261/260928/15');
    expect(calls[0]!.headers['DB-Client-Id']).toBe('id');
    expect(calls[0]!.headers['DB-Api-Key']).toBe('key');
  });

  it('returns null for slots without data', async () => {
    const fetchImpl = (async () => new Response('', { status: 410 })) as unknown as typeof fetch;
    const client = new IrisClient({ clientId: 'id', apiKey: 'key', fetchImpl });
    expect(await client.fullChanges('8000261')).toBeNull();
  });
});

describe('parseTimetable on real responses (München Hbf, captured 2026-09-28)', () => {
  const opts = { eva: '8000261', observedAt };

  it('parses plan: every stop has a trip label and planned times', () => {
    const rows = parseTimetable(fixture('real-plan-8000261.xml'), opts);
    expect(rows.length).toBeGreaterThan(10);
    for (const r of rows) {
      expect(r.trainType).toBeTruthy();
      expect(r.trainNumber).toMatch(/^\d+$/);
      expect(r.plannedArr ?? r.plannedDep).toBeInstanceOf(Date);
      expect(r.changedArr).toBeNull();
      expect(r.changedDep).toBeNull();
      expect(r.eva).toBe('8000261');
    }
    expect(rows.find((r) => r.trainNumber === '883')).toMatchObject({ trainType: 'ICE', stopSeq: 12, plannedDep: null });
  });

  it('parses fchg: changed times, planned times where present, cancellations', () => {
    const rows = parseTimetable(fixture('real-fchg-8000261.xml'), opts);
    expect(rows.length).toBeGreaterThan(100);
    expect(rows.filter((r) => r.changedArr || r.changedDep).length).toBeGreaterThan(100);
    expect(rows.some((r) => r.arrCancelled || r.depCancelled)).toBe(true);
    const ice1291 = rows.find((r) => r.rideId === '1162876063810022739');
    expect(ice1291?.plannedArr?.toISOString()).toBe('2026-09-28T18:10:00.000Z');
    expect(ice1291?.changedArr?.toISOString()).toBe('2026-09-28T19:50:00.000Z'); // 100 min late
  });

  it('parses rchg', () => {
    const rows = parseTimetable(fixture('real-rchg-8000261.xml'), opts);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.eva === '8000261')).toBe(true);
  });
});
