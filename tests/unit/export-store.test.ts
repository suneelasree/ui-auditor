import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ExportStore, exportKey, normaliseOrigin } from '../../src/export/store.js';
import { ExportService } from '../../src/export/service.js';
import { cannedReport } from '../e2e/fake-engine.js';

const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'uia-store-'));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('export store', () => {
  it('normalises origins', () => {
    expect(normaliseOrigin('https://WWW.Example.com/path?q=1')).toBe('https://example.com');
    expect(normaliseOrigin('https://example.com:443/')).toBe('https://example.com');
    expect(normaliseOrigin('http://localhost:4000/x')).toBe('http://localhost:4000');
    expect(exportKey('github', 'https://example.com/a', 'abc')).toBe('github|https://example.com|abc');
  });

  it('records and finds exports across runs of the same site, per target', () => {
    const dir = tmp();
    const store = new ExportStore(dir);
    expect(store.get('github', 'https://example.com', 'fp1')).toBeUndefined();
    store.record('github', 'https://example.com/listings', 'fp1', { key: '#1', url: 'u', exportedAt: 'now', runId: 'r1' });
    // Same site, different page URL / later run: still found
    expect(store.get('github', 'https://www.example.com/', 'fp1')?.key).toBe('#1');
    // Other target or other site: not found
    expect(store.get('jira', 'https://example.com', 'fp1')).toBeUndefined();
    expect(store.get('github', 'https://other.com', 'fp1')).toBeUndefined();
    expect(JSON.parse(readFileSync(join(dir, 'exports.json'), 'utf8'))['github|https://example.com|fp1'].runId).toBe('r1');
  });

  it('preview skips findings already exported from an earlier run', () => {
    const dir = tmp();
    const env = { GITHUB_TOKEN: 't0ken-x', GITHUB_REPO: 'o/r' };
    let calls = 0;
    const svc = new ExportService(dir, env, (async () => {
      calls++;
      return new Response('{}');
    }) as typeof fetch);
    const report = cannedReport('run-2', 'https://example.com', 'x');
    svc.store.record('github', 'https://example.com', report.findings[0].fingerprint, { key: '#9', url: 'u9', exportedAt: 'now', runId: 'run-1' });
    const p = svc.preview(report, join(dir, 'run-2'), 'github', ['UIA-001', 'UIA-002']);
    expect(p.items.map((i) => i.findingId)).toEqual(['UIA-002']);
    expect(p.skipped).toEqual([expect.objectContaining({ findingId: 'UIA-001', reason: 'Already exported as #9' })]);
    expect(calls).toBe(0);
  });
});
