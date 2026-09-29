/**
 * Estimate screen (design 2a): a trip bar on top (route, train number, or pasted share text) and
 * the forecast below it. All state lives in the URL so estimates are linkable and survive reload.
 */
import { useEffect, useState, type FormEvent } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import type { StationOption } from '../../../bff/src/contract.ts';
import { useConnections, useEstimate, useFeatured, useTrainStops } from '../api.ts';
import { EstimateView } from '../components/EstimateView.tsx';
import { StationPicker } from '../components/StationPicker.tsx';
import { Empty, ErrorNote, Loading, Segmented, Skeleton, pct, toneClass, toneColor } from '../components/ui.tsx';
import { berlinToday } from '../dates.ts';

type Mode = 'route' | 'train' | 'share';
type Update = (patch: Record<string, string | null>) => void;
const HBF: StationOption = { eva: '8000261', name: 'München Hbf' };

export function EstimatePage() {
  const [params, setParams] = useSearchParams();
  const mode = (params.get('mode') as Mode | null) ?? 'route';
  const date = params.get('date') ?? berlinToday();
  const train = params.get('train') ?? undefined;
  const tf = params.get('tf') ?? undefined;
  const tt = params.get('tt') ?? undefined;

  // Opened without a search: show the upcoming train with the largest predicted delay.
  const blank = params.size === 0;
  const isFeatured = params.get('featured') === '1';
  const featured = useFeatured(blank || isFeatured);
  const pick = featured.data?.featured;
  useEffect(() => {
    if (!blank || !pick) return;
    setParams(
      { mode: 'train', train: pick.train, date: pick.date, [pick.event === 'dep' ? 'tf' : 'tt']: pick.eva, featured: '1' },
      { replace: true },
    );
  }, [blank, pick, setParams]);

  const update: Update = (patch) => {
    const next = new URLSearchParams(params);
    next.delete('featured'); // any change means the user is searching for their own train
    for (const [k, v] of Object.entries(patch)) {
      if (v === null || v === '') next.delete(k);
      else next.set(k, v);
    }
    setParams(next, { replace: true });
  };

  const estimate = useEstimate({ train, date, from: tf, to: tt });

  return (
    <div className="est-page">
      <div className="tripbar" role="search" aria-label="Find a train">
        <Segmented
          inline
          label="Search by"
          value={mode}
          onChange={(m) => update({ mode: m })}
          options={[
            { value: 'route', label: 'Route' },
            { value: 'train', label: 'Train no.' },
            { value: 'share', label: 'Shared trip' },
          ]}
        />
        {mode === 'route' && <RouteSearch params={params} date={date} update={update} />}
        {mode === 'train' && <TrainSearch key={`${train}-${date}`} train={train} date={date} from={tf} to={tt} update={update} />}
        {mode === 'share' && <ShareSearch />}
      </div>
      {mode === 'route' && <RouteResults params={params} date={date} update={update} />}

      <section className="est-body" aria-live="polite">
        {blank && featured.isPending && <Loading label="Finding a train to show…" />}
        {!train && !(blank && (featured.isPending || pick)) && (
          <Empty title="Will my train be late?">
            <p className="muted" style={{ margin: 0, lineHeight: 1.5 }}>
              Pick a route or enter a train number to see how late it's likely to be, stop by stop. In DB Navigator you can also
              share a trip ("Reise teilen") and paste it here.
            </p>
          </Empty>
        )}
        {isFeatured && pick && pick.train === train && (
          <div className="notice featured-note">
            <strong>Example:</strong> {pick.reason} Search above for your own train.
          </div>
        )}
        {train && estimate.isPending && <Loading />}
        {train && estimate.error && <ErrorNote error={estimate.error} />}
        {estimate.data && <EstimateView key={JSON.stringify([train, date, tf, tt])} estimate={estimate.data} />}
      </section>
    </div>
  );
}

const routeStations = (params: URLSearchParams) => ({
  from: params.get('from') ? { eva: params.get('from')!, name: params.get('fn') ?? '' } : HBF,
  to: params.get('to') ? { eva: params.get('to')!, name: params.get('tn') ?? '' } : null,
});

function RouteSearch({ params, date, update }: { params: URLSearchParams; date: string; update: Update }) {
  const { from, to } = routeStations(params);
  return (
    <div className="tripbar-fields">
      <StationPicker label="From" value={from} onChange={(s) => update({ from: s.eva, fn: s.name, train: null })} />
      <StationPicker label="To" value={to} onChange={(s) => update({ to: s.eva, tn: s.name, train: null })} />
      <label className="field">
        <span className="field-label">Date</span>
        <input type="date" value={date} onChange={(e) => update({ date: e.target.value, train: null })} />
      </label>
      <label className="field">
        <span className="field-label">Depart after</span>
        <input type="time" value={params.get('after') ?? ''} onChange={(e) => update({ after: e.target.value })} />
      </label>
    </div>
  );
}

/** Direct trains for the route, as a row under the trip bar; picking one shows its forecast. */
function RouteResults({ params, date, update }: { params: URLSearchParams; date: string; update: Update }) {
  const { from, to } = routeStations(params);
  const after = params.get('after') ?? '';
  const selected = params.get('train');
  const conns = useConnections({ from: from.eva, to: to?.eva, date, after: after || undefined });
  if (!to) return null;
  return (
    <div className="conn-strip" aria-label="Trains on this route">
      <div className="eyebrow">Chance of arriving &gt;5 min late</div>
      <div className="conn-row">
        {conns.isPending && [0, 1, 2, 3].map((i) => <Skeleton key={i} height={64} width={200} />)}
        {conns.error && <ErrorNote error={conns.error} />}
        {conns.data?.items.length === 0 && <div className="notice">No direct ICE, IC or regional trains found for this route and time.</div>}
        {conns.data?.items.map((c) => (
          <button
            key={c.train}
            type="button"
            className="conn"
            aria-current={selected === c.train}
            onClick={() => update({ train: c.train, tf: c.fromEva, tt: c.toEva })}
          >
            <span className="conn-times">
              {c.dep} <span className="muted" style={{ fontWeight: 400 }}>→ {c.arr}</span>
            </span>
            <span className={`conn-risk ${toneClass(c.tone)}`}>{pct(c.lateOver5)}</span>
            <span className="conn-meta">
              {c.train} · {c.durationLabel}
            </span>
            <span className="meter" aria-hidden>
              <div style={{ width: pct(c.lateOver5), background: toneColor(c.tone) }} />
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

function TrainSearch(props: { train?: string; date: string; from?: string; to?: string; update: Update }) {
  const [text, setText] = useState(props.train ?? '');
  const [date, setDate] = useState(props.date);
  const stops = useTrainStops(props.train, props.date);
  const list = stops.data?.stops ?? [];

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const t = text.trim().toUpperCase().replace(/^([A-Z]+)\s*(\d+)$/, '$1 $2');
    if (t) props.update({ train: t, date, tf: null, tt: null });
  };

  return (
    <form onSubmit={submit} className="tripbar-form">
      <div className="tripbar-fields">
        <label className="field">
          <span className="field-label">Train</span>
          <input value={text} onChange={(e) => setText(e.target.value)} placeholder="ICE 514" autoCapitalize="characters" />
        </label>
        <label className="field">
          <span className="field-label">Date</span>
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </label>
        <label className="field wide">
          <span className="field-label">Board at</span>
          <select value={props.from ?? ''} disabled={!list.length} onChange={(e) => props.update({ tf: e.target.value })}>
            <option value="">First stop</option>
            {list.slice(0, -1).map((s) => (
              <option key={s.eva} value={s.eva}>
                {s.time} {s.name}
              </option>
            ))}
          </select>
        </label>
        <label className="field wide">
          <span className="field-label">Get off at</span>
          <select value={props.to ?? ''} disabled={!list.length} onChange={(e) => props.update({ tt: e.target.value })}>
            <option value="">Last stop</option>
            {list.slice(1).map((s) => (
              <option key={s.eva} value={s.eva}>
                {s.time} {s.name}
              </option>
            ))}
          </select>
        </label>
      </div>
      <button className="btn" type="submit" disabled={!text.trim()}>
        Show forecast
      </button>
    </form>
  );
}

function ShareSearch() {
  const navigate = useNavigate();
  const [text, setText] = useState('');
  return (
    <form
      className="tripbar-form"
      onSubmit={(e) => {
        e.preventDefault();
        navigate(`/share?${new URLSearchParams({ text })}`);
      }}
    >
      <label className="field tripbar-share">
        <span className="field-label">
          Paste a trip shared from DB Navigator (open the trip, tap Share / "Reise teilen", copy the text)
        </span>
        <textarea
          rows={1}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={'München Hbf → Stuttgart Hbf · 10/26/2026 · ICE 514 · From 15:28 München Hbf …'}
        />
      </label>
      <button className="btn" type="submit" disabled={!text.trim()}>
        Forecast this trip
      </button>
    </form>
  );
}
