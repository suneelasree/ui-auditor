import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DOMAIN_NAMES, type EvidenceBundle, type PageEvidence } from '../../src/core/types.js';
import { detectDomain, domainCheckFindings, loadDomainPacks } from '../../src/agents/domain.js';
import { parseHtml, parseSelector, selectorMatches } from '../../src/agents/htmlMatch.js';
import { validateEvidence } from '../../src/agents/evidence.js';

function page(over: Partial<PageEvidence> = {}): PageEvidence {
  return {
    url: 'https://example.test/', path: '/', title: '', depth: 0, status: 200, lang: 'en', metaDescription: null,
    h1: [], headings: [], textSample: '', links: [], buttons: [], images: [], forms: [], console: [],
    networkFailures: [], securityHeaders: {}, captures: [], requiresLogin: false, domSnapshot: '', ...over,
  };
}

function bundleWith(pages: { html: string; over?: Partial<PageEvidence> }[]): EvidenceBundle {
  const runDir = mkdtempSync(join(tmpdir(), 'uia-domain-'));
  mkdirSync(join(runDir, 'dom'));
  return {
    runDir, startUrl: 'https://example.test/', startedAt: new Date().toISOString(),
    pages: pages.map((p, i) => {
      writeFileSync(join(runDir, 'dom', `p${i}.html`), p.html);
      return page({ domSnapshot: `dom/p${i}.html`, ...p.over });
    }),
    nav: { nodes: [], edges: [], brokenLinks: [] }, robotsBlocked: [], loginUsed: false, errors: [],
  };
}

const packs = loadDomainPacks();
const realEstate = packs.find((p) => p.name === 'real-estate')!;

describe('domain packs', () => {
  it('loads and validates all 8 packs', () => {
    expect(packs.map((p) => p.name).sort()).toEqual([...DOMAIN_NAMES].sort());
    for (const p of packs.filter((x) => x.name !== 'generic')) expect(p.checks.length).toBeGreaterThanOrEqual(5);
  });

  it('every pack selector is supported by the strict matcher', () => {
    for (const p of packs) for (const c of p.checks) for (const s of c.signals.selectors) expect(() => parseSelector(s), `${p.name}/${c.id}: ${s}`).not.toThrow();
  });

  it('check ids are unique across packs', () => {
    const ids = packs.flatMap((p) => p.checks.map((c) => c.id));
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('real-estate has the required checks', () => {
    const ids = realEstate.checks.map((c) => c.id);
    for (const id of ['re-price-filter', 're-map-view', 're-mortgage-calculator', 're-agent-contact', 're-save-favourite', 're-neighbourhood-info', 're-sort', 're-photo-gallery', 're-beds-baths-filter']) expect(ids).toContain(id);
  });

  it('throws a clear error naming the bad file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'uia-packs-'));
    writeFileSync(join(dir, 'broken.yaml'), 'name: nope\ndisplayName: X\n');
    expect(() => loadDomainPacks(dir)).toThrow(/broken\.yaml/);
  });
});

describe('detectDomain', () => {
  it('detects real-estate from listing text', () => {
    const b = bundleWith([{ html: '<p></p>', over: { title: 'Homes for sale | Acme Realty', headings: [{ level: 2, text: 'Featured listings' }], textSample: '3 bedrooms, 2 bathrooms, 1,800 sq ft. Property for sale. Mortgage options. Open house Sunday. Another listing: 2 beds 1 bath condo.' } }]);
    const d = detectDomain(b, packs, 'auto');
    expect(d.name).toBe('real-estate');
    expect(d.detected).toBe(true);
    expect(d.confidence).toBeGreaterThan(0);
    expect(d.confidence).toBeLessThanOrEqual(1);
  });

  it('falls back to generic for unrelated text', () => {
    const b = bundleWith([{ html: '<p></p>', over: { title: 'My blog', textSample: 'Thoughts about gardening, tomatoes and the weather this spring.' } }]);
    expect(detectDomain(b, packs, 'auto').name).toBe('generic');
  });

  it('respects an explicit override', () => {
    const b = bundleWith([{ html: '<p></p>', over: { textSample: 'homes for sale, listings, bedrooms, bathrooms, mortgage, realtor' } }]);
    expect(detectDomain(b, packs, 'banking')).toEqual({ name: 'banking', detected: false, confidence: 1 });
  });
});

describe('domainCheckFindings', () => {
  it('flags a missing price filter', () => {
    const b = bundleWith([{ html: '<html><body><h1>Listings</h1><div class="card">$450,000</div></body></html>', over: { title: 'Listings', textSample: 'Listings $450,000 Price' } }]);
    const findings = domainCheckFindings(b, realEstate);
    const price = findings.find((f) => f.evidence[0].value === 're-price-filter');
    expect(price).toBeDefined();
    expect(price).toMatchObject({ category: 'Domain', foundBy: 'Domain Expert', source: 'rule', viewport: 'all', severity: 'High' });
    expect(price!.evidence[0]).toMatchObject({ kind: 'domain-check' });
    expect(price!.evidence[0].detail).toMatch(/Searched 1 page/);
    // deterministic domain findings survive grounding
    expect(validateEvidence(findings, b).dropped).toBe(0);
  });

  it('does not flag the price filter when <input name="minPrice"> exists', () => {
    const b = bundleWith([{ html: '<form><label>From <input name="minPrice" type="number"></label></form>' }]);
    const ids = domainCheckFindings(b, realEstate).map((f) => f.evidence[0].value);
    expect(ids).not.toContain('re-price-filter');
    expect(ids).toContain('re-map-view');
  });

  it('does not flag when a keyword appears in the page text', () => {
    const b = bundleWith([{ html: '<div>Choose a price range</div>' }]);
    expect(domainCheckFindings(b, realEstate).map((f) => f.evidence[0].value)).not.toContain('re-price-filter');
  });

  it('points filter findings at a listings page when one exists', () => {
    const b = bundleWith([
      { html: '<p>Home</p>' },
      { html: '<p>Results</p>', over: { url: 'https://example.test/listings', path: '/listings', depth: 1, title: 'Listings' } },
    ]);
    const f = domainCheckFindings(b, realEstate).find((x) => x.evidence[0].value === 're-price-filter');
    expect(f!.page).toBe('https://example.test/listings');
  });
});

describe('htmlMatch', () => {
  const doc = parseHtml(`<!-- <input name="price"> --><div id="app" class="map wrap"><nav><ul><li><a href="/Contact-Agent">Talk</a></li></ul></nav>
    <select name="sort_by" aria-label="Sort"></select><img src="a.png" alt=""><p>Hi &amp; bye</p><script>var x = "<input name='bed'>"</script></div>`);
  it.each([
    ['#app', true], ['.map', true], ['[class~=map]', true], ['[class~=ma]', false], ['div.wrap > nav a', true],
    ['div > a', false], ['a[href*=contact-agent i]', true], ['a[href*=contact-agent]', false], ['select[name^=sort]', true],
    ['input[name*=price i]', false], ['input[name*=bed i]', false], ['img[alt=""]', true], ['span, select', true],
    ['div:not(.wrap)', false], ['nav + select', true], ['nav ~ p', true],
  ])('%s -> %s', (sel, expected) => {
    expect(selectorMatches(doc, sel)).toBe(expected);
  });
  it('extracts text without scripts or comments', () => {
    expect(doc.text).toContain('Hi & bye');
    expect(doc.text).not.toContain('var x');
  });
  it('rejects unsupported pseudo-classes in strict mode, ignores them in lenient mode', () => {
    expect(() => selectorMatches(doc, 'li:nth-child(1)')).toThrow();
    expect(selectorMatches(doc, 'li:nth-child(1)', { lenient: true })).toBe(true);
  });
});
