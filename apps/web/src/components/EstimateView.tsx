/** The trip estimate (design 1a/1c): headline numbers, delay chart, stop-by-stop timeline, context. */
import { Fragment, useState } from 'react';
import type { StopView, TripEstimate } from '../../../bff/src/contract.ts';
import { DelayChart, type ChartMode } from './DelayChart.tsx';
import { Segmented, pct, toneClass, toneColor } from './ui.tsx';

export function EstimateView({ estimate }: { estimate: TripEstimate }) {
  const lastLeg = estimate.legs.length - 1;
  const [sel, setSel] = useState<[number, number]>([lastLeg, estimate.legs[lastLeg]!.timeline.length - 1]);
  const [mode, setMode] = useState<ChartMode>('histogram');
  const leg = estimate.legs[sel[0]] ?? estimate.legs[lastLeg]!;
  const stop = leg.timeline[sel[1]] ?? estimate.final;
  const d = stop.dist;

  return (
    <>
      <div className="est-head">
        <div>
          <div className="est-sub">
            {leg.train}
            {leg.routeLabel ? ` (${leg.routeLabel})` : ''} · {stop.event} at {stop.name} · scheduled {stop.time} · {estimate.dateLabel}
          </div>
          <h1 className="est-headline">{stop.headline}</h1>
        </div>
        <div className="bignums">
          <div>
            <div className="bignum-label">Most likely</div>
            <div className={`bignum ${toneClass(stop.tone)}`}>{stop.typicalLabel}</div>
          </div>
          <div>
            <div className="bignum-label">80% chance at most</div>
            <div className="bignum">+{d.upTo80}</div>
          </div>
        </div>
      </div>
      <p className="est-sentence">{stop.sentence}</p>

      <div className="est-grid">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 22, minWidth: 0 }}>
          <section className="card" aria-label="Delay distribution">
            <div className="card-head">
              <div className="card-title">{mode === 'histogram' ? 'Probability of each delay range' : 'Chance of arriving within X minutes'}</div>
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
              <span>
                <span className="swatch" style={{ background: 'var(--neutral)' }} />
                Cancelled {pct(d.cancelled)}
              </span>
            </div>
          </section>

          <section style={{ display: 'flex', flexDirection: 'column', gap: 8 }} aria-label="Journey">
            <div className="section-title">Journey</div>
            <div className="timeline">
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
            </div>
          </section>
        </div>

        <aside style={{ display: 'flex', flexDirection: 'column', gap: 14 }} aria-label="Context">
          <div className="section-title">Context</div>
          <dl className="kv">
            <div>
              <dt>On time (≤2 min)</dt>
              <dd className="tone-good">{pct(d.onTime)}</dd>
            </div>
            <div>
              <dt>More than 5 min late</dt>
              <dd className={toneClass(stop.tone)}>{pct(d.lateOver5)}</dd>
            </div>
            <div>
              <dt>More than 15 min late</dt>
              <dd>{pct(d.lateOver15)}</dd>
            </div>
            <div>
              <dt>Average, if it runs</dt>
              <dd>+{d.expected.toFixed(1)} min</dd>
            </div>
            {stop.live && (
              <div>
                <dt>Live now</dt>
                <dd>
                  {stop.live.label}
                  {stop.live.cause && !stop.reasons.length && <span className="muted"> · {stop.live.cause}</span>}
                </dd>
              </div>
            )}
            {estimate.allConnectionsP !== null && (
              <div>
                <dt>All connections hold</dt>
                <dd>{pct(estimate.allConnectionsP)}</dd>
              </div>
            )}
          </dl>
          <Signals stop={stop} />
          {estimate.timetableNote && <div className="notice">{estimate.timetableNote}.</div>}
          {estimate.warnings.map((w) => (
            <div className="notice" key={w}>
              {w}
            </div>
          ))}
          <div className="muted" style={{ fontSize: 13 }}>
            Model {estimate.model}. Early arrivals count as on time.
          </div>
        </aside>
      </div>
    </>
  );
}

function StopRow(props: { stop: StopView; first: boolean; last: boolean; selected: boolean; onSelect: () => void }) {
  const s = props.stop;
  return (
    <button type="button" className="stop" aria-current={props.selected} onClick={props.onSelect}>
      <span className="stop-time">{s.time}</span>
      <span className="stop-rail" aria-hidden>
        <span className={`seg top${props.first ? ' hidden' : ''}`} />
        <span className="stop-dot" style={{ background: props.selected ? 'var(--ink)' : toneColor(s.tone) }} />
        <span className={`seg bottom${props.last ? ' hidden' : ''}`} />
      </span>
      <span className="stop-body">
        <span className="stop-name">{s.name}</span>
        {s.live && <span className="live-badge">{s.live.label}</span>}
        <span className="stop-note" style={{ display: 'block' }}>
          {s.event === 'departure' ? 'departs' : 'arrives'} · {pct(s.dist.onTime)} on time
        </span>
      </span>
      <span className={`stop-exp ${toneClass(s.tone)}`}>{s.typicalLabel}</span>
    </button>
  );
}

/** What went into the selected stop's forecast, and the delay reasons DB reported for the run. */
function Signals({ stop }: { stop: StopView }) {
  return (
    <>
      <section className="signals" aria-label="Why this forecast">
        <div className="signals-title">Why this forecast</div>
        <ul>
          {stop.signals.map((s) => (
            <li key={s.kind} className={s.tone === 'warn' ? 'signal warn' : 'signal'}>
              <span className="signal-title">{s.title}</span>
              <span>{s.text}</span>
            </li>
          ))}
        </ul>
      </section>
      {stop.reasons.length > 0 && (
        <section className="signals" aria-label="Reported by DB">
          <div className="signals-title">Reported by DB for this run</div>
          <ul>
            {stop.reasons.map((r) => (
              <li key={`${r.kind}-${r.text}`} className="signal reason">
                <span className="reason-text">{r.text}</span>
                <span className="muted">{r.detail}</span>
              </li>
            ))}
          </ul>
          <div className="muted signals-note">DB's stated reasons, for context. The forecast doesn't use them yet.</div>
        </section>
      )}
    </>
  );
}
