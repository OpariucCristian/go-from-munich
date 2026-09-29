/**
 * Landing page for shared trips: the PWA share target (GET /share?title&text&url) and pasted text
 * both end up here, so a shared trip is one tap from DB Navigator to a forecast.
 */
import { Link, useSearchParams } from 'react-router';
import { useShareEstimate } from '../api.ts';
import { EstimateView } from '../components/EstimateView.tsx';
import { Empty, ErrorNote, Loading } from '../components/ui.tsx';

export function SharePage() {
  const [params] = useSearchParams();
  const share = {
    text: params.get('text') ?? undefined,
    title: params.get('title') ?? undefined,
    url: params.get('url') ?? undefined,
  };
  const result = useShareEstimate(share);
  const hasInput = !!(share.text || share.title || share.url);

  return (
    <section className="content" aria-live="polite" style={{ maxWidth: 1180, width: '100%', margin: '0 auto' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
        <div className="eyebrow">Shared trip</div>
        <Link className="chip" to="/?mode=share">
          Change trip
        </Link>
      </div>
      {!hasInput && (
        <Empty title="Nothing was shared">
          <p className="muted" style={{ margin: 0 }}>
            Share a trip from DB Navigator, or <Link to="/?mode=share">paste its text</Link>.
          </p>
        </Empty>
      )}
      {hasInput && result.isPending && <Loading />}
      {result.error && <ErrorNote error={result.error} />}
      {result.data && !result.data.estimate && (
        <Empty title="Couldn't read that trip">
          {result.data.warnings.map((w) => (
            <div className="notice" key={w}>
              {w}
            </div>
          ))}
          <p className="muted" style={{ margin: 0 }}>
            Spät needs the train (e.g. "ICE 514") and the From/To lines with times. <Link to="/?mode=train">Search by train number</Link>{' '}
            instead.
          </p>
        </Empty>
      )}
      {result.data?.estimate && (
        <>
          <div>
            <div style={{ fontSize: 26, fontWeight: 700, letterSpacing: '-0.02em' }}>{result.data.estimate.title}</div>
            <div className="muted">
              {result.data.estimate.legs.map((l) => l.train).join(' → ')} · {result.data.estimate.dateLabel}
            </div>
          </div>
          <EstimateView estimate={result.data.estimate} />
        </>
      )}
    </section>
  );
}
