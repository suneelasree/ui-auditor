// Five specialist agents interpret the evidence bundle in parallel. Every finding is
// re-validated against RawFinding and grounded against the bundle before it is kept.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import {
  CATEGORIES,
  EVIDENCE_KINDS,
  RawFinding,
  SEVERITIES,
  VIEWPORTS,
  type AgentRunInfo,
  type AttributedFinding,
  type DomainPack,
  type EvidenceBundle,
  type PageEvidence,
  type Persona,
  type ProgressFn,
} from '../core/types.js';
import type { LlmClient, LlmContent } from './claude.js';
import { domainCheckFindings } from './domain.js';
import { validateEvidence } from './evidence.js';

type AgentName = Exclude<Persona, 'Rules'>;

const PROMPT_FILES: Record<AgentName, string> = {
  'UX Designer': 'ux-designer.md',
  'Senior Engineer': 'senior-engineer.md',
  SDET: 'sdet.md',
  Accessibility: 'accessibility.md',
  'Domain Expert': 'domain-expert.md',
};

const PROMPT_DIR = fileURLToPath(new URL('./prompts/', import.meta.url));
const MAX_FINDINGS_PER_AGENT = 12;
const MAX_PAGES = 15;
const MAX_IMAGES = 6;

export function loadPrompt(agent: AgentName, domain?: DomainPack): string {
  const body = readFileSync(join(PROMPT_DIR, PROMPT_FILES[agent]), 'utf8');
  const shared = readFileSync(join(PROMPT_DIR, '_shared.md'), 'utf8');
  return `${body.replaceAll('{{domain}}', domain?.displayName.toLowerCase() ?? 'this industry')}\n\n${shared}`;
}

// ---------- LLM-facing schemas (no min/max constraints; validated against RawFinding afterwards) ----------

const LlmEvidence = z.object({
  kind: z.enum(EVIDENCE_KINDS),
  value: z.string(),
  detail: z.string().optional(),
  screenshot: z.string().optional(),
});
const LlmFinding = z.object({
  title: z.string(),
  category: z.enum(CATEGORIES),
  severity: z.enum(SEVERITIES),
  page: z.string(),
  viewport: z.enum([...VIEWPORTS, 'all']),
  evidence: z.array(LlmEvidence),
  stepsToReproduce: z.array(z.string()),
  expected: z.string(),
  actual: z.string(),
  recommendation: z.string(),
});
export const AgentOutput = z.object({ findings: z.array(LlmFinding) });
export const DomainAgentOutput = z.object({ findings: z.array(LlmFinding), insights: z.array(z.string()) });

// ---------- Digests ----------

const clip = (s: string | null | undefined, n: number) => (s && s.length > n ? `${s.slice(0, n)}...` : (s ?? ''));

function pagesFor(bundle: EvidenceBundle): PageEvidence[] {
  return [...bundle.pages].sort((a, b) => a.depth - b.depth).slice(0, MAX_PAGES);
}

function pageBase(p: PageEvidence) {
  return { url: p.url, title: clip(p.title, 120), status: p.status, depth: p.depth, requiresLogin: p.requiresLogin || undefined };
}

function uxDigest(bundle: EvidenceBundle) {
  return pagesFor(bundle).map((p) => ({
    ...pageBase(p),
    h1: p.h1.slice(0, 3),
    headings: p.headings.slice(0, 15).map((h) => `h${h.level}: ${clip(h.text, 80)}`),
    textSample: clip(p.textSample, 800),
    buttons: p.buttons.slice(0, 20).map((b) => ({ selector: b.selector, text: clip(b.text, 60), hasHandler: b.hasHandler })),
    navLinks: p.links.filter((l) => l.internal).slice(0, 20).map((l) => ({ href: l.href, text: clip(l.text, 50), selector: l.selector })),
    viewports: p.captures.map((c) => ({
      viewport: c.viewport,
      aboveFold: c.aboveFold,
      horizontalOverflow: c.horizontalOverflow,
      hiddenCtas: c.hiddenCtas.slice(0, 8).map((h) => ({ selector: h.selector, text: clip(h.text, 60) })),
    })),
  }));
}

function engineerDigest(bundle: EvidenceBundle) {
  return pagesFor(bundle).map((p) => ({
    ...pageBase(p),
    lang: p.lang,
    metaDescription: clip(p.metaDescription, 160),
    h1: p.h1.slice(0, 3),
    console: p.console.slice(0, 15).map((c) => ({ type: c.type, text: clip(c.text, 300), location: c.location })),
    networkFailures: p.networkFailures.slice(0, 15),
    lighthouse: p.lighthouse,
    securityHeaders: p.securityHeaders,
    heavyImages: p.images
      .filter((i) => (i.bytes ?? 0) > 200_000 || i.naturalWidth > i.renderedWidth * 2 || i.naturalWidth === 0)
      .slice(0, 10)
      .map((i) => ({ src: i.src, selector: i.selector, bytes: i.bytes, natural: `${i.naturalWidth}x${i.naturalHeight}`, rendered: `${i.renderedWidth}x${i.renderedHeight}` })),
  }));
}

function sdetDigest(bundle: EvidenceBundle) {
  return {
    pages: pagesFor(bundle).map((p) => ({
      ...pageBase(p),
      brokenLinks: p.links.filter((l) => !l.ok).slice(0, 20).map((l) => ({ href: l.href, text: clip(l.text, 50), selector: l.selector, status: l.status, error: l.error })),
      deadButtons: p.buttons.filter((b) => !b.hasHandler).slice(0, 15).map((b) => ({ selector: b.selector, text: clip(b.text, 60) })),
      forms: p.forms.slice(0, 8).map((f) => ({ selector: f.selector, action: f.action, method: f.method, hasValidation: f.hasValidation, emptySubmitResult: f.emptySubmitResult, fields: f.fields.slice(0, 12) })),
      viewports: p.captures.map((c) => ({ viewport: c.viewport, horizontalOverflow: c.horizontalOverflow, hiddenCtas: c.hiddenCtas.slice(0, 5).map((h) => h.selector) })),
    })),
    nav: {
      deadEnds: bundle.nav.nodes.filter((n) => n.deadEnd).map((n) => n.url).slice(0, 20),
      orphans: bundle.nav.nodes.filter((n) => n.orphan).map((n) => n.url).slice(0, 20),
      brokenLinks: bundle.nav.brokenLinks.slice(0, 30),
    },
  };
}

function a11yDigest(bundle: EvidenceBundle) {
  return pagesFor(bundle).map((p) => ({
    ...pageBase(p),
    lang: p.lang,
    headings: p.headings.slice(0, 20).map((h) => `h${h.level}: ${clip(h.text, 60)}`),
    imagesMissingAlt: p.images.filter((i) => i.alt === null).slice(0, 10).map((i) => ({ selector: i.selector, src: i.src })),
    unlabelledFields: p.forms.flatMap((f) => f.fields.filter((x) => !x.label).map((x) => ({ form: f.selector, name: x.name, type: x.type }))).slice(0, 10),
    axe: p.captures.map((c) => ({
      viewport: c.viewport,
      aboveFold: c.aboveFold,
      violations: c.axe.slice(0, 15).map((v) => ({
        id: v.id,
        impact: v.impact,
        help: v.help,
        nodes: v.nodes.slice(0, 4).map((n) => ({ target: n.target, html: clip(n.html, 160), failureSummary: clip(n.failureSummary, 200) })),
        totalNodes: v.nodes.length,
      })),
    })),
  }));
}

function domainDigest(bundle: EvidenceBundle, domain: DomainPack) {
  const missing = domainCheckFindings(bundle, domain);
  const missingIds = new Set(missing.flatMap((f) => f.evidence.map((e) => e.value)));
  return {
    domain: domain.displayName,
    checklist: domain.checks.map((c) => ({ id: c.id, title: c.title, description: c.description, status: missingIds.has(c.id) ? 'missing (already reported)' : 'present' })),
    pages: pagesFor(bundle).map((p) => ({
      ...pageBase(p),
      h1: p.h1.slice(0, 3),
      headings: p.headings.slice(0, 12).map((h) => clip(h.text, 80)),
      textSample: clip(p.textSample, 600),
      buttons: p.buttons.slice(0, 12).map((b) => ({ selector: b.selector, text: clip(b.text, 50) })),
      forms: p.forms.slice(0, 5).map((f) => ({ selector: f.selector, fields: f.fields.map((x) => x.name).slice(0, 12) })),
      aboveFold: p.captures.find((c) => c.viewport === 'desktop')?.aboveFold,
    })),
  };
}

function screenshots(bundle: EvidenceBundle): LlmContent[] {
  const out: LlmContent[] = [];
  let images = 0;
  for (const p of pagesFor(bundle)) {
    for (const vp of ['desktop', 'mobile'] as const) {
      const c = p.captures.find((x) => x.viewport === vp);
      if (!c?.aboveFold || images >= MAX_IMAGES) continue;
      const abs = join(bundle.runDir, c.aboveFold);
      if (!existsSync(abs)) continue;
      out.push({ type: 'text', text: `Screenshot ${c.aboveFold} (${p.url} @ ${vp}, above the fold):` });
      out.push({ type: 'image', path: abs });
      images++;
    }
    if (images >= MAX_IMAGES) break;
  }
  return out;
}

function buildContent(agent: AgentName, bundle: EvidenceBundle, domain: DomainPack): LlmContent[] {
  const header = `Site: ${bundle.startUrl}\nPages crawled: ${bundle.pages.length}\nDomain: ${domain.displayName}\n`;
  const json = (label: string, data: unknown) => ({ type: 'text' as const, text: `${header}\n${label}:\n${JSON.stringify(data)}` });
  switch (agent) {
    case 'UX Designer':
      return [json('Evidence', uxDigest(bundle)), ...screenshots(bundle)];
    case 'Senior Engineer':
      return [json('Evidence', engineerDigest(bundle))];
    case 'SDET':
      return [json('Evidence', sdetDigest(bundle))];
    case 'Accessibility':
      return [json('Evidence', a11yDigest(bundle)), ...screenshots(bundle)];
    case 'Domain Expert':
      return [json('Domain checklist and evidence', domainDigest(bundle, domain))];
  }
}

// ---------- Runner ----------

const AGENTS: AgentName[] = ['UX Designer', 'Senior Engineer', 'SDET', 'Accessibility', 'Domain Expert'];

/** Validate raw LLM findings against RawFinding; returns valid ones, the count of invalid ones and how many were over the cap. */
function toAttributed(raw: unknown[], agent: AgentName): { valid: AttributedFinding[]; invalid: number; overCap: number } {
  const valid: AttributedFinding[] = [];
  let invalid = 0;
  for (const r of raw.slice(0, MAX_FINDINGS_PER_AGENT)) {
    const cleaned = cleanRaw(r);
    const parsed = RawFinding.safeParse(cleaned);
    if (parsed.success) valid.push({ ...parsed.data, foundBy: agent, source: 'agent' });
    else invalid++;
  }
  return { valid, invalid, overCap: Math.max(0, raw.length - MAX_FINDINGS_PER_AGENT) };
}

/** Drop empty evidence items / steps before strict validation so one blank entry doesn't sink a finding. */
function cleanRaw(r: unknown): unknown {
  if (!r || typeof r !== 'object') return r;
  const f = r as Record<string, unknown>;
  return {
    ...f,
    evidence: Array.isArray(f.evidence)
      ? f.evidence.filter((e) => e && typeof e === 'object' && typeof (e as { value?: unknown }).value === 'string' && (e as { value: string }).value.trim())
      : f.evidence,
    stepsToReproduce: Array.isArray(f.stepsToReproduce)
      ? f.stepsToReproduce.filter((s) => typeof s === 'string' && s.trim())
      : f.stepsToReproduce,
  };
}

export async function runSpecialists(args: {
  bundle: EvidenceBundle;
  domain: DomainPack;
  llm: LlmClient;
  onProgress?: ProgressFn;
}): Promise<{ findings: AttributedFinding[]; agents: AgentRunInfo[]; domainInsights: string[] }> {
  const { bundle, domain, llm, onProgress } = args;
  const missingDomainChecks = new Set(
    domainCheckFindings(bundle, domain).flatMap((f) => f.evidence.filter((e) => e.kind === 'domain-check').map((e) => e.value)),
  );
  let done = 0;
  const pct = () => Math.round(42 + (28 * done) / AGENTS.length);

  const runOne = async (agent: AgentName) => {
    onProgress?.({ stage: 'agents', agent, status: 'started', message: `${agent} agent started`, pct: pct() });
    try {
      const system = loadPrompt(agent, domain);
      const content = buildContent(agent, bundle, domain);
      const isDomain = agent === 'Domain Expert';
      const out = (await llm.json({
        system,
        content,
        schema: isDomain ? DomainAgentOutput : AgentOutput,
        maxTokens: 32000,
      })) as { findings?: unknown[]; insights?: unknown[] };
      const { valid, invalid, overCap } = toAttributed(Array.isArray(out?.findings) ? out.findings : [], agent);
      const { kept, dropped } = validateEvidence(valid, bundle, { missingDomainChecks });
      const insights = isDomain && Array.isArray(out?.insights)
        ? out.insights.filter((s): s is string => typeof s === 'string' && s.trim().length > 0).map((s) => s.trim()).slice(0, 8)
        : [];
      done++;
      const info: AgentRunInfo = {
        name: agent,
        status: 'ok',
        findings: kept.length,
        dropped: dropped + invalid + overCap,
        ...(invalid || overCap
          ? {
              note: [
                invalid ? `${invalid} finding(s) failed schema validation` : '',
                overCap ? `${overCap} finding(s) over the ${MAX_FINDINGS_PER_AGENT}-per-agent cap` : '',
              ].filter(Boolean).join('; '),
            }
          : {}),
      };
      onProgress?.({ stage: 'agents', agent, status: 'done', message: `${agent}: ${kept.length} findings (${info.dropped} dropped)`, pct: pct() });
      return { findings: kept, info, insights };
    } catch (err) {
      done++;
      const note = err instanceof Error ? err.message : String(err);
      onProgress?.({ stage: 'agents', agent, status: 'failed', message: `${agent} failed: ${note}`, pct: pct() });
      throw Object.assign(new Error(note), { agent });
    }
  };

  const results = await Promise.allSettled(AGENTS.map(runOne));
  const findings: AttributedFinding[] = [];
  const agents: AgentRunInfo[] = [];
  let domainInsights: string[] = [];
  results.forEach((r, i) => {
    const agent = AGENTS[i];
    if (r.status === 'fulfilled') {
      findings.push(...r.value.findings);
      agents.push(r.value.info);
      if (agent === 'Domain Expert') domainInsights = r.value.insights;
    } else {
      const reason = r.reason instanceof Error ? r.reason.message : String(r.reason);
      agents.push({ name: agent, status: 'failed', findings: 0, dropped: 0, note: clip(reason, 300) });
    }
  });
  return { findings, agents, domainInsights };
}
