import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AuditOptions, type EvidenceBundle } from '../../src/core/types.js';
import type { LlmClient } from '../../src/agents/claude.js';

const crawlMock = vi.fn();
vi.mock('../../src/crawler/crawl.js', () => ({ crawl: (...a: unknown[]) => crawlMock(...a) }));
vi.mock('../../src/rules/ruleFindings.js', () => ({ ruleFindings: () => [] }));

const { compareCompetitors } = await import('../../src/competitor/compare.js');
const { loadDomainPacks } = await import('../../src/agents/domain.js');
const { computeScores } = await import('../../src/report/scoring.js');

function bundleAt(runDir: string, url: string, html: string): EvidenceBundle {
  mkdirSync(join(runDir, 'dom'), { recursive: true });
  mkdirSync(join(runDir, 'evidence'), { recursive: true });
  writeFileSync(join(runDir, 'dom', 'home.html'), html);
  writeFileSync(join(runDir, 'evidence', 'home-desktop.png'), 'x');
  return {
    runDir, startUrl: url, startedAt: '',
    pages: [{
      url, path: '/', title: 'Homes', depth: 0, status: 200, lang: 'en', metaDescription: null, h1: [], headings: [], textSample: '',
      links: [], buttons: [], images: [], forms: [], console: [], networkFailures: [], securityHeaders: {},
      captures: [{ viewport: 'desktop', screenshot: 'evidence/full.png', aboveFold: 'evidence/home-desktop.png', axe: [], hiddenCtas: [], horizontalOverflow: false }],
      requiresLogin: false, domSnapshot: 'dom/home.html',
    }],
    nav: { nodes: [], edges: [], brokenLinks: [] }, robotsBlocked: [], loginUsed: false, errors: [],
  };
}

const domain = loadDomainPacks().find((p) => p.name === 'real-estate')!;
const options = AuditOptions.parse({ url: 'https://target.test/', competitors: ['https://rival.test/', 'https://down.test/'] });

describe('compareCompetitors', () => {
  let runDir: string;
  beforeEach(() => {
    runDir = mkdtempSync(join(tmpdir(), 'uia-comp-'));
    crawlMock.mockReset();
    crawlMock.mockImplementation(async (opts: { options: { url: string }; runDir: string; lite?: boolean }) => {
      if (opts.options.url.includes('down')) throw new Error('net::ERR_NAME_NOT_RESOLVED');
      if (opts.options.url.includes('target')) return bundleAt(opts.runDir, opts.options.url, '<p>Nothing useful</p>');
      return bundleAt(opts.runDir, opts.options.url, '<form><select name="min_price"></select><div id="map"></div></form>');
    });
  });

  it('diffs domain checks and scores, records failed crawls, never throws', async () => {
    const target = bundleAt(runDir, 'https://target.test/', '<p>Nothing useful</p>');
    const scores = computeScores([{ category: 'Domain', severity: 'High' }, { category: 'Domain', severity: 'High' }, { category: 'Performance', severity: 'Low' }]);
    const res = await compareCompetitors({ target: { bundle: target, findings: [], scores }, competitorUrls: options.competitors, options, runDir, llm: null, domain });

    // Target gets the same quick crawl as each competitor, then each competitor.
    expect(crawlMock).toHaveBeenCalledTimes(3);
    expect(crawlMock.mock.calls[0][0]).toMatchObject({ lite: true, runDir: join(runDir, 'competitors', '_target'), options: { url: 'https://target.test/' } });
    const call = crawlMock.mock.calls[1][0];
    expect(call).toMatchObject({ lite: true, options: { url: 'https://rival.test/', competitors: [], lighthouse: false } });
    expect(call.options.login).toBeUndefined();
    expect(call.runDir).toBe(join(runDir, 'competitors', '1-rival.test'));

    const { comparison, info } = res;
    expect(comparison.sites.map((s) => [s.label, s.isTarget])).toEqual([['target.test', true], ['rival.test', false]]);
    expect(comparison.sites[1].screenshot).toBe('competitors/1-rival.test/evidence/home-desktop.png');
    const titles = comparison.theyDoBetter.map((t) => t.title);
    expect(titles).toContain('Price range filter on listings');
    expect(titles).toContain('Map view for listings');
    expect(comparison.theyDoBetter[0]).toMatchObject({ competitor: 'rival.test', screenshot: 'competitors/1-rival.test/evidence/home-desktop.png' });
    expect(comparison.patternsToCopy).toEqual(titles);
    // Target lost points on Performance; the rival did not, so Performance is not a "win".
    expect(comparison.youWin.some((s) => s.startsWith('Performance'))).toBe(false);
    expect(info).toMatchObject({ name: 'Competitor Analyst', status: 'ok' });
    expect(info.note).toContain('down.test');
  });

  it('falls back to the full-audit score when the target quick crawl fails, and applies grounded LLM refinement', async () => {
    const target = bundleAt(runDir, 'https://target-down.test/', '<p>Nothing useful</p>');
    const scores = computeScores([]); // perfect on every category, so it beats the rival on Domain
    const llm: LlmClient = {
      model: 'fake',
      async json() {
        return {
          theyDoBetter: [
            { competitor: 'rival.test', title: 'Price range filter on listings', detail: 'Rival shows min/max price selects above results.' },
            { competitor: 'rival.test', title: 'Invented thing', detail: 'Should be ignored' },
          ],
          youWin: ['Cleaner home page'],
          patternsToCopy: ['Min/max price selects'],
        } as never;
      },
    };
    const res = await compareCompetitors({ target: { bundle: target, findings: [], scores }, competitorUrls: ['https://rival.test/'], options, runDir, llm, domain });
    const c = res.comparison;
    expect(c.youWin.some((s) => s.startsWith('Domain: you score 100'))).toBe(true);
    expect(c.youWin).toContain('Cleaner home page');
    expect(c.theyDoBetter.find((t) => t.title === 'Price range filter on listings')!.detail).toBe('Rival shows min/max price selects above results.');
    expect(c.theyDoBetter.some((t) => t.title === 'Invented thing')).toBe(false);
    expect(c.patternsToCopy).toContain('Min/max price selects');
    expect(c.patternsToCopy).toContain('Price range filter on listings');
  });

  it('marks the analyst failed when every competitor fails', async () => {
    const target = bundleAt(runDir, 'https://target.test/', '<p>x</p>');
    const res = await compareCompetitors({ target: { bundle: target, findings: [], scores: computeScores([]) }, competitorUrls: ['https://down.test/'], options, runDir, llm: null, domain });
    expect(res.info.status).toBe('failed');
    expect(res.comparison.sites).toHaveLength(1);
  });
});
