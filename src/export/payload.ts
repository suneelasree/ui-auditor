// Pure builders for GitHub and Jira issue payloads. No I/O here.
import type { Finding, Report, Severity } from '../core/types.js';

export interface BuildOptions {
  /** Absolute URL of the report (e.g. http://localhost:3000/reports/<id>/report.html), used for links. */
  reportUrl?: string;
}

export interface GithubIssuePayload {
  title: string;
  body: string;
  labels: string[];
}

export interface GithubIssue extends GithubIssuePayload {
  /** Evidence screenshot paths relative to the run dir (GitHub API cannot attach them; they are named in the body). */
  attachments: string[];
}

export interface JiraConfig {
  projectKey: string;
  issueType: string;
  setPriority?: boolean;
}

// ---- Atlassian Document Format (subset) ----
export type AdfText = { type: 'text'; text: string; marks?: { type: 'code' | 'strong' | 'link'; attrs?: { href: string } }[] };
export type AdfParagraph = { type: 'paragraph'; content: AdfText[] };
export type AdfHeading = { type: 'heading'; attrs: { level: number }; content: AdfText[] };
export type AdfListItem = { type: 'listItem'; content: AdfParagraph[] };
export type AdfList = { type: 'bulletList' | 'orderedList'; content: AdfListItem[] };
export type AdfNode = AdfParagraph | AdfHeading | AdfList;
export interface AdfDoc {
  type: 'doc';
  version: 1;
  content: AdfNode[];
}

export interface JiraIssuePayload {
  fields: {
    project: { key: string };
    issuetype: { name: string };
    summary: string;
    description: AdfDoc;
    labels: string[];
    priority?: { name: string };
  };
}

export interface JiraIssue {
  payload: JiraIssuePayload;
  attachments: string[];
}

export const JIRA_PRIORITY: Record<Severity, string> = {
  Critical: 'Highest',
  High: 'High',
  Medium: 'Medium',
  Low: 'Low',
};

export function issueTitle(f: Finding): string {
  return `[${f.id}][${f.severity}] ${f.title}`;
}

/** Evidence screenshots (relative paths), deduplicated, in evidence order. */
export function evidenceAttachments(f: Finding): string[] {
  const out: string[] = [];
  for (const e of f.evidence) {
    if (e.screenshot && !out.includes(e.screenshot)) out.push(e.screenshot);
  }
  return out;
}

function viewportLabel(f: Finding): string {
  return f.viewport === 'all' ? 'all viewports' : f.viewport;
}

function evidenceLine(e: Finding['evidence'][number]): string {
  let s = `${e.kind}: \`${oneLine(e.value)}\``;
  if (e.detail) s += ` (${oneLine(e.detail)})`;
  if (e.screenshot) s += ` [screenshot: ${e.screenshot}]`;
  return s;
}

function oneLine(s: string): string {
  return s.replace(/\s+/g, ' ').replace(/`/g, "'").trim();
}

function designNote(f: Finding, opts: BuildOptions): string | undefined {
  const d = f.designAlternative;
  if (!d) return undefined;
  const where = opts.reportUrl ? `${opts.reportUrl}#${f.id}` : `report.html#${f.id}`;
  return `Good: ${d.goodSummary} / Better: ${d.betterSummary} (mockups: ${d.goodHtml}, ${d.betterHtml}; see ${where})`;
}

export function buildGithubIssue(finding: Finding, report: Report, opts: BuildOptions = {}): GithubIssue {
  const f = finding;
  const attachments = evidenceAttachments(f);
  const lines: string[] = [];
  lines.push('## Summary', '', f.title, '');
  lines.push(`- **Severity:** ${f.severity}`);
  lines.push(`- **Category:** ${f.category}`);
  lines.push(`- **Page:** ${f.page}`);
  lines.push(`- **Viewport:** ${viewportLabel(f)}`);
  lines.push(`- **Found by:** ${f.foundBy.join(', ')}`);
  lines.push(`- **Site:** ${report.target}`, '');
  lines.push('## Evidence', '');
  for (const e of f.evidence) lines.push(`- ${evidenceLine(e)}`);
  if (attachments.length) {
    lines.push('', `Screenshots (in the UI Auditor run folder \`reports/${report.id}/\`): ${attachments.map((a) => `\`${a}\``).join(', ')}`);
  }
  lines.push('', '## Steps to reproduce', '');
  f.stepsToReproduce.forEach((s, i) => lines.push(`${i + 1}. ${s}`));
  lines.push('', '## Expected', '', f.expected, '', '## Actual', '', f.actual, '');
  lines.push('## Recommendation', '', f.recommendation, '');
  const design = designNote(f, opts);
  if (design) lines.push('## Design alternatives', '', design, '');
  lines.push('---', `_Created by UI Auditor from run ${report.id}${opts.reportUrl ? ` ([report](${opts.reportUrl}))` : ''}. Fingerprint: \`${f.fingerprint}\`._`);
  return {
    title: issueTitle(f),
    body: lines.join('\n'),
    labels: ['ui-auditor', f.category, f.severity],
    attachments,
  };
}

// ---- ADF helpers ----
const text = (t: string, marks?: AdfText['marks']): AdfText => (marks ? { type: 'text', text: t, marks } : { type: 'text', text: t });
const para = (...content: AdfText[]): AdfParagraph => ({ type: 'paragraph', content: content.filter((c) => c.text.length > 0) });
const heading = (t: string): AdfHeading => ({ type: 'heading', attrs: { level: 3 }, content: [text(t)] });
const list = (kind: AdfList['type'], items: AdfText[][]): AdfList => ({
  type: kind,
  content: items.map((c) => ({ type: 'listItem', content: [para(...c)] })),
});

/** Jira labels may not contain spaces. */
function jiraLabel(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, '-');
}

export function buildJiraIssue(finding: Finding, report: Report, cfg: JiraConfig, opts: BuildOptions = {}): JiraIssue {
  const f = finding;
  const attachments = evidenceAttachments(f);
  const content: AdfNode[] = [];
  content.push(heading('Summary'), para(text(f.title)));
  content.push(
    list('bulletList', [
      [text('Severity: ', [{ type: 'strong' }]), text(f.severity)],
      [text('Category: ', [{ type: 'strong' }]), text(f.category)],
      [text('Page: ', [{ type: 'strong' }]), text(f.page)],
      [text('Viewport: ', [{ type: 'strong' }]), text(viewportLabel(f))],
      [text('Found by: ', [{ type: 'strong' }]), text(f.foundBy.join(', '))],
      [text('Site: ', [{ type: 'strong' }]), text(report.target)],
    ]),
  );
  content.push(heading('Evidence'));
  content.push(
    list(
      'bulletList',
      f.evidence.map((e) => {
        const parts: AdfText[] = [text(`${e.kind}: `), text(oneLine(e.value), [{ type: 'code' }])];
        if (e.detail) parts.push(text(` (${oneLine(e.detail)})`));
        if (e.screenshot) parts.push(text(` [screenshot: ${e.screenshot}]`));
        return parts;
      }),
    ),
  );
  if (attachments.length) content.push(para(text(`Attached screenshots: ${attachments.join(', ')}`)));
  content.push(heading('Steps to reproduce'), list('orderedList', f.stepsToReproduce.map((s) => [text(s)])));
  content.push(heading('Expected'), para(text(f.expected)));
  content.push(heading('Actual'), para(text(f.actual)));
  content.push(heading('Recommendation'), para(text(f.recommendation)));
  const design = designNote(f, opts);
  if (design) content.push(heading('Design alternatives'), para(text(design)));
  content.push(para(text(`Created by UI Auditor from run ${report.id}. Fingerprint: ${f.fingerprint}.`)));

  return {
    payload: {
      fields: {
        project: { key: cfg.projectKey },
        issuetype: { name: cfg.issueType },
        summary: issueTitle(f).slice(0, 255),
        description: { type: 'doc', version: 1, content },
        labels: ['ui-auditor', jiraLabel(f.category), jiraLabel(f.severity)],
        ...(cfg.setPriority === false ? {} : { priority: { name: JIRA_PRIORITY[f.severity] } }),
      },
    },
    attachments,
  };
}

/** Plain-text rendering of an ADF doc for previews. */
export function adfToText(doc: AdfDoc): string {
  const out: string[] = [];
  const inline = (c: AdfText[]) => c.map((t) => t.text).join('');
  for (const n of doc.content) {
    if (n.type === 'heading') out.push('', `## ${inline(n.content)}`, '');
    else if (n.type === 'paragraph') out.push(inline(n.content));
    else n.content.forEach((li, i) => out.push(`${n.type === 'orderedList' ? `${i + 1}.` : '-'} ${li.content.map((p) => inline(p.content)).join(' ')}`));
  }
  return out.join('\n').trim();
}
