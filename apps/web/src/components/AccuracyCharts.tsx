/**
 * Charts for the Accuracy screen: a daily trend (one metric at a time), a calibration plot and one
 * train run's predicted vs actual delay, stop by stop.
 */
import { useLayoutEffect, useRef, useState } from 'react';
import type { AccuracyDay, AccuracyRunStop, CalibrationPoint } from '../../../bff/src/contract.ts';
import { pct } from './ui.tsx';

export type TrendMetric = 'green' | 'within80' | 'skill';

const DAY_MS = 86400_000;
const signedPct = (x: number) => `${x >= 0 ? '+' : '−'}${Math.abs(Math.round(x * 100))}%`;
const fmt = (metric: TrendMetric, v: number) => (metric === 'skill' ? signedPct(v) : pct(v));

function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setWidth(el.getBoundingClientRect().width);
    const ro = new ResizeObserver(([e]) => e && setWidth(e.contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, width] as const;
}

function niceDomain(metric: TrendMetric, values: number[]): [number, number] {
  const min = Math.min(...values);
  const max = Math.max(...values);
  if (metric === 'skill') {
    return [Math.min(0, Math.floor((min - 0.02) * 10) / 10), Math.max(0.1, Math.ceil((max + 0.02) * 10) / 10)];
  }
  return [Math.max(0, Math.min(0.6, Math.floor((min - 0.02) * 10) / 10)), 1];
}

function ticksOf([lo, hi]: [number, number]): number[] {
  const step = hi - lo > 0.5 ? 0.2 : 0.1;
  const out: number[] = [];
  for (let t = Math.ceil(lo / step - 1e-9) * step; t <= hi + 1e-9; t += step) out.push(Math.round(t * 100) / 100);
  return out;
}

const REFERENCE: Record<TrendMetric, { value: number; label: string } | null> = {
  green: null,
  within80: { value: 0.8, label: 'Target 80%' },
  skill: { value: 0, label: 'Same as average' },
};

export function TrendChart({ days, metric }: { days: AccuracyDay[]; metric: TrendMetric }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const values = days.map((d) => d[metric]);
  const present = values.filter((v): v is number => v !== null);
  const ref0 = REFERENCE[metric];
  const height = 230;
  const m = { top: 14, right: 14, bottom: 28, left: 44 };
  const innerW = Math.max(0, width - m.left - m.right);
  const innerH = height - m.top - m.bottom;
  const domain = niceDomain(metric, ref0 ? [...present, ref0.value] : present.length ? present : [0.5]);
  const y = (v: number) => m.top + innerH - ((v - domain[0]) / (domain[1] - domain[0])) * innerH;
  const step = days.length ? innerW / days.length : 0;
  const x = (i: number) => m.left + (i + 0.5) * step;

  // Break the line where days aren't consecutive, a value is missing, or live/replay changes.
  const segments: { source: AccuracyDay['source']; points: [number, number][] }[] = [];
  days.forEach((d, i) => {
    const v = values[i];
    if (v === null || v === undefined) return;
    const prev = days[i - 1];
    const last = segments.at(-1);
    const joins =
      last && prev && values[i - 1] !== null && prev.source === d.source &&
      Date.parse(d.date) - Date.parse(prev.date) <= DAY_MS;
    if (joins) last.points.push([x(i), y(v)]);
    else segments.push({ source: d.source, points: [[x(i), y(v)]] });
  });
  const labelEvery = Math.max(1, Math.ceil(days.length / Math.max(2, Math.floor(innerW / 70))));
  const sources = new Set(days.map((d) => d.source));
  const hovered = hover === null ? null : days[hover];
  const color = (s: AccuracyDay['source']) => (s === 'live' ? 'var(--ink)' : 'var(--neutral)');

  return (
    <div className="acc-chart" ref={ref}>
      {sources.size > 1 && (
        <div className="legend acc-legend" aria-hidden>
          <span><i className="line-key" style={{ background: 'var(--ink)' }} />Live</span>
          <span><i className="line-key" style={{ background: 'var(--neutral)' }} />Replayed</span>
        </div>
      )}
      {width > 0 && (
        <svg width={width} height={height} role="img" aria-label={`Daily ${metric} trend`} onPointerLeave={() => setHover(null)}>
          {ticksOf(domain).map((t) => (
            <g key={t}>
              <line x1={m.left} x2={width - m.right} y1={y(t)} y2={y(t)} className="grid" />
              <text x={m.left - 8} y={y(t)} className="axis" textAnchor="end" dominantBaseline="middle">
                {fmt(metric, t)}
              </text>
            </g>
          ))}
          {ref0 && (
            <g>
              <line x1={m.left} x2={width - m.right} y1={y(ref0.value)} y2={y(ref0.value)} className="ref" />
              <text x={width - m.right} y={y(ref0.value) - 6} className="axis" textAnchor="end">
                {ref0.label}
              </text>
            </g>
          )}
          {days.map((d, i) =>
            i % labelEvery === 0 || i === days.length - 1 ? (
              <text key={d.date} x={x(i)} y={height - 8} className="axis" textAnchor="middle">
                {d.label}
              </text>
            ) : null,
          )}
          {hovered && <line x1={x(hover!)} x2={x(hover!)} y1={m.top} y2={m.top + innerH} className="crosshair" />}
          {segments.map((s, i) => (
            <polyline
              key={i}
              points={s.points.map((p) => p.join(',')).join(' ')}
              fill="none"
              stroke={color(s.source)}
              strokeWidth={2}
              strokeLinejoin="round"
              strokeLinecap="round"
            />
          ))}
          {days.map((d, i) => {
            const v = values[i];
            if (v === null || v === undefined) return null;
            const big = hover === i || days.length <= 45;
            return big ? (
              <circle key={d.date} cx={x(i)} cy={y(v)} r={hover === i ? 5 : 4} fill={color(d.source)} className="ring" />
            ) : null;
          })}
          {days.map((d, i) => (
            <rect
              key={d.date}
              x={m.left + i * step}
              y={m.top}
              width={step}
              height={innerH}
              fill="transparent"
              onPointerEnter={() => setHover(i)}
            />
          ))}
        </svg>
      )}
      {hovered && (
        <div
          className="tooltip"
          style={{ left: Math.min(Math.max(x(hover!), 90), width - 90), top: 8 }}
          role="status"
        >
          <strong>{hovered[metric] === null ? '–' : fmt(metric, hovered[metric]!)}</strong>
          <span>
            {hovered.label} · {hovered.source === 'live' ? 'live' : 'replayed'}
          </span>
          <span>
            &gt;5 min late: said {pct(hovered.predLate5)}, was {pct(hovered.obsLate5)}
          </span>
          <span>{hovered.n.toLocaleString('en-GB')} predictions</span>
        </div>
      )}
    </div>
  );
}

export function CalibrationChart({ points }: { points: CalibrationPoint[] }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const size = Math.min(width, 380);
  const m = { top: 12, right: 12, bottom: 40, left: 46 };
  const inner = Math.max(0, size - m.left - m.right);
  const maxV = Math.max(0.3, ...points.flatMap((p) => [p.predicted, p.observed]));
  const hi = Math.min(1, Math.ceil((maxV + 0.05) * 10) / 10);
  const sx = (v: number) => m.left + (v / hi) * inner;
  const sy = (v: number) => m.top + inner - (v / hi) * inner;
  const maxN = Math.max(1, ...points.map((p) => p.n));
  const ticks = ticksOf([0, hi]);
  const hovered = hover === null ? null : points[hover];
  const height = m.top + inner + m.bottom;

  return (
    <div className="acc-chart" ref={ref}>
      {size > 0 && (
        <svg width={size} height={height} role="img" aria-label="Predicted versus actual chance of being more than 5 minutes late">
          {ticks.map((t) => (
            <g key={t}>
              <line x1={m.left} x2={m.left + inner} y1={sy(t)} y2={sy(t)} className="grid" />
              <text x={m.left - 8} y={sy(t)} className="axis" textAnchor="end" dominantBaseline="middle">
                {pct(t)}
              </text>
              <text x={sx(t)} y={m.top + inner + 16} className="axis" textAnchor="middle">
                {pct(t)}
              </text>
            </g>
          ))}
          <line x1={sx(0)} y1={sy(0)} x2={sx(hi)} y2={sy(hi)} className="ref" />
          <text
            x={sx(hi * 0.72) + 14}
            y={sy(hi * 0.72) + 14}
            className="axis"
            textAnchor="middle"
            transform={`rotate(-45 ${sx(hi * 0.72) + 14} ${sy(hi * 0.72) + 14})`}
          >
            Perfect calibration
          </text>
          <text x={m.left + inner / 2} y={height - 4} className="axis" textAnchor="middle">
            Predicted chance of &gt;5 min late
          </text>
          {points.map((p, i) => (
            <circle
              key={p.label}
              cx={sx(p.predicted)}
              cy={sy(p.observed)}
              r={4 + 6 * Math.sqrt(p.n / maxN)}
              fill="var(--ink)"
              className="ring"
              tabIndex={0}
              aria-label={`Said ${p.label}: ${pct(p.observed)} were more than 5 minutes late, ${p.n} predictions`}
              onPointerEnter={() => setHover(i)}
              onPointerLeave={() => setHover(null)}
              onFocus={() => setHover(i)}
              onBlur={() => setHover(null)}
            />
          ))}
        </svg>
      )}
      {hovered && (
        <div
          className="tooltip"
          style={{ left: Math.min(Math.max(sx(hovered.predicted), 90), size - 60), top: Math.max(0, sy(hovered.observed) - 96) }}
          role="status"
        >
          <strong>{pct(hovered.observed)} were late</strong>
          <span>We said {hovered.label} (avg {pct(hovered.predicted)})</span>
          <span>{hovered.n.toLocaleString('en-GB')} predictions</span>
        </div>
      )}
    </div>
  );
}

const shortStation = (name: string) => {
  const s = name.replace(/^München[- ]/, '').replace(/\s+Gl\..*$/, '');
  return s.length > 14 ? `${s.slice(0, 13)}…` : s;
};

/**
 * One run, stop by stop: the shaded bar is the "80% chance it's at most this late" limit, the
 * hollow dot the most likely delay we said and the filled dot what happened (green inside the
 * limit, red above it). Cancelled stops are marked with a cross.
 */
export function RunChart({ stops }: { stops: AccuracyRunStop[] }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const height = 240;
  const m = { top: 16, right: 12, bottom: 40, left: 44 };
  const innerW = Math.max(0, width - m.left - m.right);
  const innerH = height - m.top - m.bottom;
  const maxV = Math.max(10, ...stops.flatMap((s) => [s.limit80, s.predicted, s.actual ?? 0]));
  // About five gridlines at round minute steps (5, 10, 20, 30, 60, 120…).
  const tickStep = [5, 10, 20, 30, 60, 120, 240].find((s) => maxV / s <= 5) ?? 480;
  const hi = Math.ceil((maxV + 1) / tickStep) * tickStep;
  const ticks: number[] = [];
  for (let t = 0; t <= hi; t += tickStep) ticks.push(t);
  const y = (v: number) => m.top + innerH - (v / hi) * innerH;
  const step = stops.length ? innerW / stops.length : 0;
  const x = (i: number) => m.left + (i + 0.5) * step;
  const band = Math.min(28, step * 0.5);
  const labelEvery = Math.max(1, Math.ceil(stops.length / Math.max(1, Math.floor(innerW / 90))));
  const hovered = hover === null ? null : stops[hover];

  return (
    <div className="acc-chart" ref={ref}>
      <div className="legend acc-legend" aria-hidden>
        <span><i className="run-key run-key-band" />80% limit</span>
        <span><i className="run-key run-key-said" />Said (likely)</span>
        <span><i className="run-key run-key-was" />Was</span>
      </div>
      {width > 0 && (
        <svg width={width} height={height} role="img" aria-label="Predicted versus actual delay at each stop" onPointerLeave={() => setHover(null)}>
          {ticks.map((t) => (
            <g key={t}>
              <line x1={m.left} x2={width - m.right} y1={y(t)} y2={y(t)} className="grid" />
              <text x={m.left - 8} y={y(t)} className="axis" textAnchor="end" dominantBaseline="middle">
                +{t}
              </text>
            </g>
          ))}
          {stops.map((s, i) => (
            <g key={`${s.eva}-${s.event}-${i}`}>
              {i % labelEvery === 0 && (
                <>
                  <text x={x(i)} y={height - 22} className="axis" textAnchor="middle">
                    {shortStation(s.station)}
                  </text>
                  <text x={x(i)} y={height - 8} className="axis" textAnchor="middle">
                    {s.time} {s.event}
                  </text>
                </>
              )}
              {hover === i && <line x1={x(i)} x2={x(i)} y1={m.top} y2={m.top + innerH} className="crosshair" />}
              <rect x={x(i) - band / 2} y={y(s.limit80)} width={band} height={y(0) - y(s.limit80)} rx={3} className="run-band" />
              {s.cancelled ? (
                <text x={x(i)} y={y(0) - 10} className="run-cancel" textAnchor="middle" dominantBaseline="middle">
                  ✕
                </text>
              ) : (
                <>
                  <line x1={x(i)} x2={x(i)} y1={y(s.predicted)} y2={y(s.actual!)} className="run-gap" />
                  <circle cx={x(i)} cy={y(s.predicted)} r={5} className="run-said" />
                  <circle cx={x(i)} cy={y(s.actual!)} r={5} fill={s.within80 ? 'var(--good)' : 'var(--bad)'} className="ring" />
                </>
              )}
              <rect
                x={m.left + i * step}
                y={m.top}
                width={step}
                height={innerH}
                fill="transparent"
                tabIndex={0}
                aria-label={`${s.station} ${s.event} ${s.time}: said +${s.predicted}, 80% limit +${s.limit80}, ${
                  s.cancelled ? 'cancelled' : `was +${s.actual}`
                }`}
                onPointerEnter={() => setHover(i)}
                onFocus={() => setHover(i)}
                onBlur={() => setHover(null)}
              />
            </g>
          ))}
        </svg>
      )}
      {hovered && (
        <div className="tooltip" style={{ left: Math.min(Math.max(x(hover!), 110), width - 110), top: 8 }} role="status">
          <strong>{hovered.cancelled ? 'Cancelled' : `Was +${hovered.actual}`}</strong>
          <span>
            {hovered.station} · {hovered.event} {hovered.time}
          </span>
          <span>
            Said likely +{hovered.predicted}, 80% ≤ +{hovered.limit80}
          </span>
          <span>
            {pct(hovered.late5)} risk of &gt;5 min · {pct(hovered.cancelRisk)} cancellation · {hovered.lead}
          </span>
        </div>
      )}
    </div>
  );
}
