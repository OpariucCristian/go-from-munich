/** When trains run late: weekday × hour heatmap of average departure delay at the hubs (design 1f). */
import { useSearchParams } from 'react-router';
import type { HeatCell } from '../../../bff/src/contract.ts';
import { usePatterns } from '../api.ts';
import { Chips, ErrorNote, Skeleton, pct } from '../components/ui.tsx';

const GROUPS = [
  { value: 'all', label: 'All lines' },
  { value: 'long', label: 'ICE / IC' },
  { value: 'regional', label: 'Regional' },
];
const MIN_N = 30;

function heatColor(v: number) {
  const t = Math.min(v / 8, 1);
  return `oklch(${(0.95 - 0.45 * t).toFixed(3)} ${(0.02 + 0.15 * t).toFixed(3)} ${(80 - 50 * t).toFixed(1)})`;
}

export function PatternsPage() {
  const [params, setParams] = useSearchParams();
  const group = params.get('group') ?? 'all';
  const q = usePatterns(group);
  const p = q.data;

  return (
    <section className="page" aria-label="Patterns">
      <div className="page-head">
        <div>
          <h1 className="page-title">When trains run late</h1>
          <div className="muted">
            Average departure delay at München Hbf, Ost and Pasing, in minutes
            {p ? ` · ${p.rangeLabel} · ${p.departures.toLocaleString('en-GB')} departures` : ''}
          </div>
        </div>
        <Chips label="Trains" value={group} onChange={(v) => setParams({ group: v }, { replace: true })} options={GROUPS} />
      </div>
      {q.error && <ErrorNote error={q.error} />}
      {q.isPending && <Skeleton height={460} />}
      {p && (
        <div className="patterns-grid">
          <div className="heat" role="table" aria-label="Average delay by weekday and hour">
            <div className="heat-row" role="row">
              <div />
              {p.hours.map((h) => (
                <div className="heat-hours" role="columnheader" key={h}>
                  {String(h).padStart(2, '0')}
                </div>
              ))}
            </div>
            {p.rows.map((row) => (
              <div className="heat-row" role="row" key={row.day}>
                <div className="heat-day" role="rowheader">
                  {row.day}
                </div>
                {row.cells.map((c) => (
                  <Cell key={c.hour} day={row.day} cell={c} />
                ))}
              </div>
            ))}
            <div className="heat-scale">
              <span>0 min</span>
              <div className="ramp" />
              <span>8+ min</span>
              <span style={{ marginLeft: 12 }}>Faded: fewer than {MIN_N} departures</span>
            </div>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            {p.worst && (
              <div className="stat-card">
                <div className="muted" style={{ fontSize: 13 }}>Worst slot</div>
                <div style={{ fontSize: 22, fontWeight: 700 }}>{p.worst.label}</div>
                <div className="v tone-bad">+{p.worst.avg.toFixed(1)} min</div>
              </div>
            )}
            {p.best && (
              <div className="stat-card">
                <div className="muted" style={{ fontSize: 13 }}>Most reliable weekday slot</div>
                <div style={{ fontSize: 22, fontWeight: 700 }}>{p.best.label}</div>
                <div className="v tone-good">+{p.best.avg.toFixed(1)} min</div>
              </div>
            )}
            <div className="muted" style={{ fontSize: 14, lineHeight: 1.5 }}>
              Hover a cell for the average, the share of departures more than 5 minutes late, and how many departures it's based on.
              Cancelled departures are not included in the average.
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

function Cell({ day, cell: c }: { day: string; cell: HeatCell }) {
  const hour = `${String(c.hour).padStart(2, '0')}:00`;
  if (c.avg === null) {
    return <div className="heat-cell" role="cell" style={{ background: 'var(--track)' }} title={`${day} ${hour} · no departures`} />;
  }
  const tip = `${day} ${hour} · avg +${c.avg} min · ${c.lateOver5 === null ? '' : `${pct(c.lateOver5)} >5 min late · `}${c.n} departures`;
  return (
    <div
      className={`heat-cell${c.n < MIN_N ? ' sparse' : ''}`}
      role="cell"
      title={tip}
      aria-label={tip}
      style={{ background: heatColor(c.avg), color: c.avg > 4.5 ? '#fff' : 'var(--ink)' }}
    >
      {c.avg.toFixed(1)}
    </div>
  );
}
