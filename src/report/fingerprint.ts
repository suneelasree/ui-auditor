import { createHash } from 'node:crypto';
import type { RawFinding } from '../core/types.js';

/** Stable across runs: same issue on the same page produces the same fingerprint. */
export function fingerprint(f: Pick<RawFinding, 'category' | 'page' | 'evidence' | 'title'>): string {
  const path = safePath(f.page);
  // Screenshots are shared by many findings, so they only anchor a finding that has nothing else.
  const specific = f.evidence.filter((e) => e.kind !== 'screenshot');
  const anchor = (specific.length > 0 ? specific : f.evidence)
    .map((e) => `${e.kind}:${e.value.trim().toLowerCase()}`)
    .sort()[0];
  const key = anchor ? `${f.category}|${path}|${anchor}` : `${f.category}|${path}|${f.title.toLowerCase()}`;
  return createHash('sha1').update(key).digest('hex').slice(0, 16);
}

function safePath(page: string): string {
  try {
    const u = new URL(page);
    // Keep the query: /listing?id=1 and /listing?id=2 are different pages.
    return (u.pathname.replace(/\/+$/, '') || '/') + u.search;
  } catch {
    return page;
  }
}
