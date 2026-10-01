/**
 * Start screen: what '/' shows when nothing was searched yet. One set of blocks laid out three
 * ways by CSS grid (see styles.css): design 2b on phones (one column), 2a up to ~1400px (search
 * and departures side by side, the network chart along the bottom) and 3a on wide screens (capped
 * at 1440px; the chart under the big figure, ten departures with column headers on the right).
 */
import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router';
import type { DepartureRow, SplashView, StationOption } from '../../../bff/src/contract.ts';
import { useFeatured, useSplash } from '../api.ts';
import { StationPicker } from '../components/StationPicker.tsx';
import { ErrorNote, Segmented, Skeleton, pct, toneClass } from '../components/ui.tsx';
import { berlinDateOf, berlinNowHm, berlinToday } from '../dates.ts';

type Tab = 'train' | 'route' | 'station';
const HBF: StationOption = { eva: '8000261', name: 'München Hbf' };
const PASING: StationOption = { eva: '8004158', name: 'München-Pasing' };
const BAR_COLORS = ['var(--b0)', 'var(--b1)', 'var(--b2)', 'var(--b3)', 'var(--b4)', 'var(--b5)'];

const estimateHref = (p: Record<string, string>) => `/?${new URLSearchParams(p)}`;
const routeHref = (from: StationOption, to: StationOption) =>
  estimateHref({ mode: 'route', from: from.eva, fn: from.name, to: to.eva, tn: to.name, date: berlinToday(), after: berlinNowHm() });

export function SplashPage() {
  const splash = useSplash();
  const s = splash.data;
  return (
    <section className="splash" aria-label="Start">
      <div className="splash-main">
        <div className="splash-hero">
          <h1 className="splash-title">How late will your train be?</h1>
          <p className="splash-lead">Delay forecasts for every ICE, IC and regional train through Munich.</p>
          <Search />
          <TryChips next={s?.next ?? []} />
        </div>
        {splash.error && (
          <div className="splash-late">
            <ErrorNote error={splash.error} />
          </div>
        )}
        {splash.isPending && (
          <div className="splash-deps">
            <Skeleton height={330} />
          </div>
        )}
        {s && <Late s={s} />}
        {s && <Departures s={s} />}
        {s && s.count > 0 && <Outlook s={s} />}
      </div>
    </section>
  );
}

function Search() {
  const navigate = useNavigate();
  const [tab, setTab] = useState<Tab>('train');
  const [train, setTrain] = useState('');
  const [from, setFrom] = useState<StationOption>(HBF);
  const [to, setTo] = useState<StationOption | null>(null);
  const [station, setStation] = useState<StationOption | null>(null);

  const ready = tab === 'train' ? !!train.trim() : tab === 'route' ? !!to && to.eva !== from.eva : !!station;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!ready) return;
    if (tab === 'train') {
      // 'ice514' and 'ICE  514' both mean ICE 514, as on the Estimate screen.
      const t = train.trim().toUpperCase().replace(/^([A-Z]+)\s*(\d+)$/, '$1 $2');
      navigate(estimateHref({ mode: 'train', train: t, date: berlinToday() }));
    } else if (tab === 'route') navigate(routeHref(from, to!));
    else navigate(`/departures?${new URLSearchParams({ station: station!.eva })}`);
  };

  return (
    <form className="splash-search" role="search" aria-label="Find a train" onSubmit={submit}>
      <Segmented
        label="Search by"
        value={tab}
        onChange={setTab}
        options={[
          { value: 'train', label: 'Train no.' },
          { value: 'route', label: 'Route' },
          { value: 'station', label: 'Station' },
        ]}
      />
      <div className="splash-search-row">
        {tab === 'train' && (
          <label className="field">
            <span className="field-label">Train number</span>
            <input value={train} onChange={(e) => setTrain(e.target.value)} placeholder="ICE 514, RE 4010" autoCapitalize="characters" />
          </label>
        )}
        {tab === 'route' && (
          <div className="splash-route">
            <StationPicker label="From" value={from} onChange={setFrom} />
            <StationPicker label="To" value={to} onChange={setTo} />
          </div>
        )}
        {tab === 'station' && <StationPicker label="Station" value={station} onChange={setStation} />}
        <button className="btn" type="submit" disabled={!ready}>
          {tab === 'station' ? 'Show departures' : 'Show forecast'}
        </button>
      </div>
    </form>
  );
}

/** Ready-made searches: the train we expect to be latest, the next long-distance train, a common route. */
function TryChips({ next }: { next: DepartureRow[] }) {
  const pick = useFeatured(true).data?.featured;
  const long = next.find((r) => ['ICE', 'IC', 'EC', 'ECE', 'RJ', 'RJX'].includes(r.trainType) && r.train !== pick?.train);
  const chips = [
    pick && {
      label: pick.train,
      to: estimateHref({ mode: 'train', train: pick.train, date: pick.date, [pick.event === 'dep' ? 'tf' : 'tt']: pick.eva, featured: '1' }),
    },
    long && { label: long.train, to: estimateHref({ mode: 'train', train: long.train, date: berlinDateOf(long.planned), tf: HBF.eva }) },
    { label: 'Pasing → Hbf', to: routeHref(PASING, HBF) },
    { label: 'Shared trip', to: estimateHref({ mode: 'share' }) },
  ].filter((c): c is { label: string; to: string } => !!c);
  return (
    <div className="splash-try">
      Try
      {chips.map((c) => (
        <Link key={c.label} className="splash-chip" to={c.to}>
          {c.label} →
        </Link>
      ))}
    </div>
  );
}

function Late({ s }: { s: SplashView }) {
  return (
    <div className="splash-late">
      {s.count > 0 ? (
        <div className="splash-late-row">
          <div className="splash-late-figure">{pct(s.lateOver5)}</div>
          <div className="splash-late-text">of departures in the next hour are likely to be more than 5 min late</div>
        </div>
      ) : (
        <div className="notice">No departures from the Munich hubs in the next hour. Live data may be paused.</div>
      )}
    </div>
  );
}

/** Up to ten rows; narrower layouts hide the later ones (2a shows five, phones three). */
function Departures({ s }: { s: SplashView }) {
  const all = `/departures?station=${s.station.eva}`;
  return (
    <div className="splash-deps">
      <div className="splash-deps-head">
        <h2>Next departures, {s.station.name}</h2>
        <Link to={all}>All departures →</Link>
      </div>
      <div className="splash-dep splash-dep-cols" aria-hidden>
        <span className="splash-dep-time">Time</span>
        <span className="splash-dep-tag">Train</span>
        <span className="splash-dep-dest">Destination</span>
        <span className="splash-split-col">Chance of delay</span>
        <span className="splash-dep-exp">Exp.</span>
      </div>
      <div className="splash-dep-list" role="list" aria-label={`Next departures, ${s.station.name}`}>
        {s.next.map((r) => (
          <DepartureLine key={`${r.train}-${r.planned}`} row={r} station={s.station.eva} />
        ))}
      </div>
      <div className="splash-legend" aria-hidden>
        <span><i style={{ background: 'var(--good)' }} />on time</span>
        <span><i style={{ background: 'var(--split-mid)' }} />3–10 min</span>
        <span><i style={{ background: 'var(--bad)' }} />over 10 min</span>
      </div>
      <div className="splash-deps-foot">
        <span className="muted">Next departures, {s.station.name}</span>
        <Link to={all}>All departures →</Link>
      </div>
    </div>
  );
}

function DepartureLine({ row: r, station }: { row: DepartureRow; station: string }) {
  const [onTime, mid, late] = r.split;
  const cancelled = !!r.live?.cancelled;
  return (
    <Link
      role="listitem"
      className="splash-dep"
      to={estimateHref({ mode: 'train', train: r.train, date: berlinDateOf(r.planned), tf: station })}
    >
      <span className="splash-dep-time">{r.time}</span>
      <span className="splash-dep-tag">
        <span className="train-tag">{r.train}</span>
      </span>
      <span className="splash-dep-dest">
        <span className="splash-dep-train">{r.train} </span>
        {r.destination}
      </span>
      <span
        className="splash-split"
        aria-label={`${pct(onTime)} on time, ${pct(mid)} 3 to 10 minutes late, ${pct(late)} more than 10 minutes late`}
      >
        <span style={{ width: pct(onTime), background: 'var(--good)' }} />
        <span style={{ width: pct(mid), background: 'var(--split-mid)' }} />
        <span style={{ width: pct(late), background: 'var(--bad)' }} />
      </span>
      <span className={`splash-dep-exp ${cancelled ? 'tone-bad' : toneClass(r.tone)}`}>{cancelled ? '✕' : r.typicalLabel}</span>
    </Link>
  );
}

/** Every departure from the hubs in the next hour, by forecast delay, on the estimate chart's ranges and colours. */
function Outlook({ s }: { s: SplashView }) {
  const max = Math.max(...s.bars.map((b) => b.p), 0.01);
  return (
    <div className="splash-outlook">
      <div className="splash-caption">
        <span>
          {s.count} departures from Munich stations, {s.window}
          <span className="splash-by">, by forecast delay</span> · <Link to="/patterns">Explore patterns →</Link>
        </span>
        {s.accuracy && (
          <span className="splash-acc">
            {s.accuracy} · <Link to="/accuracy">Accuracy →</Link>
          </span>
        )}
      </div>
      <div
        className="splash-bars"
        role="img"
        aria-label={`Forecast delay of the next hour's departures: ${s.bars.map((b) => `${b.label} min ${pct(b.p)}`).join(', ')}`}
      >
        {s.bars.map((b, i) => (
          <div className="splash-bar" key={b.label}>
            <div className="splash-bar-pct">{pct(b.p)}</div>
            <div className="splash-bar-fill" style={{ height: `${(b.p / max) * 78}%`, background: BAR_COLORS[i] }} />
          </div>
        ))}
      </div>
      <div className="splash-bar-labels" aria-hidden>
        {s.bars.map((b) => (
          <div key={b.label}>
            {b.label}
            <span className="splash-unit"> min</span>
          </div>
        ))}
      </div>
    </div>
  );
}
