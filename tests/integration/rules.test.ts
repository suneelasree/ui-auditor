import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AuditOptions, RawFinding, type AttributedFinding, type EvidenceBundle } from '../../src/core/types.js';
import { crawl } from '../../src/crawler/crawl.js';
import { ruleFindings } from '../../src/rules/ruleFindings.js';
import { FIXTURE_LOGIN, startFixtures } from '../../fixtures/serve.js';

let fx: Awaited<ReturnType<typeof startFixtures>>;
let runDir: string;
let bundle: EvidenceBundle;
let findings: AttributedFinding[];

beforeAll(async () => {
  fx = await startFixtures();
  runDir = mkdtempSync(join(tmpdir(), 'uia-rules-'));
  const options = AuditOptions.parse({
    url: fx.realEstateUrl,
    lighthouse: false,
    rateLimitMs: 0,
    login: { loginUrl: `${fx.realEstateUrl}/login`, successUrlContains: '/account' },
  });
  bundle = await crawl({ options, runDir, credentials: { ...FIXTURE_LOGIN } });
  findings = ruleFindings(bundle);
});

afterAll(async () => {
  await fx?.close();
  rmSync(runDir, { recursive: true, force: true });
});

const has = (kind: string, pred: (v: string) => boolean) =>
  findings.filter((f) => f.evidence.some((e) => e.kind === kind && pred(e.value)));

/** Deterministic seeded defects (see fixtures/real-estate-site/SEEDED_DEFECTS.md). */
const SEEDED: { id: string; match: () => AttributedFinding[]; persona: string; category: string }[] = [
  { id: 'SD-01', match: () => has('link', (v) => v.endsWith('/neighborhoods')), persona: 'SDET', category: 'Navigation' },
  { id: 'SD-02', match: () => has('selector', (v) => v === 'button.btn.tour-btn'), persona: 'SDET', category: 'Functional' },
  { id: 'SD-03', match: () => has('selector', (v) => v.includes('listing-photo')), persona: 'Accessibility', category: 'Accessibility' },
  { id: 'SD-04', match: () => has('axe-rule', (v) => v === 'color-contrast'), persona: 'Accessibility', category: 'Accessibility' },
  { id: 'SD-05', match: () => findings.filter((f) => f.foundBy === 'UX Designer' && f.title.includes('Book a free valuation')), persona: 'UX Designer', category: 'UX' },
  { id: 'SD-06', match: () => has('console', (v) => v.includes('SavedSearch widget failed to initialise')), persona: 'Senior Engineer', category: 'Functional' },
  { id: 'SD-07', match: () => has('network', (v) => v.endsWith('/images/kitchen-missing.jpg')), persona: 'Senior Engineer', category: 'Performance' },
  { id: 'SD-08', match: () => has('selector', (v) => v === '#contact-form'), persona: 'SDET', category: 'Functional' },
  { id: 'SD-09', match: () => findings.filter((f) => f.title.startsWith('Navigation dead end') && f.page.endsWith('/privacy')), persona: 'SDET', category: 'Navigation' },
  { id: 'SD-11', match: () => has('network', (v) => v.endsWith('/images/team-photo.png')), persona: 'Senior Engineer', category: 'Performance' },
  { id: 'SD-12', match: () => findings.filter((f) => f.title.startsWith('Missing H1') && f.page.endsWith('/about')), persona: 'UX Designer', category: 'SEO' },
  { id: 'SD-13', match: () => has('selector', (v) => v.includes('account-agent-avatar')), persona: 'Accessibility', category: 'Accessibility' },
  { id: 'SD-14', match: () => findings.filter((f) => f.title.startsWith('Page scrolls horizontally') && f.page.endsWith('/listings/42-harbor-view-drive')), persona: 'SDET', category: 'UX' },
  { id: 'SD-17', match: () => findings.filter((f) => f.category === 'Security'), persona: 'Senior Engineer', category: 'Security' },
];

describe('ruleFindings on the crawled fixture', () => {
  it('logged in and reached the protected page', () => {
    expect(bundle.loginUsed).toBe(true);
    expect(bundle.pages.find((p) => p.path === '/account')?.requiresLogin).toBe(true);
  });

  for (const s of SEEDED) {
    it(`${s.id} produces exactly one finding with the right owner`, () => {
      const m = s.match();
      expect(m, `no finding for ${s.id}`).toHaveLength(1);
      expect(m[0]!.foundBy).toBe(s.persona);
      expect(m[0]!.category).toBe(s.category);
    });
  }

  it('every finding is schema-valid, rule-sourced and has evidence screenshots that exist in the bundle', () => {
    const shots = new Set(bundle.pages.flatMap((p) => p.captures.flatMap((c) => [c.screenshot, c.aboveFold, ...c.hiddenCtas.map((h) => h.screenshot)])));
    for (const f of findings) {
      expect(RawFinding.safeParse(f).success, f.title).toBe(true);
      expect(f.source).toBe('rule');
      for (const e of f.evidence) if (e.screenshot) expect(shots.has(e.screenshot), e.screenshot).toBe(true);
    }
  });

  it('only one Low security finding for a localhost site', () => {
    const sec = findings.filter((f) => f.category === 'Security');
    expect(sec).toHaveLength(1);
    expect(sec[0]!.severity).toBe('Low');
  });

  it('does not report the missing price filter (domain pack owns that) or false dead buttons', () => {
    expect(findings.some((f) => /price filter/i.test(f.title))).toBe(false);
    expect(findings.filter((f) => f.title.includes('does nothing'))).toHaveLength(1);
  });

  it('the evidence validator keeps every seeded finding (if available)', async () => {
    let validate: ((f: AttributedFinding[], b: EvidenceBundle) => { kept: AttributedFinding[]; dropped: number }) | undefined;
    try {
      ({ validateEvidence: validate } = await import('../../src/agents/evidence.js'));
    } catch {
      return; // validator not built yet
    }
    const { kept } = validate!(SEEDED.flatMap((s) => s.match()), bundle);
    expect(kept.map((f) => f.title).sort()).toEqual(SEEDED.flatMap((s) => s.match()).map((f) => f.title).sort());
  });
});
