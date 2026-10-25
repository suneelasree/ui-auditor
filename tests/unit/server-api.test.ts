import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../../src/server/app.js';
import { createFakeRunAudit } from '../e2e/fake-engine.js';

interface FetchCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

function fakeFetch() {
  const calls: FetchCall[] = [];
  let n = 0;
  const fn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>));
    calls.push({ url, method: init?.method ?? 'GET', headers, body: init?.body });
    n++;
    if (url.includes('/repos/') && url.endsWith('/issues')) {
      return new Response(JSON.stringify({ number: 100 + n, html_url: `https://github.example/o/r/issues/${100 + n}` }), { status: 201 });
    }
    if (url.endsWith('/rest/api/3/issue')) return new Response(JSON.stringify({ id: '1', key: `QA-${n}` }), { status: 201 });
    if (url.includes('/attachments')) return new Response('[]', { status: 200 });
    return new Response('nope', { status: 404 });
  }) as typeof fetch;
  return Object.assign(fn, { calls });
}

const PASSWORD = 'Sup3r-Secret-Pa55word!';
const ENV = {
  GITHUB_TOKEN: 'ghp_faketoken123',
  GITHUB_REPO: 'o/r',
  GITHUB_API_URL: 'https://gh.fake',
  JIRA_BASE_URL: 'https://jira.fake',
  JIRA_EMAIL: 'qa@example.test',
  JIRA_API_TOKEN: 'jira-fake-token',
  JIRA_PROJECT_KEY: 'QA',
};

let reportsDir: string;
let app: FastifyInstance;
let fetchFake: ReturnType<typeof fakeFetch>;
let engine: ReturnType<typeof createFakeRunAudit>;

beforeEach(() => {
  reportsDir = mkdtempSync(join(tmpdir(), 'uia-server-'));
  fetchFake = fakeFetch();
  engine = createFakeRunAudit();
  app = buildServer({ reportsDir, runAudit: engine, fetchImpl: fetchFake, env: { ...ENV }, webDist: join(reportsDir, 'no-dist') });
});

afterEach(async () => {
  await app.close();
  rmSync(reportsDir, { recursive: true, force: true });
});

async function startAudit(payload: Record<string, unknown> = { options: { url: 'https://example.test' } }): Promise<string> {
  const res = await app.inject({ method: 'POST', url: '/api/audits', payload });
  expect(res.statusCode).toBe(202);
  const { id } = res.json() as { id: string };
  for (let i = 0; i < 100; i++) {
    const r = await app.inject({ method: 'GET', url: `/api/audits/${id}` });
    if (r.statusCode === 200 && r.json().meta.status !== 'running') return id;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('audit did not finish');
}

describe('audits API', () => {
  it('rejects invalid options with 400 and issues', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/audits', payload: { options: { url: 'not a url', depth: 99 } } });
    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.issues.map((i: { path: string }) => i.path)).toEqual(expect.arrayContaining(['url', 'depth']));
    expect(engine.calls).toHaveLength(0);
  });

  it('requires credentials when login is set and none are in env', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/audits',
      payload: { options: { url: 'https://example.test', login: { loginUrl: 'https://example.test/login' } } },
    });
    expect(res.statusCode).toBe(400);
  });

  it('starts an audit, lists it, returns the report and replays SSE events', async () => {
    const id = await startAudit();
    expect(id).toMatch(/^[A-Za-z0-9-]+$/);
    expect(engine.calls[0].options.depth).toBe(2); // defaults applied

    const list = await app.inject({ method: 'GET', url: '/api/audits' });
    expect(list.json().runs.map((r: { id: string }) => r.id)).toEqual([id]);

    const detail = await app.inject({ method: 'GET', url: `/api/audits/${id}` });
    expect(detail.json().meta.status).toBe('done');
    expect(detail.json().report.findings).toHaveLength(4);

    const sse = await app.inject({ method: 'GET', url: `/api/audits/${id}/events` });
    expect(sse.headers['content-type']).toContain('text/event-stream');
    const data = sse.body
      .split('\n\n')
      .filter((b) => b.startsWith('data: '))
      .map((b) => JSON.parse(b.slice(6)));
    expect(data.length).toBeGreaterThanOrEqual(5);
    expect(data[0].stage).toBe('crawl');
    expect(data.at(-1).stage).toBe('done');
    expect(sse.body).toContain('event: end');

    const missing = await app.inject({ method: 'GET', url: '/api/audits/nope-123' });
    expect(missing.statusCode).toBe(404);
  });

  it('lists runs newest first', async () => {
    const a = await startAudit();
    await new Promise((r) => setTimeout(r, 20));
    const b = await startAudit();
    const list = await app.inject({ method: 'GET', url: '/api/audits' });
    expect(list.json().runs.map((r: { id: string }) => r.id)).toEqual([b, a]);
  });

  it('never writes credentials to any file in reportsDir', async () => {
    const id = await startAudit({
      options: { url: 'https://example.test', login: { loginUrl: 'https://example.test/login' } },
      credentials: { username: 'qa-user', password: PASSWORD },
    });
    expect(engine.calls[0].credentials?.password).toBe(PASSWORD);
    // also run an export so exports.json exists
    const p = await app.inject({ method: 'POST', url: `/api/audits/${id}/export/preview`, payload: { target: 'github', findingIds: ['UIA-002'] } });
    await app.inject({ method: 'POST', url: `/api/audits/${id}/export/confirm`, payload: { target: 'github', findingIds: ['UIA-002'], previewToken: p.json().previewToken } });
    const walk = (d: string): string[] => readdirSync(d).flatMap((n) => (statSync(join(d, n)).isDirectory() ? walk(join(d, n)) : [join(d, n)]));
    const files = walk(reportsDir);
    expect(files.length).toBeGreaterThan(5);
    for (const f of files) expect(readFileSync(f, 'utf8')).not.toContain(PASSWORD);
  });
});

describe('config and static files', () => {
  it('reports configured targets as booleans only', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/config' });
    expect(res.json()).toEqual({ targets: { github: true, jira: true } });
    expect(res.body).not.toContain(ENV.GITHUB_TOKEN);
  });

  it('serves run files and rejects traversal', async () => {
    const id = await startAudit();
    const ok = await app.inject({ method: 'GET', url: `/reports/${id}/report.html` });
    expect(ok.statusCode).toBe(200);
    expect(ok.headers['content-type']).toContain('text/html');
    expect(ok.headers['content-security-policy']).toMatch(/^sandbox allow-scripts/);
    const png = await app.inject({ method: 'GET', url: `/reports/${id}/evidence/p1-mobile.png` });
    expect(png.headers['content-type']).toBe('image/png');
    expect(png.headers['content-security-policy']).toBe('sandbox');
    for (const url of [
      `/reports/${id}/..%2f..%2fexports.json`,
      `/reports/${id}/%2e%2e/%2e%2e/package.json`,
      `/reports/${id}/..%5c..%5cpackage.json`,
      `/reports/..%2f/report.html`,
      `/reports/${id}/../meta.json`,
    ]) {
      const res = await app.inject({ method: 'GET', url });
      expect([400, 403, 404], url).toContain(res.statusCode);
    }
  });

  it('explains how to build the UI when web/dist is missing', async () => {
    const res = await app.inject({ method: 'GET', url: '/' });
    expect(res.body).toContain('npm run build:web');
  });
});

describe('export flow', () => {
  it('preview sends nothing and returns what would be created', async () => {
    const id = await startAudit();
    const res = await app.inject({ method: 'POST', url: `/api/audits/${id}/export/preview`, payload: { target: 'jira', findingIds: ['UIA-001', 'UIA-003'] } });
    expect(res.statusCode).toBe(200);
    const p = res.json();
    expect(p.previewToken).toBeTruthy();
    expect(p.items).toHaveLength(2);
    expect(p.items[0]).toMatchObject({ title: '[UIA-001][Critical] Primary "Search Homes" button hidden on mobile', priority: 'Highest', labels: ['ui-auditor', 'ux', 'critical'] });
    expect(p.items[0].attachments).toEqual(['evidence/p1-mobile-el1.png', 'evidence/p1-mobile.png']);
    expect(fetchFake.calls).toHaveLength(0);
  });

  it('rejects confirm without a valid preview token', async () => {
    const id = await startAudit();
    const noToken = await app.inject({ method: 'POST', url: `/api/audits/${id}/export/confirm`, payload: { target: 'github', findingIds: ['UIA-001'] } });
    expect(noToken.statusCode).toBe(400);
    const bad = await app.inject({ method: 'POST', url: `/api/audits/${id}/export/confirm`, payload: { target: 'github', findingIds: ['UIA-001'], previewToken: 'bogus' } });
    expect(bad.statusCode).toBe(409);
    // token for a different selection is rejected
    const p = await app.inject({ method: 'POST', url: `/api/audits/${id}/export/preview`, payload: { target: 'github', findingIds: ['UIA-001'] } });
    const mismatch = await app.inject({
      method: 'POST',
      url: `/api/audits/${id}/export/confirm`,
      payload: { target: 'github', findingIds: ['UIA-001', 'UIA-002'], previewToken: p.json().previewToken },
    });
    expect(mismatch.statusCode).toBe(409);
    expect(fetchFake.calls).toHaveLength(0);
  });

  it('creates GitHub issues on confirm and skips them on re-export (also from a later run)', async () => {
    const id = await startAudit();
    const p = (await app.inject({ method: 'POST', url: `/api/audits/${id}/export/preview`, payload: { target: 'github', findingIds: ['UIA-001', 'UIA-002'] } })).json();
    const c = await app.inject({ method: 'POST', url: `/api/audits/${id}/export/confirm`, payload: { target: 'github', findingIds: ['UIA-001', 'UIA-002'], previewToken: p.previewToken } });
    expect(c.statusCode).toBe(200);
    const result = c.json();
    expect(result.errors).toEqual([]);
    expect(result.created.map((x: { key: string }) => x.key)).toEqual(['#101', '#102']);
    expect(fetchFake.calls).toHaveLength(2);
    const call = fetchFake.calls[0];
    expect(call.url).toBe('https://gh.fake/repos/o/r/issues');
    expect(call.method).toBe('POST');
    expect(call.headers.Authorization).toBe('Bearer ghp_faketoken123');
    expect(JSON.parse(String(call.body)).labels).toEqual(['ui-auditor', 'UX', 'Critical']);

    // token is single use
    const again = await app.inject({ method: 'POST', url: `/api/audits/${id}/export/confirm`, payload: { target: 'github', findingIds: ['UIA-001', 'UIA-002'], previewToken: p.previewToken } });
    expect(again.statusCode).toBe(409);

    // exported badge data
    const detail = (await app.inject({ method: 'GET', url: `/api/audits/${id}` })).json();
    expect(detail.exported['UIA-001']).toEqual([{ target: 'github', key: '#101', url: 'https://github.example/o/r/issues/101' }]);

    // later run of the same site: same fingerprints are skipped
    const id2 = await startAudit();
    const p2 = (await app.inject({ method: 'POST', url: `/api/audits/${id2}/export/preview`, payload: { target: 'github', findingIds: ['UIA-001', 'UIA-002', 'UIA-003'] } })).json();
    expect(p2.items.map((i: { findingId: string }) => i.findingId)).toEqual(['UIA-003']);
    expect(p2.skipped.map((s: { findingId: string }) => s.findingId)).toEqual(['UIA-001', 'UIA-002']);
    const c2 = (await app.inject({ method: 'POST', url: `/api/audits/${id2}/export/confirm`, payload: { target: 'github', findingIds: ['UIA-001', 'UIA-002', 'UIA-003'], previewToken: p2.previewToken } })).json();
    expect(c2.created).toHaveLength(1);
    expect(c2.skipped).toHaveLength(2);
    expect(fetchFake.calls).toHaveLength(3);
  });

  it('creates Jira issues with basic auth and uploads screenshots as attachments', async () => {
    const id = await startAudit();
    const p = (await app.inject({ method: 'POST', url: `/api/audits/${id}/export/preview`, payload: { target: 'jira', findingIds: ['UIA-001'] } })).json();
    const result = (await app.inject({ method: 'POST', url: `/api/audits/${id}/export/confirm`, payload: { target: 'jira', findingIds: ['UIA-001'], previewToken: p.previewToken } })).json();
    expect(result.errors).toEqual([]);
    expect(result.created).toEqual([{ findingId: 'UIA-001', key: 'QA-1', url: 'https://jira.fake/browse/QA-1' }]);
    const [create, ...attach] = fetchFake.calls;
    expect(create.url).toBe('https://jira.fake/rest/api/3/issue');
    expect(create.headers.Authorization).toBe(`Basic ${Buffer.from('qa@example.test:jira-fake-token').toString('base64')}`);
    const body = JSON.parse(String(create.body));
    expect(body.fields.priority).toEqual({ name: 'Highest' });
    expect(body.fields.description.type).toBe('doc');
    expect(attach).toHaveLength(2);
    expect(attach[0].url).toBe('https://jira.fake/rest/api/3/issue/QA-1/attachments');
    expect(attach[0].headers['X-Atlassian-Token']).toBe('no-check');
    expect(attach[0].body).toBeInstanceOf(FormData);

    const p2 = (await app.inject({ method: 'POST', url: `/api/audits/${id}/export/preview`, payload: { target: 'jira', findingIds: ['UIA-001'] } })).json();
    expect(p2.items).toHaveLength(0);
    expect(p2.skipped[0].reason).toContain('QA-1');
  });

  it('returns per-item errors with secrets scrubbed', async () => {
    const failing = (async () => new Response(`bad token ${ENV.GITHUB_TOKEN}`, { status: 401 })) as typeof fetch;
    const app2 = buildServer({ reportsDir, runAudit: engine, fetchImpl: failing, env: { ...ENV }, webDist: join(reportsDir, 'no-dist') });
    try {
      const id = await startAudit();
      const p = (await app2.inject({ method: 'POST', url: `/api/audits/${id}/export/preview`, payload: { target: 'github', findingIds: ['UIA-002'] } })).json();
      const r = (await app2.inject({ method: 'POST', url: `/api/audits/${id}/export/confirm`, payload: { target: 'github', findingIds: ['UIA-002'], previewToken: p.previewToken } })).json();
      expect(r.created).toEqual([]);
      expect(r.errors[0].error).toContain('401');
      expect(r.errors[0].error).not.toContain(ENV.GITHUB_TOKEN);
    } finally {
      await app2.close();
    }
  });

  it('refuses preview for an unconfigured target', async () => {
    const app3 = buildServer({ reportsDir, runAudit: engine, fetchImpl: fetchFake, env: {}, webDist: join(reportsDir, 'no-dist') });
    try {
      const id = await startAudit();
      const res = await app3.inject({ method: 'POST', url: `/api/audits/${id}/export/preview`, payload: { target: 'jira', findingIds: ['UIA-001'] } });
      expect(res.statusCode).toBe(400);
      expect((await app3.inject({ method: 'GET', url: '/api/config' })).json()).toEqual({ targets: { github: false, jira: false } });
    } finally {
      await app3.close();
    }
  });

  it('refuses non-local hosts and cross-origin writes', async () => {
    const rebound = await app.inject({ method: 'GET', url: '/api/audits', headers: { host: 'evil.example:3000' } });
    expect(rebound.statusCode).toBe(403);
    const cross = await app.inject({
      method: 'POST',
      url: '/api/audits',
      headers: { host: 'localhost:3000', origin: 'https://evil.example' },
      payload: { options: { url: 'https://example.test' } },
    });
    expect(cross.statusCode).toBe(403);
    const same = await app.inject({
      method: 'POST',
      url: '/api/audits',
      headers: { host: 'localhost:3000', origin: 'http://localhost:3000' },
      payload: { options: { url: 'https://example.test' } },
    });
    expect(same.statusCode).toBe(202);
  });
});
