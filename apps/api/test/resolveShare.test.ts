import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { extractVbid, parseDate, parseRecon, parseShareText } from '../src/resolveShare.ts';

const fixture = (name: string) =>
  readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', name), 'utf8');

// Captured from DB Navigator on iOS (English), 2026-09-28.
const iosShare = fixture('share-ios-en-ice514.txt');

describe('real iOS share (English)', () => {
  it('extracts and decodes the vbid', () => {
    expect(extractVbid(iosShare)).toBe('593560d8-4d1c-48b1-9612-76976e93df19');
  });

  it('parses the train block and ignores the direction line', () => {
    const p = parseShareText(iosShare);
    expect(p.date).toBe('2026-10-26');
    expect(p.dateAmbiguous).toBe(false);
    expect(p.legs).toEqual([
      {
        trainType: 'ICE',
        trainNumber: '514',
        from: { name: 'München Hbf', time: '15:28' },
        to: { name: 'Stuttgart Hbf', time: '17:43' },
      },
    ]);
  });
});

describe('bahn.de vbid response', () => {
  it('parses legs from the recon string (Berlin local → UTC, after the DST switch)', () => {
    const body = JSON.parse(fixture('vbid-ice514.json')) as { hinfahrtRecon: string };
    expect(parseRecon(body.hinfahrtRecon)).toEqual([
      {
        trainType: 'ICE',
        trainNumber: '514',
        fromEva: '8000261',
        toEva: '8000096',
        plannedDep: '2026-10-26T14:28:00.000Z',
        plannedArr: '2026-10-26T16:43:00.000Z',
      },
    ]);
  });

  it('skips non-transport segments in multi-leg recons', () => {
    const recon =
      '¶HKI¶T$A=1@O=A@L=8000183@a=128@$A=1@O=B@L=8000261@a=128@$202609281607$202609281655$RE  4031$$1$¶HKI¶G@F$A=1@O=B@L=8000261@$A=1@O=B@L=8000261@$202609281655$202609281700$$$1$¶HKI¶T$A=1@O=B@L=8000261@a=128@$A=1@O=C@L=8000013@a=128@$202609281709$202609281742$ICE   700$$1$¶KC¶x';
    const legs = parseRecon(recon);
    expect(legs.map((l) => `${l.trainType} ${l.trainNumber} ${l.fromEva}→${l.toEva}`)).toEqual([
      'RE 4031 8000183→8000261',
      'ICE 700 8000261→8000013',
    ]);
  });
});

describe('text fallbacks', () => {
  it('parses German-style blocks and multiple legs', () => {
    const p = parseShareText(
      'München Hbf → Augsburg Hbf\n28.09.2026\n\nRE 4031\nRichtung München Hbf\nVon 18:07 Ingolstadt Hbf, Gleis 3\nNach 18:55 München Hbf, Gleis 26\n\nICE 700\nVon 19:09 München Hbf, Gleis 12\nNach 19:42 Augsburg Hbf, Gleis 2',
    );
    expect(p.date).toBe('2026-09-28');
    expect(p.legs.map((l) => [l.trainType, l.trainNumber, l.from?.name, l.from?.time, l.to?.name, l.to?.time])).toEqual([
      ['RE', '4031', 'Ingolstadt Hbf', '18:07', 'München Hbf', '18:55'],
      ['ICE', '700', 'München Hbf', '19:09', 'Augsburg Hbf', '19:42'],
    ]);
  });

  it('falls back to train mentions in unstructured text', () => {
    const p = parseShareText('taking RE 4012 then ICE 1001, RE4012 again');
    expect(p.legs.map((l) => `${l.trainType} ${l.trainNumber}`)).toEqual(['RE 4012', 'ICE 1001']);
  });

  it('handles date formats', () => {
    expect(parseDate('10/26/2026')).toEqual({ date: '2026-10-26', ambiguous: false });
    expect(parseDate('26/10/2026')).toEqual({ date: '2026-10-26', ambiguous: false });
    expect(parseDate('03/04/2026')).toEqual({ date: '2026-03-04', ambiguous: true });
    expect(parseDate('26.10.26')).toEqual({ date: '2026-10-26', ambiguous: false });
    expect(parseDate('2026-10-26')).toEqual({ date: '2026-10-26', ambiguous: false });
  });
});
