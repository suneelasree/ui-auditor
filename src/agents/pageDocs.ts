// Shared helpers for reading saved DOM snapshots and comparing page URLs.
import { readFileSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import type { EvidenceBundle, PageEvidence } from '../core/types.js';
import { parseHtml, type ParsedHtml } from './htmlMatch.js';

const cache = new Map<string, { mtime: number; doc: ParsedHtml }>();
const MAX_CACHE = 64;

/** Parsed DOM snapshot for a page, or null when it can't be read. Cached by path + mtime. */
export function pageDoc(bundle: EvidenceBundle, page: PageEvidence): ParsedHtml | null {
  if (!page.domSnapshot) return null;
  const abs = insideRunDir(bundle.runDir, page.domSnapshot);
  if (!abs) return null;
  try {
    const mtime = statSync(abs).mtimeMs;
    const hit = cache.get(abs);
    if (hit && hit.mtime === mtime) return hit.doc;
    const doc = parseHtml(readFileSync(abs, 'utf8'));
    if (cache.size >= MAX_CACHE) cache.delete(cache.keys().next().value as string);
    cache.set(abs, { mtime, doc });
    return doc;
  } catch {
    return null;
  }
}

/** Absolute path for a run-relative path, or null if it escapes the run directory. */
export function insideRunDir(runDir: string, rel: string): string | null {
  const abs = isAbsolute(rel) ? resolve(rel) : resolve(runDir, rel);
  const r = relative(resolve(runDir), abs);
  if (r.startsWith('..') || isAbsolute(r)) return null;
  return abs;
}

/** Normalise a URL for comparison: drop hash, trailing slash, default ports; lower-case host. */
export function normUrl(u: string, base?: string): string {
  try {
    const url = new URL(u.trim(), base);
    url.hash = '';
    let s = `${url.protocol}//${url.host.toLowerCase()}${url.pathname.replace(/\/+$/, '')}${url.search}`;
    if (s.endsWith('?')) s = s.slice(0, -1);
    return s;
  } catch {
    return u.trim().replace(/#.*$/, '').replace(/\/+$/, '');
  }
}

function pathOnly(u: string): string {
  try {
    const url = new URL(u);
    return (url.pathname.replace(/\/+$/, '') || '/') + url.search;
  } catch {
    return u.trim().replace(/#.*$/, '').replace(/\/+$/, '') || '/';
  }
}

/** Find the bundle page a finding refers to (full URL or path-only). */
export function findPage(bundle: EvidenceBundle, page: string): PageEvidence | undefined {
  if (!page) return undefined;
  const n = normUrl(page, bundle.startUrl);
  const exact = bundle.pages.find((p) => normUrl(p.url) === n);
  if (exact) return exact;
  const isPathOnly = !/^[a-z][a-z0-9+.-]*:/i.test(page.trim());
  if (isPathOnly) {
    const want = pathOnly(new URL(page.trim() || '/', 'http://x').toString());
    return bundle.pages.find((p) => pathOnly(p.url) === want || (p.path && (p.path.replace(/\/+$/, '') || '/') === want));
  }
  return undefined;
}

export function toPosix(p: string): string {
  return p.replace(/\\/g, '/');
}
