import { useEffect, useState } from 'react';
import { api, formatDate, hostOf, shortPage, type RunMeta } from '../api';
import { IconArrowRight } from './Icons';
import { ScoreBadge } from './Ring';

export function StatusBadge({ status }: { status: RunMeta['status'] }) {
  const label = status === 'done' ? 'Done' : status === 'failed' ? 'Failed' : 'Running';
  return (
    <span className={`status-badge status-${status}`}>
      <span className="status-dot" aria-hidden="true" />
      {label}
    </span>
  );
}

export function RunsList({ limit }: { limit?: number }) {
  const [runs, setRuns] = useState<RunMeta[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    api
      .runs()
      .then((r) => alive && setRuns(r.runs))
      .catch((e) => alive && setError(String(e.message ?? e)));
    return () => {
      alive = false;
    };
  }, []);

  if (error) return <p className="alert error" role="alert">Could not load audits: {error}</p>;
  if (!runs)
    return (
      <ul className="runs" aria-busy="true" aria-label="Loading audits">
        {[0, 1].map((i) => (
          <li key={i} className="run-card skeleton" />
        ))}
      </ul>
    );
  const shown = limit ? runs.slice(0, limit) : runs;
  if (shown.length === 0)
    return (
      <div className="empty" data-testid="runs-empty">
        <p>No audits yet.</p>
        <p className="muted small">Paste a link above and press Audit to run your first one.</p>
      </div>
    );

  return (
    <ul className="runs" data-testid="runs-list">
      {shown.map((r) => (
        <li key={r.id}>
          <a href={`#/runs/${r.id}`} className="run-card" data-testid="run-row">
            <ScoreBadge score={r.overall} />
            <span className="run-main">
              <span className="run-host">{r.url ? hostOf(r.url) : r.id}</span>
              <span className="run-path muted small">{r.url ? shortPage(r.url) : ''}</span>
            </span>
            <span className="run-side">
              <StatusBadge status={r.status} />
              <time dateTime={r.createdAt} className="muted small">
                {formatDate(r.createdAt)}
              </time>
            </span>
            <IconArrowRight size={18} className="run-go" />
          </a>
        </li>
      ))}
    </ul>
  );
}
