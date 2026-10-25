// Domain packs: loading, detection, and deterministic "missing pattern" checks.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import {
  DomainPack,
  type AttributedFinding,
  type DomainCheck,
  type DomainName,
  type EvidenceBundle,
  type PageEvidence,
} from '../core/types.js';
import { keywordRegex, selectorMatches } from './htmlMatch.js';
import { pageDoc } from './pageDocs.js';

const DEFAULT_DIR = fileURLToPath(new URL('../../domains', import.meta.url));

export function loadDomainPacks(dir: string = DEFAULT_DIR): DomainPack[] {
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => /\.ya?ml$/i.test(f)).sort();
  } catch (err) {
    throw new Error(`Cannot read domain pack directory ${dir}: ${(err as Error).message}`, { cause: err });
  }
  if (files.length === 0) throw new Error(`No domain packs (*.yaml) found in ${dir}`);
  const packs = files.map((file) => {
    let raw: unknown;
    try {
      raw = parseYaml(readFileSync(join(dir, file), 'utf8'));
    } catch (err) {
      throw new Error(`Domain pack ${file}: invalid YAML: ${(err as Error).message}`, { cause: err });
    }
    const res = DomainPack.safeParse(raw);
    if (!res.success) {
      const issues = res.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
      throw new Error(`Domain pack ${file} failed validation: ${issues}`);
    }
    return res.data;
  });
  const seen = new Set<string>();
  for (const p of packs) {
    if (seen.has(p.name)) throw new Error(`Duplicate domain pack name "${p.name}" in ${dir}`);
    seen.add(p.name);
  }
  return packs;
}

// ---------- Detection ----------

const MAX_HITS_PER_KEYWORD = 5;

function countHits(text: string, keyword: string): number {
  const re = keywordRegex(keyword, 'giu');
  let n = 0;
  while (re.exec(text) && n < MAX_HITS_PER_KEYWORD) n++;
  return n;
}

function detectionText(bundle: EvidenceBundle): string {
  return bundle.pages
    .map((p) => [p.title, ...p.h1, ...p.headings.map((h) => h.text), p.textSample].join('\n'))
    .join('\n');
}

export function detectDomain(
  bundle: EvidenceBundle,
  packs: DomainPack[],
  option: 'auto' | DomainName,
): { name: DomainName; detected: boolean; confidence: number } {
  if (option !== 'auto') return { name: option, detected: false, confidence: 1 };
  const text = detectionText(bundle);
  const scored = packs
    .filter((p) => p.name !== 'generic')
    .map((p) => ({ pack: p, score: p.detect.keywords.reduce((s, k) => s + countHits(text, k), 0) }))
    .sort((a, b) => b.score - a.score);
  const best = scored[0];
  if (!best || best.score < best.pack.detect.minScore) return { name: 'generic', detected: false, confidence: 0 };
  const second = scored[1]?.score ?? 0;
  const strength = Math.min(1, best.score / (best.pack.detect.minScore * 2));
  const margin = best.score / (best.score + second);
  return { name: best.pack.name, detected: true, confidence: Math.round(strength * margin * 100) / 100 };
}

// ---------- Deterministic checks ----------

interface PageSearch {
  page: PageEvidence;
  text: string;
  doc: ReturnType<typeof pageDoc>;
}

function searchablePages(bundle: EvidenceBundle): PageSearch[] {
  return bundle.pages.map((page) => {
    const doc = pageDoc(bundle, page);
    const text = [
      page.title,
      page.metaDescription ?? '',
      ...page.headings.map((h) => h.text),
      ...page.h1,
      page.textSample,
      ...page.buttons.map((b) => b.text),
      ...page.links.map((l) => l.text),
      ...page.forms.flatMap((f) => f.fields.map((x) => x.label ?? '')),
      doc?.text ?? '',
      doc?.attrText ?? '',
    ].join('\n');
    return { page, text, doc };
  });
}

/** True if any selector matches or any keyword appears on any page. */
export function checkPresent(check: DomainCheck, pages: PageSearch[]): boolean {
  const kws = check.signals.keywords.map((k) => keywordRegex(k));
  for (const p of pages) {
    if (kws.some((re) => re.test(p.text))) return true;
    if (p.doc) {
      for (const sel of check.signals.selectors) {
        try {
          if (selectorMatches(p.doc, sel, { lenient: true })) return true;
        } catch {
          // An unparseable selector in a pack is a pack bug; ignore it rather than crash the run.
        }
      }
    }
  }
  return false;
}

const LISTING_CHECK = /filter|sort|map|search|gallery|result/i;
const LISTING_PAGE = /listing|search|propert|homes|results|products|shop|catalog|collection|courses|programs|flights|hotels|stays|rent|buy/i;

function relevantPage(bundle: EvidenceBundle, check: DomainCheck): PageEvidence | undefined {
  const start = bundle.pages.find((p) => p.depth === 0) ?? bundle.pages[0];
  if (LISTING_CHECK.test(check.id)) {
    const listing = bundle.pages.find((p) => LISTING_PAGE.test(p.path) || LISTING_PAGE.test(p.title));
    if (listing) return listing;
  }
  return start;
}

export function domainCheckFindings(bundle: EvidenceBundle, pack: DomainPack): AttributedFinding[] {
  if (bundle.pages.length === 0) return [];
  const pages = searchablePages(bundle);
  const out: AttributedFinding[] = [];
  for (const check of pack.checks) {
    if (check.signals.selectors.length === 0 && check.signals.keywords.length === 0) continue;
    if (checkPresent(check, pages)) continue;
    const page = relevantPage(bundle, check);
    const capture = page?.captures.find((c) => c.viewport === 'desktop') ?? page?.captures[0];
    const sels = check.signals.selectors.slice(0, 6);
    const kws = check.signals.keywords.slice(0, 6);
    out.push({
      title: check.title,
      category: 'Domain',
      severity: check.severity,
      page: page?.url ?? bundle.startUrl,
      viewport: 'all',
      evidence: [
        {
          kind: 'domain-check',
          value: check.id,
          detail: `Searched ${bundle.pages.length} page(s) for selectors [${sels.join(', ')}${check.signals.selectors.length > sels.length ? ', ...' : ''}] and keywords [${kws.join(', ')}${check.signals.keywords.length > kws.length ? ', ...' : ''}]; none found`,
          ...(capture?.aboveFold ? { screenshot: capture.aboveFold } : {}),
        },
      ],
      stepsToReproduce: [
        `Open ${page?.url ?? bundle.startUrl}`,
        `Look for: ${check.title.replace(/^No /i, '').replace(/^(\w)/, (c) => c.toUpperCase())}`,
        `Observe that it is not present on any of the ${bundle.pages.length} crawled page(s)`,
      ],
      expected: check.description,
      actual: `Not found on any of the ${bundle.pages.length} crawled page(s).`,
      recommendation: check.recommendation,
      foundBy: 'Domain Expert',
      source: 'rule',
    });
  }
  return out;
}

/** Ids of all checks across the default packs (cached). Used to ground 'domain-check' evidence. */
let knownIds: Set<string> | null = null;
export function knownCheckIds(): Set<string> {
  if (!knownIds) {
    try {
      knownIds = new Set(loadDomainPacks().flatMap((p) => p.checks.map((c) => c.id)));
    } catch {
      knownIds = new Set();
    }
  }
  return knownIds;
}
