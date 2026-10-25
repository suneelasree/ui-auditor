// Starts the real Web UI server with a FAKE engine and a fake GitHub API, for Playwright e2e tests.
import { execSync } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { AddressInfo } from 'node:net';
import { buildServer } from '../../src/server/app.js';
import { createFakeRunAudit } from './fake-engine.js';

const repoRoot = resolve(import.meta.dirname, '../..');
const port = Number(process.env.UIA_E2E_PORT) || 3199;

if (!process.env.UIA_E2E_SKIP_BUILD) {
  execSync('npm run build:web', { cwd: repoRoot, stdio: 'inherit' });
}

// Tiny fake GitHub: POST /repos/o/r/issues -> 201
let issueNo = 0;
const fakeGithub = createServer((req, res) => {
  req.resume();
  req.on('end', () => {
    if (req.method === 'POST' && req.url === '/repos/o/r/issues' && req.headers.authorization === 'Bearer fake') {
      issueNo++;
      const { port: p } = fakeGithub.address() as AddressInfo;
      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ number: issueNo, html_url: `http://127.0.0.1:${p}/o/r/issues/${issueNo}` }));
      return;
    }
    res.writeHead(404).end('not found');
  });
});
await new Promise<void>((r) => fakeGithub.listen(0, '127.0.0.1', () => r()));
const ghPort = (fakeGithub.address() as AddressInfo).port;

const reportsDir = mkdtempSync(join(tmpdir(), 'uia-e2e-'));
const env = { GITHUB_TOKEN: 'fake', GITHUB_REPO: 'o/r', GITHUB_API_URL: `http://127.0.0.1:${ghPort}` };
const sessionsDir = mkdtempSync(join(tmpdir(), 'uia-e2e-sessions-'));

// Fake sign-in, no real browser: any URL containing "needs-login" needs a sign-in until a session is saved.
const checkAccess = async (url: string, sessionPath?: string) => ({
  needsSignIn: url.includes('needs-login') && !(sessionPath && existsSync(sessionPath)),
});
const signInLauncher = async (_url: string) => {
  let closed = false;
  const closeCbs: (() => void)[] = [];
  return {
    waitForSignedIn: () =>
      new Promise<void>((res, rej) =>
        setTimeout(() => (closed ? rej(new Error('closed')) : res()), 1500),
      ),
    saveState: async (path: string) => {
      mkdirSync(join(path, '..'), { recursive: true });
      writeFileSync(path, JSON.stringify({ cookies: [], origins: [] }));
    },
    close: async () => {
      if (closed) return;
      closed = true;
      closeCbs.forEach((cb) => cb());
    },
    onClosed: (cb: () => void) => {
      closeCbs.push(cb);
    },
  };
};
const app = buildServer({ reportsDir, runAudit: createFakeRunAudit({ delayMs: 250 }), env, checkAccess, signInLauncher, sessionsDir });
await app.listen({ port, host: '127.0.0.1' });
console.log(`e2e server on http://127.0.0.1:${port} (reports ${reportsDir}, fake GitHub :${ghPort})`);

const shutdown = async () => {
  await app.close();
  fakeGithub.close();
  rmSync(reportsDir, { recursive: true, force: true });
  rmSync(sessionsDir, { recursive: true, force: true });
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
