/** View models for the departures board, route list, patterns heatmap and header metadata. */
import type { ConnectionsView, DeparturesView, MetaView, PatternsView } from '../contract.ts';
import type { CoreConnections, CoreDepartures, CoreMeta, CorePatterns } from '../core/types.ts';
import { dateLabelOf, distributionOf, durationLabel, liveOf, shortDateOf, signedMin, timeOf, toneOf } from './format.ts';

const r4 = (x: number) => Math.round(x * 10000) / 10000;

export function departuresView(core: CoreDepartures): DeparturesView {
  return {
    station: core.station,
    asOf: timeOf(core.at),
    rows: core.departures.map((d) => {
      const b = d.prediction.buckets.map((x) => x.p);
      const dist = distributionOf(d.prediction);
      return {
        eva: d.eva,
        linkable: d.routeKnown !== false,
        time: timeOf(d.planned),
        train: d.train,
        trainType: d.trainType,
        trainNumber: d.trainNumber,
        destination: d.destination ?? '—',
        split: [r4(b[0]!), r4(b[1]! + b[2]!), r4(b[3]! + b[4]! + b[5]! + b[6]!)],
        cancelled: r4(d.prediction.cancelled),
        typicalLabel: signedMin(dist.median),
        tone: toneOf(dist.lateOver5),
        live: liveOf(d.live),
        planned: d.planned,
      };
    }),
  };
}

export function connectionsView(core: CoreConnections): ConnectionsView {
  return {
    date: core.date,
    dateLabel: dateLabelOf(core.date),
    items: core.connections.map((c) => {
      const dist = distributionOf(c.arrival);
      return {
        train: c.train,
        trainType: c.trainType,
        trainNumber: c.trainNumber,
        fromEva: c.fromEva,
        toEva: c.toEva,
        dep: timeOf(c.plannedDep),
        arr: timeOf(c.plannedArr),
        durationLabel: durationLabel(c.plannedDep, c.plannedArr),
        lateOver5: dist.lateOver5,
        tone: toneOf(dist.lateOver5),
        typicalLabel: signedMin(dist.median),
      };
    }),
  };
}

const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
export const PATTERN_HOURS = Array.from({ length: 19 }, (_, i) => i + 5); // 05–23
/** Cells with fewer departures than this are shown but never picked as best/worst. */
export const MIN_CELL_N = 30;

export function patternsView(core: CorePatterns): PatternsView {
  const byKey = new Map(core.cells.map((c) => [`${c.dow}|${c.hour}`, c]));
  let worst: PatternsView['worst'] = null;
  let best: PatternsView['best'] = null;
  const rows = DAYS.map((day, i) => ({
    day,
    cells: PATTERN_HOURS.map((hour) => {
      const c = byKey.get(`${i + 1}|${hour}`);
      const avg = c?.avg == null ? null : Math.round(c.avg * 10) / 10;
      if (c && avg !== null && c.n >= MIN_CELL_N) {
        const label = `${day} ${String(hour).padStart(2, '0')}:00`;
        if (!worst || avg > worst.avg) worst = { label, avg };
        if (i < 5 && hour >= 6 && hour <= 21 && (!best || avg < best.avg)) best = { label, avg };
      }
      return { hour, avg, lateOver5: c?.late == null ? null : r4(c.late), n: c?.n ?? 0 };
    }),
  }));
  return {
    rangeLabel: core.from && core.to ? `${shortDateOf(core.from)} – ${shortDateOf(core.to)}` : 'no data',
    departures: core.departures,
    hours: PATTERN_HOURS,
    rows,
    worst,
    best,
  };
}

export function metaView(core: CoreMeta): MetaView {
  return {
    city: core.city.name,
    hubs: core.hubs,
    model: `${core.model.kind} ${core.model.version.replace(/^(baseline|lgbm)-/, '')}`,
    dataThrough:
      [
        core.trainedThrough && `trained to ${shortDateOf(core.trainedThrough)}`,
        core.statsThrough && `stats to ${shortDateOf(core.statsThrough)}`,
      ]
        .filter(Boolean)
        .join(' · ') || null,
    liveLabel: core.liveObservedAt ? `live ${timeOf(core.liveObservedAt)}` : null,
    attribution: core.attribution,
  };
}
