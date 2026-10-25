import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AuditOptions, type EvidenceBundle, type PageEvidence } from '../../src/core/types.js';
import { crawl } from '../../src/crawler/crawl.js';
import { FIXTURE_LOGIN, startFixtures } from '../../fixtures/serve.js';

let fx: Awaited<ReturnType<typeof startFixtures>>;
let runDir: string;
let bundle: EvidenceBundle;
const dirs: string[] = [];

const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'uia-crawl-'));
  dirs.push(d);
  return d;
};
const pageAt = (path: string): PageEvidence => {
  const p = bundle.pages.find((x) => x.path === path);
  if (!p) throw new Error(`page ${path} not crawled; got ${bundle.pages.map((x) => x.path).join(', ')}`);
  return p;
};

function allFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? allFiles(p) : [p];
  });
}

beforeAll(async () => {
  fx = await startFixtures();
  runDir = tmp();
  const options = AuditOptions.parse({ url: fx.realEstateUrl, lighthouse: false, rateLimitMs: 0, maxPages: 15, depth: 2 });
  const progress: number[] = [];
  bundle = await crawl({ options, runDir, onProgress: (e) => progress.push(e.pct ?? 0) });
  expect(progress.length).toBeGreaterThan(0);
  expect(Math.min(...progress)).toBeGreaterThanOrEqual(2);
  expect(Math.max(...progress)).toBeLessThanOrEqual(35);
});

afterAll(async () => {
  await fx?.close();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

describe('crawler on the real-estate fixture (anonymous)', () => {
  it('crawls the public pages, all 3 viewports, with evidence files', () => {
    const paths = bundle.pages.map((p) => p.path);
    for (const p of ['/', '/listings', '/listings/42-harbor-view-drive', '/about', '/contact', '/privacy', '/login']) expect(paths).toContain(p);
    expect(paths).not.toContain('/account'); // redirects to /login without a session
    expect(bundle.loginUsed).toBe(false);
    for (const p of bundle.pages) {
      expect(p.requiresLogin).toBe(false);
      expect(p.captures.map((c) => c.viewport)).toEqual(['desktop', 'tablet', 'mobile']);
      expect(existsSync(join(runDir, p.domSnapshot))).toBe(true);
      for (const c of p.captures) {
        expect(c.screenshot).not.toContain('\\');
        expect(existsSync(join(runDir, c.screenshot))).toBe(true);
        expect(existsSync(join(runDir, c.aboveFold))).toBe(true);
      }
      expect(Object.keys(p.securityHeaders)).toContain('content-security-policy');
    }
  });

  it('respects robots.txt and skips nothing else', () => {
    expect(bundle.robotsBlocked.some((u) => u.endsWith('/admin'))).toBe(true);
    expect(bundle.pages.some((p) => p.path === '/admin')).toBe(false);
  });

  it('SD-01 broken internal link', () => {
    const l = pageAt('/').links.find((x) => x.href.endsWith('/neighborhoods'))!;
    expect(l).toMatchObject({ ok: false, status: 404, internal: true });
    expect(bundle.nav.brokenLinks.some((b) => b.href.endsWith('/neighborhoods'))).toBe(true);
  });

  it('SD-02 dead button, while handled buttons are not flagged', () => {
    const btns = pageAt('/listings/42-harbor-view-drive').buttons;
    expect(btns.find((b) => b.text === 'Schedule a tour')).toMatchObject({ hasHandler: false });
    const saves = pageAt('/listings').buttons.filter((b) => b.text === 'Save');
    expect(saves.length).toBe(4);
    expect(saves.every((b) => b.hasHandler)).toBe(true);
    expect(pageAt('/listings').buttons.find((b) => b.text === 'Search')?.hasHandler).toBe(true);
  });

  it('SD-03 image missing alt', () => {
    expect(pageAt('/listings').images.find((i) => i.selector.includes('listing-photo'))).toMatchObject({ alt: null });
    expect(pageAt('/listings').captures.some((c) => c.axe.some((v) => v.id === 'image-alt'))).toBe(true);
  });

  it('SD-04 low-contrast text (axe color-contrast)', () => {
    const v = pageAt('/').captures[0]!.axe.find((x) => x.id === 'color-contrast');
    expect(v).toBeTruthy();
    expect(v!.nodes.some((n) => n.target.includes('disclaimer'))).toBe(true);
  });

  it('SD-05 CTA hidden on mobile (and tablet), with desktop element screenshot', () => {
    const home = pageAt('/');
    const mobile = home.captures.find((c) => c.viewport === 'mobile')!;
    const cta = mobile.hiddenCtas.find((h) => h.text === 'Book a free valuation');
    expect(cta).toBeTruthy();
    expect(cta!.box!.width).toBeGreaterThan(0);
    expect(cta!.screenshot && existsSync(join(runDir, cta!.screenshot))).toBe(true);
    expect(home.captures.find((c) => c.viewport === 'desktop')!.hiddenCtas).toHaveLength(0);
    expect(mobile.hiddenCtas.some((h) => h.text === 'Browse listings')).toBe(false);
  });

  it('SD-06 console error from thrown JS', () => {
    expect(pageAt('/listings').console).toContainEqual(expect.objectContaining({ type: 'error', text: 'Uncaught Error: SavedSearch widget failed to initialise' }));
  });

  it('SD-07 404 image as failed request', () => {
    expect(pageAt('/listings/42-harbor-view-drive').networkFailures).toContainEqual(
      expect.objectContaining({ status: 404, resourceType: 'image', url: expect.stringContaining('/images/kitchen-missing.jpg') }),
    );
  });

  it('SD-08 contact form without validation; login form validated', () => {
    const f = pageAt('/contact').forms.find((x) => x.selector === '#contact-form')!;
    expect(f.hasValidation).toBe(false);
    expect(f.fields.map((x) => x.name)).toEqual(['name', 'email', 'phone', 'message']);
    expect(f.fields[1]!.label).toBe('Email');
    expect(f.emptySubmitResult).toBeUndefined(); // read-only by default
    expect(pageAt('/login').forms[0]!.hasValidation).toBe(true);
  });

  it('SD-09 navigation dead end', () => {
    const n = bundle.nav.nodes.find((x) => x.url.endsWith('/privacy'))!;
    expect(n.deadEnd).toBe(true);
    expect(bundle.nav.nodes.filter((x) => x.deadEnd)).toHaveLength(1);
    expect(bundle.nav.nodes.filter((x) => x.orphan)).toHaveLength(0);
  });

  it('SD-10 precondition: listings page has no price filter wording', () => {
    const text = pageAt('/listings').textSample.toLowerCase();
    expect(text).toContain('bedrooms');
    for (const w of ['price range', 'min price', 'max price']) expect(text).not.toContain(w);
  });

  it('SD-11 oversized image', () => {
    const img = pageAt('/about').images.find((i) => i.src.endsWith('/images/team-photo.png'))!;
    expect(img.naturalWidth).toBe(2400);
    expect(img.renderedWidth).toBeLessThanOrEqual(320);
    expect(img.bytes).toBeGreaterThan(200 * 1024);
  });

  it('SD-12 missing H1', () => {
    expect(pageAt('/about').h1).toEqual([]);
    expect(pageAt('/').h1).toEqual(['Find your home on the harbor']);
  });

  it('SD-14 horizontal overflow on small screens only', () => {
    const caps = pageAt('/listings/42-harbor-view-drive').captures;
    expect(caps.find((c) => c.viewport === 'desktop')!.horizontalOverflow).toBe(false);
    expect(caps.find((c) => c.viewport === 'mobile')!.horizontalOverflow).toBe(true);
    expect(pageAt('/').captures.every((c) => !c.horizontalOverflow)).toBe(true);
  });

  it('records page metadata', () => {
    const home = pageAt('/');
    expect(home.status).toBe(200);
    expect(home.lang).toBe('en');
    expect(home.metaDescription).toMatch(/Harbor Homes/);
    expect(home.title).toMatch(/Harbor Homes/);
    expect(home.textSample.length).toBeGreaterThan(100);
    expect(home.securityHeaders['x-frame-options']).toBeNull();
  });
});

describe('crawler with login', () => {
  it('reaches /account with requiresLogin, finds SD-13, never writes the password', async () => {
    const dir = tmp();
    const options = AuditOptions.parse({
      url: fx.realEstateUrl,
      lighthouse: false,
      rateLimitMs: 0,
      viewports: ['desktop', 'mobile'],
      login: { loginUrl: `${fx.realEstateUrl}/login`, successUrlContains: '/account' },
    });
    const b = await crawl({ options, runDir: dir, credentials: { ...FIXTURE_LOGIN } });
    expect(b.loginUsed).toBe(true);
    expect(existsSync(join(dir, '.auth', 'state.json'))).toBe(true);
    const account = b.pages.find((p) => p.path === '/account');
    expect(account, b.errors.join('\n')).toBeTruthy();
    expect(account!.requiresLogin).toBe(true);
    expect(account!.images.find((i) => i.selector.includes('account-agent-avatar'))).toMatchObject({ alt: null });
    // logout link is never followed or fetched, so the session survives
    expect(account!.links.find((l) => l.href.endsWith('/logout'))).toMatchObject({ status: null });
    expect(b.pages.some((p) => p.path === '/logout')).toBe(false);
    expect(b.pages.filter((p) => p.path !== '/account').every((p) => !p.requiresLogin)).toBe(true);

    rmSync(join(dir, '.auth'), { recursive: true, force: true }); // the engine does this after a run
    for (const f of allFiles(dir)) {
      if (!/\.(json|html|txt|jsonl|md)$/i.test(f)) continue;
      expect(readFileSync(f, 'utf8').includes(FIXTURE_LOGIN.password), f).toBe(false);
    }
    expect(JSON.stringify(b).includes(FIXTURE_LOGIN.password)).toBe(false);
  });

  it('bad credentials are a non-fatal error and the crawl continues anonymously', async () => {
    const dir = tmp();
    const options = AuditOptions.parse({
      url: fx.realEstateUrl,
      lighthouse: false,
      rateLimitMs: 0,
      maxPages: 2,
      viewports: ['desktop'],
      login: { loginUrl: `${fx.realEstateUrl}/login`, successUrlContains: '/account' },
    });
    const b = await crawl({ options, runDir: dir, credentials: { username: FIXTURE_LOGIN.username, password: 'wrong-password-xyz' } });
    expect(b.loginUsed).toBe(false);
    expect(b.errors.some((e) => e.startsWith('Login failed'))).toBe(true);
    expect(b.errors.join(' ')).not.toContain('wrong-password-xyz');
    expect(b.pages.length).toBe(2);
  });
});

describe('crawler modes', () => {
  it('lite mode: desktop only, at most 6 pages', async () => {
    const b = await crawl({ options: AuditOptions.parse({ url: fx.competitorUrl, rateLimitMs: 0 }), runDir: tmp(), lite: true });
    expect(b.pages.length).toBeGreaterThan(1);
    expect(b.pages.length).toBeLessThanOrEqual(6);
    for (const p of b.pages) {
      expect(p.captures.map((c) => c.viewport)).toEqual(['desktop']);
      expect(p.lighthouse).toBeUndefined();
      expect(p.depth).toBeLessThanOrEqual(1);
    }
  });

  it('allowForms submits forms empty once', async () => {
    const b = await crawl({
      options: AuditOptions.parse({ url: `${fx.realEstateUrl}/contact`, rateLimitMs: 0, depth: 0, lighthouse: false, viewports: ['desktop'], allowForms: true }),
      runDir: tmp(),
    });
    expect(b.pages[0]!.forms[0]!.emptySubmitResult).toBe('submitted');
  });

  it('Lighthouse on one page: metrics are numbers or the failure is recorded', async () => {
    const b = await crawl({
      options: AuditOptions.parse({ url: fx.realEstateUrl, rateLimitMs: 0, maxPages: 1, lighthouse: true, viewports: ['desktop'] }),
      runDir: tmp(),
    });
    expect(b.pages).toHaveLength(1);
    const lh = b.pages[0]!.lighthouse;
    if (lh) {
      expect(typeof lh.performance).toBe('number');
      expect(typeof lh.lcpMs).toBe('number');
    } else {
      expect(b.errors.some((e) => e.includes('Lighthouse'))).toBe(true);
    }
  });
});
