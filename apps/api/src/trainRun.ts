/**
 * Building a train's stop list for a date when that day's run is incomplete: the live poller only
 * records the stations it watches, so today's run often has one or two stops. The full stop list
 * then comes from an earlier complete run, and today's partial run corrects its times.
 */

export interface RunStop {
  eva: string;
  planned_arr: Date | null;
  planned_dep: Date | null;
}

const plus = (d: Date | null, ms: number) => (d ? new Date(d.getTime() + ms) : null);

/** One run of a train: its stations in the order the train calls at them (by time). */
export interface RunSummary {
  id: string;
  date: string; // service date, YYYY-MM-DD
  stations: string[];
}

/** Station identity by name, so platform sub-EVAs ("München Hbf Gl.27-36") match their station. */
export const stationKey = (name: string | null, eva: string) => (name ? name.replace(/\s+Gl\..*$/, '') : eva);

/**
 * Loose station-name key for matching the live timetable's names against the dataset's, which
 * spell some stations differently: "Vaihingen(Enz)" / "Vaihingen (Enz)", "Frankfurt(M) Flughafen
 * Fernbf" / "Frankfurt am Main Flughafen Fernbahnhof", "Köln Messe/Deutz Gl.11-12".
 */
export const routeKey = (name: string) =>
  name
    .toLowerCase()
    .replace(/\s+gl\..*$/, '')
    .replace(/\(m\)|\bam main\b/g, '')
    .replace(/\bfernbf\b/g, 'fernbahnhof')
    .replace(/[^\p{L}\p{N}]/gu, '');

/**
 * Keeps the stops the train makes on the day's route (from the live timetable), dropping calls an
 * earlier run made that this day's train doesn't (e.g. München-Pasing on a route that changed).
 * Station names from the two sources don't always match, so it only filters when most of the
 * stops are recognised on the route.
 */
export function onRoute<T extends { eva: string; name: string | null }>(stops: T[], route: string[]): T[] {
  const names = new Set(route.map(routeKey));
  const kept = stops.filter((s) => s.name !== null && names.has(routeKey(s.name)));
  return kept.length >= 2 && kept.length >= stops.length / 2 ? kept : stops;
}

/** A route end for display: our spelling when it's one of the stops, else the live name without a platform suffix. */
export function routeEndName(name: string, stops: { eva: string; name: string | null }[]): string {
  const match = stops.find((s) => s.name !== null && routeKey(s.name) === routeKey(name));
  return stationKey(match?.name ?? name, name);
}

function inOrder(needle: string[], hay: string[]): boolean {
  let i = 0;
  for (const s of hay) if (s === needle[i]) i++;
  return i === needle.length;
}

/**
 * Picks the run whose stop list represents the train on `date`:
 *  1. it must call at every station seen on that date's own run, in the same order (routes change:
 *     ICE 118 skipped München Hbf all summer and serves it from September);
 *  2. it should be complete, i.e. have at least the usual number of stops (median of the other
 *     runs), so a partial live run or a one-off diversion doesn't become the pattern;
 *  3. then that date's own run, the same weekday, the most recent.
 * The date's own run always satisfies (1), so it's the fallback when no earlier run fits.
 */
export function chooseRun(runs: RunSummary[], date: string): RunSummary | null {
  const target = runs.find((r) => r.date === date);
  const counts = runs.filter((r) => r.date !== date).map((r) => r.stations.length).sort((a, b) => a - b);
  const typical = counts.length ? counts[Math.floor((counts.length - 1) / 2)]! : 0;
  const weekday = (d: string) => new Date(`${d}T12:00:00Z`).getUTCDay();
  const key = (r: RunSummary) => [
    !target || inOrder(target.stations, r.stations),
    r.stations.length >= typical,
    r.date === date,
    weekday(r.date) === weekday(date),
  ];
  let best: RunSummary | null = null;
  let bestKey: boolean[] = [];
  for (const r of runs) {
    const k = key(r);
    const cmp = k.findIndex((v, i) => v !== bestKey[i]);
    const better = !best || (cmp >= 0 ? k[cmp]! : r.date > best.date);
    if (better) {
      best = r;
      bestKey = k;
    }
  }
  return best;
}

/**
 * Shifts a complete run's stops (already moved to the target date) by the timetable offset seen
 * at the first station both runs share, then uses the partial run's exact times where it has
 * them. Timetables change (e.g. a train leaving 48 minutes later from September), and a shifted
 * old run would otherwise show wrong times and never match the live status.
 */
export function alignToPartialRun<T extends RunStop>(pattern: T[], partial: RunStop[]): T[] {
  const byEva = new Map(partial.map((s) => [s.eva, s]));
  // The offset between the runs, measured on the same event (departure, else arrival) at the
  // first station both have.
  let offset: number | null = null;
  for (const s of pattern) {
    const l = byEva.get(s.eva);
    if (!l) continue;
    const field = s.planned_dep && l.planned_dep ? 'planned_dep' : s.planned_arr && l.planned_arr ? 'planned_arr' : null;
    if (!field) continue;
    offset = l[field]!.getTime() - s[field]!.getTime();
    break;
  }
  if (offset === null) return pattern;
  return pattern.map((s) => {
    const l = byEva.get(s.eva);
    return {
      ...s,
      planned_arr: l?.planned_arr ?? plus(s.planned_arr, offset),
      planned_dep: l?.planned_dep ?? plus(s.planned_dep, offset),
    };
  });
}
