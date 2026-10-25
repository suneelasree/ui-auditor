// Builds the navigation graph from crawled pages.
import type { NavGraph, NavNode, PageEvidence } from '../core/types.js';
import { normalizeUrl } from './url.js';

/** `aliases` maps a linked URL to the URL it redirected to (e.g. /account -> /login). */
export function buildNavGraph(pages: PageEvidence[], startUrl: string, aliases: Map<string, string> = new Map()): NavGraph {
  const start = normalizeUrl(startUrl) ?? startUrl;
  const crawled = new Set(pages.map((p) => p.url));
  const edges: NavGraph['edges'] = [];
  const brokenLinks: NavGraph['brokenLinks'] = [];
  const inLinks = new Map<string, Set<string>>();
  const outCount = new Map<string, number>();

  for (const p of pages) {
    const targets = new Set<string>();
    for (const l of p.links) {
      if (!l.ok) {
        brokenLinks.push({ from: p.url, href: l.href, status: l.status });
        continue;
      }
      if (!l.internal || l.href === p.url || aliases.get(l.href) === p.url) continue;
      targets.add(aliases.get(l.href) ?? l.href);
    }
    outCount.set(p.url, targets.size);
    for (const t of targets) {
      if (!crawled.has(t)) continue;
      edges.push({ from: p.url, to: t });
      if (!inLinks.has(t)) inLinks.set(t, new Set());
      inLinks.get(t)!.add(p.url);
    }
  }

  const nodes: NavNode[] = pages.map((p) => {
    const outLinks = outCount.get(p.url) ?? 0;
    const ins = inLinks.get(p.url)?.size ?? 0;
    return {
      url: p.url,
      title: p.title,
      depth: p.depth,
      outLinks,
      inLinks: ins,
      deadEnd: outLinks === 0,
      orphan: p.url !== start && ins === 0,
    };
  });
  return { nodes, edges, brokenLinks };
}
