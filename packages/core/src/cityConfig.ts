import { munich } from './cities/munich.ts';

export interface StationRef {
  eva: string; // 7-digit, no leading zero
  name: string;
}

export interface WeatherPoint {
  id: string;
  lat: number;
  lon: number;
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
  /**
   * Stations further out (often abroad) where trains bound for the city are seen earlier. Polled
   * like the corridor, only as live sightings for the nowcast; not predicted or scored.
   */
  upstream: StationRef[];
  /** Hourly weather is fetched for these points; the first is the city itself. */
  weatherPoints: WeatherPoint[];
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

/** All stations the live poller watches for a city. */
export function polledStations(city: CityConfig): StationRef[] {
  return [...city.hubs, ...city.corridor, ...city.upstream];
}

/** Stations whose predictions are tracked for accuracy: hubs and corridor, where we have history. */
export function scoredStations(city: CityConfig): StationRef[] {
  return [...city.hubs, ...city.corridor];
}
