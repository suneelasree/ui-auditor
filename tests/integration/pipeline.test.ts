// Full pipeline against the seeded-defect fixture: crawl (with login) -> rules -> domain pack ->
// (AI agents when ANTHROPIC_API_KEY is set) -> competitor comparison -> report files.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { startFixtures, FIXTURE_LOGIN } from '../../fixtures/serve.js';
import { runAudit } from '../../src/engine/runAudit.js';
import { AuditOptions, type Finding, type Report } from '../../src/core/types.js';

const hasKey = Boolean(process.env.ANTHROPIC_API_KEY);

type Check = { id: string; test: (f: Finding) => boolean };
const has = (f: Finding, kind: string, needle: string) =>
  f.evidence.some((e) => e.kind === kind && e.value.toLowerCase().includes(needle.toLowerCase()));
const onPage = (f: Finding, path: string) => new URL(f.page, 'http://x').pathname.replace(/\/$/, '') === path;

const SEEDED: Check[] = [
  { id: 'SD-01 broken link', test: (f) => has(f, 'link', '/neighborhoods') },
  { id: 'SD-02 dead button', test: (f) => has(f, 'selector', 'tour-btn') },
  { id: 'SD-03 missing alt', test: (f) => has(f, 'selector', 'listing-photo') },
  { id: 'SD-04 low contrast', test: (f) => has(f, 'axe-rule', 'color-contrast') },
  { id: 'SD-05 hidden CTA on mobile', test: (f) => f.category === 'UX' && onPage(f, '') && /hidden|not visible/i.test(f.title + f.actual) },
  { id: 'SD-06 console error', test: (f) => has(f, 'console', 'SavedSearch') },
  { id: 'SD-07 404 image', test: (f) => has(f, 'network', 'kitchen-missing') },
  { id: 'SD-08 form validation', test: (f) => has(f, 'selector', 'contact-form') },
  { id: 'SD-09 nav dead end', test: (f) => f.category === 'Navigation' && onPage(f, '/privacy') },
  { id: 'SD-10 missing price filter', test: (f) => f.category === 'Domain' && /price/i.test(f.title) },
  { id: 'SD-11 oversized image', test: (f) => has(f, 'network', 'team-photo') || has(f, 'selector', 'team-photo') },
  { id: 'SD-12 missing H1', test: (f) => onPage(f, '/about') && /h1|heading/i.test(f.title) },
  { id: 'SD-13 login-only missing alt', test: (f) => has(f, 'selector', 'account-agent-avatar') },
];

describe('full audit pipeline on the fixture site', () => {
  let fixtures: Awaited<ReturnType<typeof startFixtures>>;
  let reportsDir: string;
  let report: Report;
  let runDir: string;

  beforeAll(async () => {
    fixtures = await startFixtures();
    reportsDir = mkdtempSync(join(tmpdir(), 'uia-pipeline-'));
    const options = AuditOptions.parse({
      url: fixtures.realEstateUrl,
      depth: 2,
      maxPages: 15,
      competitors: [fixtures.competitorUrl],
      login: { loginUrl: `${fixtures.realEstateUrl}/login`, successUrlContains: '/account' },
      lighthouse: false,
      rateLimitMs: 0,
    });
    report = await runAudit({
      options,
      credentials: { username: FIXTURE_LOGIN.username, password: FIXTURE_LOGIN.password },
      reportsDir,
      ...(hasKey ? {} : { llm: null }),
    });
    runDir = join(reportsDir, report.id);
  }, 900_000);

  afterAll(async () => {
    await fixtures?.close();
    if (reportsDir) rmSync(reportsDir, { recursive: true, force: true });
  });

  it('writes all three report files and generated tests', () => {
    for (const f of ['report.html', 'report.json', 'report.md']) expect(existsSync(join(runDir, f))).toBe(true);
    expect(report.generatedTests.length).toBeGreaterThan(0);
    for (const t of report.generatedTests) expect(existsSync(join(runDir, t))).toBe(true);
  });

  it('detects at least 90% of the seeded defects', () => {
    const missed = SEEDED.filter((c) => !report.findings.some(c.test)).map((c) => c.id);
    const rate = (SEEDED.length - missed.length) / SEEDED.length;
    console.log(`Seeded-defect detection: ${SEEDED.length - missed.length}/${SEEDED.length} (${Math.round(rate * 100)}%)` + (missed.length ? `; missed: ${missed.join(', ')}` : ''));
    expect(rate).toBeGreaterThanOrEqual(0.9);
  });

  it('every finding has evidence, steps, severity and a recommendation', () => {
    expect(report.findings.length).toBeGreaterThan(0);
    for (const f of report.findings) {
      expect(f.evidence.length).toBeGreaterThan(0);
      expect(f.stepsToReproduce.length).toBeGreaterThan(0);
      expect(f.severity).toBeTruthy();
      expect(f.recommendation.length).toBeGreaterThan(0);
    }
  });

  it('auto-detects the real-estate domain', () => {
    expect(report.domain).toMatchObject({ name: 'real-estate', detected: true });
  });

  it('audits the login-protected page', () => {
    expect(report.pages.some((p) => p.requiresLogin && p.url.includes('/account'))).toBe(true);
  });

  it('populates the competitor comparison', () => {
    expect(report.comparison?.sites).toHaveLength(2);
    expect(report.comparison?.theyDoBetter.length).toBeGreaterThan(0);
  });

  it('never writes the password anywhere in the run folder', () => {
    const walk = (dir: string): string[] =>
      readdirSync(dir).flatMap((n) => (statSync(join(dir, n)).isDirectory() ? walk(join(dir, n)) : [join(dir, n)]));
    const textFiles = walk(runDir).filter((p) => /\.(json|jsonl|html|md|txt|ts)$/.test(p));
    expect(textFiles.length).toBeGreaterThan(0);
    for (const file of textFiles) expect(readFileSync(file, 'utf8')).not.toContain(FIXTURE_LOGIN.password);
    expect(existsSync(join(runDir, '.auth'))).toBe(false);
  });

  it.skipIf(!hasKey)('with a Claude key: agents ran and at least 3 design alternatives were rendered', () => {
    expect(report.agents.filter((a) => a.status === 'ok' && a.name !== 'Rules').length).toBeGreaterThanOrEqual(3);
    const designs = report.findings.filter((f) => f.designAlternative);
    expect(designs.length).toBeGreaterThanOrEqual(3);
    for (const f of designs) {
      expect(existsSync(join(runDir, f.designAlternative!.goodScreenshot))).toBe(true);
      expect(existsSync(join(runDir, f.designAlternative!.betterScreenshot))).toBe(true);
    }
  });
});
