// Preview -> confirm export flow. Preview sends nothing; confirm only sends what a stored preview contained.
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import type { Finding, Report } from '../core/types.js';
import { redact } from '../core/redact.js';
import { githubConfig, jiraConfig, scrubSecrets, type ExportTarget } from './config.js';
import { adfToText, buildGithubIssue, buildJiraIssue, type GithubIssuePayload, type JiraIssuePayload } from './payload.js';
import { createGithubIssue } from './github.js';
import { attachJiraFile, createJiraIssue } from './jira.js';
import { ExportStore, type ExportRecord } from './store.js';

export interface PreviewItem {
  findingId: string;
  fingerprint: string;
  title: string;
  /** Markdown (GitHub) or a plain-text rendering of the ADF description (Jira). */
  body: string;
  labels: string[];
  priority: string;
  attachments: string[];
  /** The exact request body that will be sent. */
  payload: GithubIssuePayload | JiraIssuePayload;
}

export interface SkippedItem {
  findingId: string;
  title: string;
  reason: string;
  existing?: ExportRecord;
}

export interface Preview {
  previewToken: string;
  target: ExportTarget;
  runId: string;
  items: PreviewItem[];
  skipped: SkippedItem[];
}

export interface ConfirmResult {
  created: { findingId: string; key: string; url: string; attachmentErrors?: string[] }[];
  skipped: SkippedItem[];
  errors: { findingId: string; error: string }[];
}

interface StoredPreview {
  preview: Preview;
  findingIds: string[];
  site: string;
  runDir: string;
  expires: number;
}

const PREVIEW_TTL_MS = 30 * 60 * 1000;

export class ExportError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
  ) {
    super(message);
  }
}

export class ExportService {
  private readonly previews = new Map<string, StoredPreview>();
  readonly store: ExportStore;

  constructor(
    private readonly reportsDir: string,
    private readonly env: NodeJS.ProcessEnv,
    private readonly fetchImpl: typeof fetch,
  ) {
    this.store = new ExportStore(reportsDir);
  }

  configured(): Record<ExportTarget, boolean> {
    return { github: !!githubConfig(this.env), jira: !!jiraConfig(this.env) };
  }

  /** Which targets each finding was already exported to. */
  exportedFor(report: Report): Record<string, { target: ExportTarget; key: string; url: string }[]> {
    const out: Record<string, { target: ExportTarget; key: string; url: string }[]> = {};
    for (const f of report.findings) {
      for (const target of ['github', 'jira'] as const) {
        const rec = this.store.get(target, report.target, f.fingerprint);
        if (rec) (out[f.id] ??= []).push({ target, key: rec.key, url: rec.url });
      }
    }
    return out;
  }

  preview(report: Report, runDir: string, target: ExportTarget, findingIds: string[], reportUrl?: string): Preview {
    const gh = githubConfig(this.env);
    const jira = jiraConfig(this.env);
    if (target === 'github' && !gh) throw new ExportError('GitHub export is not configured (set GITHUB_TOKEN and GITHUB_REPO in .env).', 400);
    if (target === 'jira' && !jira) throw new ExportError('Jira export is not configured (set JIRA_BASE_URL, JIRA_EMAIL, JIRA_API_TOKEN and JIRA_PROJECT_KEY in .env).', 400);

    const byId = new Map(report.findings.map((f) => [f.id, f] as const));
    const items: PreviewItem[] = [];
    const skipped: SkippedItem[] = [];
    for (const id of [...new Set(findingIds)]) {
      const f = byId.get(id);
      if (!f) {
        skipped.push({ findingId: id, title: '', reason: 'Finding not found in this report' });
        continue;
      }
      const existing = this.store.get(target, report.target, f.fingerprint);
      if (existing) {
        skipped.push({ findingId: id, title: f.title, reason: `Already exported as ${existing.key}`, existing });
        continue;
      }
      items.push(this.buildItem(f, report, runDir, target, reportUrl));
    }

    const preview: Preview = { previewToken: randomUUID(), target, runId: report.id, items, skipped };
    this.prune();
    this.previews.set(preview.previewToken, {
      preview,
      findingIds: [...new Set(findingIds)].sort(),
      site: report.target,
      runDir,
      expires: Date.now() + PREVIEW_TTL_MS,
    });
    return preview;
  }

  async confirm(runId: string, target: ExportTarget, findingIds: string[], previewToken: string | undefined): Promise<ConfirmResult> {
    if (!previewToken) throw new ExportError('A previewToken from the preview step is required.', 400);
    const stored = this.previews.get(previewToken);
    if (!stored || stored.expires < Date.now()) throw new ExportError('Preview not found or expired. Generate a new preview.', 409);
    const ids = [...new Set(findingIds)].sort();
    if (stored.preview.runId !== runId || stored.preview.target !== target || ids.join('|') !== stored.findingIds.join('|')) {
      throw new ExportError('This confirmation does not match the preview. Generate a new preview.', 409);
    }
    this.previews.delete(previewToken); // single use

    const result: ConfirmResult = { created: [], skipped: [...stored.preview.skipped], errors: [] };
    const gh = githubConfig(this.env);
    const jira = jiraConfig(this.env);
    for (const item of stored.preview.items) {
      // Re-check: another export may have happened since the preview.
      const existing = this.store.get(target, stored.site, item.fingerprint);
      if (existing) {
        result.skipped.push({ findingId: item.findingId, title: item.title, reason: `Already exported as ${existing.key}`, existing });
        continue;
      }
      try {
        let created: { key: string; url: string };
        const attachmentErrors: string[] = [];
        if (target === 'github') {
          if (!gh) throw new Error('GitHub export is not configured');
          created = await createGithubIssue(item.payload as GithubIssuePayload, gh, this.fetchImpl);
        } else {
          if (!jira) throw new Error('Jira export is not configured');
          created = await createJiraIssue(item.payload as JiraIssuePayload, jira, this.fetchImpl);
          for (const rel of item.attachments) {
            try {
              await attachJiraFile(created.key, resolve(stored.runDir, rel), jira, this.fetchImpl);
            } catch (err) {
              attachmentErrors.push(this.clean(err));
            }
          }
        }
        this.store.record(target, stored.site, item.fingerprint, { ...created, exportedAt: new Date().toISOString(), runId });
        result.created.push({ findingId: item.findingId, ...created, ...(attachmentErrors.length ? { attachmentErrors } : {}) });
      } catch (err) {
        result.errors.push({ findingId: item.findingId, error: this.clean(err) });
      }
    }
    return result;
  }

  private buildItem(f: Finding, report: Report, runDir: string, target: ExportTarget, reportUrl?: string): PreviewItem {
    const existingFile = (rel: string) => {
      const abs = resolve(runDir, rel);
      return abs.startsWith(runDir + sep) && existsSync(abs);
    };
    if (target === 'github') {
      const gh = buildGithubIssue(f, report, { reportUrl });
      return {
        findingId: f.id,
        fingerprint: f.fingerprint,
        title: gh.title,
        body: gh.body,
        labels: gh.labels,
        priority: f.severity,
        attachments: gh.attachments.filter(existingFile),
        payload: { title: gh.title, body: gh.body, labels: gh.labels },
      };
    }
    const cfg = jiraConfig(this.env)!;
    const j = buildJiraIssue(f, report, { projectKey: cfg.projectKey, issueType: cfg.issueType }, { reportUrl });
    return {
      findingId: f.id,
      fingerprint: f.fingerprint,
      title: j.payload.fields.summary,
      body: adfToText(j.payload.fields.description),
      labels: j.payload.fields.labels,
      priority: j.payload.fields.priority?.name ?? '(not set)',
      attachments: j.attachments.filter(existingFile),
      payload: j.payload,
    };
  }

  private clean(err: unknown): string {
    return redact(scrubSecrets(err instanceof Error ? err.message : String(err), this.env));
  }

  private prune(): void {
    const now = Date.now();
    for (const [k, v] of this.previews) if (v.expires < now) this.previews.delete(k);
  }
}
