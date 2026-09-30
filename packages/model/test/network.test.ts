import { describe, expect, it } from 'vitest';
import { getCity } from '@gfm/core';
import { NETWORK_FEATURE_NAMES, NetworkIndex, networkCutoff, networkStations, type NetEvent } from '../src/network.ts';

const HBF = '8000261';
const OST = '8000262';
const AUGSBURG = '8000013';
const KAUFERING = '8000187';
const t = (hhmm: string) => new Date(`2026-09-30T${hhmm}:00Z`);
const ev = (eva: string, hhmm: string, delay: number | null, cancelled = false): NetEvent => ({ eva, pt: t(hhmm), delay, cancelled });

const events = [
  ev(HBF, '09:05', 0),
  ev(HBF, '09:20', 12),
  ev(HBF, '09:40', 90), // capped at 60
  ev(OST, '09:50', null, true),
  ev(AUGSBURG, '09:30', 8),
  ev(AUGSBURG, '09:45', 2),
  ev(HBF, '10:00', 30), // at the cutoff: not yet in the window
];
const index = new NetworkIndex(events, new Set([HBF, OST]), new Set([HBF, OST, AUGSBURG]));

describe('NetworkIndex', () => {
  it('summarises the hour before the cutoff at the station and across the hubs', () => {
    const f = index.features(AUGSBURG, t('10:30'), t('10:00'));
    expect(f).toHaveLength(NETWORK_FEATURE_NAMES.length);
    const [lead, stnN, stnDelay, stnLate, hubN, hubDelay, hubLate] = f;
    expect(lead).toBe(30);
    expect([stnN, stnDelay, stnLate]).toEqual([2, 5, 0.5]);
    // Hubs: 0, 12, 60 ran; the cancelled one counts as late but not in the mean delay.
    expect(hubN).toBe(4);
    expect(hubDelay).toBeCloseTo(24);
    expect(hubLate).toBe(0.75);
  });

  it('gives unwatched stations no station-level state', () => {
    const f = index.features(KAUFERING, t('10:30'), t('10:00'));
    expect(f.slice(1, 4).every(Number.isNaN)).toBe(true);
    expect(f[4]).toBe(4);
  });

  it('reports an empty watched station as zero trains', () => {
    const f = index.features(AUGSBURG, t('12:30'), t('12:00'));
    expect(f[1]).toBe(0);
    expect(Number.isNaN(f[2]!)).toBe(true);
  });

  it('says nothing about forecasts made far ahead', () => {
    const f = index.features(HBF, t('18:00'), t('10:00'));
    expect(f.every(Number.isNaN)).toBe(true);
  });
});

describe('networkCutoff', () => {
  it('is now, but at most 5 min before the stop', () => {
    expect(networkCutoff(t('11:00'), t('10:00'))).toEqual(t('10:00'));
    expect(networkCutoff(t('09:00'), t('10:00'))).toEqual(t('08:55'));
  });
});

describe('networkStations', () => {
  it('keeps German polled stations only', () => {
    const s = networkStations(getCity('muc'));
    expect(s).toContain(HBF);
    expect(s).toContain('8010101'); // Erfurt
    expect(s).not.toContain('8100002'); // Salzburg
  });
});
