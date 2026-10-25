import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { FastifyInstance } from 'fastify';
import { SessionStore, originOf } from '../../src/sessions/store.js';
import { SignInManager } from '../../src/sessions/signin.js';
import type { SignInWindow } from '../../src/sessions/browser.js';
import { buildServer } from '../../src/server/app.js';
import { createFakeRunAudit } from '../e2e/fake-engine.js';

/** A fake sign-in window the test controls: call signIn() or closeWindow(). */
function fakeWindow() {
  let resolveSignedIn: () => void = () => {};
  let rejectSignedIn: (e: Error) => void = () => {};
  const closedCbs: (() => void)[] = [];
  const win: SignInWindow & { signIn(): void; closeWindow(): void; closed: boolean } = {
    closed: false,
    waitForSignedIn: () => new Promise<void>((res, rej) => ((resolveSignedIn = res), (rejectSignedIn = rej))),
    saveState: async (path) => writeFileSync(path, JSON.stringify({ cookies: [{ name: 'sid', value: 'abc' }], origins: [] })),
    close: async () => {
      win.closed = true;
    },
    onClosed: (cb) => closedCbs.push(cb),
    signIn: () => resolveSignedIn(),
    closeWindow: () => {
      win.closed = true;
      closedCbs.forEach((cb) => cb());
      rejectSignedIn(new Error('closed'));
    },
  };
  return win;
}

const tick = () => new Promise((r) => setTimeout(r, 20));

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'uia-sessions-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('SessionStore', () => {
  it('saves, finds, lists and forgets sessions per origin', () => {
    const store = new SessionStore(join(dir, 's'));
    expect(store.find('https://app.example.com/x?y=1')).toBeUndefined();
    writeFileSync(store.prepare('https://app.example.com'), '{}');
    expect(store.find('https://app.example.com/other')).toBeTruthy();
    expect(store.find('https://other.example.com/')).toBeUndefined();
    expect(store.list().map((s) => s.origin)).toEqual(['https://app.example.com']);
    expect(store.forget('https://app.example.com')).toBe(true);
    expect(store.list()).toEqual([]);
    expect(originOf('javascript:alert(1)')).toBeNull();
  });
});

describe('SignInManager', () => {
  it('saves the session once the user signs in and closes the window', async () => {
    const store = new SessionStore(dir);
    const win = fakeWindow();
    const mgr = new SignInManager(store, async () => win);
    const { id } = await mgr.start('https://app.example.com/page');
    expect(mgr.get(id)?.status).toBe('waiting');
    await expect(mgr.start('https://app.example.com/page')).rejects.toMatchObject({ running: id });
    win.signIn();
    await tick();
    expect(mgr.get(id)).toMatchObject({ status: 'saved', origin: 'https://app.example.com' });
    expect(win.closed).toBe(true);
    expect(store.find('https://app.example.com/')).toBeTruthy();
  });

  it('reports cancelled when the user closes the window, and supports "I\'m signed in"', async () => {
    const store = new SessionStore(dir);
    const first = fakeWindow();
    const second = fakeWindow();
    const wins = [first, second];
    const mgr = new SignInManager(store, async () => wins.shift()!);
    const a = await mgr.start('https://a.example.com/');
    first.closeWindow();
    await tick();
    expect(mgr.get(a.id)?.status).toBe('cancelled');
    expect(store.find('https://a.example.com/')).toBeUndefined();

    const b = await mgr.start('https://a.example.com/');
    expect((await mgr.done(b.id))?.status).toBe('saved');
    expect(store.find('https://a.example.com/')).toBeTruthy();
  });
});

describe('sign-in API', () => {
  let app: FastifyInstance;
  let win: ReturnType<typeof fakeWindow>;
  let engine: ReturnType<typeof createFakeRunAudit>;
  const sessionsDir = () => join(dir, 'sessions');

  beforeEach(() => {
    win = fakeWindow();
    engine = createFakeRunAudit();
    app = buildServer({
      reportsDir: join(dir, 'reports'),
      sessionsDir: sessionsDir(),
      runAudit: engine,
      webDist: join(dir, 'no-dist'),
      env: {},
      checkAccess: async (url, sessionPath) => ({ needsSignIn: url.includes('needs-login') && !sessionPath }),
      signInLauncher: async () => win,
    });
  });
  afterEach(() => app.close());

  it('checks access, signs in, then audits with the saved session; Forget removes it', async () => {
    const url = 'https://app.example.com/needs-login?id=1';
    let check = (await app.inject({ method: 'POST', url: '/api/check', payload: { url } })).json();
    expect(check).toEqual({ origin: 'https://app.example.com', needsSignIn: true, hasSession: false });

    const { id } = (await app.inject({ method: 'POST', url: '/api/signin', payload: { url } })).json();
    expect((await app.inject({ method: 'GET', url: `/api/signin/${id}` })).json().status).toBe('waiting');
    win.signIn();
    await tick();
    expect((await app.inject({ method: 'GET', url: `/api/signin/${id}` })).json().status).toBe('saved');

    check = (await app.inject({ method: 'POST', url: '/api/check', payload: { url } })).json();
    expect(check).toMatchObject({ needsSignIn: false, hasSession: true });
    expect((await app.inject({ method: 'GET', url: '/api/sessions' })).json().sessions).toHaveLength(1);

    const start = await app.inject({ method: 'POST', url: '/api/audits', payload: { options: { url, depth: 0, maxPages: 1 } } });
    expect(start.json()).toMatchObject({ usedSession: true });

    const forget = await app.inject({ method: 'DELETE', url: `/api/sessions?origin=${encodeURIComponent('https://app.example.com')}` });
    expect(forget.json()).toEqual({ ok: true });
    expect(existsSync(join(sessionsDir(), 'https_app.example.com.json'))).toBe(false);
  });

  it('rejects non-http URLs and unknown sign-in ids', async () => {
    expect((await app.inject({ method: 'POST', url: '/api/check', payload: { url: 'file:///etc/passwd' } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/api/signin', payload: { url: 'javascript:alert(1)' } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'GET', url: '/api/signin/si_nope' })).statusCode).toBe(404);
  });
});
