/** Departure board with probabilities (design 1d). Refreshes every minute. */
import { Link, useSearchParams } from 'react-router';
import type { DepartureRow } from '../../../bff/src/contract.ts';
import { useDepartures, useMeta } from '../api.ts';
import { Chips, ErrorNote, Skeleton, pct, toneClass } from '../components/ui.tsx';
import { berlinDateOf } from '../dates.ts';

const GROUPS = [
  { value: 'all', label: 'All' },
  { value: 'long', label: 'ICE / IC / EC' },
  { value: 'regional', label: 'Regional' },
];

export function DeparturesPage() {
  const [params, setParams] = useSearchParams();
  const station = params.get('station') ?? '8000261';
  const group = params.get('group') ?? 'all';
  const meta = useMeta();
  const board = useDepartures(station, group);
  const set = (k: string, v: string) => {
    const next = new URLSearchParams(params);
    next.set(k, v);
    setParams(next, { replace: true });
  };
  const hubs = meta.data?.hubs ?? [{ eva: '8000261', name: 'München Hbf' }];

  return (
    <section className="page" aria-label="Departures">
      <div className="page-head">
        <div>
          <h1 className="page-title">{board.data?.station.name ?? hubs.find((h) => h.eva === station)?.name ?? 'Departures'}</h1>
          <div className="muted">
            Next 90 minutes · ICE, IC, EC and regional trains{board.data ? ` · updated ${board.data.asOf}` : ''}
          </div>
        </div>
        <div className="filters">
          <Chips label="Station" value={station} onChange={(v) => set('station', v)} options={hubs.map((h) => ({ value: h.eva, label: h.name.replace('München-', '').replace('München ', '') }))} />
          <Chips label="Trains" value={group} onChange={(v) => set('group', v)} options={GROUPS} />
        </div>
      </div>

      <div role="table" aria-label="Departures with delay probabilities">
        <div className="board-head" role="row">
          <div role="columnheader">Time</div>
          <div role="columnheader">Train</div>
          <div role="columnheader">Destination</div>
          <div role="columnheader" className="legend">
            <span><span className="swatch" style={{ background: 'var(--good)' }} />On time</span>
            <span><span className="swatch" style={{ background: 'var(--split-mid)' }} />3–10</span>
            <span><span className="swatch" style={{ background: 'var(--bad)' }} />&gt;10 min</span>
          </div>
          <div role="columnheader" style={{ textAlign: 'right' }} title="Most likely delay">Likely</div>
        </div>
        {board.isPending && [0, 1, 2, 3, 4, 5].map((i) => <Skeleton key={i} height={50} />)}
        {board.error && <ErrorNote error={board.error} />}
        {board.data?.rows.length === 0 && (
          <div className="notice" style={{ marginTop: 12 }}>
            No departures in the next 90 minutes. The live poller may not be running.
          </div>
        )}
        {board.data?.rows.map((r) => <BoardRow key={`${r.train}-${r.planned}`} row={r} />)}
      </div>
    </section>
  );
}

function BoardRow({ row: r }: { row: DepartureRow }) {
  const href = `/?${new URLSearchParams({ mode: 'train', train: r.train, date: berlinDateOf(r.planned), tf: r.eva })}`;
  const [onTime, mid, late] = r.split;
  const cells = (
    <>
      <div role="cell" className="board-time c-time">
        {r.time}
      </div>
      <div role="cell" className="c-train">
        <span className="train-tag">{r.train}</span>
      </div>
      <div role="cell" className="board-dest c-dest">
        {r.destination}
      </div>
      <div role="cell" className="c-split">
        {r.live?.cancelled ? (
          <span className="tone-bad" style={{ fontWeight: 700 }}>Cancelled</span>
        ) : (
          <div className="splitbar" aria-label={`${pct(onTime)} on time, ${pct(mid)} 3 to 10 minutes late, ${pct(late)} more than 10 minutes late, ${pct(r.cancelled)} cancelled`}>
            <div style={{ width: pct(onTime), background: 'var(--good)' }}>{onTime >= 0.12 ? pct(onTime) : ''}</div>
            <div style={{ width: pct(mid), background: 'var(--split-mid)', color: 'var(--ink)' }}>{mid >= 0.12 ? pct(mid) : ''}</div>
            <div style={{ width: pct(late), background: 'var(--bad)' }}>{late >= 0.12 ? pct(late) : ''}</div>
          </div>
        )}
      </div>
      <div role="cell" className={`board-exp c-exp ${toneClass(r.tone)}`}>
        {r.typicalLabel}
        {r.live && !r.live.cancelled && r.live.delayMin !== null && r.live.delayMin > 0 && (
          <div className="mono muted" style={{ fontSize: 12, fontWeight: 500 }}>
            {r.live.label}
          </div>
        )}
      </div>
    </>
  );
  if (!r.linkable) {
    return (
      <div className="board-row board-row-static" role="row" title="We only know this train at this station so far, so there is no route to forecast yet">
        {cells}
      </div>
    );
  }
  return (
    <Link className="board-row" role="row" to={href}>
      {cells}
    </Link>
  );
}
