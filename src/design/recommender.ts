// Design Recommender: for the top issues, ask the LLM for a "Good" fix and a "Better" redesign
// as standalone HTML, then render both with Playwright.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium, type Browser } from 'playwright';
import { z } from 'zod';
import {
  VIEWPORT_SIZES,
  type AgentRunInfo,
  type DesignAlternative,
  type EvidenceBundle,
  type Finding,
  type ProgressFn,
  type Viewport,
} from '../core/types.js';
import type { LlmClient, LlmContent } from '../agents/claude.js';
import { findPage } from '../agents/pageDocs.js';

export const TAILWIND_TAG = '<script src="https://cdn.tailwindcss.com/3.4.17"></script>';

const DesignOutput = z.object({
  goodHtml: z.string(),
  goodSummary: z.string(),
  betterHtml: z.string(),
  betterSummary: z.string(),
});

const SYSTEM = `You are a senior product designer and front-end engineer. For one UI issue found on a website, produce two alternatives:
- "good": the minimal, low-effort fix of the issue, keeping the existing look.
- "better": a stronger redesign of that section following current best practice for the industry.

Each must be a complete standalone HTML document using Tailwind via ${TAILWIND_TAG} in <head>. Mock only the focused section around the issue (e.g. a hero with its CTA, a filter bar, a form), not a whole site. Use realistic copy taken from the provided page data, no external images (use solid colour blocks or inline SVG as placeholders), no JavaScript other than the Tailwind script, accessible markup (labels, alt, sufficient contrast). Keep each document under 8 KB.
Summaries: one or two sentences explaining what changed and why it fixes the issue.`;

const VISUAL = new Set(['UX', 'Accessibility', 'Domain', 'Navigation']);

export function pickDesignFindings(findings: Finding[], max = 5, min = 3): Finding[] {
  const preferred = findings.filter((f) => VISUAL.has(f.category));
  const picked = preferred.slice(0, max);
  if (picked.length < min) {
    for (const f of findings) {
      if (picked.length >= min) break;
      if (!picked.includes(f)) picked.push(f);
    }
  }
  return picked;
}

function viewportOf(f: Finding): Viewport {
  return f.viewport === 'all' ? 'desktop' : f.viewport;
}

/** Best "before" image for a finding: an evidence crop if it exists, else the page's above-fold capture. */
function originalFor(f: Finding, bundle: EvidenceBundle, runDir: string): string | undefined {
  // Full-page captures can be taller than the API's image limit; use crops or viewport-sized shots only.
  const exists = (rel: string) => !/-full.png$/i.test(rel) && existsSync(join(runDir, rel));
  for (const e of f.evidence) {
    if (e.screenshot && exists(e.screenshot)) return e.screenshot;
    if (e.kind === 'screenshot' && exists(e.value)) return e.value;
  }
  const page = findPage(bundle, f.page) ?? bundle.pages[0];
  const vp = viewportOf(f);
  const cap = page?.captures.find((c) => c.viewport === vp) ?? page?.captures[0];
  return cap?.aboveFold && exists(cap.aboveFold) ? cap.aboveFold : undefined;
}

/** Adds the Tailwind CDN script when the markup uses classes but forgot to include it. */
function ensureTailwind(html: string): string {
  if (/cdn\.tailwindcss\.com/.test(html) || !/\sclass\s*=/.test(html)) return html;
  if (/<head[^>]*>/i.test(html)) return html.replace(/<head[^>]*>/i, (m) => `${m}\n${TAILWIND_TAG}`);
  return `<!doctype html><html><head><meta charset="utf-8">${TAILWIND_TAG}</head><body>${html}</body></html>`;
}

async function renderHtml(browser: Browser, html: string, vp: Viewport, outPng: string): Promise<void> {
  const context = await browser.newContext({ viewport: VIEWPORT_SIZES[vp] });
  try {
    const page = await context.newPage();
    await page.setContent(html, { waitUntil: 'load', timeout: 20_000 }).catch(() => undefined);
    await page.waitForTimeout(300); // let the Tailwind runtime apply styles
    await page.screenshot({ path: outPng, fullPage: true, timeout: 20_000 });
  } finally {
    await context.close();
  }
}

async function mapLimit<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) await fn(items[i++]);
  });
  await Promise.all(workers);
}

export async function recommendDesigns(args: {
  findings: Finding[];
  bundle: EvidenceBundle;
  llm: LlmClient | null;
  runDir: string;
  onProgress?: ProgressFn;
}): Promise<{ alternatives: Map<string, DesignAlternative>; info: AgentRunInfo }> {
  const { findings, bundle, llm, runDir, onProgress } = args;
  const alternatives = new Map<string, DesignAlternative>();
  if (!llm) {
    return {
      alternatives,
      info: { name: 'Design Recommender', status: 'skipped', findings: 0, dropped: 0, note: 'Design alternatives need ANTHROPIC_API_KEY' },
    };
  }
  const picked = pickDesignFindings(findings);
  if (picked.length === 0) {
    return { alternatives, info: { name: 'Design Recommender', status: 'ok', findings: 0, dropped: 0, note: 'No findings to redesign' } };
  }

  mkdirSync(join(runDir, 'designs'), { recursive: true });
  const errors: string[] = [];
  let browser: Browser | null = null;
  let done = 0;
  try {
    browser = await chromium.launch();
    await mapLimit(picked, 2, async (f) => {
      try {
        const vp = viewportOf(f);
        const original = originalFor(f, bundle, runDir);
        const page = findPage(bundle, f.page);
        const content: LlmContent[] = [
          {
            type: 'text',
            text: `Issue:\n${JSON.stringify({ id: f.id, title: f.title, category: f.category, severity: f.severity, page: f.page, viewport: vp, evidence: f.evidence, expected: f.expected, actual: f.actual, recommendation: f.recommendation })}\n\nPage context:\n${JSON.stringify({ title: page?.title, h1: page?.h1, headings: page?.headings.slice(0, 10).map((h) => h.text), textSample: page?.textSample.slice(0, 600) })}\n\nTarget viewport: ${vp} (${VIEWPORT_SIZES[vp].width}px wide).`,
          },
        ];
        if (original) {
          content.push({ type: 'text', text: 'Current design (screenshot):' });
          content.push({ type: 'image', path: join(runDir, original) });
        }
        const out = await llm.json({ system: SYSTEM, content, schema: DesignOutput, maxTokens: 24000 });
        const parsed = DesignOutput.parse(out);
        const safeId = f.id.replace(/[^\w.-]/g, '_');
        const rel = (suffix: string) => `designs/${safeId}-${suffix}`;
        const goodHtml = ensureTailwind(parsed.goodHtml);
        const betterHtml = ensureTailwind(parsed.betterHtml);
        writeFileSync(join(runDir, rel('good.html')), goodHtml);
        writeFileSync(join(runDir, rel('better.html')), betterHtml);
        await renderHtml(browser!, goodHtml, vp, join(runDir, rel('good.png')));
        await renderHtml(browser!, betterHtml, vp, join(runDir, rel('better.png')));
        alternatives.set(f.id, {
          ...(original ? { original } : {}),
          goodHtml: rel('good.html'),
          goodScreenshot: rel('good.png'),
          betterHtml: rel('better.html'),
          betterScreenshot: rel('better.png'),
          goodSummary: parsed.goodSummary,
          betterSummary: parsed.betterSummary,
        });
      } catch (err) {
        errors.push(`${f.id}: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        done++;
        onProgress?.({
          stage: 'design',
          agent: 'Design Recommender',
          status: 'progress',
          message: `Designed ${done}/${picked.length} alternatives`,
          pct: Math.round(84 + (8 * done) / picked.length),
        });
      }
    });
  } catch (err) {
    errors.push(err instanceof Error ? err.message : String(err));
  } finally {
    await browser?.close().catch(() => undefined);
  }

  const status = alternatives.size > 0 || errors.length === 0 ? 'ok' : 'failed';
  return {
    alternatives,
    info: {
      name: 'Design Recommender',
      status,
      findings: alternatives.size,
      dropped: picked.length - alternatives.size,
      ...(errors.length ? { note: `${errors.length} design(s) failed: ${errors.join('; ').slice(0, 400)}` } : {}),
    },
  };
}
