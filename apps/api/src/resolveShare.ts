/**
 * Turns what DB Navigator's "Reise teilen" hands us into legs for /predict.
 *
 * Real iOS (English) payload:
 *
 *   München Hbf → Stuttgart Hbf
 *   10/26/2026
 *
 *   ICE 514
 *   To Hamburg-Altona                        ← train direction, NOT the user's destination
 *   From 15:28 München Hbf, Platform 13
 *   To 17:43 Stuttgart Hbf, Platform 10
 *
 *   View journey:
 *   https://int.bahn.de/en/buchung/start?vbid=593560d8%2D4d1c%2D…   ← vbid is URL-encoded
 *
 * Strategies, in order:
 *  1. OPT-IN (ENABLE_VBID_LOOKUP=1): vbid → bahn.de `/web/api/angebote/verbindung/{vbid}` →
 *     legs from the HAFAS-style `hinfahrtRecon` string. The endpoint is undocumented and its bot
 *     protection rejects non-browser clients (403 OPS_BLOCKED for Node's fetch, observed
 *     2026-09-28), so it is off by default and we do not try to get around that.
 *  2. Structured text (the default, and sufficient — the share contains train, stations, times, date): per train block, the `From/Von/Ab HH:MM <station>` and
 *     `To/Nach/An HH:MM <station>` lines; station names resolved to EVAs via our data.
 */
import { normalizeEva, zonedToUtc } from '@gfm/core';
import { getPool } from '@gfm/db';
import type { LegInput } from './predict/service.ts';

export interface ResolveResult {
  legs: LegInput[];
  strategy: 'vbid' | 'text' | 'none';
  vbid: string | null;
  warnings: string[];
}

const TRAIN_TYPES = 'ICE|IC|ECE|EC|RJX|RJ|NJ|EN|TGV|FLX|RE|RB|BRB|ARV|ALX|MEX|IRE|S';
const TRAIN_RE = new RegExp(`\\b(${TRAIN_TYPES})\\s*(\\d{1,5})\\b`, 'g');
const TRAIN_LINE_RE = new RegExp(`^\\s*(${TRAIN_TYPES})\\s*(\\d{1,5})\\s*$`);
const FROM_RE = /^\s*(?:From|Von|Ab|Dep\.?)\s+(\d{1,2}):(\d{2})\s+(.+?)\s*(?:,\s*(?:Platform|Gleis|Pl\.|Bahnsteig|Track)\b.*)?$/i;
const TO_RE = /^\s*(?:To|Nach|An|Arr\.?)\s+(\d{1,2}):(\d{2})\s+(.+?)\s*(?:,\s*(?:Platform|Gleis|Pl\.|Bahnsteig|Track)\b.*)?$/i;
const URL_RE = /https?:\/\/[^\s]*bahn\.de[^\s]*/i;

// ---------------------------------------------------------------------------------------------
// vbid

export function extractVbid(text: string): string | null {
  const m = URL_RE.exec(text);
  if (!m) return null;
  try {
    return new URL(m[0]).searchParams.get('vbid');
  } catch {
    return null;
  }
}

/** `202610261528` (Berlin wall clock) → ISO instant. */
function compactLocalToIso(s: string): string | null {
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})$/.exec(s);
  return m ? zonedToUtc(+m[1]!, +m[2]!, +m[3]!, +m[4]!, +m[5]!).toISOString() : null;
}

/**
 * Parses transport segments from a HAFAS recon string:
 *   ¶HKI¶T$A=1@O=München Hbf@…@L=8000261@…$A=1@O=Stuttgart Hbf@…@L=8000096@…$202610261528$202610261743$ICE   514$…
 * Segments not starting with `T$` (walks, transfers) are skipped.
 */
export function parseRecon(recon: string): LegInput[] {
  const legs: LegInput[] = [];
  for (const part of recon.split('¶HKI¶').slice(1)) {
    const segment = part.split('¶')[0]!;
    if (!segment.startsWith('T$')) continue;
    const f = segment.split('$');
    const fromEva = /@L=(\d+)@/.exec(f[1] ?? '')?.[1];
    const toEva = /@L=(\d+)@/.exec(f[2] ?? '')?.[1];
    const dep = compactLocalToIso(f[3] ?? '');
    const arr = compactLocalToIso(f[4] ?? '');
    const train = /^\s*([A-Za-z]+)\s+(\d+)\s*$/.exec(f[5] ?? '');
    if (!fromEva || !toEva || !dep || !arr || !train) continue;
    legs.push({
      trainType: train[1]!.toUpperCase(),
      trainNumber: train[2]!,
      fromEva: normalizeEva(fromEva),
      toEva: normalizeEva(toEva),
      plannedDep: dep,
      plannedArr: arr,
    });
  }
  return legs;
}

async function resolveVbid(vbid: string): Promise<LegInput[] | null> {
  if (process.env.ENABLE_VBID_LOOKUP !== '1') return null;
  try {
    const res = await fetch(`https://www.bahn.de/web/api/angebote/verbindung/${encodeURIComponent(vbid)}`, {
      headers: { accept: 'application/json', 'user-agent': 'Mozilla/5.0 (gofrommunich)' },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { hinfahrtRecon?: string };
    const legs = body.hinfahrtRecon ? parseRecon(body.hinfahrtRecon) : [];
    return legs.length ? legs : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------------------------
// text

export interface ParsedLeg {
  trainType: string;
  trainNumber: string;
  from: { name: string; time: string } | null; // time HH:MM local
  to: { name: string; time: string } | null;
}

export interface ParsedShareText {
  legs: ParsedLeg[];
  date: string | null; // YYYY-MM-DD
  dateAmbiguous: boolean;
}

/** Dates: 26.10.2026 (DE), 10/26/2026 (US; D/M/Y if the first part > 12), 2026-10-26 (ISO). */
export function parseDate(text: string): { date: string | null; ambiguous: boolean } {
  const pad = (n: number) => String(n).padStart(2, '0');
  const year = (y: string) => (y.length === 2 ? 2000 + Number(y) : Number(y));
  let m = /\b(\d{4})-(\d{2})-(\d{2})\b/.exec(text);
  if (m) return { date: `${m[1]}-${m[2]}-${m[3]}`, ambiguous: false };
  m = /\b(\d{1,2})\.(\d{1,2})\.(\d{2,4})\b/.exec(text);
  if (m) return { date: `${year(m[3]!)}-${pad(+m[2]!)}-${pad(+m[1]!)}`, ambiguous: false };
  m = /\b(\d{1,2})\/(\d{1,2})\/(\d{2,4})\b/.exec(text);
  if (m) {
    const a = +m[1]!;
    const b = +m[2]!;
    const [month, day] = a > 12 ? [b, a] : [a, b];
    return { date: `${year(m[3]!)}-${pad(month)}-${pad(day)}`, ambiguous: a <= 12 && b <= 12 && a !== b };
  }
  return { date: null, ambiguous: false };
}

export function parseShareText(text: string): ParsedShareText {
  const { date, ambiguous } = parseDate(text);
  const legs: ParsedLeg[] = [];
  let current: ParsedLeg | null = null;
  for (const line of text.split(/\r?\n/)) {
    const train = TRAIN_LINE_RE.exec(line);
    if (train) {
      current = { trainType: train[1]!.toUpperCase(), trainNumber: train[2]!, from: null, to: null };
      legs.push(current);
      continue;
    }
    if (!current) continue;
    const from = FROM_RE.exec(line);
    if (from && !current.from) {
      current.from = { name: from[3]!, time: `${from[1]!.padStart(2, '0')}:${from[2]}` };
      continue;
    }
    const to = TO_RE.exec(line); // lines like "To Hamburg-Altona" have no time and don't match
    if (to && !current.to) current.to = { name: to[3]!, time: `${to[1]!.padStart(2, '0')}:${to[2]}` };
  }
  // Unstructured text (e.g. copied from elsewhere): fall back to any train mentions.
  if (!legs.length) {
    for (const m of text.matchAll(TRAIN_RE)) {
      const t = { trainType: m[1]!.toUpperCase(), trainNumber: m[2]!, from: null, to: null };
      if (!legs.some((l) => l.trainType === t.trainType && l.trainNumber === t.trainNumber)) legs.push(t);
    }
  }
  return { legs, date, dateAmbiguous: ambiguous };
}

const norm = (s: string) =>
  s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();

/** Moves a timestamp from the known run's date to $3 in Berlin wall-clock time (DST-safe). */
export const shiftSql = (col: string) =>
  `((${col} AT TIME ZONE 'Europe/Berlin') + ($3::date - run.service_date) * interval '1 day') AT TIME ZONE 'Europe/Berlin'`;

interface StopRow {
  eva: string;
  name: string;
  planned_arr: Date | null;
  planned_dep: Date | null;
}

/** Stops of the most recent known run (same weekday preferred), projected onto `date`. */
async function stopsFor(type: string, number: string, date: string): Promise<StopRow[]> {
  const { rows } = await getPool().query<StopRow>(
    `WITH run AS (
       SELECT id, service_date FROM trips
       WHERE train_type = $1 AND train_number = $2 AND service_date BETWEEN $3::date - 90 AND $3::date
       ORDER BY (extract(isodow FROM service_date) = extract(isodow FROM $3::date)) DESC, service_date DESC
       LIMIT 1)
     SELECT e.eva, COALESCE(s.name, e.eva) AS name,
            ${shiftSql('e.planned_arr')} AS planned_arr,
            ${shiftSql('e.planned_dep')} AS planned_dep
     FROM run JOIN stop_events e ON e.trip_id = run.id AND e.service_date = run.service_date
     LEFT JOIN stations s ON s.eva = e.eva
     ORDER BY COALESCE(e.planned_dep, e.planned_arr)`,
    [type, number, date],
  );
  return rows;
}

/** EVA for a station name: prefer a stop of the train itself, then our station table. */
async function evaForName(name: string, stops: StopRow[]): Promise<string | null> {
  const n = norm(name);
  const onRoute = stops.find((s) => norm(s.name) === n);
  if (onRoute) return onRoute.eva;
  const { rows } = await getPool().query<{ eva: string; name: string }>(
    `SELECT eva, name FROM stations WHERE name ILIKE $1
     ORDER BY (role = 'hub') DESC, (role = 'corridor') DESC, length(name) LIMIT 10`,
    [`%${name.replace(/[%_]/g, '').split(/\s+/)[0]}%`],
  );
  return rows.find((r) => norm(r.name) === n)?.eva ?? null;
}

function localIso(date: string, time: string): string {
  const [y, mo, d] = date.split('-').map(Number) as [number, number, number];
  const [h, mi] = time.split(':').map(Number) as [number, number];
  return zonedToUtc(y, mo, d, h, mi).toISOString();
}

function addDay(date: string): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

async function resolveFromText(text: string): Promise<{ legs: LegInput[]; warnings: string[] }> {
  const parsed = parseShareText(text);
  const warnings: string[] = [];
  if (!parsed.legs.length) return { legs: [], warnings: ['no train numbers found in shared text'] };
  const date = parsed.date ?? new Date().toISOString().slice(0, 10);
  if (!parsed.date) warnings.push('no date found, assuming today');
  if (parsed.dateAmbiguous) warnings.push(`date ${parsed.date} is ambiguous (M/D vs D/M), assumed M/D`);

  const legs: LegInput[] = [];
  let day = date;
  for (const p of parsed.legs) {
    const label = `${p.trainType} ${p.trainNumber}`;
    const stops = await stopsFor(p.trainType, p.trainNumber, day);

    if (p.from && p.to) {
      // Structured block: times come straight from the share, stations resolved by name.
      const [fromEva, toEva] = await Promise.all([evaForName(p.from.name, stops), evaForName(p.to.name, stops)]);
      if (!fromEva || !toEva) {
        warnings.push(`${label}: unknown station "${!fromEva ? p.from.name : p.to.name}"`);
        continue;
      }
      const prevArr = legs.at(-1)?.plannedArr;
      if (prevArr && localIso(day, p.from.time) < prevArr) day = addDay(day); // trip crosses midnight
      const dep = localIso(day, p.from.time);
      let arr = localIso(day, p.to.time);
      if (arr < dep) {
        day = addDay(day);
        arr = localIso(day, p.to.time);
      }
      legs.push({ trainType: p.trainType, trainNumber: p.trainNumber, fromEva: normalizeEva(fromEva), toEva: normalizeEva(toEva), plannedDep: dep, plannedArr: arr });
      continue;
    }

    // Only a train mention: use its known route, chained to the previous leg when possible.
    if (stops.length < 2) {
      warnings.push(`${label}: no stations in the text and train not in our data`);
      continue;
    }
    const prevTo = legs.at(-1)?.toEva;
    const from = stops.find((s) => s.eva === prevTo) ?? stops[0]!;
    const to = stops.at(-1)!;
    if (!from.planned_dep || !to.planned_arr) continue;
    warnings.push(`${label}: stations not in the text, using ${from.name} → ${to.name}`);
    legs.push({
      trainType: p.trainType,
      trainNumber: p.trainNumber,
      fromEva: normalizeEva(from.eva),
      toEva: normalizeEva(to.eva),
      plannedDep: from.planned_dep.toISOString(),
      plannedArr: to.planned_arr.toISOString(),
    });
  }
  return { legs, warnings };
}

export async function resolveShare(text: string): Promise<ResolveResult> {
  const vbid = extractVbid(text);
  if (vbid) {
    const legs = await resolveVbid(vbid);
    if (legs) return { legs, strategy: 'vbid', vbid, warnings: [] };
  }
  const { legs, warnings } = await resolveFromText(text);
  if (vbid && process.env.ENABLE_VBID_LOOKUP === '1') warnings.unshift('vbid lookup failed, parsed the text instead');
  return { legs, strategy: legs.length ? 'text' : 'none', vbid, warnings };
}
