import { useEffect, useRef } from 'react';
import { hostOf } from '../api';
import { IconArrowLeft, IconCheck, LockIllustration, Spinner } from './Icons';

export type SignInPhase =
  | { kind: 'needs-signin'; origin: string; notice?: string; busy?: boolean }
  | { kind: 'waiting'; id: string; origin: string; message: string; busy?: boolean }
  | { kind: 'saved'; origin: string };

export function SignInPanel({
  phase,
  onSignIn,
  onAuditAnyway,
  onDone,
  onCancel,
  onBack,
}: {
  phase: SignInPhase;
  onSignIn: () => void;
  onAuditAnyway: () => void;
  onDone: () => void;
  onCancel: () => void;
  onBack: () => void;
}) {
  const headingRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    headingRef.current?.focus();
  }, [phase.kind]);
  const host = hostOf(phase.origin);

  if (phase.kind === 'saved') {
    return (
      <div className="signin-panel" data-testid="signin-saved">
        <div className="success-tick" aria-hidden="true">
          <IconCheck size={40} />
        </div>
        <h2 ref={headingRef} tabIndex={-1}>
          You're signed in
        </h2>
        <p className="muted" role="status">
          Session saved for {host}. Starting the audit…
        </p>
      </div>
    );
  }

  if (phase.kind === 'waiting') {
    return (
      <div className="signin-panel" data-testid="signin-waiting">
        <div className="waiting-orb" aria-hidden="true">
          <Spinner size={44} />
        </div>
        <h2 ref={headingRef} tabIndex={-1}>
          Finish signing in in the window that opened…
        </h2>
        <p className="muted" role="status" aria-live="polite">
          Sign in to {host} as you normally do. We'll continue automatically once you're in.
        </p>
        <div className="signin-actions">
          <button type="button" className="btn primary lg" onClick={onDone} disabled={phase.busy} data-testid="signin-done">
            <IconCheck size={18} />
            I'm signed in
          </button>
          <button type="button" className="btn ghost lg" onClick={onCancel} disabled={phase.busy} data-testid="signin-cancel">
            Cancel
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="signin-panel" data-testid="signin-card">
      <LockIllustration />
      <h2 ref={headingRef} tabIndex={-1}>
        This page needs you to sign in
      </h2>
      <p className="signin-explain">
        We'll open a browser window. Sign in as you normally do — your password never touches UI Auditor. We'll remember the session for this site.
      </p>
      <p className="signin-site">
        <span className="dot" aria-hidden="true" />
        {host}
      </p>
      {phase.notice && (
        <p className="alert warn" role="alert" data-testid="signin-notice">
          {phase.notice}
        </p>
      )}
      <div className="signin-actions">
        <button type="button" className="btn primary lg" onClick={onSignIn} disabled={phase.busy} data-testid="signin-start">
          {phase.busy ? <Spinner size={18} /> : null}
          {phase.busy ? 'Opening window…' : 'Sign in'}
        </button>
        <button type="button" className="btn secondary lg" onClick={onAuditAnyway} disabled={phase.busy} data-testid="audit-signin-page">
          Audit the sign-in page instead
        </button>
      </div>
      <button type="button" className="btn link back-link" onClick={onBack}>
        <IconArrowLeft size={16} />
        Use a different URL
      </button>
    </div>
  );
}
