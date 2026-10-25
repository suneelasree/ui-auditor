import { useEffect, useRef, useState } from 'react';
import { api, type ConfirmResult, type Preview, type Target } from '../api';
import { IconCheck, IconX } from './Icons';

type Step = 'choose' | 'preview' | 'result';

const TARGET_LABEL: Record<Target, string> = { github: 'GitHub Issues', jira: 'Jira' };

export function ExportModal({
  runId,
  findingIds,
  onClose,
  onDone,
}: {
  runId: string;
  findingIds: string[];
  onClose: () => void;
  onDone: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [targets, setTargets] = useState<Record<Target, boolean> | null>(null);
  const [target, setTarget] = useState<Target | null>(null);
  const [step, setStep] = useState<Step>('choose');
  const [preview, setPreview] = useState<Preview | null>(null);
  const [result, setResult] = useState<ConfirmResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const d = ref.current;
    if (d && !d.open) d.showModal();
    api
      .config()
      .then((c) => {
        setTargets(c.targets);
        setTarget(c.targets.github ? 'github' : c.targets.jira ? 'jira' : null);
      })
      .catch((e) => setError(String(e.message ?? e)));
  }, []);

  const close = () => {
    ref.current?.close();
  };

  async function loadPreview() {
    if (!target) return;
    setBusy(true);
    setError(null);
    try {
      setPreview(await api.preview(runId, target, findingIds));
      setStep('preview');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function confirm() {
    if (!target || !preview) return;
    setBusy(true);
    setError(null);
    try {
      setResult(await api.confirm(runId, target, findingIds, preview.previewToken));
      setStep('result');
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const none = targets && !targets.github && !targets.jira;

  return (
    <dialog ref={ref} className="modal" aria-labelledby="export-title" onClose={onClose} data-testid="export-modal">
      <div className="modal-head">
        <h2 id="export-title">
          {step === 'choose' && `Export ${findingIds.length} finding${findingIds.length === 1 ? '' : 's'}`}
          {step === 'preview' && `Preview: ${target ? TARGET_LABEL[target] : ''}`}
          {step === 'result' && 'Export results'}
        </h2>
        <button type="button" className="icon-btn" onClick={close} aria-label="Close" data-testid="export-close">
          <IconX size={18} />
        </button>
      </div>

      <div className="modal-body">
        {error && (
          <div className="alert error" role="alert" data-testid="export-error">
            {error}
          </div>
        )}

        {step === 'choose' && (
          <>
            {!targets && !error && <p className="muted">Loading export targets…</p>}
            {targets && (
              <fieldset className="field">
                <legend>Where should the issues be created?</legend>
                <div className="target-options">
                  {(['github', 'jira'] as const).map((t) => (
                    <label key={t} className={`target-option ${targets[t] ? '' : 'disabled'}`}>
                      <input
                        type="radio"
                        name="target"
                        value={t}
                        checked={target === t}
                        disabled={!targets[t]}
                        onChange={() => setTarget(t)}
                        data-testid={`target-${t}`}
                      />
                      <span>
                        <strong>{TARGET_LABEL[t]}</strong>
                        <span className="muted small block">{targets[t] ? 'Configured' : 'Not configured'}</span>
                      </span>
                    </label>
                  ))}
                </div>
              </fieldset>
            )}
            {none && (
              <div className="alert info" data-testid="export-not-configured">
                <strong>No export target is configured.</strong>
                <p>Add these to <code>.env</code> and restart the server:</p>
                <pre>
                  {`# GitHub Issues
GITHUB_TOKEN=...
GITHUB_REPO=owner/repo

# Jira
JIRA_BASE_URL=https://your-domain.atlassian.net
JIRA_EMAIL=you@example.com
JIRA_API_TOKEN=...
JIRA_PROJECT_KEY=QA
JIRA_ISSUE_TYPE=Bug`}
                </pre>
              </div>
            )}
            <p className="muted small">Nothing is sent until you review the preview and confirm.</p>
          </>
        )}

        {step === 'preview' && preview && (
          <div data-testid="export-preview">
            <p>
              {preview.items.length === 0
                ? 'Nothing new to create.'
                : `${preview.items.length} issue${preview.items.length === 1 ? '' : 's'} will be created in ${TARGET_LABEL[preview.target]}.`}{' '}
              <span className="muted">Nothing has been sent yet.</span>
            </p>
            <ul className="preview-list">
              {preview.items.map((it) => (
                <li key={it.findingId} className="preview-item" data-testid="preview-item">
                  <h3 className="preview-title">{it.title}</h3>
                  <dl className="kv">
                    <dt>Priority</dt>
                    <dd>{it.priority}</dd>
                    <dt>Labels</dt>
                    <dd>
                      {it.labels.map((l) => (
                        <span key={l} className="label-tag">
                          {l}
                        </span>
                      ))}
                    </dd>
                    <dt>Attachments</dt>
                    <dd>
                      {it.attachments.length === 0 ? (
                        <span className="muted">None</span>
                      ) : (
                        <ul className="attach-list">
                          {it.attachments.map((a) => (
                            <li key={a}>
                              <a href={`/reports/${encodeURIComponent(runId)}/${a}`} target="_blank" rel="noopener">
                                {a}
                              </a>
                            </li>
                          ))}
                        </ul>
                      )}
                      {preview.target === 'github' && it.attachments.length > 0 && (
                        <span className="muted small block">GitHub cannot attach files via its API; filenames are listed in the issue body.</span>
                      )}
                    </dd>
                  </dl>
                  <details>
                    <summary>Description</summary>
                    <pre className="preview-body">{it.body}</pre>
                  </details>
                  <details>
                    <summary>Exact request payload</summary>
                    <pre className="preview-body">{JSON.stringify(it.payload, null, 2)}</pre>
                  </details>
                </li>
              ))}
            </ul>
            {preview.skipped.length > 0 && (
              <div className="skipped" data-testid="preview-skipped">
                <h3 className="h-small">Skipped ({preview.skipped.length})</h3>
                <ul>
                  {preview.skipped.map((s) => (
                    <li key={s.findingId}>
                      <strong>{s.findingId}</strong> {s.title}: {s.reason}
                      {s.existing && (
                        <>
                          {' '}
                          <a href={s.existing.url} target="_blank" rel="noopener noreferrer">
                            open
                          </a>
                        </>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}

        {step === 'result' && result && (
          <div data-testid="export-result">
            {result.created.length > 0 && (
              <>
                <h3 className="h-small">Created ({result.created.length})</h3>
                <ul className="result-list">
                  {result.created.map((c) => (
                    <li key={c.findingId}>
                      <span className="ok-icon" aria-hidden="true">
                        <IconCheck size={14} />
                      </span>{' '}
                      {c.findingId}:{' '}
                      <a href={c.url} target="_blank" rel="noopener noreferrer" data-testid="created-issue-link">
                        {c.key}
                      </a>
                      {c.attachmentErrors?.map((e, i) => (
                        <span key={i} className="muted small block">
                          Attachment problem: {e}
                        </span>
                      ))}
                    </li>
                  ))}
                </ul>
              </>
            )}
            {result.errors.length > 0 && (
              <div className="alert error" role="alert">
                <strong>Some issues could not be created</strong>
                <ul>
                  {result.errors.map((e) => (
                    <li key={e.findingId}>
                      {e.findingId}: {e.error}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {result.skipped.length > 0 && <p className="muted">Skipped {result.skipped.length} already exported finding(s).</p>}
          </div>
        )}
      </div>

      <div className="modal-foot">
        {step === 'choose' && (
          <>
            <button type="button" className="btn" onClick={close}>
              Cancel
            </button>
            <button type="button" className="btn primary" disabled={!target || busy} onClick={loadPreview} data-testid="export-preview-button">
              {busy ? 'Building preview…' : 'Preview'}
            </button>
          </>
        )}
        {step === 'preview' && (
          <>
            <button type="button" className="btn" onClick={() => setStep('choose')} disabled={busy}>
              Back
            </button>
            <button
              type="button"
              className="btn primary"
              disabled={busy || !preview || preview.items.length === 0}
              onClick={confirm}
              data-testid="export-confirm"
            >
              {busy ? 'Creating…' : `Confirm and create ${preview?.items.length ?? 0}`}
            </button>
          </>
        )}
        {step === 'result' && (
          <button type="button" className="btn primary" onClick={close} data-testid="export-done">
            Done
          </button>
        )}
      </div>
    </dialog>
  );
}
