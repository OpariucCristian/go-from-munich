/**
 * Parses DB Timetables (IRIS) XML into StopEventInput rows.
 *
 *   <timetable station="München Hbf" eva="8000261">
 *     <s id="{rideId}-{YYMMddHHmm}-{stopIndex}">
 *       <tl c="ICE" n="618" f="F" o="80" t="p"/>            trip label (plan only)
 *       <ar pt="2609281610" ct="2609281617" cs="c" l="…" ppth="A|B"/>
 *       <dp pt="2609281615" ct="2609281620" ppth="C|D"/>
 *     </s>
 *   </timetable>
 *
 * `plan` responses carry planned data (pt, tl, ppth); `fchg`/`rchg` responses carry only
 * changes (ct, cs, clt). Missing values stay null so the DB merge keeps what it already knows.
 */
import { XMLParser } from 'fast-xml-parser';
import { normalizeEva, parseIrisStopId, parseIrisTime } from '@gfm/core';
import type { StopEventInput } from '@gfm/db';

type Attrs = Record<string, string | undefined>;
type XmlStop = Attrs & { tl?: Attrs; ar?: Attrs; dp?: Attrs };

/**
 * A parsed stop plus the planned route through it: `path` holds the station names before and
 * after it, `route` the whole run in order including this station (null when the response
 * doesn't name the station or carries no path, e.g. most change rows). Changed paths (`cpth`,
 * diversions) win over planned ones (`ppth`).
 */
export type ParsedStop = StopEventInput & { path: string[]; route: string[] | null };

const xml = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '',
  parseAttributeValue: false,
  parseTagValue: false,
  isArray: (name) => name === 's' || name === 'm',
});

function statusToCancelled(status: string | undefined): boolean | null {
  if (status === 'c') return true;
  if (status === 'p' || status === 'a') return false;
  return null;
}

function splitPath(ppth: string | undefined): string[] {
  return ppth ? ppth.split('|').filter(Boolean) : [];
}

function lastOfPath(ppth: string | undefined): string | null {
  return splitPath(ppth).at(-1) ?? null;
}

export interface ParseOptions {
  /** EVA of the requested station; used when the XML root has no eva attribute (plan). */
  eva: string;
  observedAt: Date;
  tz?: string;
}

export function parseTimetable(body: string, opts: ParseOptions): ParsedStop[] {
  const doc = xml.parse(body) as { timetable?: Attrs & { s?: XmlStop[] } };
  const tt = doc.timetable;
  if (!tt || !tt.s) return [];
  const rootEva = tt.eva ? normalizeEva(tt.eva) : normalizeEva(opts.eva);
  const tz = opts.tz ?? 'Europe/Berlin';
  const stationName = tt.station ?? null;
  const out: ParsedStop[] = [];

  for (const s of tt.s) {
    const key = s.id ? parseIrisStopId(s.id) : null;
    if (!key) continue;
    const tl = s.tl;
    const ar = s.ar;
    const dp = s.dp;
    const arrStatus = ar?.cs ?? ar?.ps;
    const depStatus = dp?.cs ?? dp?.ps;
    // Destination: the last station on the planned path after departure; for a terminating stop,
    // the stop itself (unknown here, so leave null).
    const finalDestination = lastOfPath(dp?.cpth ?? dp?.ppth);
    const before = splitPath(ar?.cpth ?? ar?.ppth);
    const after = splitPath(dp?.cpth ?? dp?.ppth);

    out.push({
      rideId: key.rideId,
      originStart: key.originStart,
      serviceDate: key.serviceDate,
      trainType: tl?.c ?? null,
      trainNumber: tl?.n ?? null,
      line: dp?.l ?? ar?.l ?? null,
      finalDestination,
      eva: s.eva ? normalizeEva(s.eva) : rootEva,
      stopSeq: key.stopIndex,
      plannedArr: parseIrisTime(ar?.pt, tz),
      changedArr: parseIrisTime(ar?.ct, tz),
      plannedDep: parseIrisTime(dp?.pt, tz),
      changedDep: parseIrisTime(dp?.ct, tz),
      arrCancelled: ar ? statusToCancelled(ar.cs) : null,
      depCancelled: dp ? statusToCancelled(dp.cs) : null,
      isAdditional: ar?.ps === 'a' || dp?.ps === 'a' ? true : ar?.ps || dp?.ps ? false : null,
      arrStatus: arrStatus ?? null,
      depStatus: depStatus ?? null,
      source: 'live',
      observedAt: opts.observedAt,
      path: [...before, ...after],
      route: stationName && (before.length || after.length) ? [...before, stationName, ...after] : null,
    });
  }
  return out;
}
