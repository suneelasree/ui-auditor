// Grounding check: every evidence item must point at something that really exists in the bundle.
// Findings left with no grounded evidence are dropped.
import { existsSync } from 'node:fs';
import type { AttributedFinding, EvidenceBundle, EvidenceItem, LighthouseMetrics, PageEvidence } from '../core/types.js';
import { selectorMatches } from './htmlMatch.js';
import { knownCheckIds } from './domain.js';
import { findPage, insideRunDir, normUrl, pageDoc } from './pageDocs.js';

const METRIC_ALIASES: Record<string, keyof LighthouseMetrics> = {
  performance: 'performance',
  perf: 'performance',
  accessibility: 'accessibility',
  a11y: 'accessibility',
  bestpractices: 'bestPractices',
  seo: 'seo',
  lcp: 'lcpMs',
  lcpms: 'lcpMs',
  largestcontentfulpaint: 'lcpMs',
  cls: 'cls',
  cumulativelayoutshift: 'cls',
  tbt: 'tbtMs',
  tbtms: 'tbtMs',
  totalblockingtime: 'tbtMs',
  fcp: 'fcpMs',
  fcpms: 'fcpMs',
  firstcontentfulpaint: 'fcpMs',
};

function metricKey(value: string): keyof LighthouseMetrics | null {
  const name = value.split(/[=:<>\s]/)[0].toLowerCase().replace(/[^a-z0-9]/g, '');
  return METRIC_ALIASES[name] ?? null;
}

const norm = (s: string) => s.trim().replace(/\s+/g, ' ').toLowerCase();

interface UrlIndex {
  urls: Set<string>;
}

function buildUrlIndex(bundle: EvidenceBundle): UrlIndex {
  const urls = new Set<string>();
  const add = (u: string | undefined, base?: string) => {
    if (u) urls.add(normUrl(u, base));
  };
  add(bundle.startUrl);
  for (const n of bundle.nav.nodes) add(n.url);
  for (const p of bundle.pages) {
    add(p.url);
    for (const n of p.networkFailures) add(n.url, p.url);
    for (const l of p.links) add(l.href, p.url);
    for (const i of p.images) add(i.src, p.url);
  }
  for (const b of bundle.nav.brokenLinks) add(b.href, b.from);
  return { urls };
}

/** Selectors the crawler itself recorded for a page. */
function knownSelectors(page: PageEvidence): Set<string> {
  const s = new Set<string>();
  for (const l of page.links) s.add(l.selector);
  for (const b of page.buttons) s.add(b.selector);
  for (const i of page.images) s.add(i.selector);
  for (const f of page.forms) s.add(f.selector);
  for (const c of page.captures) {
    for (const h of c.hiddenCtas) s.add(h.selector);
    for (const v of c.axe) for (const n of v.nodes) s.add(n.target);
  }
  return new Set([...s].filter(Boolean).map((x) => x.trim()));
}

function selectorGrounded(bundle: EvidenceBundle, page: PageEvidence, selector: string): boolean {
  const sel = selector.trim();
  if (knownSelectors(page).has(sel)) return true;
  const doc = pageDoc(bundle, page);
  if (!doc) return false;
  try {
    return selectorMatches(doc, sel, { lenient: true });
  } catch {
    // Unparseable by our matcher: fall back to checking its id/class/tag tokens appear in the DOM.
    const tokens = sel.match(/[#.]-?[_a-zA-Z][\w-]*/g) ?? [];
    if (tokens.length === 0) return false;
    return tokens.every((t) =>
      t.startsWith('#')
        ? doc.elements.some((e) => e.attrs.get('id') === t.slice(1))
        : doc.elements.some((e) => (e.attrs.get('class') ?? '').split(/\s+/).includes(t.slice(1))),
    );
  }
}

export interface ValidateOptions {
  /** When given, domain-check evidence must name a check that actually failed in this run. */
  missingDomainChecks?: Set<string>;
}

/** Evidence screenshots are PNGs the crawler saved under evidence/; when the page is known, one of its own. */
function screenshotGrounded(value: string, page: PageEvidence | undefined, bundle: EvidenceBundle): boolean {
  const rel = value.replace(/\\/g, '/').replace(/^\.\//, '');
  if (!/^evidence\/[^/]+\.png$/i.test(rel)) return false;
  const abs = insideRunDir(bundle.runDir, rel);
  if (!abs || !existsSync(abs)) return false;
  if (!page) return true;
  const own = page.captures.flatMap((c) => [c.screenshot, c.aboveFold, ...c.hiddenCtas.map((h) => h.screenshot)]);
  if (own.includes(rel)) return true;
  const key = page.domSnapshot.replace(/\\/g, '/').split('/').pop()?.replace(/\.html$/i, '');
  return !key || rel.split('/').pop()!.startsWith(`${key}-`);
}

function itemGrounded(
  item: EvidenceItem,
  page: PageEvidence | undefined,
  bundle: EvidenceBundle,
  urls: UrlIndex,
  opts: ValidateOptions,
): boolean {
  const value = item.value?.trim();
  if (!value) return false;
  switch (item.kind) {
    case 'axe-rule':
      return !!page && page.captures.some((c) => c.axe.some((v) => v.id === value));
    case 'console': {
      if (!page) return false;
      const v = norm(value);
      return page.console.some((c) => {
        const t = norm(c.text);
        return (v.length >= 6 && t.includes(v)) || (t.length >= 6 && v.includes(t));
      });
    }
    case 'network':
    case 'link':
      return urls.urls.has(normUrl(value, page?.url ?? bundle.startUrl));
    case 'metric': {
      if (!page?.lighthouse) return false;
      const key = metricKey(value);
      return !!key && page.lighthouse[key] != null;
    }
    case 'screenshot':
      return screenshotGrounded(value, page, bundle);
    case 'selector':
      return !!page && selectorGrounded(bundle, page, value);
    case 'domain-check':
      return opts.missingDomainChecks ? opts.missingDomainChecks.has(value) : knownCheckIds().has(value);
  }
}

/** Strip a screenshot attachment that does not exist on disk (the item itself may still be valid). */
function cleanScreenshot(item: EvidenceItem, bundle: EvidenceBundle): EvidenceItem {
  if (!item.screenshot) return item;
  const abs = insideRunDir(bundle.runDir, item.screenshot);
  if (abs && existsSync(abs)) return item;
  const { screenshot: _drop, ...rest } = item;
  return rest;
}

export function validateEvidence(
  findings: AttributedFinding[],
  bundle: EvidenceBundle,
  opts: ValidateOptions = {},
): { kept: AttributedFinding[]; dropped: number } {
  const urls = buildUrlIndex(bundle);
  const kept: AttributedFinding[] = [];
  let dropped = 0;
  for (const f of findings) {
    const page = findPage(bundle, f.page);
    const evidence = (f.evidence ?? [])
      .filter((e) => itemGrounded(e, page, bundle, urls, opts))
      .map((e) => cleanScreenshot(e, bundle));
    if (evidence.length === 0) {
      dropped++;
      continue;
    }
    kept.push({ ...f, evidence });
  }
  return { kept, dropped };
}
