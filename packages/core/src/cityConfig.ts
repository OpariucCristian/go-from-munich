import { munich } from './cities/munich.ts';

export interface StationRef {
  eva: string; // 7-digit, no leading zero
  name: string;
}

export interface CityConfig {
  id: string;
  name: string;
  tz: string;
  /** Stations whose trains we model. Trips stopping at any hub are imported end-to-end. */
  hubs: StationRef[];
  /** Train categories in scope (IRIS `tl.c` / dataset `train_type`). */
  trainTypes: string[];
  /** Additional stations polled live so downstream arrivals get fresh data. */
  corridor: StationRef[];
  /** Default minimum transfer time in minutes when checking connections. */
  minTransferMin: number;
}

const CITIES: Record<string, CityConfig> = {
  [munich.id]: munich,
};

export function getCity(id: string): CityConfig {
  const c = CITIES[id];
  if (!c) throw new Error(`Unknown city "${id}". Known: ${Object.keys(CITIES).join(', ')}`);
  return c;
}

export function listCities(): CityConfig[] {
  return Object.values(CITIES);
}

/** All EVAs the live poller should watch for a city. */
export function polledStations(city: CityConfig): StationRef[] {
  return [...city.hubs, ...city.corridor];
}
