import {
  CATEGORIES,
  PERSONAS,
  SEVERITIES,
  type AttributedFinding,
  type EvidenceItem,
  type Finding,
  type Persona,
} from '../core/types.js';
import { fingerprint } from './fingerprint.js';

/**
 * Merge duplicate findings (same fingerprint, or same page + category with overlapping evidence),
 * sort them by importance and assign ids UIA-001, UIA-002, ...
 */
export function dedupe(findings: AttributedFinding[]): Finding[] {
  const n = findings.length;
  // Screenshot paths are shared by unrelated findings on a page, so they must not anchor the fingerprint.
  const fps = findings.map((f) => {
    const evidence = f.evidence.filter((e) => e.kind !== 'screenshot');
    return fingerprint(evidence.length > 0 ? { ...f, evidence } : f);
  });

  // Union-find over finding indexes.
  const parent = findings.map((_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]];
      i = parent[i];
    }
    return i;
  };
  const union = (a: number, b: number) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[rb] = ra;
  };

  const byFp = new Map<string, number>();
  const byAnchor = new Map<string, number>();
  for (let i = 0; i < n; i++) {
    const prev = byFp.get(fps[i]);
    if (prev !== undefined) union(prev, i);
    else byFp.set(fps[i], i);

    const f = findings[i];
    const scope = `${f.category}|${pagePath(f.page)}`;
    for (const e of f.evidence) {
      // Screenshot paths are shared by unrelated findings, so they don't count as overlap.
      if (e.kind === 'screenshot') continue;
      const key = `${scope}|${evidenceKey(e)}`;
      const other = byAnchor.get(key);
      if (other !== undefined) union(other, i);
      else byAnchor.set(key, i);
    }
  }

  const groups = new Map<number, number[]>();
  for (let i = 0; i < n; i++) {
    const r = find(i);
    const g = groups.get(r);
    if (g) g.push(i);
    else groups.set(r, [i]);
  }

  const merged = [...groups.values()].map((idx) => mergeGroup(idx.map((i) => findings[i]), idx.map((i) => fps[i])));

  merged.sort(
    (a, b) =>
      SEVERITIES.indexOf(a.severity) - SEVERITIES.indexOf(b.severity) ||
      b.foundBy.length - a.foundBy.length ||
      CATEGORIES.indexOf(a.category) - CATEGORIES.indexOf(b.category) ||
      a.title.localeCompare(b.title),
  );
  merged.forEach((f, i) => (f.id = `UIA-${String(i + 1).padStart(3, '0')}`));
  return merged;
}

function mergeGroup(group: AttributedFinding[], fps: string[]): Finding {
  const agents = group.filter((f) => f.source === 'agent');
  // Wording comes from the most severe agent finding when an agent was involved.
  const pool = agents.length > 0 ? agents : group;
  const primary = [...pool].sort((a, b) => SEVERITIES.indexOf(a.severity) - SEVERITIES.indexOf(b.severity))[0];

  const severity = SEVERITIES[Math.min(...group.map((f) => SEVERITIES.indexOf(f.severity)))];
  const foundBy = PERSONAS.filter((p) => group.some((f) => f.foundBy === p)) as Persona[];

  const evidence: EvidenceItem[] = [];
  const seen = new Set<string>();
  for (const f of [primary, ...group]) {
    for (const e of f.evidence) {
      const k = `${e.kind}|${e.value}`;
      if (seen.has(k)) continue;
      seen.add(k);
      evidence.push({ ...e });
    }
  }

  const steps = group.reduce((best, f) => (f.stepsToReproduce.length > best.length ? f.stepsToReproduce : best), primary.stepsToReproduce);
  const viewports = new Set(group.map((f) => f.viewport));
  const viewport = viewports.size === 1 ? primary.viewport : 'all';

  // Prefer the deterministic (rule) fingerprint so ids stay stable whether or not agents ran.
  const ruleFps = group.map((f, i) => (f.source === 'rule' ? fps[i] : null)).filter((x): x is string => x !== null);
  const fp = (ruleFps.length > 0 ? ruleFps : fps).slice().sort()[0];

  return {
    id: '',
    fingerprint: fp,
    title: primary.title,
    category: primary.category,
    severity,
    page: primary.page,
    viewport,
    evidence,
    stepsToReproduce: [...steps],
    expected: primary.expected,
    actual: primary.actual,
    recommendation: primary.recommendation,
    foundBy,
    source: agents.length > 0 ? 'agent' : 'rule',
  };
}

function evidenceKey(e: EvidenceItem): string {
  let v = e.value.trim().toLowerCase();
  if (e.kind === 'link' || e.kind === 'network') v = v.replace(/#.*$/, '').replace(/\/+$/, '');
  return `${e.kind}:${v}`;
}

function pagePath(page: string): string {
  try {
    return new URL(page).pathname.replace(/\/+$/, '') || '/';
  } catch {
    return page.replace(/\/+$/, '') || '/';
  }
}
