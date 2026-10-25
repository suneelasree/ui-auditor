import { describe, expect, it } from 'vitest';
import { adfToText, buildGithubIssue, buildJiraIssue, JIRA_PRIORITY, type AdfNode } from '../../src/export/payload.js';
import { cannedReport } from '../e2e/fake-engine.js';

const report = cannedReport('run-1', 'https://example.test', '2026-01-01T00:00:00.000Z');
const [cta, link] = report.findings;

describe('buildGithubIssue', () => {
  it('builds title, labels and markdown body with every field', () => {
    const issue = buildGithubIssue(cta, report, { reportUrl: 'http://localhost:3000/reports/run-1/report.html' });
    expect(issue.title).toBe('[UIA-001][Critical] Primary "Search Homes" button hidden on mobile');
    expect(issue.labels).toEqual(['ui-auditor', 'UX', 'Critical']);
    for (const s of ['## Summary', '## Evidence', '## Steps to reproduce', '## Expected', '## Actual', '## Recommendation', '## Design alternatives']) {
      expect(issue.body).toContain(s);
    }
    expect(issue.body).toContain('**Page:** https://example.test/listings');
    expect(issue.body).toContain('**Viewport:** mobile');
    expect(issue.body).toContain('**Found by:** UX Designer, Rules');
    expect(issue.body).toContain('1. Open /listings at 375px wide');
    expect(issue.body).toContain('evidence/p1-mobile-el1.png');
    expect(issue.body).toContain('http://localhost:3000/reports/run-1/report.html#UIA-001');
    expect(issue.attachments).toEqual(['evidence/p1-mobile-el1.png', 'evidence/p1-mobile.png']);
  });

  it('omits the design section when there is no alternative', () => {
    const issue = buildGithubIssue(link, report);
    expect(issue.body).not.toContain('## Design alternatives');
    expect(issue.body).toContain('**Viewport:** all viewports');
    expect(issue.attachments).toEqual([]);
  });
});

describe('buildJiraIssue', () => {
  const cfg = { projectKey: 'QA', issueType: 'Bug' };

  it('maps severity to priority', () => {
    expect(JIRA_PRIORITY).toEqual({ Critical: 'Highest', High: 'High', Medium: 'Medium', Low: 'Low' });
    for (const f of report.findings) {
      expect(buildJiraIssue(f, report, cfg).payload.fields.priority?.name).toBe(JIRA_PRIORITY[f.severity]);
      expect(buildJiraIssue(f, report, { ...cfg, setPriority: false }).payload.fields.priority).toBeUndefined();
    }
  });

  it('produces a REST v3 payload with a valid ADF description', () => {
    const { payload, attachments } = buildJiraIssue(cta, report, cfg);
    const { fields } = payload;
    expect(fields.project).toEqual({ key: 'QA' });
    expect(fields.issuetype).toEqual({ name: 'Bug' });
    expect(fields.summary).toBe('[UIA-001][Critical] Primary "Search Homes" button hidden on mobile');
    expect(fields.labels).toEqual(['ui-auditor', 'ux', 'critical']);
    expect(fields.description.type).toBe('doc');
    expect(fields.description.version).toBe(1);
    const types = fields.description.content.map((n: AdfNode) => n.type);
    expect(types).toContain('heading');
    expect(types).toContain('paragraph');
    expect(types).toContain('bulletList');
    expect(types).toContain('orderedList');
    const headings = fields.description.content.filter((n) => n.type === 'heading').map((n) => (n.type === 'heading' ? n.content[0].text : ''));
    expect(headings).toEqual(['Summary', 'Evidence', 'Steps to reproduce', 'Expected', 'Actual', 'Recommendation', 'Design alternatives']);
    const ordered = fields.description.content.find((n) => n.type === 'orderedList');
    expect(ordered && ordered.type === 'orderedList' && ordered.content.length).toBe(2);
    // every list item wraps a paragraph, every text node is non-empty
    for (const n of fields.description.content) {
      if (n.type === 'bulletList' || n.type === 'orderedList') {
        for (const li of n.content) {
          expect(li.type).toBe('listItem');
          expect(li.content[0].type).toBe('paragraph');
        }
      }
    }
    expect(JSON.stringify(fields.description)).not.toContain('"text":""');
    expect(attachments).toEqual(['evidence/p1-mobile-el1.png', 'evidence/p1-mobile.png']);
    expect(adfToText(fields.description)).toContain('## Steps to reproduce');
  });
});
