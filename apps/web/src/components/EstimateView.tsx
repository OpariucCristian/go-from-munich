/**
 * The trip estimate (design 2a): the answer as one figure with the key numbers beside it, the delay
 * chart next to the journey, then the signals behind the forecast. Each number appears once.
 */
import { Fragment, useState } from 'react';
import type { LiveView, StopView, TripEstimate } from '../../../bff/src/contract.ts';
import { useMeta } from '../api.ts';
import { DelayChart, type ChartMode } from './DelayChart.tsx';
import { Segmented, pct, toneClass, toneColor } from './ui.tsx';

export function EstimateView({ estimate }: { estimate: TripEstimate }) {
  const lastLeg = estimate.legs.length - 1;
  const [sel, setSel] = useState<[number, number]>([lastLeg, estimate.legs[lastLeg]!.timeline.length - 1]);
  const [mode, setMode] = useState<ChartMode>('histogram');
  const leg = estimate.legs[sel[0]] ?? estimate.legs[lastLeg]!;
  const stop = leg.timeline[sel[1]] ?? estimate.final;
  const d = stop.dist;
  const late15 = d.lateOver15 >= 0.35 ? 'tone-bad' : d.lateOver15 >= 0.2 ? 'tone-warn' : '';

  return (
    <div className="est">
      <div className="est-top">
        <div className="est-hero">
          <div className="est-sub">
            {leg.train}
            {leg.routeLabel ? ` ${leg.routeLabel}` : ''} · {estimate.dateLabel}
          </div>
          <div className="est-answer">
            <div className={`est-figure ${toneClass(stop.tone)}`}>{stop.hero.figure}</div>
            <div className="est-answer-text">
              <h1 className="est-label">{stop.hero.label}</h1>
              <div className="est-when">{boldFirstTime(stop.hero.sub)}</div>
            </div>
          </div>
        </div>
        <dl className="est-stats">
          <div>
            <dt>80% chance at most</dt>
            <dd>+{d.upTo80}</dd>
          </div>
          <div>
            <dt>On time (≤2 min)</dt>
            <dd>{pct(d.onTime)}</dd>
          </div>
          <div>
            <dt>Over 15 min late</dt>
            <dd className={late15}>{pct(d.lateOver15)}</dd>
          </div>
          <div>
            <dt>Live now</dt>
            <dd>{liveFigure(stop.live) ?? '–'}</dd>
          </div>
          {estimate.allConnectionsP !== null && (
            <div>
              <dt>All connections hold</dt>
              <dd>{pct(estimate.allConnectionsP)}</dd>
            </div>
          )}
        </dl>
      </div>

      <div className="est-main">
        <section className="est-chart" aria-label="Delay distribution">
          <div className="est-section-head">
            <div className="section-title">{mode === 'histogram' ? 'Probability of each delay range' : 'Chance of arriving within X minutes'}</div>
            <Segmented
              inline
              label="Chart type"
              value={mode}
              onChange={setMode}
              options={[
                { value: 'histogram', label: 'Ranges' },
                { value: 'cumulative', label: 'Within' },
              ]}
            />
          </div>
          <DelayChart dist={d} mode={mode} />
          <div className="chart-foot">
            <span>minutes late {stop.event === 'arrival' ? 'on arrival' : 'at departure'}</span>
            <span>+ {pct(d.cancelled)} chance of cancellation</span>
          </div>
        </section>

        <section className="journey" aria-label="Journey">
          <div className="journey-row journey-head" aria-hidden>
            <span>Sched.</span>
            <span />
            <span>Journey</span>
            <span className="num">Live</span>
            <span className="num">Forecast</span>
          </div>
          {estimate.legs.map((l, li) => (
            <Fragment key={li}>
              {estimate.legs.length > 1 && (
                <div className="leg-title">
                  <span className="train-tag">{l.train}</span>
                  <span className="muted">
                    {l.durationLabel}
                    {l.routeLabel ? ` · runs ${l.routeLabel}` : ''}
                  </span>
                </div>
              )}
              {l.timeline.map((s, si) => (
                <StopRow
                  key={`${s.eva}-${si}`}
                  stop={s}
                  first={si === 0}
                  last={si === l.timeline.length - 1}
                  yours={li === lastLeg && si === l.timeline.length - 1}
                  selected={li === sel[0] && si === sel[1]}
                  onSelect={() => setSel([li, si])}
                />
              ))}
              {estimate.transfers[li] && (
                <div className="transfer">
                  <span>
                    Change at <b>{estimate.transfers[li]!.station}</b> · {estimate.transfers[li]!.plannedMin} min
                  </span>
                  <span className={`mono ${toneClass(estimate.transfers[li]!.tone)}`}>
                    <b>{pct(estimate.transfers[li]!.missP)}</b> miss
                  </span>
                </div>
              )}
            </Fragment>
          ))}
        </section>
      </div>

      <Why stop={stop} model={estimate.model} />

      {estimate.timetableNote && <div className="notice">{estimate.timetableNote}.</div>}
      {estimate.warnings.map((w) => (
        <div className="notice" key={w}>
          {w}
        </div>
      ))}
    </div>
  );
}

/** '+27', 'On time', 'Cancelled', or null when the poller hasn't seen the train at this stop. */
function liveFigure(l: LiveView | null): string | null {
  if (!l) return null;
  if (l.cancelled) return 'Cancelled';
  if (l.delayMin === null) return null;
  return l.delayMin <= 0 ? 'On time' : `+${l.delayMin}`;
}

/** 'Arrives around 19:56 · …' with the likely time in bold, as the one number to read. */
function boldFirstTime(text: string) {
  const m = /\d{2}:\d{2}/.exec(text);
  if (!m) return text;
  return (
    <>
      {text.slice(0, m.index)}
      <b>{m[0]}</b>
      {text.slice(m.index + m[0].length)}
    </>
  );
}

function StopRow(props: { stop: StopView; first: boolean; last: boolean; yours: boolean; selected: boolean; onSelect: () => void }) {
  const s = props.stop;
  return (
    <button type="button" className="journey-row stop" aria-current={props.selected} onClick={props.onSelect}>
      <span className="stop-time">{s.time}</span>
      <span className="stop-rail" aria-hidden>
        <span className={`seg top${props.first ? ' hidden' : ''}`} />
        <span className="stop-dot" style={{ background: props.selected ? 'var(--ink)' : toneColor(s.tone) }} />
        <span className={`seg bottom${props.last ? ' hidden' : ''}`} />
      </span>
      <span className="stop-body">
        <span className="stop-name">{s.name}</span>
        <span className="stop-note">
          {s.event === 'departure' ? 'departs' : 'arrives'}
          {props.yours ? ' · your stop' : ''} · {pct(s.dist.onTime)} on time
        </span>
      </span>
      <span className="stop-live">{liveFigure(s.live) ?? '–'}</span>
      <span className={`stop-exp ${toneClass(s.tone)}`}>{s.typicalLabel}</span>
    </button>
  );
}

/** What went into the selected stop's forecast, and, apart from it, the reasons DB reported. */
function Why({ stop, model }: { stop: StopView; model: string }) {
  const dataThrough = useMeta().data?.dataThrough;
  const reasons = stop.reasons;
  const columns = `repeat(${stop.signals.length}, minmax(0, 1fr))${reasons.length ? ' minmax(0, 1.1fr)' : ''}`;
  return (
    <section className="why" aria-label="Why this forecast">
      <div className="est-section-head">
        <div className="section-title">Why this forecast</div>
        <div className="why-meta">
          {['Model ' + model, dataThrough, 'early arrivals count as on time'].filter(Boolean).join(' · ')}
        </div>
      </div>
      <div className="why-grid" style={{ gridTemplateColumns: columns }}>
        {stop.signals.map((s) => (
          <div key={s.kind} className="why-cell">
            <div className={`why-title${s.tone === 'warn' ? ' tone-warn' : ''}`}>{s.title}</div>
            <div className="why-text">{s.text}</div>
          </div>
        ))}
        {reasons.length > 0 && (
          <div className="why-cell why-reasons">
            <div className="why-reasons-head">
              <div className="why-title">Reported by DB</div>
              <div className="why-pill" title="DB's stated reasons, for context. The forecast doesn't use them yet.">
                not in forecast
              </div>
            </div>
            {reasons.map((r) => (
              <div key={`${r.kind}-${r.text}`} className="why-text">
                <b>{r.text}</b> · {r.detail}
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
