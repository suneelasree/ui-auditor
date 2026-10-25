// Creates GitHub issues. GitHub's REST API cannot attach files, so evidence filenames are named in the body.
import type { GithubConfig } from './config.js';
import type { GithubIssuePayload } from './payload.js';

export interface CreatedIssue {
  key: string;
  url: string;
}

export async function createGithubIssue(
  payload: GithubIssuePayload,
  cfg: GithubConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<CreatedIssue> {
  const res = await fetchImpl(`${cfg.apiUrl}/repos/${cfg.repo}/issues`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${cfg.token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
      'User-Agent': 'ui-auditor',
    },
    body: JSON.stringify({ title: payload.title, body: payload.body, labels: payload.labels }),
  });
  if (!res.ok) {
    const detail = (await res.text().catch(() => '')).slice(0, 300);
    throw new Error(`GitHub responded ${res.status}${detail ? `: ${detail}` : ''}`);
  }
  const data = (await res.json()) as { number?: number; html_url?: string };
  if (typeof data.number !== 'number') throw new Error('GitHub response did not include an issue number');
  return { key: `#${data.number}`, url: data.html_url ?? `https://github.com/${cfg.repo}/issues/${data.number}` };
}
