/** Builds the trip estimate screen's view model from core predictions. */
import type { DistributionView, FeaturedView, LegView, StopView, TransferView, TripEstimate } from '../contract.ts';
import type { CoreFeatured, CoreStopPrediction, CoreTripPrediction } from '../core/types.ts';
import {
  berlinDate,
  confidenceOf,
  dateLabelOf,
  distributionOf,
  durationLabel,
  liveOf,
  pct,
  signedMin,
  timeOf,
  toneOf,
} from './format.ts';

export interface TimelineStop {
  name: string;
  prediction: CoreStopPrediction;
}

export interface LegInput {
  trainType: string;
  trainNumber: string;
  /** Departure at the boarding stop first, then arrivals in order; at least two entries. */
  stops: TimelineStop[];
  basedOnRun?: string | null;
  /** True when only the stop list came from `basedOnRun` and the times are that day's own. */
  timesFromDate?: boolean;
  origin?: string | null;
  destination?: string | null;
}

export function stopView(s: TimelineStop, trainType: string, trainNumber: string): StopView {
  const p = s.prediction;
  const dist = distributionOf(p.prediction);
  const event = p.event === 'a' ? 'arrival' : 'departure';
  return {
    eva: p.eva,
    name: s.name,
    event,
    planned: p.planned,
    time: timeOf(p.planned),
    typicalLabel: signedMin(dist.median),
    tone: toneOf(dist.lateOver5),
    headline: headlineOf(dist),
    sentence: sentenceOf(dist, p.planned, event),
    dist,
    confidence: confidenceOf(p.prediction, `${trainType} ${trainNumber}`, trainType),
    live: liveOf(p.live),
  };
}

export function legView(leg: LegInput): LegView {
  if (leg.stops.length < 2) throw new Error('a leg needs a departure and an arrival');
  const timeline = leg.stops.map((s) => stopView(s, leg.trainType, leg.trainNumber));
  const from = timeline[0]!;
  const to = timeline.at(-1)!;
  return {
    train: `${leg.trainType} ${leg.trainNumber}`,
    trainType: leg.trainType,
    trainNumber: leg.trainNumber,
    from,
    to,
    timeline,
    durationLabel: durationLabel(from.planned, to.planned),
    routeLabel: leg.origin && leg.destination ? `${leg.origin} → ${leg.destination}` : null,
  };
}

export function headlineOf(d: DistributionView): string {
  if (d.cancelled >= 0.25) return 'High risk of cancellation';
  if (d.median <= 2) return d.onTime >= 0.6 ? 'Likely on time' : 'Probably on time, with some risk of delay';
  return `Likely about ${d.median} minutes late`;
}

export function sentenceOf(d: DistributionView, planned: string, event: StopView['event']): string {
  const likely = timeOf(new Date(Date.parse(planned) + d.median * 60_000));
  let text = `Most likely ${event} is ${likely}. There's a ${pct(d.onTime)} chance it's on time and a ${pct(d.lateOver15)} chance it's more than 15 minutes late.`;
  if (d.cancelled >= 0.03) text += ` Cancellation risk: ${pct(d.cancelled)}.`;
  return text;
}

export function transferViews(core: CoreTripPrediction | null | undefined): TransferView[] {
  return (core?.transfers ?? []).map((t) => {
    const tone = t.failureProbability > 0.35 ? 'bad' : t.failureProbability >= 0.15 ? 'warn' : 'good';
    return {
      station: t.at.name ?? t.at.eva,
      plannedMin: t.plannedTransferMin,
      minTransferMin: t.minTransferMin,
      missP: t.failureProbability,
      tone,
      text: `${t.plannedTransferMin} min to change: ${pct(t.failureProbability)} chance of missing the connection`,
    };
  });
}

export function tripEstimate(
  legs: LegInput[],
  opts: { transfers?: TransferView[]; allConnectionsP?: number | null; warnings?: string[]; model: string; attribution: string },
): TripEstimate {
  const views = legs.map(legView);
  const first = views[0]!;
  const final = views.at(-1)!.to;
  const date = berlinDate(first.from.planned);
  const stale = legs.find((l) => l.basedOnRun && l.basedOnRun !== date);
  return {
    title: `${first.from.name} → ${final.name}`,
    date,
    dateLabel: dateLabelOf(first.from.planned),
    legs: views,
    transfers: opts.transfers ?? [],
    final,
    allConnectionsP: views.length > 1 ? (opts.allConnectionsP ?? null) : null,
    timetableNote: stale
      ? stale.timesFromDate
        ? `Stop list taken from the ${dateLabelOf(stale.basedOnRun!)} run of ${stale.trainType} ${stale.trainNumber}; times are from the live timetable`
        : `Stops and times taken from the ${dateLabelOf(stale.basedOnRun!)} run of ${stale.trainType} ${stale.trainNumber}`
      : null,
    warnings: opts.warnings ?? [],
    model: opts.model,
    attribution: opts.attribution,
  };
}

export function featuredView(core: CoreFeatured): FeaturedView | null {
  const f = core.featured;
  if (!f) return null;
  return {
    train: `${f.trainType} ${f.trainNumber}`,
    date: f.serviceDate,
    eva: f.eva,
    station: f.station,
    event: f.event === 'a' ? 'arr' : 'dep',
    time: timeOf(f.planned),
    reason:
      `Biggest delay we expect for trains leaving the Munich hubs in the next ${f.windowHours} hours: ` +
      `${signedMin(f.expected)} min on average if it runs, ${pct(f.lateOver5)} chance of more than 5 minutes late.`,
  };
}
