import { useEffect, useId, useRef, useState, type CSSProperties, type ComponentType } from 'react';
import { hostOf, type ProgressEvent, type RunHints } from '../api';
import {
  IconAlert,
  IconCheck,
  IconChevronDown,
  IconGlobe,
  IconLock,
  IconMinus,
  IconPage,
  IconPalette,
  IconShieldCheck,
  IconSparkles,
  IconUsers,
  IconX,
} from './Icons';
import { GradientRing } from './Ring';

type StageDef = { id: string; label: string; doing: string; color: string; Icon: ComponentType<{ size?: number }> };

// Each step has its own accent colour (also used for the connecting line's gradient).
const STAGES: StageDef[] = [
  { id: 'crawl', label: 'Crawl', doing: 'Visiting pages and taking screenshots', color: '#22d3ee', Icon: IconGlobe },
  { id: 'login', label: 'Sign-in', doing: 'Signing in with your saved session', color: '#f59e0b', Icon: IconLock },
  { id: 'rules', label: 'Checks', doing: 'Running accessibility, UX and functional checks', color: '#8b5cf6', Icon: IconShieldCheck },
  { id: 'agents', label: 'AI review', doing: 'AI specialists are reviewing the evidence', color: '#ec4899', Icon: IconSparkles },
  { id: 'competitors', label: 'Competitors', doing: 'Comparing with your competitors', color: '#f97316', Icon: IconUsers },
  { id: 'design', label: 'Designs', doing: 'Sketching better designs for the top issues', color: '#10b981', Icon: IconPalette },
  { id: 'report', label: 'Report', doing: 'Writing your report', color: '#6366f1', Icon: IconPage },
];

type Status = ProgressEvent['status'] | 'pending';
const STATUS_TEXT: Record<Status, string> = { pending: 'Waiting', started: 'In progress', progress: 'In progress', done: 'Done', skipped: 'Skipped', failed: 'Failed' };

export function ProgressView({ id, url, hints, onFinished }: { id: string; url?: string; hints: RunHints; onFinished: (ok: boolean) => void }) {
  const [events, setEvents] = useState<ProgressEvent[]>([]);
  const [connected, setConnected] = useState(true);
  const [logOpen, setLogOpen] = useState(false);
  const logRef = useRef<HTMLOListElement>(null);
  const finishedRef = useRef(onFinished);
  finishedRef.current = onFinished;
  const lastStageRef = useRef<string | undefined>(undefined);
  const logId = useId();

  useEffect(() => {
    const es = new EventSource(`/api/audits/${encodeURIComponent(id)}/events`);
    let ended = false;
    // The server replays the full history on every (re)connect.
    es.onopen = () => {
      setConnected(true);
      lastStageRef.current = undefined;
      setEvents([]);
    };
    es.onmessage = (m) => {
      try {
        const e = JSON.parse(m.data) as ProgressEvent;
        lastStageRef.current = e.stage;
        setEvents((cur) => [...cur, e]);
      } catch {
        /* ignore */
      }
    };
    es.addEventListener('end', () => {
      ended = true;
      es.close();
      finishedRef.current(lastStageRef.current !== 'error');
    });
    es.onerror = () => {
      if (!ended) setConnected(false);
    };
    return () => es.close();
  }, [id]);

  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [events.length, logOpen]);

  const pct = Math.max(0, ...events.map((e) => e.pct ?? 0));
  const last = events.at(-1);
  const failed = last?.stage === 'error';
  const done = last?.stage === 'done';

  const stageStatus = new Map<string, Status>();
  for (const e of events) {
    if (e.stage === 'done' || e.stage === 'error') continue;
    if (e.agent) {
      if (!stageStatus.has(e.stage)) stageStatus.set(e.stage, 'started');
    } else stageStatus.set(e.stage, e.status);
  }
  if (done) for (const [k, v] of stageStatus) if (v === 'started' || v === 'progress') stageStatus.set(k, 'done');
  if (failed) for (const [k, v] of stageStatus) if (v === 'started' || v === 'progress') stageStatus.set(k, 'failed');
  const visible = STAGES.filter(
    (s) => stageStatus.has(s.id) || (s.id === 'login' ? !!hints.usedSession : s.id === 'competitors' ? (hints.competitors ?? 0) > 0 : true),
  );
  // A later stage having started means the earlier ones are behind us.
  let reached = -1;
  visible.forEach((s, i) => {
    if (stageStatus.has(s.id)) reached = i;
  });
  visible.forEach((s, i) => {
    if (i < reached && !stageStatus.has(s.id)) stageStatus.set(s.id, done ? 'done' : 'skipped');
    if (done && !stageStatus.has(s.id)) stageStatus.set(s.id, 'done');
  });

  const value = done ? 100 : pct;
  const current = [...visible].reverse().find((s) => {
    const st = stageStatus.get(s.id);
    return st === 'started' || st === 'progress';
  });
  // The connecting line fills up to the furthest step reached, in the steps' own colours.
  const lineFrac = done ? 1 : visible.length > 1 ? Math.max(reached, 0) / (visible.length - 1) : 0;
  const lineGrad = `linear-gradient(180deg, ${visible.map((s, i) => `${s.color} ${visible.length > 1 ? Math.round((i / (visible.length - 1)) * 100) : 0}%`).join(', ')})`;
  const accent = current?.color;

  const headline = done
    ? 'All done — opening your report'
    : failed
      ? 'The audit stopped'
      : (current?.doing ?? (events.length ? 'Working…' : 'Getting ready…'));

  return (
    <section
      className={`card progress-card ${done ? 'is-done' : failed ? 'is-failed' : 'is-running'}`}
      aria-labelledby="progress-heading"
      data-testid="progress-view"
      style={accent ? ({ '--accent': accent } as CSSProperties) : undefined}
    >
      <div className="progress-strip" aria-hidden="true">
        <span style={{ width: `${Math.max(value, 2)}%` }} />
      </div>
      <div className="progress-top">
        <p className="eyebrow-sm">{done ? 'Finished' : failed ? 'Stopped' : 'Auditing'}</p>
        <h1 id="progress-heading" className="progress-title">
          {url ? hostOf(url) : 'Your audit'}
        </h1>
        {url && <p className="muted small break">{url}</p>}
      </div>

      <div className="progress-body">
        <div className="progress-ring-col">
          <div
            role="progressbar"
            aria-label="Audit progress"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={value}
            data-testid="progress-bar"
          >
            <GradientRing value={value} size={196} stroke={14} state={failed ? 'failed' : done ? 'done' : 'running'}>
              <span className="ring-num">
                {value}
                <small>%</small>
              </span>
              <span className="ring-sub">{done ? 'complete' : failed ? 'stopped' : 'progress'}</span>
            </GradientRing>
          </div>
          <div className="progress-now" aria-live="polite">
            <p className="progress-headline" data-testid="progress-headline">
              {headline}
            </p>
            <p className="muted small">
              {last && !done && !failed ? last.message : ''}
              {!connected && !done && !failed ? ' · reconnecting…' : ''}
            </p>
            <span className="sr-only" data-testid="progress-status">
              {done ? 'Done' : failed ? 'Failed' : 'Running'}
            </span>
          </div>
        </div>

        <ol
          className="stepper"
          data-testid="stage-list"
          aria-label="Steps"
          style={{ '--line-frac': lineFrac, '--line-grad': lineGrad } as CSSProperties}
        >
          {visible.map((s) => {
            const st = stageStatus.get(s.id) ?? 'pending';
            const running = st === 'started' || st === 'progress';
            const Icon = s.Icon;
            return (
              <li
                key={s.id}
                className={`step st-${running ? 'running' : st}`}
                style={{ '--c': s.color } as CSSProperties}
                data-testid={`stage-${s.id}`}
                data-status={st}
                aria-current={running ? 'step' : undefined}
              >
                <span className="step-chip" aria-hidden="true">
                  {st === 'done' ? <IconCheck size={18} /> : st === 'failed' ? <IconX size={18} /> : st === 'skipped' ? <IconMinus size={18} /> : <Icon size={18} />}
                  {running && <span className="step-spin" />}
                </span>
                <span className="step-text">
                  <span className="step-label">{s.label}</span>
                  <span className="step-state">{STATUS_TEXT[st]}</span>
                </span>
              </li>
            );
          })}
        </ol>
      </div>

      {failed && (
        <div className="alert error" role="alert" data-testid="progress-error">
          <IconAlert size={18} />
          <span>{last?.message}</span>
        </div>
      )}

      <div className="log-wrap">
        <button type="button" className="more-toggle" aria-expanded={logOpen} aria-controls={logId} onClick={() => setLogOpen((o) => !o)} data-testid="show-log">
          {logOpen ? 'Hide log' : 'Show log'}
          <IconChevronDown size={16} className="chev" />
        </button>
        <ol id={logId} className="log" ref={logRef} hidden={!logOpen} data-testid="progress-log" tabIndex={0} aria-label="Progress log">
          {events.map((e, i) => (
            <li key={i}>
              <time dateTime={e.ts}>{new Date(e.ts).toLocaleTimeString()}</time>
              <span className="log-stage">{e.agent ?? e.stage}</span>
              <span className="log-msg">{e.message}</span>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}
