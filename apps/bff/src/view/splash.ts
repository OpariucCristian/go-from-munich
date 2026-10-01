/** Start screen: next-hour departures from every hub, folded into one network-wide delay outlook. */
import type { SplashView } from '../contract.ts';
import type { CoreAccuracy, CoreDepartures } from '../core/types.ts';
import { departuresView } from './explore.ts';
import { distributionOf, pct, timeOf } from './format.ts';

const r4 = (x: number) => Math.round(x * 10000) / 10000;
const NEXT_ROWS = 5;
const WINDOW_MIN = 60;

/** `boards[0]` is the main station, whose next departures are listed. */
export function splashView(boards: CoreDepartures[], accuracy: CoreAccuracy | null): SplashView {
  const main = boards[0]!;
  const dists = boards.flatMap((b) => b.departures.map((d) => distributionOf(d.prediction)));
  // Average the forecasts, then renormalise over running trains so the bars sum to 1.
  const sums = [0, 0, 0, 0, 0, 0];
  for (const d of dists) d.bars.forEach((b, i) => (sums[i]! += b.p));
  const total = sums.reduce((a, b) => a + b, 0);
  const shares = sums.map((v) => (total > 0 ? v / total : 0));
  const labels = ['≤2', '3–5', '6–10', '11–15', '16–30', '30+'];
  const at = new Date(main.at);
  const green = accuracy?.total?.green ?? null;
  return {
    window: `${timeOf(at)}–${timeOf(new Date(at.getTime() + WINDOW_MIN * 60_000))}`,
    count: dists.length,
    bars: labels.map((label, i) => ({ label, p: r4(shares[i]!) })),
    lateOver5: r4(shares.slice(2).reduce((a, b) => a + b, 0)),
    station: main.station,
    next: departuresView(main).rows.slice(0, NEXT_ROWS),
    accuracy: green === null ? null : `Last 7 days: ${pct(green)} of low-risk calls held`,
  };
}
