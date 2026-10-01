/** Typed client for the BFF plus the React Query hooks each screen uses. */
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import type {
  AccuracyRunSort,
  AccuracyRunsView,
  AccuracyRunView,
  AccuracySource,
  AccuracyView,
  ConnectionsView,
  DeparturesView,
  FeaturedView,
  MetaView,
  PatternsView,
  ShareResult,
  SplashView,
  StationOption,
  TrainStopsView,
  TripEstimate,
} from '../../bff/src/contract.ts';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, init);
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { message?: string | string[] };
    const message = Array.isArray(body.message) ? body.message.join(', ') : body.message;
    throw new ApiError(res.status, message ?? `Request failed (${res.status})`);
  }
  return (await res.json()) as T;
}

const qs = (params: Record<string, string | undefined>) =>
  new URLSearchParams(Object.entries(params).filter((e): e is [string, string] => !!e[1])).toString();

export const useMeta = () =>
  useQuery({ queryKey: ['meta'], queryFn: () => request<MetaView>('/bff/meta'), staleTime: 60_000 });

export const useStations = (q: string) =>
  useQuery({
    queryKey: ['stations', q],
    queryFn: () => request<StationOption[]>(`/bff/stations?${qs({ q })}`),
    enabled: q.trim().length >= 2,
    staleTime: 5 * 60_000,
    placeholderData: keepPreviousData,
  });

export const useConnections = (p: { from?: string; to?: string; date?: string; after?: string }) =>
  useQuery({
    queryKey: ['connections', p],
    queryFn: () => request<ConnectionsView>(`/bff/connections?${qs(p)}`),
    enabled: !!(p.from && p.to && p.date && p.from !== p.to),
  });

export const useTrainStops = (train?: string, date?: string) =>
  useQuery({
    queryKey: ['trainStops', train, date],
    queryFn: () => request<TrainStopsView>(`/bff/trains/${encodeURIComponent(train!)}?${qs({ date })}`),
    enabled: !!(train && date),
    retry: false,
  });

export const useEstimate = (p: { train?: string; date?: string; from?: string; to?: string }) =>
  useQuery({
    queryKey: ['estimate', p],
    queryFn: () => request<TripEstimate>(`/bff/estimate?${qs(p)}`),
    enabled: !!(p.train && p.date),
    retry: false,
  });

export const useShareEstimate = (share: { text?: string; title?: string; url?: string }) =>
  useQuery({
    queryKey: ['share', share],
    queryFn: () =>
      request<ShareResult>('/bff/share', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(share),
      }),
    enabled: !!(share.text || share.url || share.title),
    retry: false,
    staleTime: Infinity,
  });

export const useDepartures = (station: string, group: string) =>
  useQuery({
    queryKey: ['departures', station, group],
    queryFn: () => request<DeparturesView>(`/bff/departures?${qs({ station, group, minutes: '90' })}`),
    refetchInterval: 60_000,
    placeholderData: keepPreviousData,
  });

export const usePatterns = (group: string) =>
  useQuery({
    queryKey: ['patterns', group],
    queryFn: () => request<PatternsView>(`/bff/patterns?${qs({ group })}`),
    staleTime: 10 * 60_000,
    placeholderData: keepPreviousData,
  });

export const useAccuracy = (days: string, source: AccuracySource) =>
  useQuery({
    queryKey: ['accuracy', days, source],
    queryFn: () => request<AccuracyView>(`/bff/accuracy?${qs({ days, source })}`),
    staleTime: 10 * 60_000,
    placeholderData: keepPreviousData,
  });

/** Scored train runs in the window, with predicted vs actual delay. */
export const useAccuracyRuns = (days: string, source: AccuracySource, sort: AccuracyRunSort, train: string) =>
  useQuery({
    queryKey: ['accuracy-runs', days, source, sort, train],
    queryFn: () => request<AccuracyRunsView>(`/bff/accuracy/runs?${qs({ days, source, sort, train: train || undefined })}`),
    staleTime: 10 * 60_000,
    placeholderData: keepPreviousData,
  });

/** One run stop by stop; `run` is an AccuracyRunRow.run key. */
export const useAccuracyRun = (run: string | null) =>
  useQuery({
    queryKey: ['accuracy-run', run],
    queryFn: () => request<AccuracyRunView>(`/bff/accuracy/run?${qs({ run: run! })}`),
    enabled: !!run,
    staleTime: 10 * 60_000,
  });

/** The train the Estimate screen opens with (largest predicted delay coming up at the hubs). */
export const useFeatured = (enabled: boolean) =>
  useQuery({
    queryKey: ['featured'],
    queryFn: () => request<{ featured: FeaturedView | null }>('/bff/featured'),
    enabled,
    staleTime: 5 * 60_000,
  });

/** Start screen: next-hour outlook for all hubs plus the main station's next departures. */
export const useSplash = () =>
  useQuery({
    queryKey: ['splash'],
    queryFn: () => request<SplashView>('/bff/splash'),
    refetchInterval: 60_000,
    placeholderData: keepPreviousData,
  });
