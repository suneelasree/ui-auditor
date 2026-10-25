import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { api, ApiError, hostOf, saveRunHints, type AuditOptionsInput, type SavedSession, type SignInState } from '../api';
import {
  IconAccessibility,
  IconArrowRight,
  IconBug,
  IconChevronDown,
  IconEye,
  IconGauge,
  IconGlobe,
  IconLock,
  IconPage,
  IconSitemap,
  IconSliders,
  IconX,
  Spinner,
} from './Icons';
import { RunsList } from './RunsList';
import { SignInPanel, type SignInPhase } from './SignInPanel';

const DOMAINS = ['real-estate', 'ecommerce', 'saas', 'healthcare', 'banking', 'travel', 'education', 'generic'] as const;
const VIEWPORTS = [
  { id: 'desktop', label: 'Desktop' },
  { id: 'tablet', label: 'Tablet' },
  { id: 'mobile', label: 'Mobile' },
] as const;
type ViewportId = (typeof VIEWPORTS)[number]['id'];
type Scope = 'page' | 'site';

type Phase = { kind: 'idle' } | { kind: 'checking' } | { kind: 'starting' } | SignInPhase;

function domainLabel(d: string): string {
  return d.replace('-', ' ').replace(/^\w/, (c) => c.toUpperCase()).replace('Saas', 'SaaS');
}

/** "example.com" -> "https://example.com"; returns null for anything that isn't an http(s) URL. */
function normalizeUrl(raw: string): string | null {
  let s = raw.trim();
  if (!s) return null;
  if (!/^[a-z][a-z\d+.-]*:\/\//i.test(s)) s = `https://${s}`;
  try {
    const u = new URL(s);
    if (!/^https?:$/.test(u.protocol) || (!u.hostname.includes('.') && u.hostname !== 'localhost')) return null;
    return u.toString();
  } catch {
    return null;
  }
}

/** Deep links (query string or hash route) usually mean "this exact page". */
function suggestScope(raw: string): Scope {
  return /\?|#[/!]/.test(raw) ? 'page' : 'site';
}

export function Home({ onStarted }: { onStarted: (id: string) => void }) {
  const [url, setUrl] = useState('');
  const [scope, setScope] = useState<Scope>('site');
  const [scopeTouched, setScopeTouched] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [viewports, setViewports] = useState<ViewportId[]>(['desktop', 'tablet', 'mobile']);
  const [domain, setDomain] = useState('auto');
  const [competitors, setCompetitors] = useState(['', '']);
  const [lighthouse, setLighthouse] = useState(true);
  const [allowForms, setAllowForms] = useState(false);
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  const [error, setError] = useState<{ message: string; runningId?: string } | null>(null);
  const [sessions, setSessions] = useState<SavedSession[]>([]);
  const pending = useRef<AuditOptionsInput | null>(null);
  const urlRef = useRef<HTMLInputElement>(null);
  const moreId = useId();

  const loadSessions = useCallback(() => {
    api
      .sessions()
      .then((r) => setSessions(r.sessions ?? []))
      .catch(() => setSessions([]));
  }, []);
  useEffect(loadSessions, [loadSessions]);

  const onUrlChange = (v: string) => {
    setUrl(v);
    if (!scopeTouched) setScope(suggestScope(v));
  };

  const toggleViewport = (v: ViewportId) => setViewports((cur) => (cur.includes(v) ? cur.filter((x) => x !== v) : [...cur, v]));

  const startAudit = useCallback(
    async (options: AuditOptionsInput) => {
      setPhase({ kind: 'starting' });
      try {
        const res = await api.start(options);
        saveRunHints(res.id, { usedSession: !!res.usedSession, competitors: options.competitors?.length ?? 0 });
        onStarted(res.id);
      } catch (err) {
        const runningId = err instanceof ApiError && typeof err.data.id === 'string' ? err.data.id : undefined;
        const issues = err instanceof ApiError && err.issues.length ? `: ${err.issues.map((i) => i.message).join('; ')}` : '';
        setError({ message: (err instanceof Error ? err.message : String(err)) + issues, runningId });
        setPhase({ kind: 'idle' });
      }
    },
    [onStarted],
  );

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    const target = normalizeUrl(url);
    if (!target) {
      setError({ message: 'Enter a web address, for example https://example.com' });
      urlRef.current?.focus();
      return;
    }
    if (viewports.length === 0) {
      setMoreOpen(true);
      setError({ message: 'Pick at least one viewport under More options.' });
      return;
    }
    const comps: string[] = [];
    for (const c of competitors) {
      if (!c.trim()) continue;
      const n = normalizeUrl(c);
      if (!n) {
        setMoreOpen(true);
        setError({ message: `"${c.trim()}" is not a valid competitor URL.` });
        return;
      }
      comps.push(n);
    }
    const options: AuditOptionsInput = {
      url: target,
      depth: scope === 'page' ? 0 : 2,
      maxPages: scope === 'page' ? 1 : 15,
      domain: domain as AuditOptionsInput['domain'],
      viewports,
      competitors: comps,
      lighthouse,
      allowForms,
    };
    pending.current = options;
    setPhase({ kind: 'checking' });
    try {
      const res = await api.check(target);
      if (res.needsSignIn) {
        setPhase({ kind: 'needs-signin', origin: res.origin || target });
        return;
      }
    } catch (err) {
      if (err instanceof ApiError && err.status === 400) {
        setError({ message: err.message });
        setPhase({ kind: 'idle' });
        return;
      }
      // The pre-check is best effort: if it can't run, just audit.
    }
    await startAudit(options);
  }

  // ---------- Sign-in flow ----------

  const handleSignInState = useCallback(
    (s: SignInState) => {
      if (s.status === 'waiting') {
        setPhase((p) => (p.kind === 'waiting' ? { ...p, message: s.message, busy: false } : p));
        return;
      }
      if (s.status === 'saved') {
        setPhase({ kind: 'saved', origin: s.origin });
        loadSessions();
        window.setTimeout(() => {
          if (pending.current) void startAudit(pending.current);
        }, 900);
        return;
      }
      const fallback =
        s.status === 'cancelled' ? 'Sign-in was cancelled.' : s.status === 'timeout' ? 'Sign-in timed out. Try again.' : 'Sign-in failed. Try again.';
      setPhase({ kind: 'needs-signin', origin: s.origin, notice: s.message || fallback });
    },
    [loadSessions, startAudit],
  );

  const waitingId = phase.kind === 'waiting' ? phase.id : null;
  useEffect(() => {
    if (!waitingId) return;
    let alive = true;
    const t = window.setInterval(() => {
      api
        .signInStatus(waitingId)
        .then((s) => alive && handleSignInState(s))
        .catch(() => undefined);
    }, 1000);
    return () => {
      alive = false;
      window.clearInterval(t);
    };
  }, [waitingId, handleSignInState]);

  async function beginSignIn() {
    if (phase.kind !== 'needs-signin' || !pending.current) return;
    const origin = phase.origin;
    setPhase({ ...phase, busy: true, notice: undefined });
    try {
      const { id } = await api.signIn(pending.current.url);
      setPhase({ kind: 'waiting', id, origin, message: '' });
    } catch (err) {
      if (err instanceof ApiError && err.status === 409 && typeof err.data.id === 'string') {
        setPhase({ kind: 'waiting', id: err.data.id, origin, message: '' });
        return;
      }
      setPhase({ kind: 'needs-signin', origin, notice: err instanceof Error ? err.message : String(err) });
    }
  }

  async function signedIn() {
    if (phase.kind !== 'waiting') return;
    setPhase({ ...phase, busy: true });
    try {
      handleSignInState(await api.signInDone(phase.id));
    } catch (err) {
      setPhase({ kind: 'needs-signin', origin: phase.origin, notice: err instanceof Error ? err.message : String(err) });
    }
  }

  async function cancelSignIn() {
    if (phase.kind !== 'waiting') return;
    const { id, origin } = phase;
    setPhase({ kind: 'needs-signin', origin, notice: 'Sign-in cancelled.' });
    await api.signInCancel(id).catch(() => undefined);
  }

  async function forget(origin: string) {
    setSessions((cur) => cur.filter((s) => s.origin !== origin));
    try {
      await api.forgetSession(origin);
    } finally {
      loadSessions();
    }
  }

  const inFlow = phase.kind === 'needs-signin' || phase.kind === 'waiting' || phase.kind === 'saved';
  const busy = phase.kind === 'checking' || phase.kind === 'starting';

  return (
    <>
      <section className="hero" aria-labelledby="hero-heading">
        <div className="hero-inner">
          <p className="eyebrow">
            <IconSparkles16 /> UI Auditor
          </p>
          <h1 id="hero-heading" className="hero-title">
            Find UX, accessibility, performance and functional issues <span className="grad-text">on any page</span>
          </h1>
          <p className="hero-sub">Paste a link. Get a scored report with clear fixes in a few minutes.</p>

          <div className="hero-card" data-testid="audit-card">
            {inFlow ? (
              <SignInPanel
                phase={phase}
                onSignIn={beginSignIn}
                onAuditAnyway={() => pending.current && startAudit(pending.current)}
                onDone={signedIn}
                onCancel={cancelSignIn}
                onBack={() => {
                  setPhase({ kind: 'idle' });
                  window.setTimeout(() => urlRef.current?.focus(), 0);
                }}
              />
            ) : (
              <form onSubmit={submit} noValidate data-testid="audit-form" aria-busy={busy}>
                <label htmlFor="url" className="sr-only">
                  Website URL
                </label>
                <div className={`url-row ${error && !error.runningId ? 'has-error' : ''}`}>
                  <span className="url-icon" aria-hidden="true">
                    <IconGlobe size={22} />
                  </span>
                  <input
                    ref={urlRef}
                    id="url"
                    name="url"
                    type="text"
                    inputMode="url"
                    autoComplete="url"
                    spellCheck={false}
                    autoCapitalize="off"
                    placeholder="https://your-site.com/page"
                    value={url}
                    onChange={(e) => onUrlChange(e.target.value)}
                    disabled={busy}
                    aria-describedby="url-status"
                    aria-invalid={error && !error.runningId ? true : undefined}
                    data-testid="url-input"
                  />
                  <button type="submit" className="btn primary audit-btn" disabled={busy} data-testid="start-audit">
                    {busy ? <Spinner size={18} /> : null}
                    <span>{phase.kind === 'checking' ? 'Checking…' : phase.kind === 'starting' ? 'Starting…' : 'Audit'}</span>
                    {!busy && <IconArrowRight size={18} />}
                  </button>
                </div>

                <div className="form-row">
                  <div className="segmented" role="radiogroup" aria-label="What to audit">
                    <label className={scope === 'page' ? 'on' : ''}>
                      <input
                        type="radio"
                        name="scope"
                        value="page"
                        checked={scope === 'page'}
                        onChange={() => {
                          setScope('page');
                          setScopeTouched(true);
                        }}
                        data-testid="scope-page"
                      />
                      <IconPage size={16} />
                      This page
                    </label>
                    <label className={scope === 'site' ? 'on' : ''}>
                      <input
                        type="radio"
                        name="scope"
                        value="site"
                        checked={scope === 'site'}
                        onChange={() => {
                          setScope('site');
                          setScopeTouched(true);
                        }}
                        data-testid="scope-site"
                      />
                      <IconSitemap size={16} />
                      Whole site
                    </label>
                  </div>
                  <button
                    type="button"
                    className={`more-toggle ${moreOpen ? 'open' : ''}`}
                    aria-expanded={moreOpen}
                    aria-controls={moreId}
                    onClick={() => setMoreOpen((o) => !o)}
                    data-testid="more-options"
                  >
                    <IconSliders size={16} />
                    More options
                    <IconChevronDown size={16} className="chev" />
                  </button>
                </div>
                <p className="scope-hint muted small">
                  {scope === 'page' ? 'Audits just this page.' : 'Follows links from this page, up to 15 pages.'}
                </p>

                <div id={moreId} className="more-panel" hidden={!moreOpen}>
                  <fieldset className="opt-group">
                    <legend>Screen sizes</legend>
                    <div className="chips">
                      {VIEWPORTS.map((v) => (
                        <label key={v.id} className="chip-check">
                          <input type="checkbox" checked={viewports.includes(v.id)} onChange={() => toggleViewport(v.id)} data-testid={`viewport-${v.id}`} />
                          <span>{v.label}</span>
                        </label>
                      ))}
                    </div>
                  </fieldset>
                  <div className="opt-group">
                    <label htmlFor="domain" className="opt-label">
                      Industry
                    </label>
                    <select id="domain" value={domain} onChange={(e) => setDomain(e.target.value)} data-testid="domain-select">
                      <option value="auto">Detect automatically</option>
                      {DOMAINS.map((d) => (
                        <option key={d} value={d}>
                          {domainLabel(d)}
                        </option>
                      ))}
                    </select>
                  </div>
                  <fieldset className="opt-group span-2">
                    <legend>Compare with competitors (optional)</legend>
                    <div className="grid-2">
                      {competitors.map((c, i) => (
                        <input
                          key={i}
                          type="text"
                          inputMode="url"
                          aria-label={`Competitor URL ${i + 1}`}
                          placeholder={`https://competitor-${i + 1}.com`}
                          value={c}
                          onChange={(e) => setCompetitors((cur) => cur.map((x, j) => (j === i ? e.target.value : x)))}
                          data-testid={`competitor-${i + 1}`}
                        />
                      ))}
                    </div>
                  </fieldset>
                  <label className="switch">
                    <input type="checkbox" role="switch" checked={lighthouse} onChange={(e) => setLighthouse(e.target.checked)} data-testid="lighthouse" />
                    <span className="switch-ui" aria-hidden="true" />
                    <span>
                      <strong>Performance scan</strong>
                      <span className="muted small block">Lighthouse run per page. Slower, more detail.</span>
                    </span>
                  </label>
                  <label className="switch">
                    <input type="checkbox" role="switch" checked={allowForms} onChange={(e) => setAllowForms(e.target.checked)} data-testid="allow-forms" />
                    <span className="switch-ui" aria-hidden="true" />
                    <span>
                      <strong>Test forms</strong>
                      <span className="muted small block">Submit forms empty to check validation. Off = read-only.</span>
                    </span>
                  </label>
                </div>

                <div id="url-status" aria-live="polite" className="status-line">
                  {phase.kind === 'checking' && (
                    <span className="checking" data-testid="checking">
                      <Spinner size={16} /> Checking the page…
                    </span>
                  )}
                </div>
                {error && (
                  <div className="alert error" role="alert" data-testid="form-error">
                    {error.message}
                    {error.runningId && (
                      <>
                        {' '}
                        <a href={`#/runs/${error.runningId}`}>View the running audit</a>
                      </>
                    )}
                  </div>
                )}
              </form>
            )}

            {sessions.length > 0 && !inFlow && (
              <ul className="session-chips" aria-label="Saved sign-ins" data-testid="sessions">
                {sessions.map((s) => (
                  <li key={s.origin} className="session-chip" data-testid="session-chip">
                    <IconLock size={14} />
                    <span>
                      Signed in · <strong>{hostOf(s.origin)}</strong>
                    </span>
                    <button
                      type="button"
                      className="chip-forget"
                      onClick={() => forget(s.origin)}
                      aria-label={`Forget sign-in for ${hostOf(s.origin)}`}
                      data-testid="session-forget"
                    >
                      Forget
                      <IconX size={12} />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <ul className="checks-row" aria-label="What UI Auditor checks">
            <li>
              <IconEye size={18} /> UX &amp; design
            </li>
            <li>
              <IconAccessibility size={18} /> Accessibility
            </li>
            <li>
              <IconGauge size={18} /> Performance
            </li>
            <li>
              <IconBug size={18} /> Functional
            </li>
          </ul>
        </div>
      </section>

      <section className="container section" aria-labelledby="recent-heading">
        <div className="section-head">
          <h2 id="recent-heading">Recent audits</h2>
          <a href="#/runs" className="link-arrow">
            View all <IconArrowRight size={16} />
          </a>
        </div>
        <RunsList limit={4} />
      </section>
    </>
  );
}

function IconSparkles16() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="currentColor">
      <path d="M12 2l2.2 5.8L20 10l-5.8 2.2L12 18l-2.2-5.8L4 10l5.8-2.2L12 2z" />
    </svg>
  );
}
