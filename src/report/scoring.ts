import { CATEGORIES, type Category, type RawFinding, type Scores, type Severity } from '../core/types.js';

const PENALTY: Record<Severity, number> = { Critical: 25, High: 12, Medium: 5, Low: 2 };

/**
 * 100 minus severity penalties per category, floored at 0.
 * Overall is the mean of the category scores, so one bad category can't hide behind the rest.
 */
export function computeScores(findings: Pick<RawFinding, 'category' | 'severity'>[]): Scores {
  const byCategory = Object.fromEntries(CATEGORIES.map((c) => [c, 100])) as Record<Category, number>;
  for (const f of findings) byCategory[f.category] = Math.max(0, byCategory[f.category] - PENALTY[f.severity]);
  const overall = Math.round(CATEGORIES.reduce((sum, c) => sum + byCategory[c], 0) / CATEGORIES.length);
  return { overall, byCategory };
}
