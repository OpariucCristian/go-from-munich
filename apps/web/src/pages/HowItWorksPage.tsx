/**
 * How a forecast is made: the pipeline, one forecast followed step by step, connection risk and
 * the gate a new model must pass. The worked example uses illustrative counts but the real maths:
 * bucket and connection-risk functions come straight from @gfm/core, and the smoothing and
 * stacking steps mirror @gfm/model (baseline.ts, nowcast.ts, onnx.ts).
 */
import { useState, type ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router';
import {
  BUCKET_LABELS,
  connectionFailureProbability,
  delaySummary,
  normalize,
  type Distribution,
} from '../../../../packages/core/src/buckets.ts';
import { useWidth } from '../components/AccuracyCharts.tsx';
import { BUCKET_COLORS, pct } from '../components/ui.tsx';

const MIN_TRANSFER_MIN = 6; // munich.minTransferMin

/** dirichletStep in packages/model/src/baseline.ts: the group's weights plus `alpha` pseudo-observations of its parent. */
const smooth = (parent: Distribution, weights: number[], alpha: number) =>
  normalize(weights.map((w, i) => w + alpha * parent[i]!));

/** stackLogitOffset in packages/model/src/onnx.ts: softmax(log reference + tree scores). */
function nudge(ref: Distribution, scores: number[], floor = 1e-6): Distribution {
  const floored = ref.map((p) => Math.max(p, floor));
  const total = floored.reduce((a, b) => a + b, 0);
  const z = floored.map((p, k) => Math.log(p / total) + scores[k]!);
  const top = Math.max(...z);
  return normalize(z.map((v) => Math.exp(v - top)));
}

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const fmt = (x: number) => Math.round(x).toLocaleString('en-GB');
const p2 = (x: number) => x.toFixed(2);

// ---------- the worked example (illustrative counts, real formulas) ----------

const BASE_ALPHA = 8; // DEFAULT_ALPHA
const NOWCAST_ALPHA = 32; // DEFAULT_NOWCAST.alpha

interface Table {
  name: string;
  key: string;
  weights: number[];
}

/** Recency-weighted arrival counts per bucket, general to specific (levels 6 → 1 in groups.ts). */
const LEVELS: Table[] = [
  { name: 'Every train', key: 'level 6 · *', weights: [720000, 110000, 70000, 35000, 30000, 12000, 5000, 30000] },
  { name: 'Every ICE', key: 'level 5 · ICE', weights: [52000, 13000, 10000, 6000, 6500, 3000, 1300, 3200] },
  { name: 'ICEs at München Hbf', key: 'level 4 · Hbf | ICE', weights: [6100, 1500, 1250, 700, 800, 380, 150, 300] },
  { name: '…on weekday evenings', key: 'level 3 · Hbf | ICE | wd | pm', weights: [900, 260, 230, 140, 160, 80, 30, 50] },
  { name: 'ICE 514 at München Hbf', key: 'level 2 · Hbf | 514', weights: [140, 40, 30, 18, 16, 8, 3, 5] },
  { name: '…on weekday evenings', key: 'level 1 · Hbf | 514 | wd | pm', weights: [9, 4, 3, 2, 1, 0, 0, 0] },
];

/** What happened next, historically, after a train was seen 6–10 min late 30–60 min earlier. */
const NOWCAST: Table[] = [
  { name: 'Any train', key: '6–10 | 30–60', weights: [3000, 4200, 5200, 2600, 1500, 400, 100, 150] },
  { name: 'ICEs', key: 'ICE | 6–10 | 30–60', weights: [400, 600, 800, 420, 260, 70, 20, 25] },
  { name: 'ICEs arriving at Hbf', key: 'Hbf | ICE | 6–10 | 30–60', weights: [30, 45, 70, 35, 20, 6, 2, 2] },
];

/** Raw tree scores for one row; 0 leaves a bucket unchanged. */
const TREE_SCORES = [-0.12, 0.06, 0.14, 0.05, -0.04, -0.06, 0, -0.2];

/** The next train at the transfer: a regional departure from Hbf. */
const DEPARTURE: Distribution = normalize([0.86, 0.07, 0.03, 0.012, 0.006, 0.003, 0.002, 0.017]);

interface Step {
  short: string;
  eyebrow: string;
  title: string;
  text: ReactNode;
  dist: Distribution;
  prev: Distribution | null;
  detail?: ReactNode;
}

function buildSteps() {
  const uniform: Distribution = new Array(8).fill(1 / 8);
  const steps: Step[] = [
    {
      short: 'The question',
      eyebrow: 'Start',
      title: 'ICE 514, arriving München Hbf, Tuesday 17:42',
      text: (
        <>
          The app sends the API one query per stop: station, train, arrival or departure, and planned time. Before
          looking at any data, every outcome is equally likely: one eighth each.
        </>
      ),
      dist: uniform,
      prev: null,
      detail: (
        <pre className="how-code">{`{ eva: '8000261',      // München Hbf
  trainType: 'ICE', trainNumber: '514',
  event: 'a',           // arrival
  planned: 2026-10-06T17:42 }`}</pre>
      ),
    },
  ];

  let p = uniform;
  LEVELS.forEach((l, i) => {
    const next = smooth(p, l.weights, BASE_ALPHA);
    const n = sum(l.weights);
    steps.push({
      short: l.name,
      eyebrow: `History · ${l.key.split(' · ')[0]}`,
      title: l.name,
      text:
        i === 0 ? (
          <>
            Every night the delays of the past year are counted per bucket, with recent days weighted more (a delay&apos;s
            weight halves every 60 days). The lookup starts with the broadest group. With {fmt(n)} observations, the data
            completely outweighs the starting guess.
          </>
        ) : i === LEVELS.length - 1 ? (
          <>
            The most specific group has only {fmt(n)} observations, so it can&apos;t be trusted on its own. The previous
            result counts as {BASE_ALPHA} extra &ldquo;virtual&rdquo; observations, and the two are blended. Few data
            points nudge the answer; many would take it over.
          </>
        ) : (
          <>
            Each narrower group is blended with the result so far: its own counts plus {BASE_ALPHA} virtual observations
            of the broader answer. With {fmt(n)} observations, this group mostly speaks for itself.
          </>
        ),
      dist: next,
      prev: p,
      detail: <Blend parent={p} weights={l.weights} alpha={BASE_ALPHA} result={next} tableKey={l.key} />,
    });
    p = next;
  });

  const baseline = p;
  let nc = baseline;
  for (const t of NOWCAST) nc = smooth(nc, t.weights, NOWCAST_ALPHA);
  steps.push({
    short: 'Live sighting',
    eyebrow: 'Nowcast',
    title: 'Seen 8 min late at Augsburg, 40 min earlier',
    text: (
      <>
        The poller watches the train all day. History says what usually happens next after a train is seen that late
        that long before, first for any train, then ICEs, then ICEs at this station. It&apos;s blended the same way, but
        the forecast so far only counts as {NOWCAST_ALPHA} virtual observations, so a fresh sighting moves it a lot.
      </>
    ),
    dist: nc,
    prev: baseline,
    detail: (
      <div className="how-tables">
        {NOWCAST.map((t) => (
          <div key={t.key} className="how-table-row">
            <span>{t.name}</span>
            <span className="mono muted">{t.key}</span>
            <span className="mono">n = {fmt(sum(t.weights))}</span>
          </div>
        ))}
      </div>
    ),
  });

  const final = nudge(nc, TREE_SCORES);
  steps.push({
    short: 'Model correction',
    eyebrow: 'LightGBM',
    title: 'A learned correction on top',
    text: (
      <>
        A gradient-boosted tree model looks at what the tables can&apos;t: the probabilities so far, how much data they
        rest on, the hour and weekday, holidays, the stop&apos;s place on the route and the sighting. It returns one score
        per bucket. Each probability is multiplied by <span className="mono">e^score</span>, then everything is rescaled
        to 100%. A score of 0 changes nothing, so the model can only adjust the forecast, never replace it.
      </>
    ),
    dist: final,
    prev: nc,
    detail: (
      <div className="how-blend">
        <span className="muted how-key">Tree scores for this stop, per bucket (made up)</span>
        <Scores scores={TREE_SCORES} />
      </div>
    ),
  });

  const s = delaySummary(final);
  steps.push({
    short: 'The forecast',
    eyebrow: 'Result',
    title: 'What the app shows',
    text: (
      <>
        The eight probabilities are the forecast. Spreading each bucket evenly over its minutes gives the figures on the
        Estimate screen.
      </>
    ),
    dist: final,
    prev: null,
    detail: (
      <dl className="how-stats">
        <div>
          <dt>At most 5 min late</dt>
          <dd>{pct(final[0]! + final[1]!)}</dd>
        </div>
        <div>
          <dt>80% chance within</dt>
          <dd>{s.p80} min</dd>
        </div>
        <div>
          <dt>Expected delay</dt>
          <dd>{s.expected} min</dd>
        </div>
        <div>
          <dt>Cancelled</dt>
          <dd>{pct(final[7]!)}</dd>
        </div>
      </dl>
    ),
  });
  return { steps, final };
}

// ---------- small pieces ----------

function Blend(props: { parent: Distribution; weights: number[]; alpha: number; result: Distribution; tableKey: string }) {
  const n = sum(props.weights);
  const trust = n / (n + props.alpha);
  return (
    <div className="how-blend">
      <div className="how-trust" role="img" aria-label={`${pct(trust)} from this group's data, ${pct(1 - trust)} from the broader answer`}>
        <div style={{ width: `${trust * 100}%`, background: 'var(--ink)' }} />
        <div style={{ width: `${(1 - trust) * 100}%`, background: 'var(--rail)' }} />
      </div>
      <div className="how-trust-legend">
        <span>
          <i className="swatch" style={{ background: 'var(--ink)' }} />
          This group&apos;s data {trust > 0.995 ? '>99%' : pct(trust)}
        </span>
        <span>
          <i className="swatch" style={{ background: 'var(--rail)' }} />
          Broader answer {trust > 0.995 ? '<1%' : pct(1 - trust)}
        </span>
      </div>
      <div className="how-formula mono">
        P(≤2) = ({fmt(props.weights[0]!)} + {props.alpha} × {p2(props.parent[0]!)}) / ({fmt(n)} + {props.alpha}) ={' '}
        <b>{p2(props.result[0]!)}</b>
      </div>
      <div className="mono muted how-key">{props.tableKey}</div>
    </div>
  );
}

function Scores({ scores }: { scores: number[] }) {
  const max = Math.max(...scores.map(Math.abs));
  return (
    <div className="how-scores" role="img" aria-label={`Tree scores: ${scores.map((s, i) => `${BUCKET_LABELS[i]} ${s}`).join(', ')}`}>
      {scores.map((s, i) => (
        <div className="how-score" key={i}>
          <div className="how-score-well">
            <div
              className="how-score-bar"
              style={{
                height: `${(Math.abs(s) / max) * 50}%`,
                [s >= 0 ? 'bottom' : 'top']: '50%',
                background: s >= 0 ? 'var(--ink)' : 'var(--rail)',
              }}
            />
          </div>
          <div className="mono how-score-v">{s > 0 ? `+${s}` : s === 0 ? '0' : `−${Math.abs(s)}`}</div>
        </div>
      ))}
    </div>
  );
}

/** Bucket bars with a dashed marker where the previous step stood. */
function Bars({ dist, prev }: { dist: Distribution; prev: Distribution | null }) {
  const max = Math.max(0.5, ...dist, ...(prev ?? []));
  return (
    <div
      className="chart how-chart"
      role="img"
      aria-label={`Chance of each delay range: ${dist.map((p, i) => `${BUCKET_LABELS[i]}: ${pct(p)}`).join(', ')}`}
    >
      {dist.map((p, i) => (
        <div className="chart-col" key={i}>
          <div className="chart-pct">{pct(p)}</div>
          <div className="chart-well how-well">
            <div className="chart-bar" style={{ height: `${(p / max) * 100}%`, background: BUCKET_COLORS[i] }} />
            {prev && <div className="how-ghost" style={{ bottom: `${(prev[i]! / max) * 100}%` }} />}
          </div>
          <div className="chart-label">{i === 7 ? 'canc.' : BUCKET_LABELS[i]}</div>
        </div>
      ))}
    </div>
  );
}

// ---------- sections ----------

function Pipeline() {
  const ahead = [
    ['Collect', 'DB open data, imported monthly from 2024-07, plus the live Timetables API, polled all day.'],
    ['Count', 'Nightly: delay buckets per train, station, weekday and hour, at six levels of detail.'],
    ['Count what follows', 'Nightly: what happened at later stops after a train was seen running late.'],
    ['Train', 'Node exports features, Python fits LightGBM, the model is saved as ONNX.'],
    ['Gate', 'The new model goes live only if it beats what is served now on unseen weeks.'],
  ];
  const request = [
    ['Your trip', 'Each leg becomes a departure and an arrival query.'],
    ['History', 'Blend the counts, broad to specific.'],
    ['Live sighting', 'If the train is already running, shift by what usually follows.'],
    ['Correction', 'LightGBM nudges the probabilities.'],
    ['Answer', 'Forecast per stop, connection risk, chance the whole trip works.'],
  ];
  return (
    <div className="how-lanes">
      {[
        { title: 'Ahead of time', note: 'Postgres holds every stop event; jobs run in the worker.', items: ahead },
        { title: 'On every request', note: 'In the API, in tens of milliseconds.', items: request },
      ].map((lane) => (
        <div className="how-lane" key={lane.title}>
          <div className="how-lane-head">
            <span className="eyebrow">{lane.title}</span>
            <span className="muted">{lane.note}</span>
          </div>
          <ol className="how-flow">
            {lane.items.map(([t, d], i) => (
              <li key={t} className="how-node">
                <span className="mono how-node-n">{String(i + 1).padStart(2, '0')}</span>
                <strong>{t}</strong>
                <span>{d}</span>
              </li>
            ))}
          </ol>
        </div>
      ))}
    </div>
  );
}

function Walkthrough({ steps }: { steps: Step[] }) {
  const [params, setParams] = useSearchParams();
  const n = Number(params.get('step'));
  const i = Number.isInteger(n) && n >= 1 && n <= steps.length ? n - 1 : 0;
  const setI = (k: number) => setParams(k ? { step: String(k + 1) } : {}, { replace: true, preventScrollReset: true });
  const s = steps[i]!;
  return (
    <div className="how-walk">
      <ol className="how-rail" aria-label="Steps">
        {steps.map((st, k) => (
          <li key={k}>
            <button type="button" aria-current={k === i} onClick={() => setI(k)} className={k < i ? 'done' : undefined}>
              <span className="how-rail-dot" />
              <span className="how-rail-label">
                <span className="eyebrow">{st.eyebrow}</span>
                <span>{st.short}</span>
              </span>
            </button>
          </li>
        ))}
      </ol>
      <div className="card how-panel" aria-live="polite">
        <div className="card-head">
          <span className="eyebrow">
            Step {i + 1} of {steps.length} · {s.eyebrow}
          </span>
          <div className="how-nav">
            <button type="button" className="btn btn-ghost" disabled={i === 0} onClick={() => setI(i - 1)} aria-label="Previous step">
              ←
            </button>
            <button type="button" className="btn" disabled={i === steps.length - 1} onClick={() => setI(i + 1)} aria-label="Next step">
              →
            </button>
          </div>
        </div>
        <h3 className="how-step-title">{s.title}</h3>
        <p className="how-text">{s.text}</p>
        <Bars dist={s.dist} prev={s.prev} />
        <div className="chart-foot">
          <span>Chance of each delay, in minutes</span>
          {s.prev && (
            <span>
              <i className="how-ghost-key" /> previous step
            </span>
          )}
        </div>
        {s.detail}
      </div>
    </div>
  );
}

function ConnectionRisk({ arrival }: { arrival: Distribution }) {
  const [planned, setPlanned] = useState(15);
  const risk = (m: number) => connectionFailureProbability(arrival, DEPARTURE, m - MIN_TRANSFER_MIN);
  const r = risk(planned);
  const total = Math.min(1, r.total);
  const [ref, width] = useWidth<HTMLDivElement>();
  const xs = Array.from({ length: 31 }, (_, m) => m + 2);
  const W = width || 600;
  const H = 200;
  const pad = { l: 40, r: 12, t: 12, b: 28 };
  const x = (m: number) => pad.l + ((m - 2) / 30) * (W - pad.l - pad.r);
  const yMax = Math.min(1, Math.max(...xs.map((m) => Math.min(1, risk(m).total))) * 1.1);
  const y = (v: number) => pad.t + (1 - v / yMax) * (H - pad.t - pad.b);
  const line = xs.map((m, k) => `${k ? 'L' : 'M'}${x(m).toFixed(1)},${y(Math.min(1, risk(m).total)).toFixed(1)}`).join(' ');
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => f * yMax);
  const tone = total < 0.1 ? 'good' : total < 0.25 ? 'warn' : 'bad';
  return (
    <div className="how-conn">
      <div className="how-conn-controls">
        <label className="field">
          <span className="field-label">Planned transfer at München Hbf</span>
          <input
            type="range"
            min={2}
            max={32}
            value={planned}
            onChange={(e) => setPlanned(+e.target.value)}
            aria-valuetext={`${planned} minutes`}
          />
          <span className="mono how-conn-min">{planned} min</span>
        </label>
        <div className="stat-card">
          <div className="muted" style={{ fontSize: 13 }}>Chance of missing the connection</div>
          <div className={`v tone-${tone}`}>{pct(total)}</div>
          <div className="muted" style={{ fontSize: 13 }}>
            {pct(r.byDelay)} from delays · {pct(r.byCancellation)} from a cancellation
          </div>
        </div>
        <p className="how-text muted">
          The arriving ICE&apos;s forecast from above and a typical regional departure are each spread evenly over whole
          minutes. Every pair of (arrival delay, departure delay) where the arrival eats more than the slack, i.e. the
          planned transfer minus {MIN_TRANSFER_MIN} min to change platforms, counts as a miss. Then either train being
          cancelled is added. A trip&apos;s chance of working is the product over all its transfers.
        </p>
      </div>
      <div className="acc-chart" ref={ref}>
        <svg width={W} height={H} role="img" aria-label={`Risk falls from ${pct(Math.min(1, risk(2).total))} at 2 minutes to ${pct(Math.min(1, risk(32).total))} at 32 minutes`}>
          {ticks.map((t) => (
            <g key={t}>
              <line className="grid" x1={pad.l} x2={W - pad.r} y1={y(t)} y2={y(t)} />
              <text className="axis" x={pad.l - 6} y={y(t) + 4} textAnchor="end">
                {pct(t)}
              </text>
            </g>
          ))}
          {(W < 480 ? [2, 6, 10, 20, 30] : [2, 6, 10, 15, 20, 25, 30]).map((m) => (
            <text key={m} className="axis" x={x(m)} y={H - 8} textAnchor="middle">
              {m} min
            </text>
          ))}
          <rect x={pad.l} y={pad.t} width={x(MIN_TRANSFER_MIN) - pad.l} height={H - pad.t - pad.b} fill="var(--track)" />
          <path d={line} fill="none" stroke="var(--ink)" strokeWidth={2} />
          <line className="crosshair" x1={x(planned)} x2={x(planned)} y1={pad.t} y2={H - pad.b} />
          <circle className="ring" cx={x(planned)} cy={y(total)} r={6} fill={`var(--${tone})`} />
        </svg>
        <div className="acc-legend">Shaded: shorter than the {MIN_TRANSFER_MIN} min needed to change trains.</div>
      </div>
    </div>
  );
}

/** Validation RPS as recorded when the current model was trained (validation weeks from 4 Aug 2026). */
const GATE = [
  { label: 'History only', rps: 0.1093, note: 'the six-level lookup' },
  { label: '+ live sightings', rps: 0.1048, note: 'what is served without a model' },
  { label: '+ LightGBM correction', rps: 0.1037, note: 'live since 30 Sep 2026' },
];

function Gate() {
  const lo = 0.1;
  const hi = 0.112;
  const [ref, width] = useWidth<HTMLDivElement>();
  const W = width || 600;
  // Narrow screens put each label above its dot instead of beside it.
  const narrow = W < 480;
  const row = narrow ? 72 : 44;
  const pad = { l: narrow ? 8 : 190, r: 70, t: 8, b: 30 };
  const H = pad.t + GATE.length * row + pad.b;
  const x = (v: number) => pad.l + ((v - lo) / (hi - lo)) * (W - pad.l - pad.r);
  return (
    <div className="how-gate">
      <div className="acc-chart" ref={ref}>
        <svg width={W} height={H} role="img" aria-label={GATE.map((g) => `${g.label}: RPS ${g.rps}`).join(', ')}>
          {[0.1, 0.104, 0.108, 0.112].map((t) => (
            <g key={t}>
              <line className="grid" x1={x(t)} x2={x(t)} y1={pad.t} y2={H - pad.b} />
              <text className="axis" x={x(t)} y={H - 10} textAnchor="middle">
                {t.toFixed(3)}
              </text>
            </g>
          ))}
          {GATE.map((g, k) => {
            const cy = pad.t + k * row + (narrow ? row - 16 : row / 2);
            const ly = narrow ? cy - 32 : cy - 2;
            const last = k === GATE.length - 1;
            return (
              <g key={g.label}>
                <text x={0} y={ly} style={{ font: '600 14px var(--sans)', fill: 'var(--ink)' }}>
                  {g.label}
                </text>
                <text className="axis" x={0} y={narrow ? cy - 15 : cy + 14}>
                  {g.note}
                </text>
                <line x1={x(lo)} x2={x(g.rps)} y1={cy} y2={cy} stroke="var(--track)" strokeWidth={2} />
                <circle cx={x(g.rps)} cy={cy} r={7} fill={last ? 'var(--good)' : 'var(--ink)'} className="ring" />
                <text x={x(g.rps) + 14} y={cy + 5} style={{ font: '700 14px var(--mono)', fill: 'var(--ink)' }}>
                  {g.rps.toFixed(4)}
                </text>
              </g>
            );
          })}
        </svg>
        <div className="acc-legend">Ranked probability score on held-out weeks. Lower is better; 0 would be perfect.</div>
      </div>
      <div className="how-gate-text">
        <p className="how-text">
          Forecasts are scored with the <b>ranked probability score</b>. It compares the predicted chance of being at most
          2, 5, 10… minutes late with what happened, so saying &ldquo;11–15 min&rdquo; for an on-time train costs more than
          saying &ldquo;3–5 min&rdquo;.
        </p>
        <p className="how-text">
          A newly trained model is scored on recent weeks it never saw. It is switched on only if it beats what is served
          without it by at least 0.2%, and doesn&apos;t do worse than the model already running. Otherwise the app keeps
          the current forecast. If the model ever fails to load or score, the app falls back to history plus live
          sightings.
        </p>
        <p className="how-text muted">
          Live scores of the forecasts actually served are on the <Link to="/accuracy">Accuracy</Link> page.
        </p>
      </div>
    </div>
  );
}

const EXAMPLE = buildSteps();

export function HowItWorksPage() {
  return (
    <section className="page how" aria-label="How it works">
      <div className="page-head">
        <div>
          <h1 className="page-title">How a forecast is made</h1>
          <div className="muted how-lead">
            Spät doesn&apos;t guess a single number. For every stop it estimates the chance of each delay range, from
            delay history, the train&apos;s live position and a small learned correction.
          </div>
        </div>
      </div>

      <section className="how-section" aria-labelledby="how-pipeline">
        <h2 className="section-title" id="how-pipeline">
          The pipeline
        </h2>
        <Pipeline />
      </section>

      <section className="how-section" aria-labelledby="how-walk">
        <div className="how-section-head">
          <h2 className="section-title" id="how-walk">
            One forecast, step by step
          </h2>
          <span className="muted how-caveat">Example counts are made up; the formulas are the ones the app uses.</span>
        </div>
        <Walkthrough steps={EXAMPLE.steps} />
      </section>

      <section className="how-section" aria-labelledby="how-conn">
        <h2 className="section-title" id="how-conn">
          From two forecasts to connection risk
        </h2>
        <ConnectionRisk arrival={EXAMPLE.final} />
      </section>

      <section className="how-section" aria-labelledby="how-gate">
        <h2 className="section-title" id="how-gate">
          How a new model earns its place
        </h2>
        <Gate />
      </section>
    </section>
  );
}
