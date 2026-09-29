/** Typed client for the BFF plus the React Query hooks each screen uses. */
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import type {
  AccuracySource,
  AccuracyView,
  ConnectionsView,
  DeparturesView,
  FeaturedView,
  MetaView,
  PatternsView,
  ShareResult,
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

/** The train the Estimate screen opens with (largest predicted delay coming up at the hubs). */
export const useFeatured = (enabled: boolean) =>
  useQuery({
    queryKey: ['featured'],
    queryFn: () => request<{ featured: FeaturedView | null }>('/bff/featured'),
    enabled,
    staleTime: 5 * 60_000,
  });
