/**
 * IRIS stop ids look like `{rideId}-{YYMMddHHmm}-{stopIndex}`, e.g.
 * `-7033045110854920488-2607311545-17`. The ride id can be negative. The middle part is the
 * planned departure at the trip's origin (Berlin local), which, together with the ride id,
 * identifies one run of a train across all its stations. Its date is the service date.
 */
export interface IrisStopId {
  rideId: string;
  originStart: string; // YYMMddHHmm
  stopIndex: number;
  serviceDate: string; // YYYY-MM-DD
}

const STOP_ID = /^(-?\d+)-(\d{10})-(\d+)$/;

export function parseIrisStopId(id: string): IrisStopId | null {
  const m = STOP_ID.exec(id);
  if (!m) return null;
  const start = m[2]!;
  return {
    rideId: m[1]!,
    originStart: start,
    stopIndex: Number(m[3]),
    serviceDate: `20${start.slice(0, 2)}-${start.slice(2, 4)}-${start.slice(4, 6)}`,
  };
}

/** Normalise EVA numbers: the dataset uses 8 digits with a leading zero, IRIS uses 7. */
export function normalizeEva(eva: string | number): string {
  return String(eva).trim().replace(/^0+/, '');
}

/** Human-facing train label, e.g. "ICE 618" or "RE 4012". */
export function trainLabel(trainType: string, trainNumber: string): string {
  return `${trainType} ${trainNumber}`;
}
