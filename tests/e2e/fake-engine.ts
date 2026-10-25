// A deterministic stand-in for the real engine, used by server unit tests and the Web UI e2e test.
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Finding, ProgressEvent, Report, Stage } from '../../src/core/types.js';
import type { RunAuditInput, RunMeta } from '../../src/engine/runAudit.js';

// 1x1 transparent PNG
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');

export function cannedFindings(target: string): Finding[] {
  const base = target.replace(/\/+$/, '');
  return [
    {
      id: 'UIA-001',
      fingerprint: 'fp-cta-hidden-0001',
      title: 'Primary "Search Homes" button hidden on mobile',
      category: 'UX',
      severity: 'Critical',
      page: `${base}/listings`,
      viewport: 'mobile',
      evidence: [
        { kind: 'selector', value: 'button.search-cta', screenshot: 'evidence/p1-mobile-el1.png' },
        { kind: 'screenshot', value: 'above the fold', screenshot: 'evidence/p1-mobile.png' },
      ],
      stepsToReproduce: ['Open /listings at 375px wide', 'Look for the Search Homes button'],
      expected: 'The primary CTA is visible above the fold',
      actual: 'The CTA has display:none below 768px',
      recommendation: 'Remove the mobile display:none rule and make the CTA full-width',
      foundBy: ['UX Designer', 'Rules'],
      source: 'rule',
      designAlternative: {
        original: 'evidence/p1-mobile.png',
        goodHtml: 'designs/UIA-001-good.html',
        goodScreenshot: 'designs/UIA-001-good.png',
        betterHtml: 'designs/UIA-001-better.html',
        betterScreenshot: 'designs/UIA-001-better.png',
        goodSummary: 'Show the CTA full width',
        betterSummary: 'Sticky search bar with filters',
      },
    },
    {
      id: 'UIA-002',
      fingerprint: 'fp-broken-link-0002',
      title: 'Broken link to /about-us returns 404',
      category: 'Navigation',
      severity: 'High',
      page: `${base}/`,
      viewport: 'all',
      evidence: [{ kind: 'link', value: '/about-us', detail: 'status 404' }],
      stepsToReproduce: ['Open the home page', 'Click "About us" in the footer'],
      expected: 'The About page loads',
      actual: 'The server returns 404',
      recommendation: 'Fix the href to /about',
      foundBy: ['SDET'],
      source: 'rule',
    },
    {
      id: 'UIA-003',
      fingerprint: 'fp-alt-0003',
      title: 'Listing images have no alt text',
      category: 'Accessibility',
      severity: 'Medium',
      page: `${base}/listings`,
      viewport: 'desktop',
      evidence: [{ kind: 'axe-rule', value: 'image-alt', detail: '6 nodes', screenshot: 'evidence/p1-desktop.png' }],
      stepsToReproduce: ['Open /listings', 'Inspect listing images'],
      expected: 'Every informative image has alt text',
      actual: 'Images have no alt attribute',
      recommendation: 'Add descriptive alt text, e.g. "3-bed house on Elm St"',
      foundBy: ['Accessibility'],
      source: 'rule',
    },
    {
      id: 'UIA-004',
      fingerprint: 'fp-price-filter-0004',
      title: 'No price filter on listings',
      category: 'Domain',
      severity: 'Low',
      page: `${base}/listings`,
      viewport: 'all',
      evidence: [{ kind: 'domain-check', value: 're-price-filter' }],
      stepsToReproduce: ['Open /listings', 'Look for a price filter'],
      expected: 'Users can filter by price range',
      actual: 'No price filter exists',
      recommendation: 'Add min/max price filters',
      foundBy: ['Domain Expert'],
      source: 'rule',
    },
  ];
}

export function cannedReport(id: string, target: string, createdAt: string): Report {
  const findings = cannedFindings(target);
  return {
    id,
    version: 1,
    createdAt,
    finishedAt: new Date().toISOString(),
    target,
    options: {
      url: target,
      depth: 2,
      maxPages: 15,
      domain: 'auto',
      viewports: ['desktop', 'tablet', 'mobile'],
      competitors: [],
      allowForms: false,
      lighthouse: true,
      respectRobots: true,
      rateLimitMs: 300,
    },
    domain: { name: 'real-estate', detected: true, confidence: 0.9 },
    scores: {
      overall: 72,
      byCategory: { UX: 60, Navigation: 70, Functional: 90, Accessibility: 75, Performance: 80, SEO: 85, Security: 90, Domain: 65 },
    },
    summary: { topIssues: findings.map((f) => f.id), counts: { Critical: 1, High: 1, Medium: 1, Low: 1 }, pagesAudited: 3 },
    findings,
    nav: { nodes: [], edges: [], brokenLinks: [] },
    pages: [],
    domainInsights: [],
    agents: [],
    generatedTests: [],
    notes: ['Canned report from the fake engine'],
  };
}

export interface FakeEngineOptions {
  /** Delay between progress events, ms. */
  delayMs?: number;
  /** Make the run fail after the crawl stage. */
  fail?: boolean;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Mirrors the real engine's file contract: meta.json, progress.jsonl, report.json, report.html, evidence/. */
export function createFakeRunAudit(opts: FakeEngineOptions = {}) {
  const calls: RunAuditInput[] = [];
  const fn = async (input: RunAuditInput): Promise<Report> => {
    calls.push(input);
    const runId = input.runId ?? `fake-${Date.now()}`;
    const runDir = resolve(input.reportsDir, runId);
    mkdirSync(join(runDir, 'evidence'), { recursive: true });
    mkdirSync(join(runDir, 'designs'), { recursive: true });
    const createdAt = new Date().toISOString();
    const meta: RunMeta = { id: runId, url: input.options.url, status: 'running', createdAt };
    const saveMeta = () => writeFileSync(join(runDir, 'meta.json'), JSON.stringify(meta, null, 2));
    saveMeta();
    const emit = async (stage: Stage, status: ProgressEvent['status'], message: string, pct?: number, agent?: string) => {
      const e: ProgressEvent = { runId, ts: new Date().toISOString(), stage, status, message, pct, ...(agent ? { agent } : {}) };
      appendFileSync(join(runDir, 'progress.jsonl'), JSON.stringify(e) + '\n');
      input.onProgress?.(e);
      if (opts.delayMs) await sleep(opts.delayMs);
    };

    await emit('crawl', 'started', `Crawling ${input.options.url}`, 2);
    if (input.credentials) await emit('login', 'done', 'Logged in', 10);
    else if (input.sessionStatePath) await emit('login', 'done', 'Signed in with the saved session', 10);
    await emit('crawl', 'done', 'Crawled 3 pages', 35);
    if (opts.fail) {
      meta.status = 'failed';
      meta.error = 'Simulated failure';
      meta.finishedAt = new Date().toISOString();
      saveMeta();
      await emit('error', 'failed', 'Simulated failure');
      throw new Error('Simulated failure');
    }
    await emit('rules', 'done', '4 rule-based findings; domain: Real estate', 40);
    await emit('agents', 'started', 'Running specialist agents', 42);
    await emit('agents', 'done', 'UX Designer finished', 55, 'UX Designer');
    await emit('agents', 'done', 'SDET finished', 70, 'SDET');
    await emit('design', 'done', '1 design alternative', 92);

    for (const f of ['p1-mobile-el1.png', 'p1-mobile.png', 'p1-desktop.png']) writeFileSync(join(runDir, 'evidence', f), PNG);
    for (const f of ['UIA-001-good.png', 'UIA-001-better.png']) writeFileSync(join(runDir, 'designs', f), PNG);
    writeFileSync(join(runDir, 'designs', 'UIA-001-good.html'), '<!doctype html><title>Good</title><p>Good</p>');
    writeFileSync(join(runDir, 'designs', 'UIA-001-better.html'), '<!doctype html><title>Better</title><p>Better</p>');
    const report = cannedReport(runId, input.options.url, createdAt);
    writeFileSync(join(runDir, 'report.json'), JSON.stringify(report, null, 2));
    writeFileSync(
      join(runDir, 'report.html'),
      `<!doctype html><html lang="en"><meta charset="utf-8"><title>UI Auditor report</title><body style="font-family:system-ui"><h1 data-testid="report-title">UI Auditor report for ${input.options.url}</h1><p>Score ${report.scores.overall}/100</p></body></html>`,
    );
    writeFileSync(join(runDir, 'report.md'), `# UI Auditor report\n\nScore ${report.scores.overall}/100\n`);
    meta.status = 'done';
    meta.finishedAt = report.finishedAt;
    meta.overall = report.scores.overall;
    saveMeta();
    await emit('done', 'done', `Audit complete: score ${report.scores.overall}/100, 4 findings`, 100);
    return report;
  };
  return Object.assign(fn, { calls });
}
