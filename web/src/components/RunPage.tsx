import { useCallback, useEffect, useState } from 'react';
import { api, loadRunHints, type RunDetail } from '../api';
import { IconArrowLeft, IconPlus } from './Icons';
import { ProgressView } from './ProgressView';
import { ReportView } from './ReportView';

export function RunPage({ id }: { id: string }) {
  const [detail, setDetail] = useState<RunDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hints] = useState(() => loadRunHints(id));

  const load = useCallback(() => {
    api
      .run(id)
      .then((d) => {
        setDetail(d);
        setError(null);
      })
      .catch((e) => setError(String(e.message ?? e)));
  }, [id]);

  useEffect(load, [load]);

  const onFinished = useCallback(() => {
    // The report files land just before the stream ends; retry briefly if they're not there yet.
    let tries = 0;
    const tick = () =>
      api
        .run(id)
        .then((d) => {
          setDetail(d);
          if (!d.report && d.meta.status === 'running' && ++tries < 10) window.setTimeout(tick, 800);
        })
        .catch((e) => setError(String(e.message ?? e)));
    void tick();
  }, [id]);

  if (error && !detail) {
    return (
      <div className="card narrow center">
        <p className="alert error" role="alert">
          {error}
        </p>
        <a href="#/runs" className="btn secondary">
          <IconArrowLeft size={16} /> Back to history
        </a>
      </div>
    );
  }
  if (!detail)
    return (
      <p className="muted center pad" role="status">
        Loading…
      </p>
    );

  const { meta, report } = detail;

  if (report) return <ReportView id={id} meta={meta} report={report} exported={detail.exported} onExported={load} />;

  return (
    <div className="narrow">
      <ProgressView id={id} url={meta.url} hints={hints} onFinished={onFinished} />
      {meta.status === 'failed' && (
        <div className="center pad">
          <a href="#/" className="btn primary">
            <IconPlus size={16} /> Start a new audit
          </a>
        </div>
      )}
    </div>
  );
}
