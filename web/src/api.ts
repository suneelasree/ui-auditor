import type { AuditOptionsInput, Finding, ProgressEvent, Report } from '../../src/core/types.js';

export type { AuditOptionsInput, Finding, ProgressEvent, Report };
export type Target = 'github' | 'jira';

export interface RunMeta {
  id: string;
  url: string;
  status: 'running' | 'done' | 'failed';
  createdAt: string;
  finishedAt?: string;
  overall?: number;
  error?: string;
}

export interface ExportedRef {
  target: Target;
  key: string;
  url: string;
}

export interface RunDetail {
  meta: RunMeta;
  report: Report | null;
  exported: Record<string, ExportedRef[]>;
}

export interface PreviewItem {
  findingId: string;
  title: string;
  body: string;
  labels: string[];
  priority: string;
  attachments: string[];
  payload: unknown;
}

export interface SkippedItem {
  findingId: string;
  title: string;
  reason: string;
  existing?: { key: string; url: string };
}

export interface Preview {
  previewToken: string;
  target: Target;
  items: PreviewItem[];
  skipped: SkippedItem[];
}

export interface ConfirmResult {
  created: { findingId: string; key: string; url: string; attachmentErrors?: string[] }[];
  skipped: SkippedItem[];
  errors: { findingId: string; error: string }[];
}

export interface CheckResult {
  origin: string;
  needsSignIn: boolean;
  hasSession: boolean;
}

export type SignInStatus = 'waiting' | 'saved' | 'cancelled' | 'failed' | 'timeout';

export interface SignInState {
  id: string;
  origin: string;
  status: SignInStatus;
  message: string;
}

export interface SavedSession {
  origin: string;
  savedAt: string;
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly issues: { path: string; message: string }[] = [],
    readonly data: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: init?.body ? { 'Content-Type': 'application/json', ...init.headers } : init?.headers,
  });
  const text = await res.text();
  let data: unknown = undefined;
  try {
    data = text ? JSON.parse(text) : undefined;
  } catch {
    /* non-JSON */
  }
  if (!res.ok) {
    const d = (data ?? {}) as { error?: string; issues?: { path: string; message: string }[] };
    throw new ApiError(d.error ?? `Request failed (${res.status})`, res.status, d.issues, (data ?? {}) as Record<string, unknown>);
  }
  return data as T;
}

export const api = {
  config: () => request<{ targets: Record<Target, boolean> }>('/api/config'),
  runs: () => request<{ runs: RunMeta[] }>('/api/audits'),
  run: (id: string) => request<RunDetail>(`/api/audits/${encodeURIComponent(id)}`),
  start: (options: AuditOptionsInput) =>
    request<{ id: string; usedSession?: boolean }>('/api/audits', { method: 'POST', body: JSON.stringify({ options }) }),
  check: (url: string) => request<CheckResult>('/api/check', { method: 'POST', body: JSON.stringify({ url }) }),
  signIn: (url: string) => request<{ id: string }>('/api/signin', { method: 'POST', body: JSON.stringify({ url }) }),
  signInStatus: (id: string) => request<SignInState>(`/api/signin/${encodeURIComponent(id)}`),
  signInDone: (id: string) => request<SignInState>(`/api/signin/${encodeURIComponent(id)}/done`, { method: 'POST', body: '{}' }),
  signInCancel: (id: string) => request<unknown>(`/api/signin/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  sessions: () => request<{ sessions: SavedSession[] }>('/api/sessions'),
  forgetSession: (origin: string) => request<{ ok: boolean }>(`/api/sessions?origin=${encodeURIComponent(origin)}`, { method: 'DELETE' }),
  preview: (id: string, target: Target, findingIds: string[]) =>
    request<Preview>(`/api/audits/${encodeURIComponent(id)}/export/preview`, { method: 'POST', body: JSON.stringify({ target, findingIds }) }),
  confirm: (id: string, target: Target, findingIds: string[], previewToken: string) =>
    request<ConfirmResult>(`/api/audits/${encodeURIComponent(id)}/export/confirm`, {
      method: 'POST',
      body: JSON.stringify({ target, findingIds, previewToken }),
    }),
};

export function formatDate(iso?: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

export function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

export function shortPage(page: string): string {
  try {
    const u = new URL(page);
    return u.pathname + u.search || '/';
  } catch {
    return page;
  }
}

/** Per-run hints the progress page uses to decide which optional steps to show. */
export interface RunHints {
  usedSession?: boolean;
  competitors?: number;
}

export function saveRunHints(id: string, hints: RunHints): void {
  try {
    sessionStorage.setItem(`uia-run-${id}`, JSON.stringify(hints));
  } catch {
    /* storage unavailable */
  }
}

export function loadRunHints(id: string): RunHints {
  try {
    return JSON.parse(sessionStorage.getItem(`uia-run-${id}`) ?? '{}') as RunHints;
  } catch {
    return {};
  }
}
