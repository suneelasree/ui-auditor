// Creates Jira Cloud issues (REST v3) and attaches evidence screenshots.
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import type { JiraEnvConfig } from './config.js';
import type { JiraIssuePayload } from './payload.js';
import type { CreatedIssue } from './github.js';

function authHeader(cfg: JiraEnvConfig): string {
  return `Basic ${Buffer.from(`${cfg.email}:${cfg.apiToken}`).toString('base64')}`;
}

async function failure(res: Response, what: string): Promise<Error> {
  const detail = (await res.text().catch(() => '')).slice(0, 300);
  return new Error(`Jira ${what} responded ${res.status}${detail ? `: ${detail}` : ''}`);
}

export async function createJiraIssue(
  payload: JiraIssuePayload,
  cfg: JiraEnvConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<CreatedIssue> {
  const res = await fetchImpl(`${cfg.baseUrl}/rest/api/3/issue`, {
    method: 'POST',
    headers: { Authorization: authHeader(cfg), Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw await failure(res, 'create issue');
  const data = (await res.json()) as { key?: string };
  if (!data.key) throw new Error('Jira response did not include an issue key');
  return { key: data.key, url: `${cfg.baseUrl}/browse/${data.key}` };
}

const MIME: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' };

/** Upload one file (absolute path) as an attachment. */
export async function attachJiraFile(
  issueKey: string,
  absPath: string,
  cfg: JiraEnvConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const bytes = await readFile(absPath);
  const name = basename(absPath);
  const type = MIME[name.split('.').pop()?.toLowerCase() ?? ''] ?? 'application/octet-stream';
  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(bytes)], { type }), name);
  const res = await fetchImpl(`${cfg.baseUrl}/rest/api/3/issue/${encodeURIComponent(issueKey)}/attachments`, {
    method: 'POST',
    headers: { Authorization: authHeader(cfg), Accept: 'application/json', 'X-Atlassian-Token': 'no-check' },
    body: form,
  });
  if (!res.ok) throw await failure(res, `attachment ${name}`);
}
