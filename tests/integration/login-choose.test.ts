// Login with a post-login tenant picker (common in multi-tenant apps): sign in, then choose a tenant.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { chromium, type Browser } from 'playwright';
import { performLogin } from '../../src/crawler/login.js';

const PAGE = (body: string) => `<!doctype html><html><body>${body}</body></html>`;
const LOGIN = PAGE(`<div id="app"></div><script>
  // Render the form late, like a single-page app.
  setTimeout(() => { document.getElementById('app').innerHTML =
    '<form method="post" action="/login"><input type="email" name="email"><input type="password" name="password"><button type="submit">Launch Workspace</button></form>'; }, 800);
</script>`);
// Inline tenant picker: the first submit reveals a tenant <select> on the same form; a second submit signs in.
const INLINE = PAGE(`<form id="f" method="post" action="/login-inline">
  <input type="email" name="email"><input type="password" name="password">
  <div id="tenant" hidden><label>Select Tenant to Impersonate <select name="tenant"><option value="">Choose…</option><option value="acme">Acme</option><option value="northwind">Northwind</option></select></label></div>
  <button type="submit">Launch Workspace</button></form>
  <script>document.getElementById('f').addEventListener('submit', (e) => {
    const t = document.getElementById('tenant');
    if (t.hidden) { e.preventDefault(); t.hidden = false; }
  });</script>`);
const TENANTS = PAGE(`<h1>Workspace</h1><p>Select a tenant</p>
  <button onclick="location='/pick?t=acme'">Acme Corp</button>
  <button onclick="location='/pick?t=northwind'">Northwind</button>`);

describe('login with a tenant picker', () => {
  let server: Server;
  let base: string;
  let browser: Browser;
  const runDir = mkdtempSync(join(tmpdir(), 'uia-login-choose-'));

  beforeAll(async () => {
    server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://x');
      if (url.pathname === '/inline') {
        res.writeHead(200, { 'content-type': 'text/html' }).end(INLINE);
        return;
      }
      if (req.method === 'POST' && url.pathname === '/login-inline') {
        let body = '';
        req.on('data', (c) => (body += c));
        req.on('end', () => {
          const tenant = new URLSearchParams(body).get('tenant');
          if (tenant) res.writeHead(302, { location: '/home', 'set-cookie': `tenant=${tenant}; Path=/` }).end();
          else res.writeHead(302, { location: '/inline' }).end();
        });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/login') {
        res.writeHead(302, { location: '/tenants', 'set-cookie': 'pre=1; Path=/' }).end();
      } else if (url.pathname === '/tenants') {
        res.writeHead(200, { 'content-type': 'text/html' }).end(TENANTS);
      } else if (url.pathname === '/pick') {
        res.writeHead(302, { location: '/home', 'set-cookie': `tenant=${url.searchParams.get('t')}; Path=/` }).end();
      } else if (url.pathname === '/home') {
        res.writeHead(200, { 'content-type': 'text/html' }).end(PAGE('<h1>Dashboard</h1>'));
      } else {
        res.writeHead(200, { 'content-type': 'text/html' }).end(LOGIN);
      }
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const addr = server.address();
    base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
    browser = await chromium.launch();
  });

  afterAll(async () => {
    await browser?.close();
    server?.close();
    rmSync(runDir, { recursive: true, force: true });
  });

  it('waits for the late form, signs in, picks the named tenant and saves the session', async () => {
    const result = await performLogin(
      browser,
      { loginUrl: `${base}/`, afterLoginChoose: ['Northwind'], successUrlContains: '/home' },
      { username: 'qa@example.test', password: 'Not-A-Real-Pass-1' },
      runDir,
    );
    expect(result.landingUrl).toContain('/home');
    const state = readFileSync(result.statePath, 'utf8');
    expect(state).toMatch(/"value": ?"northwind"/);
    expect(state).not.toContain('Not-A-Real-Pass-1');
  });

  it('handles a tenant picker on the sign-in form itself by submitting again', async () => {
    const result = await performLogin(
      browser,
      { loginUrl: `${base}/inline`, afterLoginChoose: ['Northwind'] },
      { username: 'qa@example.test', password: 'Not-A-Real-Pass-1' },
      runDir,
    );
    expect(result.landingUrl).toContain('/home');
    expect(readFileSync(result.statePath, 'utf8')).toMatch(/"value": ?"northwind"/);
  });

  it('explains what the page showed when the choice is missing', async () => {
    await expect(
      performLogin(
        browser,
        { loginUrl: `${base}/`, afterLoginChoose: ['No Such Tenant'] },
        { username: 'qa@example.test', password: 'Not-A-Real-Pass-1' },
        runDir,
      ),
    ).rejects.toThrow(/could not find "No Such Tenant".*Screenshot: evidence\/login-failed\.png/);
    expect(existsSync(join(runDir, 'evidence', 'login-failed.png'))).toBe(true);
  }, 60_000);
});
