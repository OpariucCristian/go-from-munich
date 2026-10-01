/**
 * Orchestrates the trip estimate: resolves the journey (train lookup or shared text), fetches
 * predictions for every stop along each leg in one call, and shapes the result for the screen.
 */
import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import type { FeaturedView, ShareResult, TrainStopsView, TripEstimate } from '../contract.ts';
import { CoreApi } from '../core/coreApi.ts';
import type {
  CoreFeatured,
  CoreLeg,
  CoreResolveShare,
  CoreStopPrediction,
  CoreTrainStops,
  CoreTripPrediction,
} from '../core/types.ts';
import { MetaService } from '../explore/meta.service.ts';
import { featuredView, tripEstimate, transferViews, type LegInput } from '../view/estimate.ts';
import { berlinDate, timeOf } from '../view/format.ts';

export function parseTrain(train: string): { type: string; number: string } {
  const m = /^\s*([A-Za-z]{1,5})\s*(\d{1,6})\s*$/.exec(train);
  if (!m) throw new BadRequestException('train must look like "ICE 514"');
  return { type: m[1]!.toUpperCase(), number: m[2]! };
}

interface StopQuery {
  eva: string;
  trainType: string;
  trainNumber: string;
  event: 'a' | 'd';
  planned: string;
}

/** Departure at `from`, then arrivals at every later stop through `to` (inclusive). */
export function timelineQueries(
  run: CoreTrainStops,
  type: string,
  number: string,
  from?: string,
  to?: string,
): { queries: StopQuery[]; names: string[] } {
  const stops = run.stops;
  const fromIdx = from ? stops.findIndex((s) => s.eva === from && s.planned_dep) : stops.findIndex((s) => s.planned_dep);
  const lastArr = stops.findLastIndex((s) => s.planned_arr);
  const toIdx = to ? stops.findIndex((s, i) => i > fromIdx && s.eva === to && s.planned_arr) : lastArr;
  if (fromIdx >= 0 && !to && !stops.slice(fromIdx + 1).some((s) => s.planned_arr)) {
    const at = stops[fromIdx]!.name ?? 'this station';
    throw new BadRequestException(`We only know ${type} ${number} at ${at} so far, so there are no later stops to forecast yet`);
  }
  if (fromIdx < 0 || toIdx < 0 || toIdx <= fromIdx) {
    throw new BadRequestException(`${type} ${number} does not run from that station to that station`);
  }
  const queries: StopQuery[] = [];
  const names: string[] = [];
  const first = stops[fromIdx]!;
  queries.push({ eva: first.eva, trainType: type, trainNumber: number, event: 'd', planned: first.planned_dep! });
  names.push(first.name ?? first.eva);
  for (const s of stops.slice(fromIdx + 1, toIdx + 1)) {
    if (!s.planned_arr) continue;
    queries.push({ eva: s.eva, trainType: type, trainNumber: number, event: 'a', planned: s.planned_arr });
    names.push(s.name ?? s.eva);
  }
  return { queries, names };
}

@Injectable()
export class EstimateService {
  constructor(
    @Inject(CoreApi) private readonly core: CoreApi,
    @Inject(MetaService) private readonly meta: MetaService,
  ) {}

  /** The upcoming hub stop with the largest predicted delay, or null when nothing is tracked. */
  async featured(): Promise<FeaturedView | null> {
    return featuredView(await this.core.get<CoreFeatured>('/featured'));
  }

  async trainStops(train: string, date: string): Promise<TrainStopsView> {
    const { type, number } = parseTrain(train);
    const run = await this.core.get<CoreTrainStops>(`/trains/${type}/${number}`, { date });
    return {
      train: `${type} ${number}`,
      date,
      stops: run.stops
        .filter((s) => s.planned_dep || s.planned_arr)
        .map((s) => ({ eva: s.eva, name: s.name ?? s.eva, time: timeOf((s.planned_dep ?? s.planned_arr)!) })),
    };
  }

  async byTrain(train: string, date: string, from?: string, to?: string): Promise<TripEstimate> {
    const { type, number } = parseTrain(train);
    const [leg, meta] = await Promise.all([this.legFromRun(type, number, date, from, to), this.meta.get()]);
    return tripEstimate([leg], { model: meta.model, attribution: meta.attribution });
  }

  async fromShare(body: { text?: string; title?: string; url?: string }): Promise<ShareResult> {
    const resolved = await this.core.post<CoreResolveShare>('/resolve-share', body);
    if (!resolved.legs.length || !resolved.prediction) {
      return { estimate: null, warnings: resolved.warnings.length ? resolved.warnings : ['No train found in the shared text'] };
    }
    const prediction = resolved.prediction;
    const [legs, meta] = await Promise.all([
      Promise.all(resolved.legs.map((l, i) => this.legForShare(l, prediction.legs[i]!))),
      this.meta.get(),
    ]);
    // The text was resolvable, so a failed vbid lookup is not worth showing to the user.
    const warnings = resolved.warnings.filter((w) => !/vbid/i.test(w));
    return {
      estimate: tripEstimate(legs, {
        transfers: transferViews(prediction),
        allConnectionsP: prediction.tripSuccessProbability,
        warnings,
        model: meta.model,
        attribution: meta.attribution,
      }),
      warnings,
    };
  }

  private async legFromRun(type: string, number: string, date: string, from?: string, to?: string): Promise<LegInput> {
    const run = await this.core.get<CoreTrainStops>(`/trains/${type}/${number}`, { date });
    const { queries, names } = timelineQueries(run, type, number, from, to);
    const preds = await this.core.post<CoreStopPrediction[]>('/predict/stops', { stops: queries });
    return {
      trainType: type,
      trainNumber: number,
      basedOnRun: run.basedOnRun,
      timesFromDate: run.timesFromDate,
      origin: run.origin,
      destination: run.destination,
      stops: preds.map((p, i) => ({ name: names[i]!, prediction: p })),
    };
  }

  /** Full stop-by-stop timeline when the train's run is known; otherwise just boarding → alighting. */
  private async legForShare(leg: CoreLeg, predicted: CoreTripPrediction['legs'][number]): Promise<LegInput> {
    try {
      const full = await this.legFromRun(leg.trainType, leg.trainNumber, berlinDate(leg.plannedDep), leg.fromEva, leg.toEva);
      const boarding = full.stops[0]!.prediction.planned;
      // Only trust the run's timeline if it matches the shared departure time.
      if (Math.abs(Date.parse(boarding) - Date.parse(leg.plannedDep)) <= 5 * 60_000) return full;
    } catch {
      // Unknown train or stops: fall through to the two-stop leg from the share itself.
    }
    return {
      trainType: leg.trainType,
      trainNumber: leg.trainNumber,
      stops: [
        {
          name: predicted.from.name ?? leg.fromEva,
          prediction: { eva: leg.fromEva, event: 'd', planned: leg.plannedDep, live: predicted.from.live, prediction: predicted.from.departure },
        },
        {
          name: predicted.to.name ?? leg.toEva,
          prediction: { eva: leg.toEva, event: 'a', planned: leg.plannedArr, live: predicted.to.live, prediction: predicted.to.arrival },
        },
      ],
    };
  }
}
