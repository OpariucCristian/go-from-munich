import { NavLink, Outlet, Route, Routes, useSearchParams } from 'react-router';
import { useMeta } from './api.ts';
import { AccuracyPage } from './pages/AccuracyPage.tsx';
import { DeparturesPage } from './pages/DeparturesPage.tsx';
import { EstimatePage } from './pages/EstimatePage.tsx';
import { HowItWorksPage } from './pages/HowItWorksPage.tsx';
import { PatternsPage } from './pages/PatternsPage.tsx';
import { SharePage } from './pages/SharePage.tsx';
import { SplashPage } from './pages/SplashPage.tsx';

const NAV: { to: string; label: string; short?: string; end: boolean }[] = [
  { to: '/', label: 'Estimate', end: true },
  { to: '/departures', label: 'Departures', end: false },
  { to: '/patterns', label: 'Patterns', end: false },
  { to: '/accuracy', label: 'Accuracy', end: false },
  { to: '/how-it-works', label: 'How it works', short: 'How', end: false },
];

function Shell() {
  const meta = useMeta().data;
  const status = meta ? [`Model ${meta.model}`, meta.dataThrough, meta.liveLabel].filter(Boolean).join(' · ') : '';
  return (
    <div className="shell">
      <header className="topbar">
        <div className="topbar-left">
          <NavLink to="/" className="brand" aria-label="Spät home">
            <span className="brand-mark" aria-hidden />
            <span className="brand-name">Spät</span>
          </NavLink>
          <nav className="nav" aria-label="Main">
            {NAV.map((n) => (
              <NavLink key={n.to} to={n.to} end={n.end}>
                {n.label}
              </NavLink>
            ))}
          </nav>
        </div>
        <div className="meta">{status}</div>
      </header>
      <main className="main">
        <Outlet />
      </main>
      <footer className="footer">{meta?.attribution ?? 'Delay data © Deutsche Bahn AG (CC BY 4.0).'} Forecasts are estimates, not guarantees.</footer>
      <nav className="tabbar" aria-label="Main">
        {NAV.map((n) => (
          <NavLink key={n.to} to={n.to} end={n.end}>
            {n.short ?? n.label}
          </NavLink>
        ))}
      </nav>
    </div>
  );
}

/** '/' with nothing to look up opens the start screen; any search state opens the estimate. */
function Home() {
  const [params] = useSearchParams();
  return params.size === 0 ? <SplashPage /> : <EstimatePage />;
}

export function App() {
  return (
    <Routes>
      <Route element={<Shell />}>
        <Route index element={<Home />} />
        <Route path="share" element={<SharePage />} />
        <Route path="departures" element={<DeparturesPage />} />
        <Route path="patterns" element={<PatternsPage />} />
        <Route path="accuracy" element={<AccuracyPage />} />
        <Route path="how-it-works" element={<HowItWorksPage />} />
        <Route path="*" element={<Home />} />
      </Route>
    </Routes>
  );
}
