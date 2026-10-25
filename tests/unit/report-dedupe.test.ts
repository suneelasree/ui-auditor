import { describe, expect, it } from 'vitest';
import type { AttributedFinding } from '../../src/core/types.js';
import { dedupe } from '../../src/report/dedupe.js';
import { fingerprint } from '../../src/report/fingerprint.js';

function f(over: Partial<AttributedFinding>): AttributedFinding {
  return {
    title: 'Some issue',
    category: 'Functional',
    severity: 'Medium',
    page: 'https://example.test/',
    viewport: 'desktop',
    evidence: [{ kind: 'selector', value: '#x' }],
    stepsToReproduce: ['Open the page'],
    expected: 'Works',
    actual: 'Broken',
    recommendation: 'Fix it',
    foundBy: 'Rules',
    source: 'rule',
    ...over,
  };
}

describe('dedupe', () => {
  it('merges findings with the same fingerprint', () => {
    const a = f({ title: 'Broken link to /old', evidence: [{ kind: 'link', value: 'https://example.test/old' }], severity: 'Medium' });
    const b = f({
      title: 'Navigation link returns 404',
      evidence: [{ kind: 'link', value: 'https://example.test/old' }],
      severity: 'High',
      foundBy: 'SDET',
      source: 'agent',
      recommendation: 'Agent wording',
      stepsToReproduce: ['Open home', 'Click "Old page"', 'See 404'],
    });
    expect(fingerprint(a)).toBe(fingerprint(b));
    const out = dedupe([a, b]);
    expect(out).toHaveLength(1);
    const m = out[0];
    expect(m.severity).toBe('High');
    expect(m.foundBy).toEqual(['SDET', 'Rules']);
    expect(m.source).toBe('agent');
    expect(m.title).toBe('Navigation link returns 404');
    expect(m.recommendation).toBe('Agent wording');
    expect(m.stepsToReproduce).toHaveLength(3);
    expect(m.evidence).toHaveLength(1);
    expect(m.fingerprint).toBe(fingerprint(a)); // rule fingerprint kept
  });

  it('merges near-duplicates on the same page + category with overlapping evidence', () => {
    const rule = f({
      title: 'Images missing alt text',
      category: 'Accessibility',
      evidence: [{ kind: 'selector', value: 'img.hero' }],
      severity: 'Medium',
    });
    const agent = f({
      title: 'Hero image has no text alternative',
      category: 'Accessibility',
      evidence: [
        { kind: 'axe-rule', value: 'image-alt' },
        { kind: 'selector', value: 'IMG.HERO' },
      ],
      foundBy: 'Accessibility',
      source: 'agent',
      severity: 'Low',
    });
    expect(fingerprint(rule)).not.toBe(fingerprint(agent));
    const out = dedupe([rule, agent]);
    expect(out).toHaveLength(1);
    expect(out[0].severity).toBe('Medium');
    expect(out[0].title).toBe('Hero image has no text alternative');
    expect(out[0].foundBy).toEqual(['Accessibility', 'Rules']);
    expect(out[0].evidence.map((e) => e.value)).toEqual(['image-alt', 'IMG.HERO', 'img.hero']);
  });

  it('does not merge across pages, categories, or shared screenshots only', () => {
    const out = dedupe([
      f({ title: 'A', evidence: [{ kind: 'selector', value: '#a' }] }),
      f({ title: 'B', evidence: [{ kind: 'selector', value: '#a' }], page: 'https://example.test/other' }),
      f({ title: 'C', evidence: [{ kind: 'selector', value: '#a' }], category: 'UX' }),
      f({ title: 'D', evidence: [{ kind: 'screenshot', value: 'evidence/p1.png' }, { kind: 'selector', value: '#d' }] }),
      f({ title: 'E', evidence: [{ kind: 'screenshot', value: 'evidence/p1.png' }, { kind: 'selector', value: '#e' }] }),
    ]);
    expect(out).toHaveLength(5);
  });

  it('sorts by severity, persona count, category, title and assigns ids', () => {
    const out = dedupe([
      f({ title: 'Zeta low', severity: 'Low', evidence: [{ kind: 'selector', value: '#1' }] }),
      f({ title: 'Beta high', severity: 'High', evidence: [{ kind: 'selector', value: '#2' }] }),
      f({ title: 'Alpha high', severity: 'High', evidence: [{ kind: 'selector', value: '#3' }] }),
      f({ title: 'Gamma high two personas', severity: 'High', evidence: [{ kind: 'selector', value: '#4' }] }),
      f({ title: 'Gamma dup', severity: 'Medium', evidence: [{ kind: 'selector', value: '#4' }], foundBy: 'SDET', source: 'agent' }),
      f({ title: 'Critical one', severity: 'Critical', category: 'Security', evidence: [{ kind: 'selector', value: '#5' }] }),
      f({ title: 'Nav high', severity: 'High', category: 'Navigation', evidence: [{ kind: 'selector', value: '#6' }] }),
    ]);
    expect(out.map((x) => [x.id, x.title])).toEqual([
      ['UIA-001', 'Critical one'],
      ['UIA-002', 'Gamma dup'],
      ['UIA-003', 'Nav high'],
      ['UIA-004', 'Alpha high'],
      ['UIA-005', 'Beta high'],
      ['UIA-006', 'Zeta low'],
    ]);
    expect(out[1].severity).toBe('High');
    expect(out[1].foundBy).toEqual(['SDET', 'Rules']);
  });
});
