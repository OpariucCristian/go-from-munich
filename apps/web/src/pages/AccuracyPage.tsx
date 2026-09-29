/**
 * How good are the forecasts? Predictions are frozen before each train runs and scored against
 * the real delay the morning after (replayed days fill in history before live tracking began).
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router';
import type {
  AccuracyBreakdownRow,
  AccuracyMiss,
  AccuracyRunRow,
  AccuracyRunSort,
  AccuracySource,
  AccuracyView,
} from '../../../bff/src/contract.ts';
import { useAccuracy, useAccuracyRun, useAccuracyRuns } from '../api.ts';
import { CalibrationChart, RunChart, TrendChart, type TrendMetric } from '../components/AccuracyCharts.tsx';
import { Chips, Empty, ErrorNote, Segmented, Skeleton, pct } from '../components/ui.tsx';

/** A run key from the BFF: `<date>.<tripId>.<source>`. */
const RUN = /^\d{4}-\d{2}-\d{2}\.\d{1,18}\.(live|replay|near)$/;

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
  const run = RUN.test(params.get('run') ?? '') ? params.get('run') : null;
  const set = (key: string, value: string | null) =>
    setParams((p) => {
      if (value === null) p.delete(key);
      else p.set(key, value);
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
      {a && !a.empty && (
        <Report a={a} runs={<RunsCard days={days} source={source} run={run} onRun={(r) => set('run', r)} />} onRun={(r) => set('run', r)} />
      )}
    </section>
  );
}

function Report({ a, runs, onRun }: { a: AccuracyView; runs: ReactNode; onRun: (run: string) => void }) {
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

      {runs}

      {a.misses.length > 0 && (
        <div className="card">
          <div>
            <div className="card-title">Biggest misses</div>
            <div className="muted acc-sub">Trains that ran much later than we forecast. Cancellations are counted in the scores but not listed here.</div>
          </div>
          <div className="acc-misses">
            {a.misses.map((m) => (
              <MissRow key={`${m.date}-${m.train}-${m.eva}-${m.event}`} m={m} onRun={onRun} />
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

const trainHref = (train: string, date: string, eva?: string) =>
  `/?${new URLSearchParams({ mode: 'train', train, date, ...(eva ? { tf: eva } : {}) })}`;

function MissRow({ m, onRun }: { m: AccuracyMiss; onRun: (run: string) => void }) {
  return (
    <div className="acc-miss-row">
      <Link className="acc-miss" to={trainHref(m.train, m.date, m.eva)}>
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
      <button type="button" className="chip acc-miss-run" onClick={() => onRun(m.run)} title="Predicted vs actual at every stop of this run">
        Whole run
      </button>
    </div>
  );
}

const RUN_SORTS: { value: AccuracyRunSort; label: string }[] = [
  { value: 'miss', label: 'Biggest miss' },
  { value: 'recent', label: 'Most recent' },
];

const minutes = (x: number | null) => (x === null ? '–' : `+${x.toFixed(1)}`);

/** Train by train: each scored run's average predicted vs actual delay, with a stop-by-stop drill-down. */
function RunsCard(props: { days: string; source: AccuracySource; run: string | null; onRun: (run: string | null) => void }) {
  const [sort, setSort] = useState<AccuracyRunSort>('miss');
  const [text, setText] = useState('');
  const [train, setTrain] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setTrain(text.trim()), 300);
    return () => clearTimeout(t);
  }, [text]);
  const q = useAccuracyRuns(props.days, props.source, sort, train);
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (props.run) panel.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [props.run]);

  return (
    <div className="card" ref={panel}>
      <div className="card-head">
        <div>
          <div className="card-title">Train by train</div>
          <div className="muted acc-sub">
            Each run is one train on one day. We compare the most likely delay we showed with the real delay, averaged over
            the stops we scored. Pick a run to see every stop.
          </div>
        </div>
        <div className="acc-run-controls">
          <label className="field acc-run-filter">
            <span className="field-label">Train</span>
            <input value={text} onChange={(e) => setText(e.target.value)} placeholder="RE 4012" autoCapitalize="characters" />
          </label>
          <Chips label="Sort runs" value={sort} onChange={setSort} options={RUN_SORTS} />
        </div>
      </div>
      {props.run && <RunDetail run={props.run} onClose={() => props.onRun(null)} />}
      {q.error && <ErrorNote error={q.error} />}
      {q.isPending && <Skeleton height={240} />}
      {q.data && !q.data.runs.length && <div className="muted">No scored runs{train ? ` match “${train}”` : ''}.</div>}
      {q.data && q.data.runs.length > 0 && (
        <div className="acc-scroll acc-run-list">
          <table className="acc-table acc-run-table">
            <thead>
              <tr>
                <th>Train</th>
                <th>Day</th>
                <th>Stops</th>
                <th>Said</th>
                <th>Was</th>
                <th>Typical miss</th>
                <th>80% limit kept</th>
              </tr>
            </thead>
            <tbody>
              {q.data.runs.map((r) => (
                <RunTableRow key={r.run} r={r} selected={r.run === props.run} onSelect={() => props.onRun(r.run === props.run ? null : r.run)} />
              ))}
            </tbody>
          </table>
          {q.data.total > q.data.runs.length && (
            <div className="muted acc-run-more">
              Showing {q.data.runs.length} of {q.data.total.toLocaleString('en-GB')} runs. Filter by train to find others.
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function RunTableRow({ r, selected, onSelect }: { r: AccuracyRunRow; selected: boolean; onSelect: () => void }) {
  return (
    <tr className={selected ? 'acc-run-row selected' : 'acc-run-row'} onClick={onSelect}>
      <td>
        <button type="button" className="acc-run-open" aria-pressed={selected} onClick={(e) => (e.stopPropagation(), onSelect())}>
          <span className="train-tag">{r.train}</span>
        </button>
      </td>
      <td>
        {r.dateLabel} <span className="muted">{r.time}</span>
        {r.source === 'replay' && <span className="muted"> · replayed</span>}
      </td>
      <td>
        {r.stops}
        {r.cancelled > 0 && <span className="tone-bad"> ({r.cancelled} ✕)</span>}
      </td>
      <td>{minutes(r.predicted)}</td>
      <td>{minutes(r.actual)}</td>
      <td className={r.tone === 'neutral' ? '' : `tone-${r.tone}`}>{r.maeMin === null ? '–' : `${r.maeMin.toFixed(1)} min`}</td>
      <td>{r.within80 === null ? '–' : pct(r.within80)}</td>
    </tr>
  );
}

function RunDetail({ run, onClose }: { run: string; onClose: () => void }) {
  const q = useAccuracyRun(run);
  const v = q.data;
  return (
    <div className="acc-run-detail" aria-live="polite">
      <div className="card-head">
        <div className="acc-run-title">
          {v ? (
            <>
              <span className="train-tag">{v.run.train}</span>
              <strong>{v.run.dateLabel}</strong>
              {v.run.source === 'replay' && <span className="muted">replayed</span>}
              <span className="muted">· model {v.model}</span>
            </>
          ) : (
            <strong>Loading run…</strong>
          )}
        </div>
        <div className="acc-run-actions">
          {v && (
            <Link to={trainHref(v.run.train, v.run.date)} className="chip">
              Open train
            </Link>
          )}
          <button type="button" className="chip" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
      {q.error && <ErrorNote error={q.error} />}
      {q.isPending && <Skeleton height={240} />}
      {v && (
        <>
          {v.summary && <div className="acc-sub">{v.summary}</div>}
          <RunChart stops={v.stops} />
          <details className="acc-table-toggle">
            <summary>Stop by stop</summary>
            <div className="acc-scroll">
              <table className="acc-table">
                <thead>
                  <tr>
                    <th>Stop</th>
                    <th>Planned</th>
                    <th>Said (likely)</th>
                    <th>80% limit</th>
                    <th>&gt;5 min risk</th>
                    <th>Was</th>
                    <th>Forecast made</th>
                  </tr>
                </thead>
                <tbody>
                  {v.stops.map((s, i) => (
                    <tr key={`${s.eva}-${s.event}-${i}`}>
                      <td>{s.station}</td>
                      <td>
                        {s.event} {s.time}
                      </td>
                      <td>+{s.predicted}</td>
                      <td>+{s.limit80}</td>
                      <td>{pct(s.late5)}</td>
                      <td className={s.cancelled || s.within80 === false ? 'tone-bad' : 'tone-good'}>
                        {s.cancelled ? 'Cancelled' : `+${s.actual}`}
                      </td>
                      <td className="muted">{s.lead}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
        </>
      )}
    </div>
  );
}
