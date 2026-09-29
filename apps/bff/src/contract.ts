/**
 * View models the BFF serves to the web app. Everything here is display-ready: times are
 * Europe/Berlin wall clock, probabilities are 0..1, tones are decided server-side so every
 * screen colours risk the same way. The web app imports these types (type-only).
 */

/** good < 20% chance of >5 min late, warn 20–35%, bad > 35% (cancellations count as late). */
export type Tone = 'good' | 'warn' | 'bad';

export interface Bar {
  label: string; // '≤2', '3–5', '6–10', '11–15', '16–30', '30+'
  p: number;
}

export interface DistributionView {
  /** Six delay ranges; their sum plus `cancelled` is 1. */
  bars: Bar[];
  /** P(delay ≤ upper bound of each bar), for the cumulative chart. */
  cumulative: number[];
  cancelled: number;
  onTime: number; // ≤2 min
  lateOver5: number; // ≥6 min or cancelled
  lateOver15: number; // ≥16 min
  expected: number; // minutes, if it runs
  median: number;
  /** 80% chance the delay is at most this many minutes (if it runs). */
  upTo80: number;
}

export interface Confidence {
  level: 'high' | 'medium' | 'low';
  text: string;
}

export interface LiveView {
  delayMin: number | null;
  cancelled: boolean;
  label: string; // '+7 now', 'cancelled', 'on time now'
  observedAt: string | null;
}

export interface StopView {
  eva: string;
  name: string;
  event: 'arrival' | 'departure';
  planned: string; // ISO instant
  time: string; // 'HH:MM'
  typicalLabel: string; // '+7': median delay if it runs (robust to the long tail)
  tone: Tone;
  headline: string; // 'Likely about 9 minutes late'
  sentence: string; // 'Most likely arrival is 17:21. …'
  dist: DistributionView;
  confidence: Confidence;
  live: LiveView | null;
}

export interface LegView {
  train: string;
  trainType: string;
  trainNumber: string;
  from: StopView; // departure
  to: StopView; // arrival
  /** Departure at `from`, then arrival at every later stop up to `to` (just [from, to] if unknown). */
  timeline: StopView[];
  durationLabel: string;
  /** Where the train really starts and ends, e.g. 'Wien Hbf → München Hbf', when known. */
  routeLabel: string | null;
}

export interface TransferView {
  station: string;
  plannedMin: number;
  minTransferMin: number;
  missP: number;
  tone: Tone;
  text: string;
}

export interface TripEstimate {
  title: string; // 'München Hbf → Stuttgart Hbf'
  date: string; // YYYY-MM-DD (Berlin)
  dateLabel: string; // 'Mon 26 Oct'
  legs: LegView[];
  transfers: TransferView[];
  final: StopView;
  allConnectionsP: number | null;
  /** Set when stop times come from an earlier run of the same train (timetables repeat weekly). */
  timetableNote: string | null;
  warnings: string[];
  model: string;
  attribution: string;
}

export interface ShareResult {
  estimate: TripEstimate | null;
  warnings: string[];
}

export interface ConnectionItem {
  train: string;
  trainType: string;
  trainNumber: string;
  fromEva: string;
  toEva: string;
  dep: string; // 'HH:MM'
  arr: string;
  durationLabel: string;
  lateOver5: number;
  tone: Tone;
  typicalLabel: string;
}

export interface ConnectionsView {
  date: string;
  dateLabel: string;
  items: ConnectionItem[];
}

export interface DepartureRow {
  time: string;
  train: string;
  trainType: string;
  trainNumber: string;
  destination: string;
  /** On time (≤2) / 3–10 / >10 min, and cancelled; sums to 1. */
  split: [number, number, number];
  cancelled: number;
  typicalLabel: string;
  tone: Tone;
  live: LiveView | null;
  planned: string;
}

export interface DeparturesView {
  station: { eva: string; name: string };
  asOf: string; // 'HH:MM'
  rows: DepartureRow[];
}

export interface HeatCell {
  hour: number;
  avg: number | null; // minutes
  lateOver5: number | null;
  n: number;
}

export interface PatternsView {
  rangeLabel: string; // '1 Jul – 28 Sep'
  departures: number;
  hours: number[];
  rows: { day: string; cells: HeatCell[] }[];
  worst: { label: string; avg: number } | null;
  best: { label: string; avg: number } | null;
}

export interface MetaView {
  city: string;
  hubs: { eva: string; name: string }[];
  model: string;
  dataThrough: string | null; // 'data to 31 Aug'
  liveLabel: string | null; // 'live 22:43'
  attribution: string;
}

export interface StationOption {
  eva: string;
  name: string;
}

export interface TrainStopsView {
  train: string;
  date: string;
  stops: { eva: string; name: string; time: string }[];
}

export type AccuracySource = 'live' | 'replay' | 'all';

export interface AccuracyStat {
  key: 'green' | 'within80' | 'skill' | 'miss';
  label: string;
  value: string;
  detail: string;
  tone: Tone | 'neutral';
}

export interface AccuracyDay {
  date: string; // YYYY-MM-DD
  label: string; // '5 Aug'
  source: 'live' | 'replay';
  n: number;
  /** 1 − RPS / climatology RPS: how much better than a forecast that ignores train, station and time. */
  skill: number | null;
  /** Share of runs at most as late as the "80% chance" limit we showed (target 80%). */
  within80: number | null;
  /** When the risk showed green (<20% chance of >5 min late), the share that really was ≤5 min late. */
  green: number | null;
  predLate5: number;
  obsLate5: number;
}

export interface CalibrationPoint {
  label: string; // '10–20%'
  predicted: number;
  observed: number;
  n: number;
}

export interface AccuracyBreakdownRow {
  label: string;
  n: number;
  skill: number | null;
  within80: number | null;
  maeMin: number | null;
  predLate5: number;
  obsLate5: number;
}

export interface AccuracyMiss {
  train: string;
  trainType: string;
  trainNumber: string;
  date: string; // YYYY-MM-DD
  dateLabel: string; // 'Mon 28 Sep'
  station: string;
  eva: string;
  event: 'arr' | 'dep';
  time: string; // planned, HH:MM
  predicted: string; // 'Likely +1 · 9% risk'
  actual: string; // '+34 min' | 'Cancelled'
  source: 'live' | 'replay';
  /** Opens this run's stop-by-stop view: `<date>.<tripId>.<source>`. */
  run: string;
}

export type AccuracyRunSort = 'miss' | 'recent';

/** One train run (one trip on one service date) with predicted vs actual delay. */
export interface AccuracyRunRow {
  run: string; // '<date>.<tripId>.<source>'
  train: string; // 'RE 4012'
  trainType: string;
  trainNumber: string;
  date: string; // YYYY-MM-DD
  dateLabel: string; // 'Mon 28 Sep'
  time: string; // first planned stop, HH:MM
  source: 'live' | 'replay';
  stops: number;
  cancelled: number;
  /** Averages over the stops that ran, in minutes; null when every stop was cancelled. */
  predicted: number | null;
  actual: number | null;
  maeMin: number | null;
  within80: number | null;
  tone: Tone | 'neutral';
}

export interface AccuracyRunsView {
  runs: AccuracyRunRow[];
  total: number;
}

export interface AccuracyRunStop {
  station: string;
  eva: string;
  event: 'arr' | 'dep';
  time: string; // planned, HH:MM
  lead: string; // '3h ahead'
  predicted: number; // likely (median) delay, min
  limit80: number; // "80% chance it's at most this late", min
  late5: number;
  cancelRisk: number;
  actual: number | null; // clamped at 0; null when cancelled
  cancelled: boolean;
  within80: boolean | null;
}

export interface AccuracyRunView {
  run: AccuracyRunRow;
  model: string;
  summary: string; // 'Said +2 on average, was +9. Typical miss 7.0 min, 1 of 3 within the 80% limit.'
  stops: AccuracyRunStop[];
}

export interface AccuracyView {
  source: AccuracySource;
  empty: boolean;
  rangeLabel: string | null; // '5 Aug – 29 Sep'
  dayCount: number;
  predictions: number;
  stats: AccuracyStat[];
  trend: AccuracyDay[];
  calibration: CalibrationPoint[];
  breakdown: { title: string; rows: AccuracyBreakdownRow[] }[];
  misses: AccuracyMiss[];
  models: string; // 'baseline v1'
  liveStatus: string;
  note: string | null;
}

/** The train the Estimate screen opens with when nothing was searched yet. */
export interface FeaturedView {
  train: string; // 'ICE 514'
  date: string; // service date, YYYY-MM-DD
  eva: string;
  station: string;
  event: 'arr' | 'dep';
  time: string; // planned, HH:MM
  /** 'Biggest delay we expect for trains leaving the Munich hubs in the next 3 hours: +12 min on average, 58% chance of >5 min late.' */
  reason: string;
}
