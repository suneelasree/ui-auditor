import { describe, expect, it } from 'vitest';
import type { EvidenceBundle, PageEvidence } from '../../src/core/types.js';
import { buildNavGraph } from '../../src/crawler/navgraph.js';
import { ruleFindings } from '../../src/rules/ruleFindings.js';

const O = 'https://shop.example.com';

function page(path: string, over: Partial<PageEvidence> = {}): PageEvidence {
  const url = O + path;
  return {
    url,
    path,
    title: path,
    depth: path === '/' ? 0 : 1,
    status: 200,
    lang: 'en',
    metaDescription: 'A page',
    h1: ['Title'],
    headings: [{ level: 1, text: 'Title' }],
    textSample: '',
    links: [],
    buttons: [],
    images: [],
    forms: [],
    console: [],
    networkFailures: [],
    securityHeaders: {
      'content-security-policy': "default-src 'self'",
      'strict-transport-security': 'max-age=1',
      'x-content-type-options': 'nosniff',
      'x-frame-options': 'DENY',
      'referrer-policy': 'no-referrer',
      'permissions-policy': 'camera=()',
    },
    captures: [
      { viewport: 'desktop', screenshot: `evidence${path.replace(/\W/g, '_')}-d.png`, aboveFold: `evidence${path.replace(/\W/g, '_')}-df.png`, axe: [], hiddenCtas: [], horizontalOverflow: false },
    ],
    requiresLogin: false,
    domSnapshot: 'evidence/x.html',
    ...over,
  };
}

const link = (href: string, ok = true, status: number | null = 200) => ({ href: O + href, text: href, selector: `a[href="${href}"]`, internal: true, status, ok });

function bundle(pages: PageEvidence[]): EvidenceBundle {
  return { runDir: '/tmp/x', startUrl: O + '/', startedAt: '', pages, nav: buildNavGraph(pages, O + '/'), robotsBlocked: [], loginUsed: false, errors: [] };
}

describe('buildNavGraph', () => {
  it('finds dead ends, orphans and broken links', () => {
    const pages = [
      page('/', { links: [link('/a'), link('/missing', false, 404)] }),
      page('/a', { links: [link('/')] }),
      page('/dead'),
      page('/b', { links: [link('/'), link('/b')] }),
    ];
    const g = buildNavGraph(pages, O + '/');
    const n = (p: string) => g.nodes.find((x) => x.url === O + p)!;
    expect(n('/dead').deadEnd).toBe(true);
    expect(n('/dead').orphan).toBe(true);
    expect(n('/a').deadEnd).toBe(false);
    expect(n('/a').inLinks).toBe(1);
    expect(n('/').orphan).toBe(false);
    expect(n('/b').outLinks).toBe(1); // self link ignored
    expect(g.brokenLinks).toEqual([{ from: O + '/', href: O + '/missing', status: 404 }]);
    expect(g.edges).toContainEqual({ from: O + '/', to: O + '/a' });
  });
  it('follows redirect aliases', () => {
    const pages = [page('/', { links: [link('/account')] }), page('/login', { links: [link('/')] })];
    const g = buildNavGraph(pages, O + '/', new Map([[O + '/account', O + '/login']]));
    expect(g.nodes.find((x) => x.url === O + '/login')!.orphan).toBe(false);
  });
});

describe('ruleFindings mapping', () => {
  const home = page('/', {
    links: [link('/gone', false, 404), link('/about')],
    buttons: [
      { selector: 'button.dead', text: 'Book now', hasHandler: false },
      { selector: 'button.ok', text: 'Save', hasHandler: true },
    ],
    images: [
      { src: O + '/big.png', selector: 'img.big', alt: 'Team', naturalWidth: 2400, naturalHeight: 1600, renderedWidth: 300, renderedHeight: 200, bytes: 900_000 },
      { src: O + '/a.svg', selector: 'img.noalt', alt: null, naturalWidth: 100, naturalHeight: 100, renderedWidth: 100, renderedHeight: 100 },
    ],
    forms: [
      { selector: '#contact', fields: [{ name: 'name', type: 'text', required: false }, { name: 'email', type: 'text', required: false }], hasValidation: false },
      { selector: '#search', fields: [{ name: 'q', type: 'search', required: false }], hasValidation: false },
    ],
    console: [
      { type: 'error', text: 'Uncaught TypeError: x is undefined' },
      { type: 'error', text: 'Failed to load resource: the server responded with a status of 404 (Not Found)' },
    ],
    networkFailures: [{ url: O + '/missing.jpg', method: 'GET', resourceType: 'image', status: 404 }],
    lighthouse: { performance: 40, accessibility: 90, bestPractices: 90, seo: 90, lcpMs: 5200, cls: 0.02, tbtMs: 100, fcpMs: 900 },
    securityHeaders: { 'content-security-policy': null, 'strict-transport-security': null, 'x-content-type-options': 'nosniff', 'x-frame-options': null, 'referrer-policy': null, 'permissions-policy': null },
    captures: [
      {
        viewport: 'desktop', screenshot: 'evidence/d.png', aboveFold: 'evidence/df.png', hiddenCtas: [], horizontalOverflow: false,
        axe: [{ id: 'color-contrast', impact: 'serious', help: 'Elements must meet minimum color contrast ratio thresholds', helpUrl: 'https://x', nodes: [{ target: 'p.fine', html: '<p class="fine">' }] }],
      },
      {
        viewport: 'mobile', screenshot: 'evidence/m.png', aboveFold: 'evidence/mf.png', horizontalOverflow: true,
        axe: [{ id: 'color-contrast', impact: 'serious', help: 'Elements must meet minimum color contrast ratio thresholds', helpUrl: 'https://x', nodes: [{ target: 'p.fine', html: '<p class="fine">' }] }],
        hiddenCtas: [{ selector: 'a.cta', text: 'Get a quote', box: { x: 1, y: 2, width: 3, height: 4 }, screenshot: 'evidence/cta.png' }],
      },
    ],
  });
  const about = page('/about', { h1: [], headings: [{ level: 2, text: 'About' }], metaDescription: null, links: [link('/gone', false, 404)] });
  const dead = page('/dead', { h1: ['A', 'B'] });
  const findings = ruleFindings(bundle([home, about, dead]));
  const by = (pred: (f: (typeof findings)[number]) => boolean) => findings.filter(pred);
  const withEv = (kind: string, value: string) => by((f) => f.evidence.some((e) => e.kind === kind && e.value === value));

  it('all findings are rule-sourced and complete', () => {
    for (const f of findings) {
      expect(f.source).toBe('rule');
      expect(f.evidence.length).toBeGreaterThan(0);
      expect(f.stepsToReproduce.length).toBeGreaterThan(0);
      expect(f.expected && f.actual && f.recommendation).toBeTruthy();
    }
  });
  it('broken link grouped across pages -> SDET / Navigation', () => {
    const f = withEv('link', O + '/gone');
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ foundBy: 'SDET', category: 'Navigation', severity: 'High' });
  });
  it('dead button -> SDET / Functional; handled button ignored', () => {
    expect(withEv('selector', 'button.dead')[0]).toMatchObject({ foundBy: 'SDET', category: 'Functional' });
    expect(withEv('selector', 'button.ok')).toHaveLength(0);
  });
  it('form without validation flagged, single search field form ignored', () => {
    expect(withEv('selector', '#contact')[0]).toMatchObject({ foundBy: 'SDET', category: 'Functional' });
    expect(withEv('selector', '#search')).toHaveLength(0);
  });
  it('dead end + overflow -> SDET', () => {
    expect(by((f) => f.title.startsWith('Navigation dead end') && f.page === O + '/dead')[0]).toMatchObject({ foundBy: 'SDET', category: 'Navigation' });
    expect(by((f) => f.title.startsWith('Page scrolls horizontally'))[0]).toMatchObject({ foundBy: 'SDET', viewport: 'mobile' });
  });
  it('engineering findings', () => {
    expect(withEv('console', 'Uncaught TypeError: x is undefined')[0]).toMatchObject({ foundBy: 'Senior Engineer', severity: 'High' });
    expect(by((f) => f.evidence.some((e) => e.kind === 'console' && e.value.startsWith('Failed to load')))).toHaveLength(0);
    expect(withEv('network', O + '/missing.jpg')[0]).toMatchObject({ foundBy: 'Senior Engineer' });
    expect(withEv('network', O + '/big.png')[0]).toMatchObject({ foundBy: 'Senior Engineer', category: 'Performance' });
    expect(withEv('metric', 'lcpMs=5200')[0]).toMatchObject({ category: 'Performance', severity: 'High' });
    const sec = by((f) => f.category === 'Security');
    expect(sec).toHaveLength(1);
    expect(sec[0]!.severity).toBe('Medium');
    expect(by((f) => f.title.startsWith('Missing meta description'))[0]).toMatchObject({ category: 'SEO', foundBy: 'Senior Engineer' });
  });
  it('axe: one finding per rule per page, severity from impact', () => {
    const f = withEv('axe-rule', 'color-contrast');
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ foundBy: 'Accessibility', category: 'Accessibility', severity: 'High', viewport: 'all' });
    expect(withEv('selector', 'img.noalt')[0]).toMatchObject({ foundBy: 'Accessibility', category: 'Accessibility' });
  });
  it('UX: hidden CTA and headings', () => {
    expect(withEv('selector', 'a.cta')[0]).toMatchObject({ foundBy: 'UX Designer', category: 'UX', viewport: 'mobile' });
    expect(by((f) => f.title === 'Missing H1 heading on /about')[0]).toMatchObject({ foundBy: 'UX Designer', category: 'SEO' });
    expect(by((f) => f.title.startsWith('2 H1 headings'))[0]).toMatchObject({ severity: 'Low' });
  });
  it('localhost gets a single Low security finding', () => {
    const local = page('/', { securityHeaders: { 'content-security-policy': null, 'x-frame-options': null } });
    local.url = 'http://127.0.0.1:4100/';
    const b: EvidenceBundle = { ...bundle([local]), startUrl: local.url };
    const sec = ruleFindings(b).filter((f) => f.category === 'Security');
    expect(sec).toHaveLength(1);
    expect(sec[0]!.severity).toBe('Low');
  });
});

describe('hidden controls on small screens', () => {
  const cta = (n: number) => ({ selector: `button.tab-${n}`, text: `Tab ${n}`, box: { x: n, y: 0, width: 10, height: 10 }, screenshot: `evidence/cta${n}.png` });
  const withHidden = (count: number) =>
    page('/app', {
      captures: [
        { viewport: 'desktop', screenshot: 'evidence/d.png', aboveFold: 'evidence/df.png', axe: [], hiddenCtas: [], horizontalOverflow: false },
        { viewport: 'mobile', screenshot: 'evidence/m.png', aboveFold: 'evidence/mf.png', axe: [], hiddenCtas: Array.from({ length: count }, (_, i) => cta(i + 1)), horizontalOverflow: false },
      ],
    });
  const uxHidden = (count: number) => ruleFindings(bundle([withHidden(count)])).filter((f) => f.category === 'UX' && /disappear/.test(f.title));

  it('reports one or two hidden controls individually', () => {
    expect(uxHidden(2)).toHaveLength(2);
  });

  it('groups many hidden controls on a page into one finding that lists them', () => {
    const found = uxHidden(12);
    expect(found).toHaveLength(1);
    expect(found[0].title).toBe('12 controls disappear on mobile');
    expect(found[0].actual).toContain('"Tab 1"');
    expect(found[0].actual).toContain('and 4 more');
    expect(found[0].evidence.filter((e) => e.kind === 'selector')).toHaveLength(8);
  });
});
