import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { deflateSync, crc32 } from 'node:zlib';
import ts from 'typescript';
import type { EvidenceBundle, Finding, PageEvidence, Report } from '../../src/core/types.js';
import { computeScores } from '../../src/report/scoring.js';
import { generateTests } from '../../src/report/testgen.js';
import { renderMarkdown } from '../../src/report/markdown.js';
import { renderHtml } from '../../src/report/html.js';
import { writeReport } from '../../src/report/write.js';

/** Minimal valid RGB PNG of a solid colour. */
function png(width: number, height: number, rgb: [number, number, number]): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const row = Buffer.alloc(1 + width * 3);
  for (let x = 0; x < width; x++) row.set(rgb, 1 + x * 3);
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const BASE = 'https://homes.example.test';
const XSS = '<script>alert("pwned")</script>';

function finding(over: Partial<Finding> & Pick<Finding, 'id' | 'title' | 'category' | 'severity'>): Finding {
  return {
    fingerprint: over.id.toLowerCase(),
    page: `${BASE}/`,
    viewport: 'desktop',
    evidence: [{ kind: 'selector', value: '#x' }],
    stepsToReproduce: ['Open the page'],
    expected: 'It works',
    actual: 'It does not',
    recommendation: 'Fix it',
    foundBy: ['Rules'],
    source: 'rule',
    ...over,
  };
}

const findings: Finding[] = [
  finding({
    id: 'UIA-001',
    title: 'Primary "Search Homes" button invisible on mobile',
    category: 'UX',
    severity: 'Critical',
    viewport: 'mobile',
    foundBy: ['UX Designer', 'SDET', 'Rules'],
    source: 'agent',
    evidence: [
      { kind: 'selector', value: 'button.search-cta', screenshot: 'evidence/p1-mobile-fold.png', region: { x: 40, y: 60, width: 120, height: 40 } },
    ],
    stepsToReproduce: ['Open / at 375px wide', 'Look for the search button'],
    expected: 'Search button visible above the fold',
    actual: 'Button has display:none below 768px',
    recommendation: 'Remove the display:none media query on .search-cta',
    designAlternative: {
      original: 'evidence/p1-mobile-fold.png',
      goodHtml: 'design/uia-001-good.html',
      goodScreenshot: 'design/uia-001-good.png',
      betterHtml: 'design/uia-001-better.html',
      betterScreenshot: 'design/uia-001-better.png',
      goodSummary: 'Show the existing button full width under the hero.',
      betterSummary: 'Sticky search bar with location autocomplete.',
    },
  }),
  finding({
    id: 'UIA-002',
    title: 'Broken link to /mortgage-calculator',
    category: 'Navigation',
    severity: 'High',
    foundBy: ['Rules', 'SDET'],
    evidence: [{ kind: 'link', value: `${BASE}/mortgage-calculator`, detail: 'HTTP 404' }],
  }),
  finding({
    id: 'UIA-003',
    title: 'Contact form has no validation',
    category: 'Functional',
    severity: 'High',
    page: `${BASE}/contact`,
    evidence: [{ kind: 'selector', value: 'form#contact' }],
  }),
  finding({
    id: 'UIA-004',
    title: `"Save listing" button does nothing ${XSS}`,
    category: 'Functional',
    severity: 'Medium',
    page: `${BASE}/listings`,
    evidence: [{ kind: 'selector', value: 'button.save' }],
  }),
  finding({
    id: 'UIA-005',
    title: 'Uncaught TypeError on listings page',
    category: 'Functional',
    severity: 'Medium',
    page: `${BASE}/listings`,
    evidence: [{ kind: 'console', value: "TypeError: Cannot read properties of undefined (reading 'price')" }],
  }),
  finding({
    id: 'UIA-006',
    title: 'Filter results are inconsistent',
    category: 'Functional',
    severity: 'Low',
    page: `${BASE}/listings`,
    evidence: [{ kind: 'metric', value: 'results=0' }],
    stepsToReproduce: ['Open /listings', 'Filter by 3 beds */ evil', 'Line\nbreak'],
  }),
  finding({
    id: 'UIA-007',
    title: 'Low contrast footer text',
    category: 'Accessibility',
    severity: 'Low',
    evidence: [{ kind: 'axe-rule', value: 'color-contrast' }],
  }),
];

function page(path: string, over: Partial<PageEvidence> = {}): PageEvidence {
  return {
    url: `${BASE}${path}`, path, title: path, depth: 1, status: 200, lang: 'en', metaDescription: null, h1: [], headings: [],
    textSample: '', links: [], buttons: [], images: [], forms: [], console: [], networkFailures: [], securityHeaders: {},
    captures: [], requiresLogin: false, domSnapshot: '', ...over,
  };
}

const bundle: EvidenceBundle = {
  runDir: '',
  startUrl: `${BASE}/`,
  startedAt: '2026-10-24T10:00:00.000Z',
  pages: [
    page('/', { depth: 0 }),
    page('/contact', { forms: [{ selector: 'form#contact', fields: [], hasValidation: false }] }),
    page('/listings', { buttons: [{ selector: 'button.save', text: 'Save', hasHandler: false }] }),
  ],
  nav: { nodes: [], edges: [], brokenLinks: [] },
  robotsBlocked: [],
  loginUsed: false,
  errors: [],
};

function makeReport(): Report {
  return {
    id: 'run-test',
    version: 1,
    createdAt: '2026-10-24T10:00:00.000Z',
    finishedAt: '2026-10-24T10:05:00.000Z',
    target: `${BASE}/`,
    options: {
      url: `${BASE}/`, depth: 2, maxPages: 15, domain: 'auto', viewports: ['desktop', 'tablet', 'mobile'], competitors: ['https://rival.example.test/'],
      allowForms: false, lighthouse: true, respectRobots: true, rateLimitMs: 300,
    },
    domain: { name: 'real-estate', detected: true, confidence: 0.82 },
    scores: computeScores(findings),
    summary: { topIssues: findings.slice(0, 5).map((f) => f.id), counts: { Critical: 1, High: 2, Medium: 2, Low: 2 }, pagesAudited: 4 },
    findings,
    nav: {
      nodes: [
        { url: `${BASE}/`, title: 'Home', depth: 0, outLinks: 3, inLinks: 2, deadEnd: false, orphan: false },
        { url: `${BASE}/listings`, title: 'Listings', depth: 1, outLinks: 1, inLinks: 1, deadEnd: false, orphan: false },
        { url: `${BASE}/contact`, title: 'Contact', depth: 1, outLinks: 0, inLinks: 1, deadEnd: true, orphan: false },
        { url: `${BASE}/old-promo`, title: 'Old promo', depth: 1, outLinks: 1, inLinks: 0, deadEnd: false, orphan: true },
      ],
      edges: [
        { from: `${BASE}/`, to: `${BASE}/listings` },
        { from: `${BASE}/`, to: `${BASE}/contact` },
        { from: `${BASE}/listings`, to: `${BASE}/` },
        { from: `${BASE}/old-promo`, to: `${BASE}/` },
      ],
      brokenLinks: [{ from: `${BASE}/`, href: `${BASE}/mortgage-calculator`, status: 404 }],
    },
    pages: [
      { url: `${BASE}/`, title: 'Home', screenshot: 'evidence/p1-desktop-fold.png', requiresLogin: false },
      { url: `${BASE}/listings`, title: 'Listings', screenshot: 'evidence/missing.png', requiresLogin: false },
    ],
    domainInsights: ['Leading real-estate sites show a map view next to listings; this one does not.'],
    comparison: {
      sites: [
        { url: `${BASE}/`, label: 'homes.example.test', isTarget: true, scores: computeScores(findings) },
        { url: 'https://rival.example.test/', label: 'rival.example.test', isTarget: false, scores: computeScores([]), screenshot: 'competitors/rival.png' },
      ],
      theyDoBetter: [{ competitor: 'rival.example.test', title: 'Saved searches', detail: 'Lets users save a search and get alerts.', screenshot: 'competitors/rival.png' }],
      youWin: ['Faster LCP on the home page'],
      patternsToCopy: ['Sticky search bar on mobile'],
    },
    agents: [
      { name: 'Rules', status: 'ok', findings: 5, dropped: 0 },
      { name: 'UX Designer', status: 'ok', findings: 3, dropped: 1, note: '1 finding cited an unknown selector' },
      { name: 'Design Recommender', status: 'skipped', findings: 0, dropped: 0, note: 'No API key' },
    ],
    generatedTests: ['tests/generated/home.spec.ts'],
    notes: ['AI agents skipped: ANTHROPIC_API_KEY is not set. Only rule-based findings are included.'],
  };
}

let runDir: string;

beforeAll(() => {
  runDir = mkdtempSync(join(tmpdir(), 'uia-report-'));
  mkdirSync(join(runDir, 'evidence'));
  mkdirSync(join(runDir, 'design'));
  mkdirSync(join(runDir, 'competitors'));
  writeFileSync(join(runDir, 'evidence/p1-mobile-fold.png'), png(375, 300, [220, 230, 245]));
  writeFileSync(join(runDir, 'evidence/p1-desktop-fold.png'), png(480, 300, [235, 240, 235]));
  writeFileSync(join(runDir, 'design/uia-001-good.png'), png(375, 300, [200, 240, 210]));
  writeFileSync(join(runDir, 'design/uia-001-better.png'), png(375, 300, [190, 210, 250]));
  writeFileSync(join(runDir, 'competitors/rival.png'), png(480, 300, [250, 230, 200]));
});

afterAll(() => {
  rmSync(runDir, { recursive: true, force: true });
});

describe('generateTests', () => {
  it('writes one valid spec per page for functional/navigation/hidden-CTA findings', () => {
    const files = generateTests(findings, { ...bundle, runDir }, runDir);
    expect(files.sort()).toEqual(['tests/generated/contact.spec.ts', 'tests/generated/home.spec.ts', 'tests/generated/listings.spec.ts']);

    const sources = Object.fromEntries(files.map((f) => [f, readFileSync(join(runDir, f), 'utf8')]));
    for (const [file, src] of Object.entries(sources)) {
      const out = ts.transpileModule(src, {
        fileName: file,
        reportDiagnostics: true,
        compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
      });
      expect(out.diagnostics ?? [], file).toHaveLength(0);
      expect(src).toContain("from '@playwright/test'");
      expect(src).toMatch(/currently FAIL/);
    }

    const home = sources['tests/generated/home.spec.ts'];
    expect(home).toContain('UIA-001: Primary \\"Search Homes\\" button invisible on mobile');
    expect(home).toContain('setViewportSize({ width: 375, height: 812 })');
    expect(home).toContain('toBeVisible()');
    expect(home).toContain('UIA-002: Broken link');
    expect(home).toContain('toBeLessThan(400)');
    expect(home).not.toContain('UIA-007'); // accessibility findings get no test

    expect(sources['tests/generated/contact.spec.ts']).toContain(":invalid");
    const listings = sources['tests/generated/listings.spec.ts'];
    expect(listings).toContain('MutationObserver');
    expect(listings).toContain("msg.type() === 'error'");
    expect(listings).toContain('test.fixme("UIA-006: Filter results are inconsistent"');
    // injected title stays inside a string literal
    expect(listings).toContain('<script>alert(\\"pwned\\")</script>');
  });

  it('returns [] when nothing qualifies', () => {
    expect(generateTests([findings[6]], { ...bundle, runDir }, runDir)).toEqual([]);
  });
});

describe('renderMarkdown', () => {
  it('contains scores, every finding and the comparison', () => {
    const md = renderMarkdown(makeReport());
    expect(md).toMatch(/^# UI Audit: /);
    for (const f of findings) expect(md).toContain(`### ${f.id}: `);
    expect(md).toContain(`| **Overall** | **${makeReport().scores.overall}** |`);
    expect(md).toContain('| Critical | 1 |');
    expect(md).toContain('`/` @ mobile 375px');
    expect(md).toContain('Sticky search bar with location autocomplete.');
    expect(md).toContain('## Competitor comparison');
    expect(md).toContain('AI agents skipped');
    expect(md).not.toContain('<script>');
  });
});

describe('renderHtml', () => {
  it('is self-contained, embeds images, escapes content and has filters', () => {
    const html = renderHtml(makeReport(), runDir);
    if (process.env.UIA_SAMPLE_OUT) writeFileSync(process.env.UIA_SAMPLE_OUT, html);
    expect(html).not.toMatch(/src="http/i);
    expect(html).not.toMatch(/<link[^>]+href=/i);
    expect(html).not.toMatch(/url\(\s*['"]?http/i);
    // only plain anchors may point at http(s)
    for (const m of html.matchAll(/<(\w+)[^>]*\shref="http[^"]*"/g)) expect(m[1]).toBe('a');
    expect(html).toContain('data:image/png;base64,');
    expect(html).not.toContain(XSS);
    expect(html).toContain('&#60;script&#62;alert(&#34;pwned&#34;)&#60;/script&#62;');
    expect(html.match(/<script>/g)).toHaveLength(1);
    for (const id of ['f-q', 'f-sev', 'f-cat', 'f-page', 'f-persona']) expect(html).toContain(`id="${id}"`);
    for (const f of findings) expect(html).toContain(`id="${f.id}"`);
    expect(html).toContain('class="region"');
    expect(html).toContain('dead end');
    expect(html).toContain('orphan');
    expect(html).toContain('Competitor comparison');
    expect(html).toContain('AI agents skipped');
    expect(html).toContain('tests/generated/home.spec.ts');
    expect(html).toContain('Better (redesign)');
  });

  it('skips missing images and refuses paths outside the run dir', () => {
    const r = makeReport();
    r.pages = [{ url: `${BASE}/`, title: 'Home', screenshot: '../../etc/secret.png', requiresLogin: false }];
    r.findings = [];
    r.comparison = undefined;
    const html = renderHtml(r, runDir);
    expect(html).not.toContain('data:image');
  });
});

describe('writeReport', () => {
  it('writes html, json and md and returns absolute paths', async () => {
    const out = await writeReport(makeReport(), runDir);
    for (const p of [out.html, out.json, out.md]) {
      expect(isAbsolute(p)).toBe(true);
      expect(existsSync(p)).toBe(true);
    }
    expect(JSON.parse(readFileSync(out.json, 'utf8')).id).toBe('run-test');
    expect(readFileSync(out.json, 'utf8')).toContain('\n  "id"');
  });
});
