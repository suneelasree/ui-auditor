import { useEffect, useState } from 'react';
import { Home } from './components/Home';
import { BrandMark, IconHistory, IconPlus } from './components/Icons';
import { RunPage } from './components/RunPage';
import { RunsList } from './components/RunsList';
import { ThemeToggle } from './components/ThemeToggle';

type Route = { name: 'new' } | { name: 'history' } | { name: 'run'; id: string };

function parseHash(hash: string): Route {
  const m = hash.match(/^#\/runs\/([A-Za-z0-9-]+)/);
  if (m) return { name: 'run', id: m[1] };
  if (hash.startsWith('#/runs')) return { name: 'history' };
  return { name: 'new' };
}

export function navigate(path: string): void {
  window.location.hash = path;
}

export function App() {
  const [route, setRoute] = useState<Route>(() => parseHash(window.location.hash));

  useEffect(() => {
    const onHash = () => {
      setRoute(parseHash(window.location.hash));
      window.scrollTo(0, 0);
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  useEffect(() => {
    document.getElementById('main')?.focus({ preventScroll: true });
    document.title = route.name === 'history' ? 'History · UI Auditor' : route.name === 'run' ? 'Audit · UI Auditor' : 'UI Auditor';
  }, [route]);

  return (
    <>
      <a
        className="skip-link"
        href="#main"
        onClick={(e) => {
          e.preventDefault();
          document.getElementById('main')?.focus();
        }}
      >
        Skip to content
      </a>
      <header className="topbar">
        <div className="topbar-inner">
          <a className="brand" href="#/" aria-label="UI Auditor home">
            <BrandMark size={30} />
            <span>UI Auditor</span>
          </a>
          <div className="topbar-right">
            <nav aria-label="Main" className="nav">
              <a href="#/" aria-current={route.name === 'new' ? 'page' : undefined} data-testid="nav-new">
                <IconPlus size={16} />
                <span>New audit</span>
              </a>
              <a href="#/runs" aria-current={route.name === 'history' ? 'page' : undefined} data-testid="nav-history">
                <IconHistory size={16} />
                <span>History</span>
              </a>
            </nav>
            <ThemeToggle />
          </div>
        </div>
      </header>
      <main id="main" tabIndex={-1} className={`main-${route.name}`}>
        {route.name === 'new' && <Home onStarted={(id) => navigate(`/runs/${id}`)} />}
        {route.name === 'history' && (
          <section className="container section" aria-labelledby="history-heading">
            <div className="page-head">
              <h1 id="history-heading">History</h1>
              <p className="muted">Every audit you've run, newest first.</p>
            </div>
            <RunsList />
          </section>
        )}
        {route.name === 'run' && (
          <div className="container section">
            <RunPage key={route.id} id={route.id} />
          </div>
        )}
      </main>
      <footer className="footer muted small">UI Auditor runs locally. Sign-ins stay on this machine.</footer>
    </>
  );
}
