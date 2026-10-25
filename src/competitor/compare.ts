// Competitor Analyst: lite-crawl each competitor, score it with the same rules and domain pack,
// and diff against the target. Competitor findings never become target findings.
import { join } from 'node:path';
import { z } from 'zod';
import {
  CATEGORIES,
  type AgentRunInfo,
  type AttributedFinding,
  type AuditOptions,
  type Comparison,
  type ComparisonSite,
  type DomainCheck,
  type DomainPack,
  type EvidenceBundle,
  type Finding,
  type ProgressFn,
  type Scores,
} from '../core/types.js';
import type { LlmClient, LlmContent } from '../agents/claude.js';
import { crawl } from '../crawler/crawl.js';
import { ruleFindings } from '../rules/ruleFindings.js';
import { domainCheckFindings } from '../agents/domain.js';
import { computeScores } from '../report/scoring.js';
import { toPosix } from '../agents/pageDocs.js';

export function slugFor(url: string, i: number): string {
  try {
    const host = new URL(url).hostname.replace(/^www\./, '');
    const slug = `${host}${new URL(url).port ? `-${new URL(url).port}` : ''}`.replace(/[^a-z0-9.-]+/gi, '-').toLowerCase();
    return `${i + 1}-${slug}`;
  } catch {
    return `competitor-${i + 1}`;
  }
}

/** The check's `positive` label, else "No price range filter on listings" -> "Price range filter on listings". */
export function positiveTitle(check: Pick<DomainCheck, 'title' | 'positive'>): string {
  if (check.positive) return check.positive;
  const t = check.title.replace(/^no\s+/i, '').replace(/^clear\s+/i, '');
  return t.charAt(0).toUpperCase() + t.slice(1);
}

function labelFor(url: string): string {
  try {
    const u = new URL(url);
    return u.host.replace(/^www\./, '');
  } catch {
    return url;
  }
}

function homeShot(bundle: EvidenceBundle): string | undefined {
  const home = bundle.pages.find((p) => p.depth === 0) ?? bundle.pages[0];
  return (home?.captures.find((c) => c.viewport === 'desktop') ?? home?.captures[0])?.aboveFold;
}

function missingCheckIds(findings: AttributedFinding[]): Set<string> {
  return new Set(findings.flatMap((f) => f.evidence.filter((e) => e.kind === 'domain-check').map((e) => e.value)));
}

const Refinement = z.object({
  theyDoBetter: z.array(z.object({ competitor: z.string(), title: z.string(), detail: z.string() })),
  youWin: z.array(z.string()),
  patternsToCopy: z.array(z.string()),
});

const REFINE_SYSTEM = `You are a competitive UX analyst. You receive a deterministic comparison between a target website and its competitors (scores per category and domain patterns each site has or lacks), plus home-page screenshots.
Refine the wording so it is specific and useful to the target's team:
- theyDoBetter: keep the same competitor and title for each entry you are given; rewrite "detail" to explain concretely what the competitor does (use what you can see in its screenshot) and why it matters. Do not add entries.
- youWin: rewrite or add short statements of where the target is stronger, only if supported by the scores or patterns given.
- patternsToCopy: short, actionable patterns worth copying, only from what is given.
Do not invent facts that are not in the data or the screenshots.`;

export async function compareCompetitors(args: {
  target: { bundle: EvidenceBundle; findings: Finding[]; scores: Scores };
  competitorUrls: string[];
  options: AuditOptions;
  runDir: string;
  llm: LlmClient | null;
  domain: DomainPack;
  onProgress?: ProgressFn;
}): Promise<{ comparison: Comparison; info: AgentRunInfo }> {
  const { target, competitorUrls, options, runDir, llm, domain, onProgress } = args;
  const notes: string[] = [];
  const targetShot = homeShot(target.bundle);

  // Like for like: score the target with the same quick, public, desktop-only, rules-only crawl the
  // competitors get, instead of its full multi-viewport, logged-in, AI-reviewed score.
  let targetScores = target.scores;
  let targetMissing = missingCheckIds(domainCheckFindings(target.bundle, domain));
  try {
    const lite = await crawl({
      options: { ...options, url: target.bundle.startUrl, competitors: [], login: undefined, lighthouse: false },
      runDir: join(runDir, 'competitors', '_target'),
      lite: true,
    });
    if (lite.pages.length > 0) {
      const liteDomain = domainCheckFindings(lite, domain);
      targetScores = computeScores([...ruleFindings(lite), ...liteDomain]);
      targetMissing = missingCheckIds(liteDomain);
    }
  } catch (err) {
    notes.push(`Target quick crawl failed, using its full-audit score (${err instanceof Error ? err.message : String(err)})`);
  }

  const sites: ComparisonSite[] = [
    {
      url: target.bundle.startUrl,
      label: labelFor(target.bundle.startUrl),
      isTarget: true,
      scores: targetScores,
      ...(targetShot ? { screenshot: toPosix(targetShot) } : {}),
    },
  ];
  const theyDoBetter: Comparison['theyDoBetter'] = [];
  const youWin: string[] = [];
  const patterns = new Set<string>();
  const shots: { label: string; path: string }[] = targetShot ? [{ label: `${labelFor(target.bundle.startUrl)} (target)`, path: join(target.bundle.runDir || runDir, targetShot) }] : [];

  for (const [i, url] of competitorUrls.entries()) {
    const slug = slugFor(url, i);
    const label = labelFor(url);
    const pctBase = 72 + (8 * i) / Math.max(1, competitorUrls.length);
    onProgress?.({ stage: 'competitors', agent: 'Competitor Analyst', status: 'progress', message: `Crawling competitor ${label}`, pct: Math.round(pctBase) });
    try {
      const subDir = join(runDir, 'competitors', slug);
      const bundle = await crawl({
        options: { ...options, url, competitors: [], login: undefined, lighthouse: false },
        runDir: subDir,
        lite: true,
      });
      if (bundle.pages.length === 0) throw new Error('no pages could be loaded');
      const domainFindings = domainCheckFindings(bundle, domain);
      const findings = [...ruleFindings(bundle), ...domainFindings];
      const scores = computeScores(findings);
      const shotRel = homeShot(bundle);
      const screenshot = shotRel ? toPosix(join('competitors', slug, shotRel)) : undefined;
      sites.push({ url, label, isTarget: false, scores, ...(screenshot ? { screenshot } : {}) });
      if (shotRel) shots.push({ label, path: join(subDir, shotRel) });

      const theirMissing = missingCheckIds(domainFindings);
      for (const check of domain.checks) {
        if (targetMissing.has(check.id) && !theirMissing.has(check.id)) {
          theyDoBetter.push({
            competitor: label,
            title: positiveTitle(check),
            detail: `${label} has this pattern; your site does not. ${check.description}`,
            ...(screenshot ? { screenshot } : {}),
          });
          patterns.add(positiveTitle(check));
        }
        if (!targetMissing.has(check.id) && theirMissing.has(check.id)) {
          youWin.push(`You have "${positiveTitle(check)}" and ${label} does not.`);
        }
      }
      for (const c of CATEGORIES) {
        const mine = targetScores.byCategory[c];
        const theirs = scores.byCategory[c];
        if (mine > theirs) youWin.push(`${c}: you score ${mine} vs ${theirs} for ${label}.`);
      }
    } catch (err) {
      notes.push(`${label}: crawl failed (${err instanceof Error ? err.message : String(err)})`);
    }
  }

  let comparison: Comparison = { sites, theyDoBetter, youWin, patternsToCopy: [...patterns] };

  if (llm && sites.length > 1) {
    try {
      const content: LlmContent[] = [
        {
          type: 'text',
          text: `Domain: ${domain.displayName}\nDeterministic comparison:\n${JSON.stringify({
            sites: sites.map((s) => ({ label: s.label, isTarget: s.isTarget, scores: s.scores })),
            theyDoBetter: theyDoBetter.map(({ competitor, title, detail }) => ({ competitor, title, detail })),
            youWin,
            patternsToCopy: [...patterns],
          })}`,
        },
      ];
      for (const s of shots.slice(0, 3)) {
        content.push({ type: 'text', text: `Home page above the fold: ${s.label}` });
        content.push({ type: 'image', path: s.path });
      }
      const refined = Refinement.parse(await llm.json({ system: REFINE_SYSTEM, content, schema: Refinement, maxTokens: 8000 }));
      comparison = mergeRefinement(comparison, refined);
    } catch (err) {
      notes.push(`LLM refinement skipped (${err instanceof Error ? err.message : String(err)})`);
    }
  }

  const ok = sites.length > 1;
  return {
    comparison,
    info: {
      name: 'Competitor Analyst',
      status: ok ? 'ok' : competitorUrls.length ? 'failed' : 'skipped',
      findings: comparison.theyDoBetter.length,
      dropped: 0,
      ...(notes.length ? { note: notes.join('; ') } : {}),
    },
  };
}

/** Apply LLM wording only where it maps onto deterministic entries; never drop deterministic facts. */
export function mergeRefinement(base: Comparison, refined: z.infer<typeof Refinement>): Comparison {
  const key = (c: string, t: string) => `${c.trim().toLowerCase()}|${t.trim().toLowerCase()}`;
  const byKey = new Map(refined.theyDoBetter.map((r) => [key(r.competitor, r.title), r]));
  const theyDoBetter = base.theyDoBetter.map((d) => {
    const r = byKey.get(key(d.competitor, d.title));
    return r && r.detail.trim() ? { ...d, detail: r.detail.trim() } : d;
  });
  const uniq = (xs: string[]) => [...new Set(xs.map((x) => x.trim()).filter(Boolean))];
  return {
    ...base,
    theyDoBetter,
    youWin: uniq([...base.youWin, ...refined.youWin]).slice(0, 15),
    patternsToCopy: uniq([...base.patternsToCopy, ...refined.patternsToCopy]).slice(0, 12),
  };
}
