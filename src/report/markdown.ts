import { CATEGORIES, SEVERITIES, type EvidenceItem, type Finding, type Report } from '../core/types.js';
import { pagePath, viewportLabel } from './util.js';

/** Markdown report, pasteable into GitHub issues or Jira. */
export function renderMarkdown(report: Report): string {
  const out: string[] = [];
  const byId = new Map(report.findings.map((f) => [f.id, f]));

  out.push(`# UI Audit: ${txt(report.target)}`, '');
  out.push(`- **Target:** ${txt(report.target)}`);
  out.push(`- **Date:** ${txt(report.finishedAt || report.createdAt)}`);
  out.push(`- **Domain:** ${txt(report.domain.name)}${report.domain.detected ? ` (detected, confidence ${Math.round(report.domain.confidence * 100)}%)` : ''}`);
  out.push(`- **Pages audited:** ${report.summary.pagesAudited}`);
  out.push(`- **Overall score:** ${report.scores.overall}/100`, '');

  if (report.notes.length > 0) {
    out.push('> **Notes**');
    for (const n of report.notes) out.push(`> - ${txt(n)}`);
    out.push('');
  }

  out.push('## Scores', '', '| Category | Score |', '|---|---|');
  out.push(`| **Overall** | **${report.scores.overall}** |`);
  for (const c of CATEGORIES) out.push(`| ${c} | ${report.scores.byCategory[c]} |`);
  out.push('');

  out.push('## Issues by severity', '', '| Severity | Count |', '|---|---|');
  for (const s of SEVERITIES) out.push(`| ${s} | ${report.summary.counts[s] ?? 0} |`);
  out.push('');

  if (report.summary.topIssues.length > 0) {
    out.push('## Top issues', '');
    report.summary.topIssues.forEach((id, i) => {
      const f = byId.get(id);
      out.push(f ? `${i + 1}. **${f.id}** ${txt(f.title)} (${f.severity}, ${f.category})` : `${i + 1}. ${txt(id)}`);
    });
    out.push('');
  }

  out.push('## Findings', '');
  if (report.findings.length === 0) out.push('No issues found.', '');
  for (const f of report.findings) out.push(...finding(f), '');

  if (report.domainInsights.length > 0) {
    out.push('## Domain insights', '');
    for (const d of report.domainInsights) out.push(`- ${txt(d)}`);
    out.push('');
  }

  const cmp = report.comparison;
  if (cmp && cmp.sites.length > 0) {
    out.push('## Competitor comparison', '');
    out.push(`| Category | ${cmp.sites.map((s) => cell(s.label + (s.isTarget ? ' (you)' : ''))).join(' | ')} |`);
    out.push(`|---|${cmp.sites.map(() => '---').join('|')}|`);
    out.push(`| **Overall** | ${cmp.sites.map((s) => `**${s.scores.overall}**`).join(' | ')} |`);
    for (const c of CATEGORIES) out.push(`| ${c} | ${cmp.sites.map((s) => s.scores.byCategory[c]).join(' | ')} |`);
    out.push('');
    if (cmp.theyDoBetter.length > 0) {
      out.push('### What competitors do better', '');
      for (const t of cmp.theyDoBetter) out.push(`- **${txt(t.competitor)}: ${txt(t.title)}** ${txt(t.detail)}`);
      out.push('');
    }
    if (cmp.youWin.length > 0) {
      out.push('### Where you win', '');
      for (const w of cmp.youWin) out.push(`- ${txt(w)}`);
      out.push('');
    }
    if (cmp.patternsToCopy.length > 0) {
      out.push('### Patterns worth copying', '');
      for (const p of cmp.patternsToCopy) out.push(`- ${txt(p)}`);
      out.push('');
    }
  }

  if (report.generatedTests.length > 0) {
    out.push('## Generated regression tests', '');
    for (const t of report.generatedTests) out.push(`- ${code(t)}`);
    out.push('');
  }

  if (report.agents.length > 0) {
    out.push('## Agents', '', '| Agent | Status | Findings | Dropped | Note |', '|---|---|---|---|---|');
    for (const a of report.agents) out.push(`| ${cell(a.name)} | ${a.status} | ${a.findings} | ${a.dropped} | ${cell(a.note ?? '')} |`);
    out.push('');
  }

  return out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
}

function finding(f: Finding): string[] {
  const out: string[] = [];
  out.push(`### ${f.id}: ${txt(f.title)}`, '');
  out.push(`- **Severity:** ${f.severity}`);
  out.push(`- **Category:** ${f.category}`);
  out.push(`- **Found by:** ${f.foundBy.join(', ')}`);
  out.push(`- **Page:** ${code(pagePath(f.page))} @ ${viewportLabel(f.viewport)}`);
  out.push(`- **Fingerprint:** ${code(f.fingerprint)}`, '');
  out.push('**Evidence**', '');
  for (const e of f.evidence) out.push(`- ${evidence(e)}`);
  out.push('', '**Steps to reproduce**', '');
  f.stepsToReproduce.forEach((s, i) => out.push(`${i + 1}. ${txt(s)}`));
  out.push('', `**Expected:** ${txt(f.expected)}`, '', `**Actual:** ${txt(f.actual)}`, '');
  out.push(`**Recommendation:** ${txt(f.recommendation)}`);
  if (f.designAlternative) {
    out.push('', '**Design alternatives**', '');
    out.push(`- Good (minimal fix): ${txt(f.designAlternative.goodSummary)}`);
    out.push(`- Better (redesign): ${txt(f.designAlternative.betterSummary)}`);
  }
  return out;
}

function evidence(e: EvidenceItem): string {
  let s = `${e.kind}: ${code(e.value)}`;
  if (e.detail) s += ` - ${txt(e.detail)}`;
  if (e.screenshot) s += ` (screenshot: ${code(e.screenshot)})`;
  return s;
}

/** Plain text from crawled content: single line, raw HTML neutralised. */
function txt(s: string): string {
  return s.replace(/[\r\n]+/g, ' ').replace(/</g, '&lt;').replace(/>/g, '&gt;').trim();
}

function cell(s: string): string {
  return txt(s).replace(/\|/g, '\\|');
}

/** Inline code span that survives backticks in the value. */
function code(s: string): string {
  const v = s.replace(/[\r\n]+/g, ' ');
  const longest = Math.max(0, ...(v.match(/`+/g) ?? []).map((m) => m.length));
  const fence = '`'.repeat(longest + 1);
  const pad = v.startsWith('`') || v.endsWith('`') ? ' ' : '';
  return `${fence}${pad}${v}${pad}${fence}`;
}
