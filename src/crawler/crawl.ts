// Deterministic evidence collection with Playwright. No LLM here.
import { mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { chromium, request as pwRequest, type APIRequestContext, type Browser, type BrowserContext, type Page } from 'playwright';
import { AxeBuilder } from '@axe-core/playwright';
import {
  VIEWPORT_SIZES,
  type AuditOptions,
  type AxeViolation,
  type ButtonEvidence,
  type ConsoleEntry,
  type Credentials,
  type ElementEvidence,
  type EvidenceBundle,
  type ImageEvidence,
  type LighthouseMetrics,
  type LinkCheck,
  type NetworkFailure,
  type PageEvidence,
  type ProgressFn,
  type Viewport,
  type ViewportCapture,
} from '../core/types.js';
import { redact } from '../core/redact.js';
import {
  EXTRACT_SCRIPT,
  OVERFLOW_SCRIPT,
  SCROLL_SCRIPT,
  buttonChainExpression,
  emptySubmitScript,
  visibilityScript,
  type ExtractResult,
} from './browserScripts.js';
import { performLogin } from './login.js';
import { buildNavGraph } from './navgraph.js';
import { fetchRobots, type RobotsRules } from './robots.js';
import { isCrawlable, isLogoutLike, normalizeUrl, pageKey, sameOrigin } from './url.js';

export interface CrawlOptions {
  options: AuditOptions;
  runDir: string;
  credentials?: Credentials;
  /** Saved storage state from a sign-in done in the Web UI. Ignored when a username/password login runs. */
  sessionStatePath?: string;
  onProgress?: ProgressFn;
  /** Competitor mode: home + up to 5 linked pages, desktop only, no Lighthouse/login/forms. */
  lite?: boolean;
}

export const SECURITY_HEADERS = [
  'content-security-policy',
  'strict-transport-security',
  'x-content-type-options',
  'x-frame-options',
  'referrer-policy',
  'permissions-policy',
] as const;

const CLICK_EVENTS = new Set(['click', 'mousedown', 'mouseup', 'pointerdown', 'pointerup', 'touchstart', 'touchend']);
const PASSWORD_MASK = 'input[type=password]';
const LIGHTHOUSE_PAGE_CAP = 5;
const LINK_CHECK_CAP = 150;
const NAV_TIMEOUT = 30_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const rel = (...parts: string[]) => parts.join('/');
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e)).split('\n')[0]!;

interface LinkStatus {
  status: number | null;
  ok: boolean;
  error?: string;
}

async function checkLink(req: APIRequestContext, url: string): Promise<LinkStatus> {
  const opts = { timeout: 15_000, maxRedirects: 10, failOnStatusCode: false, ignoreHTTPSErrors: true };
  let headStatus: number | null = null;
  try {
    const head = await req.head(url, opts);
    headStatus = head.status();
    if (headStatus < 400) return { status: headStatus, ok: true };
  } catch {
    /* fall back to GET */
  }
  try {
    const res = await req.get(url, opts);
    const status = res.status();
    await res.dispose().catch(() => undefined);
    return { status, ok: status < 400 };
  } catch (e) {
    return { status: headStatus, ok: false, error: redact(errMsg(e)) };
  }
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx]!);
    }
  });
  await Promise.all(workers);
  return out;
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

async function gotoSettled(page: Page, url: string) {
  const res = await page.goto(url, { waitUntil: 'load', timeout: NAV_TIMEOUT });
  await page.waitForLoadState('networkidle', { timeout: 5_000 }).catch(() => undefined);
  return res;
}

function mapAxe(violations: { id: string; impact?: string | null; help: string; helpUrl: string; nodes: { target: unknown; html: string; failureSummary?: string }[] }[]): AxeViolation[] {
  return violations.map((v) => ({
    id: v.id,
    impact: v.impact ?? null,
    help: v.help,
    helpUrl: v.helpUrl,
    nodes: v.nodes.slice(0, 10).map((n) => ({
      target: Array.isArray(n.target) ? n.target.flat(3).join(' ') : String(n.target),
      html: redact(n.html.slice(0, 300)),
      failureSummary: n.failureSummary,
    })),
  }));
}

async function runAxe(page: Page): Promise<AxeViolation[]> {
  const res = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze();
  return mapAxe(res.violations as Parameters<typeof mapAxe>[0]);
}

async function detectHandlers(context: BrowserContext, page: Page, buttons: ExtractResult['buttons'], errors: string[]): Promise<ButtonEvidence[]> {
  const out: ButtonEvidence[] = buttons.map((b) => ({ selector: b.selector, text: b.text, hasHandler: b.staticHandler }));
  const todo = buttons.map((b, i) => ({ b, i })).filter(({ b }) => !b.staticHandler).slice(0, 80);
  if (todo.length === 0) return out;
  let cdp;
  try {
    cdp = await context.newCDPSession(page);
  } catch (e) {
    errors.push(redact(`CDP unavailable for listener check on ${page.url()}: ${errMsg(e)}`));
    for (const { i } of todo) out[i]!.hasHandler = true; // conservative
    return out;
  }
  try {
    for (const { b, i } of todo) {
      try {
        const { result } = await cdp.send('Runtime.evaluate', { expression: buttonChainExpression(b.index), objectGroup: 'uia' });
        if (!result.objectId) continue;
        const props = await cdp.send('Runtime.getProperties', { objectId: result.objectId, ownProperties: true });
        let found = false;
        for (const p of props.result) {
          if (!/^\d+$/.test(p.name) || !p.value?.objectId) continue;
          const { listeners } = await cdp.send('DOMDebugger.getEventListeners', { objectId: p.value.objectId, depth: 0 });
          if (listeners.some((l) => CLICK_EVENTS.has(l.type))) {
            found = true;
            break;
          }
        }
        out[i]!.hasHandler = found;
      } catch {
        out[i]!.hasHandler = true; // could not check: do not accuse
      }
    }
    await cdp.send('Runtime.releaseObjectGroup', { objectGroup: 'uia' }).catch(() => undefined);
  } finally {
    await cdp.detach().catch(() => undefined);
  }
  return out;
}

async function screenshotPair(page: Page, runDir: string, key: string, vp: Viewport, errors: string[]) {
  const mask = [page.locator(PASSWORD_MASK)];
  const full = rel('evidence', `${key}-${vp}-full.png`);
  const fold = rel('evidence', `${key}-${vp}-fold.png`);
  try {
    await page.screenshot({ path: join(runDir, full), fullPage: true, mask, timeout: 30_000 });
  } catch (e) {
    errors.push(redact(`Full-page screenshot failed for ${page.url()} @${vp}: ${errMsg(e)}`));
  }
  try {
    await page.screenshot({ path: join(runDir, fold), fullPage: false, mask, timeout: 30_000 });
  } catch (e) {
    errors.push(redact(`Above-fold screenshot failed for ${page.url()} @${vp}: ${errMsg(e)}`));
  }
  return { full, fold };
}

async function captureViewport(page: Page, runDir: string, key: string, vp: Viewport, errors: string[]): Promise<ViewportCapture> {
  const { full, fold } = await screenshotPair(page, runDir, key, vp, errors);
  let axe: AxeViolation[] = [];
  try {
    axe = await runAxe(page);
  } catch (e) {
    errors.push(redact(`axe failed for ${page.url()} @${vp}: ${errMsg(e)}`));
  }
  const horizontalOverflow = (await page.evaluate(OVERFLOW_SCRIPT).catch(() => false)) as boolean;
  return { viewport: vp, screenshot: full, aboveFold: fold, axe, hiddenCtas: [], horizontalOverflow };
}

async function runLighthouse(url: string, port: number): Promise<LighthouseMetrics> {
  const { default: lighthouse } = await import('lighthouse');
  const result = await lighthouse(url, {
    port,
    output: 'json',
    logLevel: 'error',
    onlyCategories: ['performance', 'accessibility', 'best-practices', 'seo'],
    formFactor: 'desktop',
    screenEmulation: { disabled: true },
  });
  if (!result) throw new Error('Lighthouse returned no result');
  const lhr = result.lhr;
  const score = (k: string) => {
    const s = lhr.categories[k]?.score;
    return typeof s === 'number' ? Math.round(s * 100) : null;
  };
  const num = (k: string) => {
    const v = lhr.audits[k]?.numericValue;
    return typeof v === 'number' ? Math.round(v * 1000) / 1000 : null;
  };
  return {
    performance: score('performance'),
    accessibility: score('accessibility'),
    bestPractices: score('best-practices'),
    seo: score('seo'),
    lcpMs: num('largest-contentful-paint'),
    cls: num('cumulative-layout-shift'),
    tbtMs: num('total-blocking-time'),
    fcpMs: num('first-contentful-paint'),
  };
}

/** Did this URL only work with the session? Compare anonymous vs. logged-in responses. */
async function needsLogin(anon: APIRequestContext, auth: APIRequestContext, url: string): Promise<boolean> {
  const blocked = async (req: APIRequestContext) => {
    try {
      const res = await req.get(url, { maxRedirects: 0, timeout: 15_000, failOnStatusCode: false, ignoreHTTPSErrors: true });
      const s = res.status();
      await res.dispose().catch(() => undefined);
      if (s === 401 || s === 403) return true;
      if (s >= 300 && s < 400) {
        const loc = res.headers()['location'];
        return !!loc && normalizeUrl(loc, url) !== normalizeUrl(url);
      }
      return false;
    } catch {
      return false;
    }
  };
  return (await blocked(anon)) && !(await blocked(auth));
}

interface QueueItem {
  url: string;
  depth: number;
}

export async function crawl(opts: CrawlOptions): Promise<EvidenceBundle> {
  const { runDir, onProgress, lite = false } = opts;
  const options = opts.options;
  const startUrl = normalizeUrl(options.url);
  if (!startUrl) throw new Error(`Invalid URL: ${options.url}`);
  const depthLimit = lite ? Math.min(options.depth, 1) : options.depth;
  const maxPages = lite ? Math.min(options.maxPages, 6) : options.maxPages;
  const viewports: Viewport[] = lite ? ['desktop'] : options.viewports;
  const doLighthouse = options.lighthouse && !lite;
  const allowForms = options.allowForms && !lite;

  mkdirSync(join(runDir, 'evidence'), { recursive: true });
  const errors: string[] = [];
  const pages: PageEvidence[] = [];
  const robotsBlocked: string[] = [];
  const startedAt = new Date().toISOString();
  const progress = (message: string, pct: number) =>
    onProgress?.({ stage: 'crawl', status: 'progress', message: redact(message), pct: Math.max(2, Math.min(35, Math.round(pct))) });

  const browser: Browser = await chromium.launch({ headless: true });
  const anon = await pwRequest.newContext({ ignoreHTTPSErrors: true });
  let lhBrowser: Browser | null = null;
  let lhPort = 0;
  try {
    // robots.txt
    const robots: RobotsRules = options.respectRobots ? await fetchRobots(anon, startUrl) : { isAllowed: () => true };

    // Optional login
    let statePath: string | undefined;
    let loginUsed = false;
    let signInLost = false;
    const extraStarts: string[] = [];
    if (!lite && options.login && opts.credentials) {
      onProgress?.({ stage: 'login', status: 'started', message: 'Logging in', pct: 3 });
      try {
        const res = await performLogin(browser, options.login, opts.credentials, runDir);
        statePath = res.statePath;
        loginUsed = true;
        const landing = normalizeUrl(res.landingUrl);
        if (landing && sameOrigin(landing, startUrl)) extraStarts.push(landing);
        onProgress?.({ stage: 'login', status: 'done', message: 'Logged in', pct: 4 });
      } catch (e) {
        errors.push(redact(errMsg(e)));
        onProgress?.({ stage: 'login', status: 'failed', message: redact(errMsg(e)), pct: 4 });
      }
    } else if (!lite && opts.sessionStatePath) {
      statePath = opts.sessionStatePath;
      loginUsed = true;
      onProgress?.({ stage: 'login', status: 'done', message: 'Using your saved sign-in for this site', pct: 4 });
    }

    // One context per viewport; desktop always exists because it drives extraction.
    const contexts = new Map<Viewport, BrowserContext>();
    const newViewportContext = (vp: Viewport, storageState: string | Awaited<ReturnType<BrowserContext['storageState']>> | undefined) =>
      browser.newContext({ viewport: VIEWPORT_SIZES[vp], ignoreHTTPSErrors: true, storageState, hasTouch: vp !== 'desktop' });
    for (const vp of new Set<Viewport>(['desktop', ...viewports])) contexts.set(vp, await newViewportContext(vp, statePath));
    const desktopCtx = contexts.get('desktop')!;
    /**
     * Signed-in runs: many apps rotate their session token on first use, which logs out any other
     * browser that started from the same saved copy. So each tablet/mobile visit starts from the
     * desktop browser's current state, and any cookies it refreshes are copied back.
     */
    const viewportContext = async (vp: Viewport): Promise<BrowserContext> => {
      if (!loginUsed) return contexts.get(vp)!;
      await contexts.get(vp)!.close().catch(() => undefined);
      const ctx = await newViewportContext(vp, await desktopCtx.storageState());
      contexts.set(vp, ctx);
      return ctx;
    };
    const linkCache = new Map<string, Promise<LinkStatus>>();

    if (doLighthouse) {
      try {
        lhPort = await freePort();
        lhBrowser = await chromium.launch({ headless: true, args: [`--remote-debugging-port=${lhPort}`] });
      } catch (e) {
        errors.push(redact(`Lighthouse browser failed to start: ${errMsg(e)}`));
      }
    }

    const queue: QueueItem[] = [{ url: startUrl, depth: 0 }, ...extraStarts.map((u) => ({ url: u, depth: 1 }))];
    const seen = new Set<string>(queue.map((q) => q.url));
    const crawledUrls = new Set<string>();
    const aliases = new Map<string, string>();
    let first = true;

    while (queue.length > 0 && pages.length < maxPages) {
      const item = queue.shift()!;
      if (options.respectRobots && !robots.isAllowed(item.url)) {
        robotsBlocked.push(item.url);
        continue;
      }
      if (!first && options.rateLimitMs > 0) await sleep(options.rateLimitMs);
      first = false;
      progress(`Crawling ${item.url}`, 2 + (pages.length / maxPages) * 33);

      const page = await desktopCtx.newPage();
      const consoleEntries: ConsoleEntry[] = [];
      const failures: NetworkFailure[] = [];
      const bytes = new Map<string, number>();
      const pending: Promise<unknown>[] = [];
      page.on('console', (m) => {
        const t = m.type();
        if (t !== 'error' && t !== 'warning') return;
        const loc = m.location();
        consoleEntries.push({ type: t, text: redact(m.text().slice(0, 500)), location: loc.url ? `${loc.url}:${loc.lineNumber}` : undefined });
      });
      page.on('pageerror', (err) => {
        consoleEntries.push({ type: 'error', text: redact(`Uncaught ${err.name}: ${err.message}`.slice(0, 500)), location: err.stack?.split('\n')[1]?.trim() });
      });
      page.on('response', (r) => {
        const req = r.request();
        if (r.status() >= 400 && !(req.isNavigationRequest() && req.frame() === page.mainFrame())) {
          failures.push({ url: r.url(), method: req.method(), resourceType: req.resourceType(), status: r.status() });
        }
        if (req.resourceType() === 'image' && r.status() < 400) {
          pending.push(r.body().then((b) => bytes.set(r.url(), b.length)).catch(() => undefined));
        }
      });
      page.on('requestfailed', (req) => {
        const f = req.failure()?.errorText ?? 'failed';
        if (f.includes('ERR_ABORTED')) return;
        failures.push({ url: req.url(), method: req.method(), resourceType: req.resourceType(), status: null, failure: f });
      });

      try {
        const res = await gotoSettled(page, item.url);
        const finalUrl = normalizeUrl(page.url()) ?? item.url;
        if (!sameOrigin(finalUrl, startUrl) || (finalUrl !== item.url && crawledUrls.has(finalUrl))) {
          if (finalUrl !== item.url) aliases.set(item.url, finalUrl);
          continue; // redirected off-site or onto a page we already have
        }
        if (finalUrl !== item.url) aliases.set(item.url, finalUrl);
        crawledUrls.add(finalUrl);
        seen.add(finalUrl);
        const index = pages.length;
        const key = pageKey(index, finalUrl);
        const status = res?.status() ?? null;
        const headers = res ? await res.allHeaders().catch(() => res.headers()) : {};
        const securityHeaders: Record<string, string | null> = {};
        for (const h of SECURITY_HEADERS) securityHeaders[h] = headers[h] ?? null;

        await page.evaluate(SCROLL_SCRIPT).catch(() => undefined);
        await page.waitForLoadState('networkidle', { timeout: 3_000 }).catch(() => undefined);
        const ex = (await page.evaluate(EXTRACT_SCRIPT)) as ExtractResult;
        await Promise.allSettled(pending);

        const domSnapshot = rel('evidence', `${key}.html`);
        writeFileSync(join(runDir, domSnapshot), redact(await page.content()));

        const buttons = await detectHandlers(desktopCtx, page, ex.buttons, errors);

        // Desktop capture first (it may be skipped from output but CTAs come from desktop).
        const captures: ViewportCapture[] = [];
        if (viewports.includes('desktop')) captures.push(await captureViewport(page, runDir, key, 'desktop', errors));
        if (loginUsed && pages.length === 0 && (await page.locator(PASSWORD_MASK).filter({ visible: true }).count().catch(() => 0)) > 0) {
          signInLost = true;
          errors.push('The start page showed a sign-in form even though a sign-in was used; the session has probably expired');
        }

        const hiddenBySelector = new Map<string, ElementEvidence>();
        for (const vp of viewports) {
          if (vp === 'desktop') continue;
          const vpCtx = await viewportContext(vp);
          const vpPage = await vpCtx.newPage();
          try {
            await gotoSettled(vpPage, finalUrl);
            const cap = await captureViewport(vpPage, runDir, key, vp, errors);
            if (loginUsed) await desktopCtx.addCookies(await vpCtx.cookies()).catch(() => undefined);
            // If this viewport landed on a sign-in form that desktop didn't show, its screenshots are of a
            // different page: say so and don't compare its buttons with desktop (that would be false alarms).
            const lostSignIn =
              loginUsed &&
              (await vpPage.locator(PASSWORD_MASK).filter({ visible: true }).count().catch(() => 0)) > 0 &&
              (await page.locator(PASSWORD_MASK).filter({ visible: true }).count().catch(() => 0)) === 0;
            if (lostSignIn) errors.push(redact(`Viewport ${vp} was shown a sign-in form for ${finalUrl}; its hidden-control check was skipped`));
            if (ex.ctas.length > 0 && !lostSignIn) {
              const vis = (await vpPage.evaluate(visibilityScript(ex.ctas.map((c) => c.selector)))) as boolean[];
              ex.ctas.forEach((c, i) => {
                if (vis[i]) return;
                let ev = hiddenBySelector.get(c.selector);
                if (!ev) {
                  ev = { selector: c.selector, text: c.text, box: c.box };
                  hiddenBySelector.set(c.selector, ev);
                }
                cap.hiddenCtas.push(ev);
              });
            }
            captures.push(cap);
          } catch (e) {
            errors.push(redact(`Viewport ${vp} failed for ${finalUrl}: ${errMsg(e)}`));
          } finally {
            await vpPage.close().catch(() => undefined);
          }
        }
        // Element screenshots of hidden CTAs, taken at desktop where they are visible.
        let n = 0;
        for (const ev of hiddenBySelector.values()) {
          const shot = rel('evidence', `${key}-cta${++n}.png`);
          try {
            await page.locator(ev.selector).first().screenshot({ path: join(runDir, shot), mask: [page.locator(PASSWORD_MASK)], timeout: 5_000 });
            ev.screenshot = shot;
          } catch {
            /* element screenshot is optional */
          }
        }

        // Links
        const linkMap = new Map<string, { text: string; selector: string }>();
        for (const l of ex.links) {
          const href = normalizeUrl(l.raw, page.url());
          if (!href) continue;
          if (l.raw.trim().startsWith('#')) continue; // in-page anchor
          if (!linkMap.has(href)) linkMap.set(href, { text: redact(l.text), selector: l.selector });
        }
        const linkEntries = [...linkMap.entries()].slice(0, LINK_CHECK_CAP);
        const links: LinkCheck[] = await mapLimit(linkEntries, 6, async ([href, meta]) => {
          const internal = sameOrigin(href, startUrl);
          const base = { href, text: meta.text, selector: meta.selector, internal };
          if (isLogoutLike(href, meta.text)) return { ...base, status: null, ok: true, error: 'not checked: logout link' };
          if (internal && options.respectRobots && !robots.isAllowed(href)) {
            if (!robotsBlocked.includes(href)) robotsBlocked.push(href);
            return { ...base, status: null, ok: true, error: 'not checked: disallowed by robots.txt' };
          }
          if (!linkCache.has(href)) linkCache.set(href, checkLink(desktopCtx.request, href));
          const st = await linkCache.get(href)!;
          return { ...base, ...st };
        });

        // Forms
        const forms = ex.forms.map((f) => ({ ...f, fields: f.fields.map((x) => ({ ...x })) })) as PageEvidence['forms'];
        if (allowForms) {
          for (const f of forms.slice(0, 5)) {
            const fp = await desktopCtx.newPage();
            try {
              await gotoSettled(fp, finalUrl);
              const nav = fp.waitForNavigation({ timeout: 5_000 }).then(() => true).catch(() => false);
              const r = (await fp.evaluate(emptySubmitScript(f.selector))) as 'blocked' | 'submitted' | 'error';
              const navigated = await nav;
              f.emptySubmitResult = r === 'error' && navigated ? 'submitted' : r;
            } catch {
              f.emptySubmitResult = 'error';
            } finally {
              await fp.close().catch(() => undefined);
            }
          }
        }

        const images: ImageEvidence[] = ex.images.map((im) => ({ ...im, bytes: bytes.get(im.src) }));

        // Lighthouse (first few pages only)
        let lighthouse: LighthouseMetrics | undefined;
        if (doLighthouse && lhBrowser && index < LIGHTHOUSE_PAGE_CAP) {
          progress(`Lighthouse ${finalUrl}`, 2 + ((pages.length + 0.5) / maxPages) * 33);
          try {
            lighthouse = await runLighthouse(finalUrl, lhPort);
          } catch (e) {
            errors.push(redact(`Lighthouse failed for ${finalUrl}: ${errMsg(e)}`));
          }
        }

        const requiresLogin = loginUsed ? await needsLogin(anon, desktopCtx.request, finalUrl) : false;

        const u = new URL(finalUrl);
        pages.push({
          url: finalUrl,
          path: u.pathname + u.search,
          title: redact(ex.title),
          depth: item.depth,
          status,
          lang: ex.lang,
          metaDescription: ex.metaDescription === null ? null : redact(ex.metaDescription),
          h1: ex.h1.map(redact),
          headings: ex.headings.map((h) => ({ level: h.level, text: redact(h.text) })),
          textSample: redact(ex.textSample),
          links,
          buttons: buttons.map((b) => ({ ...b, text: redact(b.text) })),
          images,
          forms,
          console: consoleEntries,
          networkFailures: failures,
          securityHeaders,
          captures,
          lighthouse,
          requiresLogin,
          domSnapshot,
        });

        // Enqueue
        if (item.depth < depthLimit) {
          for (const l of links) {
            if (!l.internal || !l.ok || l.status === null) continue;
            if (seen.has(l.href) || !isCrawlable(l.href) || isLogoutLike(l.href, l.text)) continue;
            seen.add(l.href);
            queue.push({ url: l.href, depth: item.depth + 1 });
          }
        }
      } catch (e) {
        errors.push(redact(`Failed to crawl ${item.url}: ${errMsg(e)}`));
      } finally {
        await page.close().catch(() => undefined);
      }
    }

    // Apps that rotate their session token on use would otherwise leave the saved session stale after one audit.
    if (opts.sessionStatePath && loginUsed && !signInLost) await desktopCtx.storageState({ path: opts.sessionStatePath }).catch(() => undefined);
    for (const ctx of contexts.values()) await ctx.close().catch(() => undefined);
    progress(`Crawled ${pages.length} page(s)`, 35);

    return {
      runDir,
      startUrl,
      startedAt,
      pages,
      nav: buildNavGraph(pages, startUrl, aliases),
      robotsBlocked,
      loginUsed,
      signInLost,
      errors,
    };
  } finally {
    await anon.dispose().catch(() => undefined);
    if (lhBrowser) await lhBrowser.close().catch(() => undefined);
    await browser.close().catch(() => undefined);
  }
}
