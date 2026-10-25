import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AttributedFinding, EvidenceBundle, EvidenceItem, PageEvidence } from '../../src/core/types.js';
import { validateEvidence } from '../../src/agents/evidence.js';

function makeBundle(): EvidenceBundle {
  const runDir = mkdtempSync(join(tmpdir(), 'uia-ev-'));
  mkdirSync(join(runDir, 'dom'));
  mkdirSync(join(runDir, 'evidence'));
  writeFileSync(join(runDir, 'dom', 'home.html'), '<html><body><header><button class="cta primary" id="buy">Buy</button></header><main><div class="hero"><img src="/hero.jpg"></div></main></body></html>');
  writeFileSync(join(runDir, 'evidence', 'p1-desktop.png'), 'png');
  const home: PageEvidence = {
    url: 'https://site.test/', path: '/', title: 'Home', depth: 0, status: 200, lang: 'en', metaDescription: null,
    h1: [], headings: [], textSample: '',
    links: [{ href: 'https://site.test/about', text: 'About', selector: 'a.about', internal: true, status: 404, ok: false }],
    buttons: [{ selector: 'button#buy', text: 'Buy', hasHandler: false }],
    images: [{ src: 'https://site.test/hero.jpg', selector: '.hero img', alt: null, naturalWidth: 10, naturalHeight: 10, renderedWidth: 10, renderedHeight: 10 }],
    forms: [],
    console: [{ type: 'error', text: "Uncaught TypeError: Cannot read properties of undefined (reading 'map')" }],
    networkFailures: [{ url: 'https://site.test/api/listings', method: 'GET', resourceType: 'fetch', status: 500 }],
    securityHeaders: {},
    captures: [{
      viewport: 'desktop', screenshot: 'evidence/p1-desktop-full.png', aboveFold: 'evidence/p1-desktop.png',
      axe: [{ id: 'image-alt', impact: 'critical', help: 'Images must have alt', helpUrl: '', nodes: [{ target: '.hero > img', html: '<img>' }] }],
      hiddenCtas: [], horizontalOverflow: false,
    }],
    lighthouse: { performance: 0.4, accessibility: 0.8, bestPractices: 0.9, seo: 0.9, lcpMs: 4200, cls: 0.02, tbtMs: null, fcpMs: 1200 },
    requiresLogin: false,
    domSnapshot: 'dom/home.html',
  };
  return {
    runDir, startUrl: 'https://site.test/', startedAt: '', pages: [home],
    nav: { nodes: [], edges: [], brokenLinks: [{ from: 'https://site.test/', href: '/old-page', status: 404 }] },
    robotsBlocked: [], loginUsed: false, errors: [],
  };
}

function finding(evidence: EvidenceItem[], page = 'https://site.test/'): AttributedFinding {
  return {
    title: 'Something', category: 'Functional', severity: 'Medium', page, viewport: 'desktop', evidence,
    stepsToReproduce: ['Open page'], expected: 'x', actual: 'y', recommendation: 'z', foundBy: 'SDET', source: 'agent',
  };
}

const bundle = makeBundle();
const check = (e: EvidenceItem, page?: string) => validateEvidence([finding([e], page)], bundle).kept.length === 1;

describe('validateEvidence', () => {
  it.each<[string, EvidenceItem, boolean]>([
    ['axe rule present', { kind: 'axe-rule', value: 'image-alt' }, true],
    ['axe rule absent', { kind: 'axe-rule', value: 'color-contrast' }, false],
    ['console exact-ish (case, whitespace)', { kind: 'console', value: "  uncaught typeerror: cannot read properties of undefined (reading 'map') " }, true],
    ['console substring', { kind: 'console', value: 'Cannot read properties of undefined' }, true],
    ['console superstring', { kind: 'console', value: "Console: Uncaught TypeError: Cannot read properties of undefined (reading 'map') at app.js:3" }, true],
    ['console invented', { kind: 'console', value: 'ReferenceError: foo is not defined' }, false],
    ['network failure URL', { kind: 'network', value: 'https://site.test/api/listings' }, true],
    ['network invented URL', { kind: 'network', value: 'https://site.test/api/nope' }, false],
    ['link href with trailing slash + hash', { kind: 'link', value: 'https://site.test/about/#x' }, true],
    ['nav broken link (relative)', { kind: 'link', value: 'https://site.test/old-page' }, true],
    ['image src', { kind: 'network', value: '/hero.jpg' }, true],
    ['metric name=value', { kind: 'metric', value: 'lcpMs=4200' }, true],
    ['metric alias', { kind: 'metric', value: 'LCP' }, true],
    ['metric null on page', { kind: 'metric', value: 'tbtMs=900' }, false],
    ['metric unknown', { kind: 'metric', value: 'speedIndex=3000' }, false],
    ['screenshot exists', { kind: 'screenshot', value: 'evidence/p1-desktop.png' }, true],
    ['screenshot missing', { kind: 'screenshot', value: 'evidence/nope.png' }, false],
    ['screenshot escaping runDir', { kind: 'screenshot', value: '../../etc/passwd' }, false],
    ['non-screenshot file in runDir', { kind: 'screenshot', value: 'report.json' }, false],
    ['selector in DOM', { kind: 'selector', value: 'header button.cta.primary' }, true],
    ['selector recorded by crawler', { kind: 'selector', value: '.hero > img' }, true],
    ['selector with positional pseudo', { kind: 'selector', value: 'main > div:nth-of-type(1) img' }, true],
    ['selector not in DOM', { kind: 'selector', value: 'button.search-cta' }, false],
    ['domain-check known id', { kind: 'domain-check', value: 're-price-filter' }, true],
    ['domain-check unknown id', { kind: 'domain-check', value: 'made-up-check' }, false],
  ])('%s', (_name, item, expected) => {
    expect(check(item)).toBe(expected);
  });

  it('only accepts domain-check ids that failed in this run when told which did', () => {
    const f = finding([{ kind: 'domain-check', value: 're-price-filter' }]);
    expect(validateEvidence([f], bundle, { missingDomainChecks: new Set(['re-map-view']) }).kept).toHaveLength(0);
    expect(validateEvidence([f], bundle, { missingDomainChecks: new Set(['re-price-filter']) }).kept).toHaveLength(1);
  });

  it('accepts a path-only page and rejects pages not in the bundle for page-scoped evidence', () => {
    expect(check({ kind: 'axe-rule', value: 'image-alt' }, '/')).toBe(true);
    expect(check({ kind: 'axe-rule', value: 'image-alt' }, 'https://site.test/#top')).toBe(true);
    expect(check({ kind: 'axe-rule', value: 'image-alt' }, 'https://site.test/other')).toBe(false);
  });

  it('keeps only grounded items, drops findings with none, and counts drops', () => {
    const good = finding([{ kind: 'axe-rule', value: 'image-alt' }, { kind: 'selector', value: '#invented' }]);
    const bad = finding([{ kind: 'console', value: 'invented error text' }]);
    const res = validateEvidence([good, bad], bundle);
    expect(res.dropped).toBe(1);
    expect(res.kept).toHaveLength(1);
    expect(res.kept[0].evidence).toEqual([{ kind: 'axe-rule', value: 'image-alt' }]);
  });

  it('strips a non-existent screenshot attachment but keeps the item', () => {
    const res = validateEvidence([finding([{ kind: 'axe-rule', value: 'image-alt', screenshot: 'evidence/missing.png' }])], bundle);
    expect(res.kept[0].evidence[0].screenshot).toBeUndefined();
  });
});
