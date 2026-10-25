import { useId, type CSSProperties, type ReactNode } from 'react';

export type Tone = 'good' | 'ok' | 'bad' | 'primary' | 'failed';

export function scoreTone(score: number): Tone {
  return score >= 80 ? 'good' : score >= 60 ? 'ok' : 'bad';
}

export function scoreWord(score: number): string {
  return score >= 90 ? 'Excellent' : score >= 80 ? 'Good' : score >= 60 ? 'Needs work' : 'Poor';
}

/** Two-stop gradient per tone, used for the score ring stroke. */
const TONE_GRAD: Record<Tone, [string, string]> = {
  good: ['#34d399', '#14b8a6'],
  ok: ['#fbbf24', '#f97316'],
  bad: ['#fb7185', '#ef4444'],
  failed: ['#fb7185', '#ef4444'],
  primary: ['#8b5cf6', '#6366f1'],
};

/** Circular score ring with a gradient stroke. The caller provides the accessible text. */
export function Ring({
  value,
  size = 160,
  stroke = 12,
  tone = 'primary',
  children,
}: {
  value: number;
  size?: number;
  stroke?: number;
  tone?: Tone;
  children?: ReactNode;
}) {
  const gid = `rg-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const v = Math.max(0, Math.min(100, value));
  const [a, b] = TONE_GRAD[tone];
  return (
    <div className={`ring tone-${tone}`} style={{ width: size, height: size }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true" focusable="false">
        <defs>
          <linearGradient id={gid} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor={a} />
            <stop offset="1" stopColor={b} />
          </linearGradient>
        </defs>
        <circle className="ring-track" cx={size / 2} cy={size / 2} r={r} strokeWidth={stroke} fill="none" />
        <circle
          className="ring-value"
          cx={size / 2}
          cy={size / 2}
          r={r}
          stroke={`url(#${gid})`}
          strokeWidth={stroke}
          fill="none"
          strokeLinecap="round"
          strokeDasharray={c}
          strokeDashoffset={c * (1 - v / 100)}
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
        />
      </svg>
      <div className="ring-center">{children}</div>
    </div>
  );
}

/** Colour stops of the progress ring, as a fraction of the full circle. */
const PROGRESS_STOPS: [number, [number, number, number]][] = [
  [0, [139, 92, 246]], // violet
  [0.33, [99, 102, 241]], // indigo
  [0.66, [34, 211, 238]], // cyan
  [1, [52, 211, 153]], // emerald
];

function colorAt(f: number): string {
  for (let i = 1; i < PROGRESS_STOPS.length; i++) {
    const [f1, c1] = PROGRESS_STOPS[i];
    const [f0, c0] = PROGRESS_STOPS[i - 1];
    if (f <= f1) {
      const t = (f - f0) / (f1 - f0 || 1);
      return `rgb(${c0.map((v, k) => Math.round(v + (c1[k] - v) * t)).join(' ')})`;
    }
  }
  return 'rgb(52 211 153)';
}

/**
 * Progress ring: a conic multi-colour stroke (violet → indigo → cyan → emerald) that reveals more of the
 * spectrum as it fills, with round caps, a soft glow and a moving sheen while running.
 */
export function GradientRing({
  value,
  size = 196,
  stroke = 14,
  state = 'running',
  children,
}: {
  value: number;
  size?: number;
  stroke?: number;
  state?: 'running' | 'done' | 'failed';
  children?: ReactNode;
}) {
  const v = Math.max(0, Math.min(100, value));
  const cap = state === 'failed' ? 'rgb(239 68 68)' : colorAt(v / 100);
  const style = { width: size, height: size, '--p': v, '--stroke': `${stroke}px`, '--cap': cap } as CSSProperties;
  return (
    <div className={`gring is-${state} ${v > 0 ? 'has-value' : ''}`} style={style}>
      <div className="gring-track" />
      <div className="gring-glow">
        <div className="gring-fill">{state === 'running' && <span className="gring-sheen" />}</div>
        <span className="gring-cap start" />
        <span className="gring-cap end" />
      </div>
      <div className="ring-center">{children}</div>
    </div>
  );
}

export function ScoreBadge({ score, size = 'md' }: { score?: number; size?: 'sm' | 'md' }) {
  if (score === undefined) return <span className={`score-badge ${size} none`} aria-label="No score">–</span>;
  return (
    <span className={`score-badge ${size} tone-${scoreTone(score)}`} aria-label={`Score ${score} out of 100`}>
      {score}
    </span>
  );
}
