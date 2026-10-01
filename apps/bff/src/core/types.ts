/** Response shapes of the core prediction API (apps/api) that the BFF consumes. */

export interface CorePrediction {
  buckets: { label: string; p: number }[]; // 8: ≤2, 3–5, 6–10, 11–15, 16–30, 31–60, >60, cancelled
  atLeast: Record<string, number>; // '3min', '6min', '11min', '16min', '31min', '61min'
  cancelled: number;
  minutes: { expected: number; median: number; p10: number; p80: number; p90: number };
  support: { level: number; observations: number };
  /** Where the train was last seen before this stop, when that changed the prediction. */
  sighting?: CoreSighting | null;
  /** The weather a model scored this stop with; null when no model used weather for it. */
  weather?: CoreWeather | null;
}

/** °C, mm and cm over the last 3 hours, km/h; null where unknown. */
export interface CoreWeather {
  tempC: number | null;
  precip3h: number | null;
  snow3h: number | null;
  gustKmh: number | null;
  regionTempMin: number | null;
  regionPrecip3hMax: number | null;
  regionSnow3hMax: number | null;
  regionGustMax: number | null;
}

/** A delay reason or announcement DB attached to the train's run. */
export interface CoreReason {
  kind: 'cause' | 'announcement';
  text: string;
  station: string | null;
  reportedAt: string;
  stops: number;
}

export interface CoreSighting {
  eva: string;
  name: string | null;
  delayMin: number;
  gapMin: number;
  planned: string;
}

export interface CoreLive {
  delayMin: number | null;
  cancelled: boolean;
  observedAt: string | null;
  cause?: string | null;
}

export interface CoreStopPrediction {
  eva: string;
  event: 'a' | 'd';
  planned: string;
  live: CoreLive | null;
  prediction: CorePrediction;
  /** Absent from older core APIs. */
  reasons?: CoreReason[];
}

export interface CoreLeg {
  trainType: string;
  trainNumber: string;
  fromEva: string;
  toEva: string;
  plannedDep: string;
  plannedArr: string;
}

export interface CoreTripPrediction {
  legs: {
    train: string;
    from: { eva: string; name: string | null; planned: string; live: CoreLive | null; departure: CorePrediction };
    to: { eva: string; name: string | null; planned: string; live: CoreLive | null; arrival: CorePrediction };
  }[];
  transfers: {
    at: { eva: string; name: string | null };
    plannedTransferMin: number;
    minTransferMin: number;
    failureProbability: number;
  }[];
  tripSuccessProbability: number;
  model: { kind: string; version: string };
  attribution: string;
}

export interface CoreResolveShare {
  legs: CoreLeg[];
  strategy: string;
  vbid: string | null;
  warnings: string[];
  prediction: CoreTripPrediction | null;
}

export interface CoreTrainStops {
  train: string;
  date: string;
  basedOnRun: string;
  /** Times are that date's own (a complete run, or aligned to its partial live run). */
  timesFromDate?: boolean;
  /** The run's real origin and destination from the live timetable (null if the poller didn't see it). */
  origin?: string | null;
  destination?: string | null;
  stops: { eva: string; name: string | null; stop_seq: number | null; planned_arr: string | null; planned_dep: string | null }[];
}

export interface CoreMeta {
  city: { id: string; name: string; tz: string };
  hubs: { eva: string; name: string }[];
  model: { kind: string; version: string };
  /** Last day the served LightGBM model trained on (null for the baseline). */
  trainedThrough: string | null;
  /** Last day in the nightly delay statistics, poller days included. */
  statsThrough: string | null;
  liveObservedAt: string | null;
  attribution: string;
}

export interface CoreDepartures {
  station: { eva: string; name: string };
  at: string;
  departures: {
    /** Where this train leaves from; can differ from `station` (e.g. München Hbf Gl.27-36). */
    eva: string;
    train: string;
    trainType: string;
    trainNumber: string;
    line: string | null;
    destination: string | null;
    planned: string;
    live: CoreLive | null;
    prediction: CorePrediction;
  }[];
}

export interface CoreConnections {
  date: string;
  connections: {
    train: string;
    trainType: string;
    trainNumber: string;
    destination: string | null;
    fromEva: string;
    toEva: string;
    plannedDep: string;
    plannedArr: string;
    basedOnRun: string;
    departure: CorePrediction;
    arrival: CorePrediction;
  }[];
}

export interface CorePatterns {
  from: string | null;
  to: string | null;
  departures: number;
  cells: { dow: number; hour: number; avg: number | null; late: number | null; cancelled: number; n: number }[];
}

export interface CoreAccuracyMetrics {
  n: number;
  nRun: number;
  rps: number;
  logLoss: number;
  brier6: number;
  climatologyRps: number | null;
  topBucketHit: number;
  within80: number | null;
  maeMin: number | null;
  predLate5: number;
  obsLate5: number;
}

export interface CoreCalibrationBin {
  lo: number;
  hi: number;
  n: number;
  predicted: number;
  observed: number;
}

export interface CoreAccuracy {
  source: 'live' | 'replay' | 'all' | 'near';
  from: string | null;
  to: string | null;
  total: (CoreAccuracyMetrics & { green: number | null }) | null;
  daily: (CoreAccuracyMetrics & {
    date: string;
    source: 'live' | 'replay' | 'near';
    modelVersions: string[];
    unlabelled: number;
    /** Share of green (<20% risk) predictions that were really ≤5 min late. */
    green: number | null;
  })[];
  calibration: CoreCalibrationBin[];
  breakdown: Record<'trainType' | 'station' | 'event' | 'lead', Record<string, CoreAccuracyMetrics>>;
  models: { version: string; n: number }[];
  misses: {
    date: string;
    source: 'live' | 'replay' | 'near';
    tripId: string;
    trainType: string;
    trainNumber: string;
    eva: string;
    station: string;
    event: 'a' | 'd';
    planned: string;
    predictedMedian: number;
    predictedLate5: number;
    predictedCancelled: number;
    observedBucket: number;
    observedDelay: number | null;
    cancelled: boolean;
    rps: number;
  }[];
  live: { trackingSince: string | null; pendingSnapshots: number; lastScoredAt: string | null };
  tz: string;
}

export interface CoreRunSummary {
  date: string;
  source: 'live' | 'replay' | 'near';
  tripId: string;
  trainType: string;
  trainNumber: string;
  firstPlanned: string;
  stops: number;
  cancelled: number;
  predictedMedian: number | null;
  observedDelay: number | null;
  maeMin: number | null;
  within80: number | null;
  worstMissMin: number | null;
  modelVersions: string[];
}

export interface CoreAccuracyRuns {
  runs: CoreRunSummary[];
  total: number;
  tz: string;
}

export interface CoreAccuracyRun {
  run: CoreRunSummary;
  stops: {
    eva: string;
    station: string;
    event: 'a' | 'd';
    planned: string;
    leadMin: number;
    modelVersion: string;
    predictedMedian: number;
    predictedP80: number;
    predictedLate5: number;
    predictedCancelled: number;
    observedDelay: number | null;
    cancelled: boolean;
    within80: boolean | null;
    rps: number;
  }[];
  tz: string;
}

export interface CoreFeatured {
  featured: {
    trainType: string;
    trainNumber: string;
    serviceDate: string;
    eva: string;
    station: string;
    event: 'a' | 'd';
    planned: string;
    predictedAt: string;
    expected: number;
    lateOver5: number;
    candidates: number;
    windowHours: number;
  } | null;
}
