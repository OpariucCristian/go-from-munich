import { describe, expect, it } from 'vitest';
import { alignToPartialRun, chooseRun, onRoute, routeEndName, routeKey, stationKey } from '../src/trainRun.ts';

const d = (hm: string) => new Date(`2026-09-29T${hm}:00Z`);
// A complete August run moved to today: Hbf 11:30 → Ost 11:44 → Rosenheim 12:20 (arr).
const pattern = [
  { eva: '8000261', name: 'Hbf', planned_arr: null, planned_dep: d('11:30') },
  { eva: '8000262', name: 'Ost', planned_arr: d('11:42'), planned_dep: d('11:44') },
  { eva: '8000320', name: 'Rosenheim', planned_arr: d('12:20'), planned_dep: null },
];

describe('alignToPartialRun', () => {
  it('shifts the full stop list by the offset seen live and keeps live times exactly', () => {
    // Today the poller only saw Ost, 48 minutes later than in August.
    const out = alignToPartialRun(pattern, [{ eva: '8000262', planned_arr: d('12:30'), planned_dep: d('12:32') }]);
    expect(out.map((s) => [s.eva, s.planned_arr?.toISOString().slice(11, 16) ?? null, s.planned_dep?.toISOString().slice(11, 16) ?? null])).toEqual([
      ['8000261', null, '12:18'],
      ['8000262', '12:30', '12:32'],
      ['8000320', '13:08', null],
    ]);
    expect(out[0]!.name).toBe('Hbf');
  });

  it('leaves the pattern alone without a shared station', () => {
    expect(alignToPartialRun(pattern, [])).toBe(pattern);
    expect(alignToPartialRun(pattern, [{ eva: '9999999', planned_arr: null, planned_dep: d('10:00') }])).toBe(pattern);
  });
});

describe('chooseRun', () => {
  const run = (id: string, date: string, stations: string[]) => ({ id, date, stations });
  // ICE 118: all summer Rosenheim → Ost → Pasing; from September Rosenheim → Hbf → Augsburg.
  const summer = ['Freilassing', 'Rosenheim', 'München Ost', 'München-Pasing', 'Augsburg Hbf', 'Ulm Hbf', 'Stuttgart Hbf'];
  const oddJuly = ['Freilassing', 'Rosenheim', 'München Ost', 'München Hbf', 'München-Pasing', 'Augsburg Hbf', 'Ulm Hbf', 'Stuttgart Hbf'];
  const todayLive = ['Rosenheim', 'München Hbf', 'Augsburg Hbf', 'Ulm Hbf'];

  it('prefers a complete run that calls at the day\'s stations in the same order', () => {
    const runs = [run('1', '2026-07-19', oddJuly), run('2', '2026-08-25', summer), run('3', '2026-08-31', summer), run('9', '2026-09-29', todayLive)];
    expect(chooseRun(runs, '2026-09-29')?.id).toBe('1');
  });

  it('falls back to the day\'s own partial run when no earlier run fits', () => {
    const runs = [run('2', '2026-08-25', summer), run('3', '2026-08-31', summer), run('9', '2026-09-29', todayLive)];
    expect(chooseRun(runs, '2026-09-29')?.id).toBe('9');
  });

  it('rejects runs with the right stations in the wrong order', () => {
    const runs = [run('2', '2026-08-25', ['Ulm Hbf', 'Augsburg Hbf', 'München Hbf', 'Rosenheim', 'X', 'Y']), run('9', '2026-09-29', todayLive)];
    expect(chooseRun(runs, '2026-09-29')?.id).toBe('9');
  });

  it('uses the day\'s own run when it is complete, else the latest same-weekday complete run', () => {
    const full = ['A', 'B', 'C', 'D'];
    expect(chooseRun([run('1', '2026-09-22', full), run('2', '2026-09-29', full)], '2026-09-29')?.id).toBe('2');
    // No run on the date: same weekday (Tue 22 Sep) beats the more recent Sunday.
    expect(chooseRun([run('1', '2026-09-22', full), run('2', '2026-09-27', full)], '2026-09-29')?.id).toBe('1');
  });

  it('matches platform sub-stations to their station', () => {
    expect(stationKey('München Hbf Gl.27-36', '8098261')).toBe('München Hbf');
    expect(stationKey(null, '8000261')).toBe('8000261');
  });
});

describe('onRoute', () => {
  const s = (name: string) => ({ eva: name, name });
  const pattern = ['Rosenheim', 'München Ost', 'München Hbf Gl.27-36', 'München-Pasing', 'Augsburg Hbf', 'Ulm Hbf'].map(s);

  it("drops calls the day's route doesn't make", () => {
    const route = ['Salzburg Hbf', 'Rosenheim', 'München Hbf', 'Augsburg Hbf', 'Ulm Hbf', 'Stuttgart Hbf'];
    expect(onRoute(pattern, route).map((x) => x.name)).toEqual(['Rosenheim', 'München Hbf Gl.27-36', 'Augsburg Hbf', 'Ulm Hbf']);
  });

  it('keeps everything when the names barely match (different naming, not a different route)', () => {
    expect(onRoute(pattern, ['Rosenheim', 'Munich Central', 'Augsburg', 'Ulm'])).toBe(pattern);
  });
});

describe('routeKey', () => {
  it('matches the live timetable spellings to the dataset names', () => {
    const pairs: [string, string][] = [
      ['Vaihingen(Enz)', 'Vaihingen (Enz)'],
      ['Frankfurt(M) Flughafen Fernbf', 'Frankfurt am Main Flughafen Fernbahnhof'],
      ['Münster(Westf)Hbf', 'Münster (Westf) Hbf'],
      ['Köln Messe/Deutz Gl.11-12', 'Köln Messe/Deutz'],
      ['München Hbf Gl.5-10', 'München Hbf'],
    ];
    for (const [live, dataset] of pairs) expect(routeKey(live)).toBe(routeKey(dataset));
    expect(routeKey('München Ost')).not.toBe(routeKey('München Hbf'));
  });
});

describe('routeEndName', () => {
  it('prefers our spelling of a known stop and strips platform suffixes otherwise', () => {
    const stops = [{ eva: '8000263', name: 'Münster (Westf) Hbf' }];
    expect(routeEndName('Münster(Westf)Hbf', stops)).toBe('Münster (Westf) Hbf');
    expect(routeEndName('München Hbf Gl.5-10', [])).toBe('München Hbf');
    expect(routeEndName('Graz Hbf', stops)).toBe('Graz Hbf');
  });
});
