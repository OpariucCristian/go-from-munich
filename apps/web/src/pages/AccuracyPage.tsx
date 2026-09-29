/**
 * How good are the forecasts? Predictions are frozen before each train runs and scored against
 * the real delay the morning after (replayed days fill in history before live tracking began).
 */
import { useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import type { AccuracyBreakdownRow, AccuracyMiss, AccuracySource, AccuracyView } from '../../../bff/src/contract.ts';
import { useAccuracy } from '../api.ts';
import { CalibrationChart, TrendChart, type TrendMetric } from '../components/AccuracyCharts.tsx';
import { Chips, Empty, ErrorNote, Segmented, Skeleton, pct } from '../components/ui.tsx';

const WINDOWS = [
  { value: '7', label: '7 days' },
  { value: '30', label: '30 days' },
  { value: '90', label: '90 days' },
];
const SOURCES: { value: AccuracySource; label: string }[] = [
  { value: 'all', label: 'Live + replayed' },
  { value: 'live', label: 'Live only' },
  { value: 'near', label: 'Shortly before' },
];
const METRICS: { value: TrendMetric; label: string; title: string }[] = [
  { value: 'green', label: 'Green calls', title: 'Share of low-risk (green) calls where the train was at most 5 min late' },
  { value: 'within80', label: '80% limit', title: 'How often trains were at most as late as our "80% chance" limit (should be 80%)' },
  { value: 'skill', label: 'Vs. average', title: 'How much smaller our error was than one delay spread for every train' },
];

const signedPct = (x: number | null) => (x === null ? '–' : `${x >= 0 ? '+' : '−'}${Math.abs(Math.round(x * 100))}%`);

export function AccuracyPage() {
  const [params, setParams] = useSearchParams();
  const days = WINDOWS.some((w) => w.value === params.get('days')) ? params.get('days')! : '30';
  const source: AccuracySource = SOURCES.find((s) => s.value === params.get('source'))?.value ?? 'all';
  const set = (key: string, value: string) =>
    setParams((p) => {
      p.set(key, value);
      return p;
    }, { replace: true });
  const q = useAccuracy(days, source);
  const a = q.data;

  return (
    <section className="page" aria-label="Accuracy">
      <div className="page-head">
        <div>
          <h1 className="page-title">How accurate are we?</h1>
          <div className="muted">
            Every forecast is saved before the train runs and checked against the real delay the next morning
            {a?.rangeLabel ? ` · ${a.rangeLabel} · ${a.predictions.toLocaleString('en-GB')} predictions` : ''}
          </div>
        </div>
        <div className="filters">
          <Chips label="Window" value={days} onChange={(v) => set('days', v)} options={WINDOWS} />
          <Chips label="Source" value={source} onChange={(v) => set('source', v)} options={SOURCES} />
        </div>
      </div>
      {q.error && <ErrorNote error={q.error} />}
      {q.isPending && <Skeleton height={520} />}
      {a && a.empty && (
        <Empty title={source === 'all' ? 'No scores yet' : source === 'near' ? 'No "shortly before" scores yet' : 'No live scores yet'}>
          <p className="muted">{a.liveStatus}</p>
        </Empty>
      )}
      {a && !a.empty && <Report a={a} />}
    </section>
  );
}

function Report({ a }: { a: AccuracyView }) {
  const [metric, setMetric] = useState<TrendMetric>('green');
  const current = METRICS.find((m) => m.value === metric)!;
  return (
    <>
      <div className="notice">{a.liveStatus}</div>
      <div className="acc-stats">
        {a.stats.map((s) => (
          <div className="stat-card" key={s.key}>
            <div className="muted acc-stat-label">{s.label}</div>
            <div className={`v${s.tone === 'neutral' ? '' : ` tone-${s.tone}`}`}>{s.value}</div>
            <div className="acc-stat-detail">{s.detail}</div>
          </div>
        ))}
      </div>

      <div className="acc-grid">
        <div className="card">
          <div className="card-head">
            <div>
              <div className="card-title">Day by day</div>
              <div className="muted acc-sub">{current.title}</div>
            </div>
            <Segmented inline label="Metric" value={metric} onChange={setMetric} options={METRICS} />
          </div>
          <TrendChart days={a.trend} metric={metric} />
          <details className="acc-table-toggle">
            <summary>Daily numbers</summary>
            <div className="acc-scroll">
              <table className="acc-table">
                <thead>
                  <tr>
                    <th>Day</th>
                    <th>Predictions</th>
                    <th>Green calls</th>
                    <th>80% limit kept</th>
                    <th>Vs. average</th>
                    <th>&gt;5 min late (said / was)</th>
                  </tr>
                </thead>
                <tbody>
                  {a.trend.map((d) => (
                    <tr key={d.date}>
                      <td>
                        {d.label}
                        {d.source === 'replay' && <span className="muted"> · replayed</span>}
                      </td>
                      <td>{d.n.toLocaleString('en-GB')}</td>
                      <td>{d.green === null ? '–' : pct(d.green)}</td>
                      <td>{d.within80 === null ? '–' : pct(d.within80)}</td>
                      <td>{signedPct(d.skill)}</td>
                      <td>
                        {pct(d.predLate5)} / {pct(d.obsLate5)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
        </div>
        <div className="card">
          <div>
            <div className="card-title">Do the percentages mean what they say?</div>
            <div className="muted acc-sub">
              Actual share of trains more than 5 min late, for each level of predicted risk. Dots on the line are right;
              above it we were too optimistic. Bigger dots stand for more predictions.
            </div>
          </div>
          {a.calibration.length ? <CalibrationChart points={a.calibration} /> : <div className="muted">Not enough predictions yet.</div>}
        </div>
      </div>

      <div className="card">
        <div className="card-title">Where the model does well, and where it doesn't</div>
        <div className="acc-breakdown">
          {a.breakdown.map((g) => (
            <BreakdownTable key={g.title} title={g.title} rows={g.rows} />
          ))}
        </div>
      </div>

      {a.misses.length > 0 && (
        <div className="card">
          <div>
            <div className="card-title">Biggest misses</div>
            <div className="muted acc-sub">Trains that ran much later than we forecast. Cancellations are counted in the scores but not listed here.</div>
          </div>
          <div className="acc-misses">
            {a.misses.map((m) => (
              <MissRow key={`${m.date}-${m.train}-${m.eva}-${m.event}`} m={m} />
            ))}
          </div>
        </div>
      )}
      <div className="muted acc-foot">
        Model {a.models}. {a.note ?? ''} Stops count only at stations the live poller watches, and only trains that really ran
        or were cancelled are scored.
      </div>
    </>
  );
}

function BreakdownTable({ title, rows }: { title: string; rows: AccuracyBreakdownRow[] }) {
  return (
    <div className="acc-scroll">
      <table className="acc-table">
        <caption>{title}</caption>
        <thead>
          <tr>
            <th />
            <th>Predictions</th>
            <th>Vs. average</th>
            <th>80% limit kept</th>
            <th>Typical miss</th>
            <th>&gt;5 late said / was</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.label}>
              <th scope="row">{r.label}</th>
              <td>{r.n.toLocaleString('en-GB')}</td>
              <td>{signedPct(r.skill)}</td>
              <td>{r.within80 === null ? '–' : pct(r.within80)}</td>
              <td>{r.maeMin === null ? '–' : `${r.maeMin.toFixed(1)} min`}</td>
              <td>
                {pct(r.predLate5)} / {pct(r.obsLate5)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function MissRow({ m }: { m: AccuracyMiss }) {
  const href = `/?${new URLSearchParams({ mode: 'train', train: m.train, date: m.date, tf: m.eva })}`;
  return (
    <Link className="acc-miss" to={href}>
      <span className="train-tag">{m.train}</span>
      <span className="acc-miss-where">
        <strong>{m.station}</strong>
        <span className="muted">
          {m.dateLabel} · {m.event} {m.time}
          {m.source === 'replay' ? ' · replayed' : ''}
        </span>
      </span>
      <span className="acc-miss-said muted">Said: {m.predicted}</span>
      <span className="acc-miss-was">{m.actual}</span>
    </Link>
  );
}
