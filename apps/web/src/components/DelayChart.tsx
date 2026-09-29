/** Delay distribution as bars (histogram) or "arrive within X minutes" (cumulative). */
import type { DistributionView } from '../../../bff/src/contract.ts';
import { pct } from './ui.tsx';

export type ChartMode = 'histogram' | 'cumulative';

const COLORS = ['var(--b0)', 'var(--b1)', 'var(--b2)', 'var(--b3)', 'var(--b4)', 'var(--b5)'];

export function DelayChart({ dist, mode, compact }: { dist: DistributionView; mode: ChartMode; compact?: boolean }) {
  const values = mode === 'cumulative' ? dist.cumulative : dist.bars.map((b) => b.p);
  const max = mode === 'cumulative' ? 1 : Math.max(...values, 0.01);
  const summary = dist.bars.map((b, i) => `${b.label} min: ${pct(values[i]!)}`).join(', ');
  return (
    <div className="chart" role="img" aria-label={`${mode === 'cumulative' ? 'Chance of arriving within' : 'Chance of each delay range'}: ${summary}`}>
      {dist.bars.map((b, i) => (
        <div className="chart-col" key={b.label}>
          <div className="chart-pct">{pct(values[i]!)}</div>
          <div className="chart-well" style={compact ? { height: 110 } : undefined}>
            <div className="chart-bar" style={{ height: `${(values[i]! / max) * 100}%`, background: COLORS[i] }} />
          </div>
          <div className="chart-label">{b.label}</div>
        </div>
      ))}
    </div>
  );
}
