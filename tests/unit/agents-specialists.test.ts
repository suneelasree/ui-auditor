import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { EvidenceBundle, ProgressEvent } from '../../src/core/types.js';
import type { LlmClient, LlmJsonRequest } from '../../src/agents/claude.js';
import { loadDomainPacks } from '../../src/agents/domain.js';
import { runSpecialists } from '../../src/agents/specialists.js';

function makeBundle(): EvidenceBundle {
  const runDir = mkdtempSync(join(tmpdir(), 'uia-spec-'));
  mkdirSync(join(runDir, 'dom'));
  mkdirSync(join(runDir, 'evidence'));
  writeFileSync(join(runDir, 'dom', 'home.html'), '<html><body><a class="cta" href="/listings">Search homes</a></body></html>');
  writeFileSync(join(runDir, 'evidence', 'home-desktop.png'), 'x');
  writeFileSync(join(runDir, 'evidence', 'home-mobile.png'), 'x');
  return {
    runDir, startUrl: 'https://re.test/', startedAt: '',
    pages: [{
      url: 'https://re.test/', path: '/', title: 'Homes for sale', depth: 0, status: 200, lang: 'en', metaDescription: null,
      h1: ['Find your home'], headings: [], textSample: 'Homes for sale. 3 bedrooms.', links: [], buttons: [], images: [], forms: [],
      console: [{ type: 'error', text: 'Failed to load map tiles' }], networkFailures: [], securityHeaders: {},
      captures: [
        { viewport: 'desktop', screenshot: 'evidence/home-desktop-full.png', aboveFold: 'evidence/home-desktop.png', axe: [{ id: 'color-contrast', impact: 'serious', help: 'Contrast', helpUrl: '', nodes: [{ target: 'a.cta', html: '<a>' }] }], hiddenCtas: [], horizontalOverflow: false },
        { viewport: 'mobile', screenshot: 'evidence/home-mobile-full.png', aboveFold: 'evidence/home-mobile.png', axe: [], hiddenCtas: [], horizontalOverflow: true },
      ],
      requiresLogin: false, domSnapshot: 'dom/home.html',
    }],
    nav: { nodes: [], edges: [], brokenLinks: [] }, robotsBlocked: [], loginUsed: false, errors: [],
  };
}

const base = { category: 'UX', severity: 'High', page: 'https://re.test/', viewport: 'desktop', stepsToReproduce: ['Open the home page'], expected: 'Visible', actual: 'Hidden', recommendation: 'Fix it' };

class FakeLlm implements LlmClient {
  readonly model = 'fake';
  calls: { system: string; images: number; text: string }[] = [];
  async json<S extends import('zod').ZodType>(req: LlmJsonRequest<S>): Promise<import('zod').infer<S>> {
    const text = req.content.filter((c) => c.type === 'text').map((c) => (c as { text: string }).text).join('\n');
    this.calls.push({ system: req.system, images: req.content.filter((c) => c.type === 'image').length, text });
    let out: unknown;
    if (req.system.includes('senior software engineer')) throw new Error('rate limited');
    if (req.system.includes('UX/UI designer')) {
      out = { findings: [
        { ...base, title: 'CTA has low prominence', evidence: [{ kind: 'selector', value: 'a.cta' }] },
        { ...base, title: 'Invented carousel issue', evidence: [{ kind: 'selector', value: '.carousel-next' }] },
        { ...base, title: 'x', evidence: [] }, // schema-invalid: short title, no evidence
      ] };
    } else if (req.system.includes('accessibility specialist')) {
      out = { findings: [{ ...base, category: 'Accessibility', title: 'Low contrast CTA', evidence: [{ kind: 'axe-rule', value: 'color-contrast' }, { kind: 'axe-rule', value: 'region' }] }] };
    } else if (req.system.includes('SDET')) {
      out = { findings: [{ ...base, category: 'Functional', title: 'Map tiles fail', evidence: [{ kind: 'console', value: 'failed to load map tiles' }] }] };
    } else {
      out = { findings: [], insights: ['Leading sites offer a map view.', '  '] };
    }
    return out as import('zod').infer<S>;
  }
}

describe('runSpecialists', () => {
  it('tags findings, drops ungrounded ones, survives a failing agent', async () => {
    const llm = new FakeLlm();
    const events: Omit<ProgressEvent, 'runId' | 'ts'>[] = [];
    const domain = loadDomainPacks().find((p) => p.name === 'real-estate')!;
    const res = await runSpecialists({ bundle: makeBundle(), domain, llm, onProgress: (e) => events.push(e) });

    expect(llm.calls).toHaveLength(5);
    expect(res.agents.map((a) => a.name).sort()).toEqual(['Accessibility', 'Domain Expert', 'SDET', 'Senior Engineer', 'UX Designer']);

    const ux = res.agents.find((a) => a.name === 'UX Designer')!;
    expect(ux).toMatchObject({ status: 'ok', findings: 1, dropped: 2 });
    const eng = res.agents.find((a) => a.name === 'Senior Engineer')!;
    expect(eng.status).toBe('failed');
    expect(eng.note).toContain('rate limited');

    expect(res.findings.map((f) => f.title).sort()).toEqual(['CTA has low prominence', 'Low contrast CTA', 'Map tiles fail']);
    const a11y = res.findings.find((f) => f.title === 'Low contrast CTA')!;
    expect(a11y).toMatchObject({ foundBy: 'Accessibility', source: 'agent' });
    expect(a11y.evidence).toEqual([{ kind: 'axe-rule', value: 'color-contrast' }]);
    expect(res.findings.find((f) => f.title === 'Map tiles fail')!.foundBy).toBe('SDET');

    expect(res.domainInsights).toEqual(['Leading sites offer a map view.']);

    // screenshots only for UX + Accessibility
    const uxCall = llm.calls.find((c) => c.system.includes('UX/UI designer'))!;
    expect(uxCall.images).toBe(2);
    expect(llm.calls.find((c) => c.system.includes('SDET'))!.images).toBe(0);
    // Domain Expert sees deterministic check results
    const domainCall = llm.calls.find((c) => c.system.includes('domain expert'))!;
    expect(domainCall.text).toContain('re-price-filter');
    expect(domainCall.text).toContain('missing (already reported)');

    const agentEvents = events.filter((e) => e.stage === 'agents');
    expect(agentEvents.filter((e) => e.status === 'started')).toHaveLength(5);
    expect(agentEvents.filter((e) => e.status === 'done' || e.status === 'failed')).toHaveLength(5);
    for (const e of agentEvents) {
      expect(e.pct).toBeGreaterThanOrEqual(42);
      expect(e.pct).toBeLessThanOrEqual(70);
    }
  });
});
