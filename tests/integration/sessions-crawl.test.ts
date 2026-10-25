// Saved-session flow against the fixture site: the access check sees the sign-in form, and an
// audit with a saved session reaches the login-only page.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { copyFileSync, existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { chromium } from 'playwright';
import { startFixtures, FIXTURE_LOGIN } from '../../fixtures/serve.js';
import { checkAccess } from '../../src/sessions/browser.js';
import { performLogin } from '../../src/crawler/login.js';
import { crawl } from '../../src/crawler/crawl.js';
import { AuditOptions } from '../../src/core/types.js';
import { runAudit } from '../../src/engine/runAudit.js';

describe('saved sessions', () => {
  let fixtures: Awaited<ReturnType<typeof startFixtures>>;
  const dir = mkdtempSync(join(tmpdir(), 'uia-session-crawl-'));
  let statePath: string;

  beforeAll(async () => {
    fixtures = await startFixtures();
    // Stand-in for the user signing in through the Web UI window: produce a storage state.
    const browser = await chromium.launch();
    try {
      ({ statePath } = await performLogin(
        browser,
        { loginUrl: `${fixtures.realEstateUrl}/login`, successUrlContains: '/account' },
        { username: FIXTURE_LOGIN.username, password: FIXTURE_LOGIN.password },
        join(dir, 'login'),
      ));
    } finally {
      await browser.close();
    }
  }, 120_000);

  afterAll(async () => {
    await fixtures?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('checkAccess sees the sign-in form without a session and not with one', async () => {
    const account = `${fixtures.realEstateUrl}/account`;
    expect(await checkAccess(account)).toEqual({ needsSignIn: true });
    expect(await checkAccess(account, statePath)).toEqual({ needsSignIn: false });
    expect(await checkAccess(`${fixtures.realEstateUrl}/about`)).toEqual({ needsSignIn: false });
  }, 120_000);

  it('crawls the login-only page with a saved session and no credentials', async () => {
    const options = AuditOptions.parse({ url: `${fixtures.realEstateUrl}/account`, depth: 0, maxPages: 1, viewports: ['desktop'], lighthouse: false, rateLimitMs: 0 });
    const bundle = await crawl({ options, runDir: join(dir, 'run'), sessionStatePath: statePath });
    expect(bundle.loginUsed).toBe(true);
    const page = bundle.pages.find((p) => p.url.includes('/account'));
    expect(page?.requiresLogin).toBe(true);
    expect(page?.images.some((i) => i.selector.includes('account-agent-avatar'))).toBe(true);
  }, 180_000);

  it('writes the refreshed session back after a signed-in crawl', async () => {
    const saved = join(dir, 'saved-state.json');
    copyFileSync(statePath, saved);
    const before = statSync(saved).mtimeMs;
    await new Promise((r) => setTimeout(r, 50));
    const options = AuditOptions.parse({ url: `${fixtures.realEstateUrl}/account`, depth: 0, maxPages: 1, viewports: ['desktop', 'mobile'], lighthouse: false, rateLimitMs: 0 });
    const bundle = await crawl({ options, runDir: join(dir, 'run-writeback'), sessionStatePath: saved });
    expect(bundle.signInLost).toBe(false);
    expect(statSync(saved).mtimeMs).toBeGreaterThan(before);
  }, 180_000);

  it('stops with a clear message and forgets an expired saved session', async () => {
    const expired = join(dir, 'expired-state.json');
    writeFileSync(expired, JSON.stringify({ cookies: [], origins: [] }));
    const options = AuditOptions.parse({ url: `${fixtures.realEstateUrl}/account`, depth: 0, maxPages: 1, viewports: ['desktop'], lighthouse: false, rateLimitMs: 0 });
    await expect(runAudit({ options, sessionStatePath: expired, reportsDir: join(dir, 'reports'), llm: null })).rejects.toThrow(/sign-in .* has expired/);
    expect(existsSync(expired)).toBe(false);
  }, 180_000);

  it('keeps tablet and mobile signed in when the app rotates its session token on every view', async () => {
    const rotating = await startFixtures({ rotateSessions: true });
    try {
      const browser = await chromium.launch();
      let saved: string;
      try {
        ({ statePath: saved } = await performLogin(
          browser,
          { loginUrl: `${rotating.realEstateUrl}/login`, successUrlContains: '/account' },
          { username: FIXTURE_LOGIN.username, password: FIXTURE_LOGIN.password },
          join(dir, 'rot-login'),
        ));
      } finally {
        await browser.close();
      }
      const url = `${rotating.realEstateUrl}/account`;
      const options = AuditOptions.parse({ url, depth: 0, maxPages: 1, viewports: ['desktop', 'tablet', 'mobile'], lighthouse: false, rateLimitMs: 0 });
      const first = await crawl({ options, runDir: join(dir, 'rot-1'), sessionStatePath: saved });
      expect(first.signInLost).toBe(false);
      expect(first.errors.filter((e) => /sign-in form/.test(e))).toEqual([]);
      // The saved copy was refreshed, so a second audit is still signed in.
      const second = await crawl({ options, runDir: join(dir, 'rot-2'), sessionStatePath: saved });
      expect(second.signInLost).toBe(false);
      expect(second.pages[0]?.url).toContain('/account');
    } finally {
      await rotating.close();
    }
  }, 300_000);
});
