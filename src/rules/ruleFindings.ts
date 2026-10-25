// Deterministic findings derived straight from the evidence bundle. No LLM.
// Every evidence value is copied literally from bundle data so it can be re-checked.
import type {
  AttributedFinding,
  Category,
  EvidenceBundle,
  EvidenceItem,
  PageEvidence,
  Persona,
  Severity,
  Viewport,
  ViewportCapture,
} from '../core/types.js';
import { isLocalHost } from '../crawler/url.js';

const SEV_ORDER: Severity[] = ['Critical', 'High', 'Medium', 'Low'];
const worst = (a: Severity, b: Severity): Severity => (SEV_ORDER.indexOf(a) <= SEV_ORDER.indexOf(b) ? a : b);

export const AXE_SEVERITY: Record<string, Severity> = {
  critical: 'Critical',
  serious: 'High',
  moderate: 'Medium',
  minor: 'Low',
};

export const OVERSIZE_RATIO = 2;
export const OVERSIZE_MIN_BYTES = 200 * 1024;
export const HUGE_IMAGE_BYTES = 1024 * 1024;

const MISSING_HEADERS_RECOMMENDATION: Record<string, string> = {
  'content-security-policy': "Content-Security-Policy (start with default-src 'self')",
  'strict-transport-security': 'Strict-Transport-Security: max-age=31536000; includeSubDomains',
  'x-content-type-options': 'X-Content-Type-Options: nosniff',
  'x-frame-options': "X-Frame-Options: DENY (or CSP frame-ancestors 'none')",
  'referrer-policy': 'Referrer-Policy: strict-origin-when-cross-origin',
  'permissions-policy': 'Permissions-Policy limiting camera, microphone, geolocation',
};

function capture(p: PageEvidence, vp: Viewport = 'desktop'): ViewportCapture | undefined {
  return p.captures.find((c) => c.viewport === vp) ?? p.captures[0];
}

function shotEvidence(p: PageEvidence, vp: Viewport = 'desktop', full = false, detail?: string): EvidenceItem[] {
  const c = capture(p, vp);
  if (!c) return [];
  const path = full ? c.screenshot : c.aboveFold;
  return [{ kind: 'screenshot', value: path, screenshot: path, detail: detail ?? `${p.path} @ ${c.viewport}` }];
}

function shotPath(p: PageEvidence, vp: Viewport = 'desktop', full = true): string | undefined {
  const c = capture(p, vp);
  return c ? (full ? c.screenshot : c.aboveFold) : undefined;
}

interface Base {
  title: string;
  category: Category;
  severity: Severity;
  foundBy: Persona;
  page: string;
  viewport: Viewport | 'all';
  evidence: EvidenceItem[];
  stepsToReproduce: string[];
  expected: string;
  actual: string;
  recommendation: string;
}

const make = (b: Base): AttributedFinding => ({ ...b, source: 'rule' });

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;

// ---------------- SDET ----------------

function brokenLinks(bundle: EvidenceBundle): AttributedFinding[] {
  const groups = new Map<string, { pages: PageEvidence[]; link: PageEvidence['links'][number] }>();
  for (const p of bundle.pages) {
    for (const l of p.links) {
      if (l.ok) continue;
      const g = groups.get(l.href) ?? { pages: [], link: l };
      g.pages.push(p);
      groups.set(l.href, g);
    }
  }
  return [...groups.values()].map(({ pages, link }) => {
    const p = pages[0]!;
    const status = link.status === null ? `failed (${link.error ?? 'no response'})` : `HTTP ${link.status}`;
    return make({
      title: `Broken ${link.internal ? 'internal' : 'external'} link "${link.text || link.href}" returns ${link.status ?? 'an error'}`,
      category: 'Navigation',
      severity: link.internal ? 'High' : 'Medium',
      foundBy: 'SDET',
      page: p.url,
      viewport: 'all',
      evidence: [
        { kind: 'link', value: link.href, detail: `${status}; linked from ${pages.map((x) => x.path).join(', ')}`, screenshot: shotPath(p, 'desktop', false) },
        { kind: 'selector', value: link.selector, detail: `link text "${link.text}"` },
      ],
      stepsToReproduce: [`Open ${p.url}`, `Click the link "${link.text || link.href}" (${link.selector})`, `Observe the response for ${link.href}`],
      expected: 'The link opens a working page (HTTP 2xx/3xx).',
      actual: `The link target ${link.href} ${status}.`,
      recommendation: link.internal
        ? 'Fix the href to point at an existing page, restore the missing page, or add a redirect; add a link check to CI.'
        : 'Update or remove the outdated external link.',
    });
  });
}

function deadButtons(bundle: EvidenceBundle): AttributedFinding[] {
  const groups = new Map<string, { pages: PageEvidence[]; selector: string; text: string }>();
  for (const p of bundle.pages) {
    for (const b of p.buttons) {
      if (b.hasHandler) continue;
      const key = `${b.selector}|${b.text}`;
      const g = groups.get(key) ?? { pages: [], selector: b.selector, text: b.text };
      g.pages.push(p);
      groups.set(key, g);
    }
  }
  return [...groups.values()].map(({ pages, selector, text }) => {
    const p = pages[0]!;
    return make({
      title: `Button "${text || selector}" does nothing when clicked`,
      category: 'Functional',
      severity: 'High',
      foundBy: 'SDET',
      page: p.url,
      viewport: 'all',
      evidence: [
        { kind: 'selector', value: selector, detail: `No click listener on the element or its ancestors, no href, not a form submit. Pages: ${pages.map((x) => x.path).join(', ')}`, screenshot: shotPath(p) },
        ...shotEvidence(p, 'desktop', true),
      ],
      stepsToReproduce: [`Open ${p.url}`, `Click the button "${text}" (${selector})`, 'Observe that nothing happens: no navigation, dialog or state change'],
      expected: 'Clicking the button performs its labelled action.',
      actual: 'The button has no click handler, link or form behind it, so clicking does nothing.',
      recommendation: 'Wire the button to its action (open the booking form/dialog or link to the relevant page), or remove it until the feature exists.',
    });
  });
}

const TEXT_ENTRY = new Set(['text', 'email', 'tel', 'url', 'number', 'textarea', 'search', 'password']);

function formValidation(bundle: EvidenceBundle): AttributedFinding[] {
  const out: AttributedFinding[] = [];
  for (const p of bundle.pages) {
    for (const f of p.forms) {
      const entry = f.fields.filter((x) => TEXT_ENTRY.has(x.type) && x.type !== 'search');
      const submittedEmpty = f.emptySubmitResult === 'submitted';
      if (f.hasValidation && !submittedEmpty) continue;
      if (entry.length < 2 && !submittedEmpty) continue;
      const fieldList = f.fields.map((x) => `${x.name || x.label || '?'}(${x.type}${x.required ? ', required' : ''})`).join(', ');
      out.push(
        make({
          title: `Form ${f.selector} accepts input without any validation`,
          category: 'Functional',
          severity: submittedEmpty ? 'High' : 'Medium',
          foundBy: 'SDET',
          page: p.url,
          viewport: 'all',
          evidence: [
            { kind: 'selector', value: f.selector, detail: `Fields: ${fieldList}. No required/pattern/type constraints.${f.emptySubmitResult ? ` Empty submit result: ${f.emptySubmitResult}.` : ''}`, screenshot: shotPath(p) },
            ...shotEvidence(p, 'desktop', true),
          ],
          stepsToReproduce: [`Open ${p.url}`, `Leave every field of ${f.selector} empty (or type "abc" into the email field)`, 'Submit the form'],
          expected: 'Required fields and email/phone formats are validated before the form is sent, with clear inline errors.',
          actual: submittedEmpty ? 'The empty form was submitted.' : 'No field is required and no input type or pattern constrains the values, so empty or malformed submissions are accepted.',
          recommendation: 'Mark required fields with `required`, use type="email"/"tel", add inline error messages, and validate again on the server.',
        }),
      );
    }
  }
  return out;
}

function navIssues(bundle: EvidenceBundle): AttributedFinding[] {
  const out: AttributedFinding[] = [];
  for (const n of bundle.nav.nodes) {
    const p = bundle.pages.find((x) => x.url === n.url);
    if (!p) continue;
    if (n.deadEnd) {
      out.push(
        make({
          title: `Navigation dead end: ${p.path} has no links to other pages`,
          category: 'Navigation',
          severity: 'Medium',
          foundBy: 'SDET',
          page: p.url,
          viewport: 'all',
          evidence: [{ kind: 'link', value: p.url, detail: `${p.path} has ${n.outLinks} internal outbound links (inbound: ${n.inLinks})` }, ...shotEvidence(p, 'desktop', true, `${p.path}: no navigation, header or footer links`)],
          stepsToReproduce: [`Open ${p.url}`, 'Look for site navigation, a logo link or footer links', 'Observe there is no way to continue except the browser back button'],
          expected: 'Every page offers site navigation (header nav, logo link to home, footer links).',
          actual: 'The page contains no internal links at all.',
          recommendation: 'Use the shared page layout with header navigation and footer on this page.',
        }),
      );
    } else if (n.orphan) {
      out.push(
        make({
          title: `Orphan page: nothing links to ${p.path}`,
          category: 'Navigation',
          severity: 'Low',
          foundBy: 'SDET',
          page: p.url,
          viewport: 'all',
          evidence: shotEvidence(p, 'desktop', false, `${p.path} has 0 inbound links from crawled pages`),
          stepsToReproduce: ['Crawl the site from the start page', `Observe that no crawled page links to ${p.path}`],
          expected: 'Important pages are reachable through site navigation.',
          actual: 'No crawled page links to this page.',
          recommendation: 'Link the page from navigation or a relevant parent page, or remove it.',
        }),
      );
    }
  }
  return out;
}

function horizontalOverflow(bundle: EvidenceBundle): AttributedFinding[] {
  const out: AttributedFinding[] = [];
  for (const p of bundle.pages) {
    const caps = p.captures.filter((c) => c.horizontalOverflow);
    if (caps.length === 0) continue;
    const vps = caps.map((c) => c.viewport);
    out.push(
      make({
        title: `Page scrolls horizontally on ${vps.join(' and ')}: ${p.path}`,
        category: 'UX',
        severity: vps.includes('mobile') ? 'High' : 'Medium',
        foundBy: 'SDET',
        page: p.url,
        viewport: caps.length === 1 ? caps[0]!.viewport : 'all',
        evidence: caps.map((c) => ({ kind: 'screenshot' as const, value: c.screenshot, screenshot: c.screenshot, detail: `document.scrollWidth exceeds the ${c.viewport} viewport width` })),
        stepsToReproduce: [`Open ${p.url} at ${vps.join('/')} width`, 'Swipe or scroll sideways'],
        expected: 'Content fits the viewport width; no sideways scrolling.',
        actual: `The document is wider than the viewport at ${vps.join(', ')}.`,
        recommendation: 'Find the element with a fixed/min width (tables, images, long words) and make it responsive (max-width: 100%, overflow-x: auto wrapper, stacked layout).',
      }),
    );
  }
  return out;
}

// ---------------- Senior Engineer ----------------

function consoleErrors(bundle: EvidenceBundle): AttributedFinding[] {
  const groups = new Map<string, { pages: PageEvidence[]; text: string; location?: string }>();
  for (const p of bundle.pages) {
    for (const c of p.console) {
      if (c.type !== 'error' || /^Failed to load resource/i.test(c.text)) continue; // covered by network findings
      const key = c.text.slice(0, 200);
      const g = groups.get(key) ?? { pages: [], text: c.text, location: c.location };
      if (!g.pages.includes(p)) g.pages.push(p);
      groups.set(key, g);
    }
  }
  return [...groups.values()].map(({ pages, text, location }) => {
    const p = pages[0]!;
    const uncaught = /^Uncaught/i.test(text);
    return make({
      title: `${uncaught ? 'Uncaught JavaScript exception' : 'Console error'}: ${text.slice(0, 90)}`,
      category: 'Functional',
      severity: uncaught ? 'High' : 'Medium',
      foundBy: 'Senior Engineer',
      page: p.url,
      viewport: 'all',
      evidence: [{ kind: 'console', value: text, detail: `${location ? `at ${location}; ` : ''}pages: ${pages.map((x) => x.path).join(', ')}` }, ...shotEvidence(p)],
      stepsToReproduce: [`Open ${p.url} with DevTools open`, 'Check the Console tab after the page loads'],
      expected: 'The page loads without JavaScript errors.',
      actual: `Console shows: ${text.slice(0, 200)}`,
      recommendation: 'Fix the failing script (guard missing elements/data, handle errors) and add error monitoring so regressions are caught.',
    });
  });
}

function failedRequests(bundle: EvidenceBundle): AttributedFinding[] {
  const groups = new Map<string, { pages: PageEvidence[]; f: PageEvidence['networkFailures'][number] }>();
  for (const p of bundle.pages) {
    for (const f of p.networkFailures) {
      const g = groups.get(f.url) ?? { pages: [], f };
      if (!g.pages.includes(p)) g.pages.push(p);
      groups.set(f.url, g);
    }
  }
  return [...groups.values()].map(({ pages, f }) => {
    const p = pages[0]!;
    const critical = ['script', 'stylesheet', 'fetch', 'xhr', 'document'].includes(f.resourceType);
    const what = f.status !== null ? `HTTP ${f.status}` : f.failure ?? 'failed';
    const img = f.resourceType === 'image';
    return make({
      title: `${img ? 'Broken image' : `Failed ${f.resourceType} request`}: ${f.url.replace(/^https?:\/\/[^/]+/, '')} (${what})`,
      category: img ? 'Performance' : 'Functional',
      severity: critical ? 'High' : 'Medium',
      foundBy: 'Senior Engineer',
      page: p.url,
      viewport: 'all',
      evidence: [{ kind: 'network', value: f.url, detail: `${f.method} ${f.resourceType} -> ${what}; pages: ${pages.map((x) => x.path).join(', ')}` }, ...shotEvidence(p, 'desktop', true)],
      stepsToReproduce: [`Open ${p.url} with DevTools > Network open`, `Find the request to ${f.url}`],
      expected: 'All page resources load successfully.',
      actual: `${f.method} ${f.url} -> ${what}.`,
      recommendation: img ? 'Restore the missing image or fix its src; add a fallback/placeholder and monitor 404s.' : 'Fix the failing endpoint or resource path and handle failures gracefully in the UI.',
    });
  });
}

function oversizedImages(bundle: EvidenceBundle): AttributedFinding[] {
  const seen = new Map<string, AttributedFinding>();
  for (const p of bundle.pages) {
    for (const im of p.images) {
      if (seen.has(im.src) || im.naturalWidth === 0 || im.renderedWidth === 0) continue;
      const ratio = im.naturalWidth / im.renderedWidth;
      const bytes = im.bytes ?? 0;
      const tooLarge = ratio >= OVERSIZE_RATIO && (bytes >= OVERSIZE_MIN_BYTES || (im.bytes === undefined && im.naturalWidth * im.naturalHeight > 4_000_000));
      if (!tooLarge && bytes < HUGE_IMAGE_BYTES) continue;
      const kb = bytes ? `${Math.round(bytes / 1024)} KB` : 'unknown size';
      seen.set(
        im.src,
        make({
          title: `Oversized image: ${im.naturalWidth}x${im.naturalHeight} (${kb}) shown at ${im.renderedWidth}x${im.renderedHeight}`,
          category: 'Performance',
          severity: bytes >= HUGE_IMAGE_BYTES ? 'High' : 'Medium',
          foundBy: 'Senior Engineer',
          page: p.url,
          viewport: 'desktop',
          evidence: [
            { kind: 'network', value: im.src, detail: `natural ${im.naturalWidth}x${im.naturalHeight}, rendered ${im.renderedWidth}x${im.renderedHeight}, ${kb}` },
            { kind: 'selector', value: im.selector, screenshot: shotPath(p) },
          ],
          stepsToReproduce: [`Open ${p.url}`, `Inspect ${im.selector}`, 'Compare its intrinsic size and transfer size with its displayed size'],
          expected: 'Images are served close to their displayed size (about 2x for retina) in a modern format.',
          actual: `The image is ${ratio.toFixed(1)}x wider than displayed and weighs ${kb}.`,
          recommendation: 'Resize and compress the image (WebP/AVIF), and use srcset/sizes so small screens get small files.',
        }),
      );
    }
  }
  return [...seen.values()];
}

function securityHeaders(bundle: EvidenceBundle): AttributedFinding[] {
  const p = bundle.pages.find((x) => x.url === bundle.startUrl) ?? bundle.pages[0];
  if (!p) return [];
  const missing = Object.entries(p.securityHeaders)
    .filter(([, v]) => v === null || v === '')
    .map(([k]) => k);
  const https = p.url.startsWith('https:');
  const relevant = missing.filter((h) => https || h !== 'strict-transport-security');
  if (relevant.length === 0) return [];
  const local = isLocalHost(p.url);
  const severity: Severity = !local && (relevant.includes('content-security-policy') || relevant.includes('strict-transport-security')) ? 'Medium' : 'Low';
  return [
    make({
      title: `Missing security headers: ${relevant.join(', ')}`,
      category: 'Security',
      severity,
      foundBy: 'Senior Engineer',
      page: p.url,
      viewport: 'all',
      evidence: [
        { kind: 'link', value: p.url, detail: `Response headers of the main document lack: ${relevant.join(', ')}${local ? ' (local server; verify on production)' : ''}` },
        ...shotEvidence(p),
      ],
      stepsToReproduce: [`Run: curl -I ${p.url}`, 'Inspect the response headers'],
      expected: 'The document response sets standard security headers.',
      actual: `Missing: ${relevant.join(', ')}.`,
      recommendation: `Add at the server/CDN: ${relevant.map((h) => MISSING_HEADERS_RECOMMENDATION[h] ?? h).join('; ')}.`,
    }),
  ];
}

function lighthouse(bundle: EvidenceBundle): AttributedFinding[] {
  const out: AttributedFinding[] = [];
  for (const p of bundle.pages) {
    const m = p.lighthouse;
    if (!m) continue;
    const problems: { value: string; sev: Severity; text: string }[] = [];
    if (m.performance !== null && m.performance < 90) problems.push({ value: `performance=${m.performance}`, sev: m.performance < 50 ? 'High' : 'Medium', text: `Lighthouse performance score ${m.performance}/100` });
    if (m.lcpMs !== null && m.lcpMs > 2500) problems.push({ value: `lcpMs=${Math.round(m.lcpMs)}`, sev: m.lcpMs > 4000 ? 'High' : 'Medium', text: `LCP ${Math.round(m.lcpMs)} ms (target <= 2500)` });
    if (m.cls !== null && m.cls > 0.1) problems.push({ value: `cls=${m.cls}`, sev: m.cls > 0.25 ? 'High' : 'Medium', text: `CLS ${m.cls} (target <= 0.1)` });
    if (m.tbtMs !== null && m.tbtMs > 200) problems.push({ value: `tbtMs=${Math.round(m.tbtMs)}`, sev: m.tbtMs > 600 ? 'High' : 'Medium', text: `TBT ${Math.round(m.tbtMs)} ms (target <= 200)` });
    if (problems.length === 0) continue;
    out.push(
      make({
        title: `Slow page: ${problems.map((x) => x.text).join('; ')} on ${p.path}`,
        category: 'Performance',
        severity: problems.map((x) => x.sev).reduce(worst),
        foundBy: 'Senior Engineer',
        page: p.url,
        viewport: 'desktop',
        evidence: problems.map((x) => ({ kind: 'metric' as const, value: x.value, detail: x.text })),
        stepsToReproduce: [`Run Lighthouse (desktop) on ${p.url}`],
        expected: 'Core Web Vitals in the "good" range: LCP <= 2.5 s, CLS <= 0.1, TBT <= 200 ms.',
        actual: problems.map((x) => x.text).join('; '),
        recommendation: 'Optimise the largest element (image size, preload), defer non-critical JavaScript, reserve space for late content.',
      }),
    );
  }
  return out;
}

function metaAndLang(bundle: EvidenceBundle): AttributedFinding[] {
  const out: AttributedFinding[] = [];
  const noMeta = bundle.pages.filter((p) => !p.metaDescription || !p.metaDescription.trim());
  if (noMeta.length > 0) {
    const p = noMeta[0]!;
    out.push(
      make({
        title: `Missing meta description on ${plural(noMeta.length, 'page')}`,
        category: 'SEO',
        severity: 'Low',
        foundBy: 'Senior Engineer',
        page: p.url,
        viewport: 'all',
        evidence: noMeta.slice(0, 5).flatMap((x) => shotEvidence(x, 'desktop', false, `${x.path}: no <meta name="description">`)),
        stepsToReproduce: [`View source of ${p.url}`, 'Search for <meta name="description">'],
        expected: 'Each page has a unique meta description of 50-160 characters.',
        actual: `No meta description on: ${noMeta.map((x) => x.path).join(', ')}.`,
        recommendation: 'Add a concise, page-specific meta description to every page template.',
      }),
    );
  }
  const noLang = bundle.pages.filter((p) => !p.lang);
  if (noLang.length > 0) {
    const p = noLang[0]!;
    out.push(
      make({
        title: `Missing lang attribute on <html> (${plural(noLang.length, 'page')})`,
        category: 'SEO',
        severity: 'Medium',
        foundBy: 'Senior Engineer',
        page: p.url,
        viewport: 'all',
        evidence: noLang.slice(0, 5).flatMap((x) => shotEvidence(x, 'desktop', false, `${x.path}: <html> has no lang attribute`)),
        stepsToReproduce: [`View source of ${p.url}`, 'Inspect the <html> element'],
        expected: '<html lang="..."> declares the page language.',
        actual: `No lang attribute on: ${noLang.map((x) => x.path).join(', ')}.`,
        recommendation: 'Set lang on the <html> element in the base template (e.g. lang="en").',
      }),
    );
  }
  return out;
}

// ---------------- Accessibility ----------------

function axeFindings(bundle: EvidenceBundle): AttributedFinding[] {
  const out: AttributedFinding[] = [];
  for (const p of bundle.pages) {
    const missingAlt = p.images.some((i) => i.alt === null);
    const byRule = new Map<string, { vps: Viewport[]; v: ViewportCapture['axe'][number]; cap: ViewportCapture }>();
    for (const c of p.captures) {
      for (const v of c.axe) {
        if (v.id === 'image-alt' && missingAlt) continue; // reported by missingAlt with image details
        const g = byRule.get(v.id) ?? { vps: [], v, cap: c };
        g.vps.push(c.viewport);
        byRule.set(v.id, g);
      }
    }
    for (const { vps, v, cap } of byRule.values()) {
      const sev = AXE_SEVERITY[v.impact ?? ''] ?? 'Medium';
      const nodes = v.nodes.slice(0, 3);
      out.push(
        make({
          title: `${v.help} (${v.id}) on ${p.path}`,
          category: 'Accessibility',
          severity: sev,
          foundBy: 'Accessibility',
          page: p.url,
          viewport: vps.length === p.captures.length && vps.length > 1 ? 'all' : vps[0]!,
          evidence: [
            { kind: 'axe-rule', value: v.id, detail: `${v.help}. ${plural(v.nodes.length, 'element')} affected. ${v.helpUrl}`, screenshot: cap.aboveFold },
            ...nodes.map((n) => ({ kind: 'selector' as const, value: n.target, detail: (n.failureSummary ?? n.html).slice(0, 300) })),
          ],
          stepsToReproduce: [`Open ${p.url}${vps[0] !== 'desktop' ? ` at ${vps[0]} width` : ''}`, `Run axe-core (rule ${v.id})`, `Inspect ${nodes.map((n) => n.target).join(', ')}`],
          expected: `No violations of WCAG rule "${v.id}".`,
          actual: `${plural(v.nodes.length, 'element')} fail: ${v.help}.`,
          recommendation: `Fix per ${v.helpUrl}. ${nodes[0]?.failureSummary?.split('\n').slice(0, 2).join(' ') ?? ''}`.trim(),
        }),
      );
    }
  }
  return out;
}

function missingAlt(bundle: EvidenceBundle): AttributedFinding[] {
  const out: AttributedFinding[] = [];
  for (const p of bundle.pages) {
    const imgs = p.images.filter((i) => i.alt === null);
    if (imgs.length === 0) continue;
    out.push(
      make({
        title: `${plural(imgs.length, 'image')} without alt text on ${p.path}`,
        category: 'Accessibility',
        severity: 'High',
        foundBy: 'Accessibility',
        page: p.url,
        viewport: 'all',
        evidence: [
          ...imgs.slice(0, 5).map((i) => ({ kind: 'selector' as const, value: i.selector, detail: `<img src="${i.src}"> has no alt attribute`, screenshot: shotPath(p) })),
          ...imgs.slice(0, 2).map((i) => ({ kind: 'network' as const, value: i.src })),
        ],
        stepsToReproduce: [`Open ${p.url}`, `Inspect ${imgs.map((i) => i.selector).join(', ')}`, 'Check the alt attribute (or use a screen reader)'],
        expected: 'Informative images have descriptive alt text; decorative images have alt="".',
        actual: `${plural(imgs.length, 'image')} have no alt attribute, so screen readers announce the file name or nothing.`,
        recommendation: 'Add descriptive alt text (e.g. "3-bedroom cottage on Lighthouse Lane, front view"), or alt="" for purely decorative images.',
      }),
    );
  }
  return out;
}

// ---------------- UX Designer ----------------

function hiddenCtas(bundle: EvidenceBundle): AttributedFinding[] {
  const out: AttributedFinding[] = [];
  for (const p of bundle.pages) {
    const bySel = new Map<string, { vps: Viewport[]; el: ViewportCapture['hiddenCtas'][number]; caps: ViewportCapture[] }>();
    for (const c of p.captures) {
      for (const el of c.hiddenCtas) {
        const g = bySel.get(el.selector) ?? { vps: [], el, caps: [] };
        g.vps.push(c.viewport);
        g.caps.push(c);
        bySel.set(el.selector, g);
      }
    }
    // App screens often collapse many controls on small screens. More than a couple is one layout
    // decision, so report it once with the list instead of one finding per button.
    if (bySel.size > 2) {
      const groups = [...bySel.values()];
      const vps = [...new Set(groups.flatMap((g) => g.vps))];
      const names = groups.map((g) => `"${g.el.text || g.el.selector}"`);
      const caps = [...new Map(groups.flatMap((g) => g.caps).map((c) => [c.viewport, c])).values()];
      out.push(
        make({
          title: `${groups.length} controls disappear on ${vps.join(' and ')}`,
          category: 'UX',
          severity: vps.includes('mobile') ? 'High' : 'Medium',
          foundBy: 'UX Designer',
          page: p.url,
          viewport: vps.includes('mobile') ? 'mobile' : vps[0]!,
          evidence: [
            ...groups.slice(0, 8).map((g) => ({ kind: 'selector' as const, value: g.el.selector, detail: `"${g.el.text}" visible at desktop, hidden at ${g.vps.join(', ')}`, screenshot: g.el.screenshot, region: g.el.box })),
            ...caps.map((c) => ({ kind: 'screenshot' as const, value: c.aboveFold, screenshot: c.aboveFold, detail: `${c.viewport} above the fold` })),
          ],
          stepsToReproduce: [`Open ${p.url} on desktop and note the buttons and tabs`, `Resize to ${vps.join('/')} width (e.g. ${vps.includes('mobile') ? '375' : '768'} px)`, 'Look for the same controls'],
          expected: 'Every action available on desktop is still reachable on small screens (visible, or behind a clearly labelled menu).',
          actual: `${groups.length} controls are hidden at ${vps.join(', ')}: ${names.slice(0, 8).join(', ')}${names.length > 8 ? `, and ${names.length - 8} more` : ''}.`,
          recommendation: 'Check each hidden control is reachable another way on small screens (overflow menu, scrollable tab bar, bottom sheet); if not, add one rather than using display:none.',
        }),
      );
      continue;
    }
    for (const { vps, el, caps } of bySel.values()) {
      out.push(
        make({
          title: `Call to action "${el.text || el.selector}" disappears on ${vps.join(' and ')}`,
          category: 'UX',
          severity: vps.includes('mobile') ? 'High' : 'Medium',
          foundBy: 'UX Designer',
          page: p.url,
          viewport: vps.includes('mobile') ? 'mobile' : vps[0]!,
          evidence: [
            { kind: 'selector', value: el.selector, detail: `Visible at desktop, hidden at ${vps.join(', ')}`, screenshot: el.screenshot, region: el.box },
            ...caps.map((c) => ({ kind: 'screenshot' as const, value: c.aboveFold, screenshot: c.aboveFold, detail: `${c.viewport}: "${el.text}" not visible` })),
          ],
          stepsToReproduce: [`Open ${p.url} on desktop and note the "${el.text}" button`, `Resize to ${vps.join('/')} width (e.g. ${vps.includes('mobile') ? '375' : '768'} px)`, 'Look for the same call to action'],
          expected: 'Primary calls to action stay available on every screen size.',
          actual: `"${el.text}" (${el.selector}) is hidden at ${vps.join(', ')}.`,
          recommendation: 'Keep the CTA visible on small screens (stack it under the headline or use a sticky bottom bar) instead of display:none.',
        }),
      );
    }
  }
  return out;
}

function headingIssues(bundle: EvidenceBundle): AttributedFinding[] {
  const out: AttributedFinding[] = [];
  for (const p of bundle.pages) {
    if (p.status !== null && p.status >= 400) continue;
    if (p.h1.length === 0) {
      out.push(
        make({
          title: `Missing H1 heading on ${p.path}`,
          category: 'SEO',
          severity: 'Medium',
          foundBy: 'UX Designer',
          page: p.url,
          viewport: 'all',
          evidence: shotEvidence(p, 'desktop', false, `${p.path}: 0 <h1> elements; headings: ${p.headings.map((h) => `h${h.level} "${h.text}"`).slice(0, 4).join(', ') || 'none'}`),
          stepsToReproduce: [`Open ${p.url}`, 'Inspect the heading outline (e.g. with a headings bookmarklet)'],
          expected: 'Each page has exactly one H1 that states its purpose.',
          actual: `The page has no H1${p.headings.length ? `; it starts with h${p.headings[0]!.level} "${p.headings[0]!.text}"` : ''}.`,
          recommendation: 'Promote the main page title to an <h1> and keep a logical h1 > h2 > h3 outline.',
        }),
      );
    } else if (p.h1.length > 1) {
      out.push(
        make({
          title: `${p.h1.length} H1 headings on ${p.path}`,
          category: 'SEO',
          severity: 'Low',
          foundBy: 'UX Designer',
          page: p.url,
          viewport: 'all',
          evidence: shotEvidence(p, 'desktop', false, `${p.path}: h1s: ${p.h1.map((h) => `"${h}"`).join(', ')}`),
          stepsToReproduce: [`Open ${p.url}`, 'Inspect the heading outline'],
          expected: 'One H1 per page.',
          actual: `H1s: ${p.h1.join(' | ')}.`,
          recommendation: 'Keep one H1 for the page title and demote the others to H2.',
        }),
      );
    }
  }
  return out;
}

export function ruleFindings(bundle: EvidenceBundle): AttributedFinding[] {
  return [
    ...brokenLinks(bundle),
    ...deadButtons(bundle),
    ...formValidation(bundle),
    ...navIssues(bundle),
    ...horizontalOverflow(bundle),
    ...consoleErrors(bundle),
    ...failedRequests(bundle),
    ...oversizedImages(bundle),
    ...securityHeaders(bundle),
    ...lighthouse(bundle),
    ...metaAndLang(bundle),
    ...axeFindings(bundle),
    ...missingAlt(bundle),
    ...hiddenCtas(bundle),
    ...headingIssues(bundle),
  ].filter((f) => f.evidence.length > 0);
}
