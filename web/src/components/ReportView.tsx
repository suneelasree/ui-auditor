import { useMemo, useState, type KeyboardEvent } from 'react';
import { formatDate, hostOf, shortPage, type ExportedRef, type Finding, type Report, type RunMeta } from '../api';
import { ExportModal } from './ExportModal';
import { IconExternal, IconPlus, IconUpload } from './Icons';
import { Ring, scoreTone, scoreWord } from './Ring';

const SEVERITIES = ['Critical', 'High', 'Medium', 'Low'] as const;
type Tab = 'findings' | 'report';

function domainLabel(d: string): string {
  return d.replace('-', ' ').replace(/^\w/, (c) => c.toUpperCase()).replace('Saas', 'SaaS');
}

export function ReportView({
  id,
  meta,
  report,
  exported,
  onExported,
}: {
  id: string;
  meta: RunMeta;
  report: Report;
  exported: Record<string, ExportedRef[]>;
  onExported: () => void;
}) {
  const [tab, setTab] = useState<Tab>('findings');
  const [reportLoaded, setReportLoaded] = useState(false);
  const [severity, setSeverity] = useState<string>('all');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [exportOpen, setExportOpen] = useState(false);

  const visible = useMemo(() => report.findings.filter((f) => severity === 'all' || f.severity === severity), [report.findings, severity]);
  const allVisibleSelected = visible.length > 0 && visible.every((f) => selected.has(f.id));
  const byId = useMemo(() => new Map(report.findings.map((f) => [f.id, f])), [report.findings]);
  const top = report.summary.topIssues
    .map((fid) => byId.get(fid))
    .filter((f): f is Finding => !!f)
    .slice(0, 6);
  const counts = report.summary.counts;
  const score = report.scores.overall;
  const target = report.target || meta.url;

  const toggle = (fid: string) =>
    setSelected((cur) => {
      const next = new Set(cur);
      if (next.has(fid)) next.delete(fid);
      else next.add(fid);
      return next;
    });

  const toggleAll = () =>
    setSelected((cur) => {
      const next = new Set(cur);
      if (allVisibleSelected) visible.forEach((f) => next.delete(f.id));
      else visible.forEach((f) => next.add(f.id));
      return next;
    });

  const openTab = (t: Tab) => {
    setTab(t);
    if (t === 'report') setReportLoaded(true);
  };
  const onTabKey = (e: KeyboardEvent) => {
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      const next: Tab = tab === 'findings' ? 'report' : 'findings';
      openTab(next);
      document.getElementById(`tab-${next}`)?.focus();
    }
  };

  const reportUrl = `/reports/${encodeURIComponent(id)}/report.html`;

  return (
    <div className="report-page" data-testid="report-view">
      <section className="card report-hero" aria-labelledby="report-heading">
        <div className="report-score" data-testid="report-score">
          <Ring value={score} size={136} stroke={12} tone={scoreTone(score)}>
            <span className="ring-num">{score}</span>
            <span className="ring-sub">of 100</span>
          </Ring>
          <span className={`score-word tone-${scoreTone(score)}`}>{scoreWord(score)}</span>
        </div>
        <div className="report-info">
          <p className="eyebrow-sm">Audit report</p>
          <h1 id="report-heading" className="report-title">
            {hostOf(target)}
          </h1>
          <p className="muted small break">
            <a href={target} target="_blank" rel="noopener noreferrer" className="quiet-link">
              {target}
            </a>
          </p>
          <p className="report-meta">
            <span>
              <strong>{report.summary.pagesAudited}</strong> page{report.summary.pagesAudited === 1 ? '' : 's'} audited
            </span>
            <span aria-hidden="true">·</span>
            <span>{domainLabel(report.domain.name)}</span>
            <span aria-hidden="true">·</span>
            <time dateTime={report.finishedAt}>{formatDate(report.finishedAt || meta.finishedAt)}</time>
          </p>
          <ul className="sev-pills" aria-label="Findings by severity" data-testid="severity-counts">
            {SEVERITIES.map((s) => (
              <li key={s} className={`sev-pill sev-${s.toLowerCase()} ${counts[s] ? '' : 'zero'}`}>
                <strong>{counts[s] ?? 0}</strong> {s}
              </li>
            ))}
          </ul>
        </div>
        <div className="report-actions">
          <a href={reportUrl} target="_blank" rel="noopener" className="btn secondary" data-testid="open-report">
            Open full report <IconExternal size={16} />
          </a>
          <a href="#/" className="btn ghost">
            <IconPlus size={16} /> New audit
          </a>
        </div>
        <ul className="cat-scores" aria-label="Scores by area">
          {Object.entries(report.scores.byCategory).map(([cat, v]) => (
            <li key={cat}>
              <span className="cat-name">{cat}</span>
              <span className="cat-bar" aria-hidden="true">
                <span className={`tone-${scoreTone(v)}`} style={{ width: `${v}%` }} />
              </span>
              <span className="cat-val">{v}</span>
            </li>
          ))}
        </ul>
      </section>

      {top.length > 0 && (
        <section aria-labelledby="top-heading" className="section">
          <div className="section-head">
            <h2 id="top-heading">Top issues</h2>
            <span className="muted small">Fix these first</span>
          </div>
          <ul className="top-issues" data-testid="top-issues">
            {top.map((f) => (
              <li key={f.id} className={`issue-card sev-edge-${f.severity.toLowerCase()}`} data-testid="top-issue">
                <div className="issue-top">
                  <span className={`sev sev-${f.severity.toLowerCase()}`}>{f.severity}</span>
                  <span className="muted small">{f.category}</span>
                </div>
                <h3 className="issue-title">{f.title}</h3>
                <p className="issue-page muted small">{shortPage(f.page)}</p>
                <p className="issue-rec">{f.recommendation}</p>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="card tabs-card" aria-label="Details">
        <div className="tabs" role="tablist" aria-label="Report sections">
          <button
            id="tab-findings"
            type="button"
            role="tab"
            aria-selected={tab === 'findings'}
            aria-controls="panel-findings"
            tabIndex={tab === 'findings' ? 0 : -1}
            onClick={() => openTab('findings')}
            onKeyDown={onTabKey}
            data-testid="tab-findings"
          >
            All findings <span className="count">{report.findings.length}</span>
          </button>
          <button
            id="tab-report"
            type="button"
            role="tab"
            aria-selected={tab === 'report'}
            aria-controls="panel-report"
            tabIndex={tab === 'report' ? 0 : -1}
            onClick={() => openTab('report')}
            onKeyDown={onTabKey}
            data-testid="tab-report"
          >
            Full report
          </button>
        </div>

        <div id="panel-findings" role="tabpanel" aria-labelledby="tab-findings" hidden={tab !== 'findings'} data-testid="findings-panel">
          <div className="findings-toolbar">
            <div className="filter-row" role="group" aria-label="Filter by severity">
              {['all', ...SEVERITIES].map((s) => (
                <button
                  key={s}
                  type="button"
                  className={`filter-chip ${severity === s ? 'active' : ''}`}
                  aria-pressed={severity === s}
                  onClick={() => setSeverity(s)}
                  data-testid={`filter-${s}`}
                >
                  {s === 'all' ? 'All' : s}
                  <span className="count">{s === 'all' ? report.findings.length : report.findings.filter((f) => f.severity === s).length}</span>
                </button>
              ))}
            </div>
            <div className="select-row">
              <label className="inline-check">
                <input type="checkbox" checked={allVisibleSelected} onChange={toggleAll} disabled={visible.length === 0} data-testid="select-all" />
                Select all
              </label>
              <button type="button" className="btn primary" disabled={selected.size === 0} onClick={() => setExportOpen(true)} data-testid="export-button">
                <IconUpload size={16} />
                <span>Export{selected.size ? ` (${selected.size})` : ''}</span>
              </button>
            </div>
          </div>
          {visible.length === 0 ? (
            <p className="empty muted">No findings at this severity.</p>
          ) : (
            <ul className="findings" data-testid="findings-list">
              {visible.map((f) => (
                <FindingRow key={f.id} f={f} checked={selected.has(f.id)} onToggle={() => toggle(f.id)} exported={exported[f.id]} />
              ))}
            </ul>
          )}
        </div>

        <div id="panel-report" role="tabpanel" aria-labelledby="tab-report" hidden={tab !== 'report'} className="report-panel">
          <div className="report-panel-links">
            <a href={reportUrl} target="_blank" rel="noopener">
              Open in new tab <IconExternal size={14} />
            </a>
            <a href={`/reports/${encodeURIComponent(id)}/report.md`} target="_blank" rel="noopener">
              Markdown <IconExternal size={14} />
            </a>
          </div>
          {reportLoaded && (
            <iframe
              title="Full audit report"
              src={reportUrl}
              className="report-frame"
              sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox"
              data-testid="report-iframe"
            />
          )}
        </div>
      </section>

      {report.notes.length > 0 && (
        <ul className="notes muted small" aria-label="Notes">
          {report.notes.map((n, i) => (
            <li key={i}>{n}</li>
          ))}
        </ul>
      )}

      {exportOpen && (
        <ExportModal
          runId={id}
          findingIds={[...selected]}
          onClose={() => setExportOpen(false)}
          onDone={() => {
            setSelected(new Set());
            onExported();
          }}
        />
      )}
    </div>
  );
}

function FindingRow({ f, checked, onToggle, exported }: { f: Finding; checked: boolean; onToggle: () => void; exported?: ExportedRef[] }) {
  const inputId = `f-${f.id}`;
  return (
    <li className={`finding ${checked ? 'selected' : ''}`} data-testid="finding-row" data-finding-id={f.id}>
      <input id={inputId} type="checkbox" checked={checked} onChange={onToggle} data-testid={`finding-check-${f.id}`} />
      <label htmlFor={inputId} className="finding-body">
        <span className="finding-top">
          <span className={`sev sev-${f.severity.toLowerCase()}`}>{f.severity}</span>
          <span className="muted small">{f.category}</span>
          <span className="muted small mono">{f.id}</span>
        </span>
        <span className="finding-title">{f.title}</span>
        <span className="muted small finding-page">
          {shortPage(f.page)} · {f.viewport === 'all' ? 'all screen sizes' : f.viewport}
        </span>
        <span className="finding-rec small">{f.recommendation}</span>
      </label>
      {exported && exported.length > 0 && (
        <span className="exported">
          {exported.map((e) => (
            <a key={e.target} href={e.url} target="_blank" rel="noopener noreferrer" className="exported-badge" data-testid={`exported-${f.id}`}>
              Exported {e.target === 'github' ? 'GitHub' : 'Jira'} {e.key}
            </a>
          ))}
        </span>
      )}
    </li>
  );
}
