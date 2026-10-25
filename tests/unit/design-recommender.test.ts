import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { EvidenceBundle, Finding } from '../../src/core/types.js';
import type { LlmClient } from '../../src/agents/claude.js';
import { pickDesignFindings, recommendDesigns } from '../../src/design/recommender.js';

function setup() {
  const runDir = mkdtempSync(join(tmpdir(), 'uia-design-'));
  mkdirSync(join(runDir, 'evidence'));
  // 1x1 PNG
  writeFileSync(join(runDir, 'evidence', 'home-mobile.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'));
  const bundle: EvidenceBundle = {
    runDir, startUrl: 'https://re.test/', startedAt: '',
    pages: [{
      url: 'https://re.test/', path: '/', title: 'Home', depth: 0, status: 200, lang: 'en', metaDescription: null, h1: ['Find a home'], headings: [],
      textSample: 'Find a home', links: [], buttons: [], images: [], forms: [], console: [], networkFailures: [], securityHeaders: {},
      captures: [{ viewport: 'mobile', screenshot: 'evidence/full.png', aboveFold: 'evidence/home-mobile.png', axe: [], hiddenCtas: [], horizontalOverflow: false }],
      requiresLogin: false, domSnapshot: '',
    }],
    nav: { nodes: [], edges: [], brokenLinks: [] }, robotsBlocked: [], loginUsed: false, errors: [],
  };
  const mk = (id: string, category: Finding['category'], viewport: Finding['viewport'] = 'mobile'): Finding => ({
    id, fingerprint: id, title: `Issue ${id}`, category, severity: 'High', page: 'https://re.test/', viewport,
    evidence: [{ kind: 'selector', value: 'a.cta' }], stepsToReproduce: ['Open'], expected: 'a', actual: 'b', recommendation: 'c',
    foundBy: ['UX Designer'], source: 'agent',
  });
  return { runDir, bundle, mk };
}

describe('recommendDesigns', () => {
  it('is skipped without an LLM', async () => {
    const { runDir, bundle, mk } = setup();
    const res = await recommendDesigns({ findings: [mk('UIA-001', 'UX')], bundle, llm: null, runDir });
    expect(res.alternatives.size).toBe(0);
    expect(res.info).toMatchObject({ name: 'Design Recommender', status: 'skipped', note: 'Design alternatives need ANTHROPIC_API_KEY' });
  });

  it('prefers visual categories and fills up to 3', () => {
    const { mk } = setup();
    const picked = pickDesignFindings([mk('A', 'Security'), mk('B', 'UX'), mk('C', 'Performance'), mk('D', 'Accessibility')]);
    expect(picked.map((f) => f.id)).toEqual(['B', 'D', 'A']);
  });

  it('writes html + png files and survives a per-design failure', async () => {
    const { runDir, bundle, mk } = setup();
    let calls = 0;
    const llm: LlmClient = {
      model: 'fake',
      async json(req) {
        calls++;
        const issue = (req.content[0] as { text: string }).text;
        if (issue.includes('UIA-003')) throw new Error('model declined');
        expect(req.content.some((c) => c.type === 'image')).toBe(true);
        return {
          goodHtml: '<!doctype html><html><body style="margin:0"><button style="background:#0a6;color:#fff;padding:16px">Search homes</button></body></html>',
          goodSummary: 'Bigger CTA',
          betterHtml: '<!doctype html><html><body style="margin:0"><section style="padding:24px;background:#eef"><h2>Find your home</h2><button>Search</button></section></body></html>',
          betterSummary: 'Hero with search',
        } as never;
      },
    };
    const res = await recommendDesigns({ findings: [mk('UIA-001', 'UX'), mk('UIA-002', 'Domain', 'all'), mk('UIA-003', 'Accessibility')], bundle, llm, runDir });
    expect(calls).toBe(3);
    expect(res.alternatives.size).toBe(2);
    const alt = res.alternatives.get('UIA-001')!;
    expect(alt).toMatchObject({ original: 'evidence/home-mobile.png', goodHtml: 'designs/UIA-001-good.html', goodScreenshot: 'designs/UIA-001-good.png', betterScreenshot: 'designs/UIA-001-better.png', goodSummary: 'Bigger CTA' });
    for (const id of ['UIA-001', 'UIA-002']) {
      for (const f of ['good.html', 'better.html', 'good.png', 'better.png']) expect(existsSync(join(runDir, 'designs', `${id}-${f}`)), `${id}-${f}`).toBe(true);
    }
    // real PNG signature
    expect(readFileSync(join(runDir, 'designs', 'UIA-001-good.png')).subarray(1, 4).toString()).toBe('PNG');
    expect(res.info.status).toBe('ok');
    expect(res.info.note).toContain('UIA-003');
  }, 60_000);
});
