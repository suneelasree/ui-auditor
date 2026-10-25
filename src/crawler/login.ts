// Optional login step. Credentials are only typed into the page; they are never
// logged, screenshotted or written to disk. Only the resulting storage state
// (cookies/localStorage) is saved, under <runDir>/.auth, which the engine deletes.
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Browser, Locator, Page } from 'playwright';
import type { Credentials, LoginConfig } from '../core/types.js';

export interface LoginResult {
  /** Absolute path of the saved Playwright storage state */
  statePath: string;
  /** URL the browser landed on after a successful login */
  landingUrl: string;
}

const USERNAME_CANDIDATES = [
  'input[type=email]',
  'input[autocomplete=username]',
  'input[name*=user i]',
  'input[id*=user i]',
  'input[name*=email i]',
  'input[name*=login i]',
  'input[type=text]',
];

async function firstVisible(page: Page, selectors: string[]): Promise<Locator | null> {
  for (const sel of selectors) {
    const loc = page.locator(sel);
    const n = await loc.count();
    for (let i = 0; i < n; i++) {
      if (await loc.nth(i).isVisible().catch(() => false)) return loc.nth(i);
    }
  }
  return null;
}

const CHOICE_ROLES = ['option', 'radio', 'menuitem', 'button', 'link', 'listitem', 'row', 'gridcell'] as const;

/**
 * Picks one post-login choice (e.g. a tenant): a matching <select> option, a CSS selector,
 * or a clickable element whose text matches — exact match first, then "contains".
 */
async function choose(page: Page, choice: string): Promise<void> {
  const want = choice.trim().toLowerCase();
  const escaped = choice.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const exact = new RegExp(`^\\s*${escaped}\\s*$`, 'i');
  const contains = new RegExp(escaped, 'i');
  const deadline = Date.now() + 20_000;

  while (Date.now() < deadline) {
    const selects = page.locator('select').filter({ visible: true });
    for (let i = 0; i < (await selects.count()); i++) {
      const labels = (await selects.nth(i).locator('option').allInnerTexts()).map((s) => s.trim());
      const label = labels.find((l) => l.toLowerCase() === want) ?? labels.find((l) => l.toLowerCase().includes(want));
      if (label) {
        await selects.nth(i).selectOption({ label });
        return;
      }
    }
    if (/^[#.[]/.test(choice.trim())) {
      const css = page.locator(choice.trim()).filter({ visible: true }).first();
      if ((await css.count()) > 0) return css.click();
    }
    for (const name of [exact, contains]) {
      for (const role of CHOICE_ROLES) {
        const el = page.getByRole(role, { name }).filter({ visible: true }).first();
        if ((await el.count()) > 0) return el.click();
      }
    }
    const text = page.getByText(exact).filter({ visible: true }).first();
    if ((await text.count()) > 0) return text.click();
    await page.waitForTimeout(300);
  }
  throw new Error(`Login failed: could not find "${choice}" to choose after login`);
}

async function waitForSuccess(page: Page, login: LoginConfig): Promise<void> {
  const timeout = 30_000;
  if (login.successUrlContains) {
    const want = login.successUrlContains;
    await page.waitForURL((u) => u.toString().includes(want), { timeout }).catch(() => {
      throw new Error('Login failed: success URL check did not pass');
    });
  } else if (login.successSelector) {
    await page.locator(login.successSelector).first().waitFor({ state: 'visible', timeout }).catch(() => {
      throw new Error('Login failed: success element did not appear');
    });
  } else {
    const deadline = Date.now() + timeout;
    while ((await page.locator('input[type=password]').filter({ visible: true }).count()) > 0) {
      if (Date.now() > deadline) throw new Error('Login failed: password field still present after submit');
      await page.waitForTimeout(250);
    }
  }
}

/** What the page showed when login failed: visible error text and a screenshot with password fields masked. */
async function describeFailure(page: Page, runDir: string): Promise<string> {
  const texts = await page
    .locator('[role=alert], [aria-live=assertive], [class*=error i], [class*=invalid i]')
    .filter({ visible: true })
    .allInnerTexts()
    .catch(() => [] as string[]);
  const message = [...new Set(texts.map((t) => t.trim()).filter(Boolean))].join(' | ').slice(0, 300);
  const shot = 'evidence/login-failed.png';
  mkdirSync(join(runDir, 'evidence'), { recursive: true });
  const saved = await page
    .screenshot({ path: join(runDir, shot), mask: [page.locator('input[type=password]')] })
    .then(() => true)
    .catch(() => false);
  return (message ? `. Page says: "${message}"` : '. No error message was visible') + (saved ? `. Screenshot: ${shot}` : '');
}

export async function performLogin(
  browser: Browser,
  login: LoginConfig,
  creds: Credentials,
  runDir: string,
): Promise<LoginResult> {
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  try {
    const page = await context.newPage();
    await page.goto(login.loginUrl, { waitUntil: 'load', timeout: 30_000 });
    // Single-page apps render the sign-in form after load; give it time to appear.
    await page
      .locator(login.passwordSelector ?? 'input[type=password]')
      .filter({ visible: true })
      .first()
      .waitFor({ state: 'visible', timeout: 20_000 })
      .catch(() => undefined);

    const user = await firstVisible(page, login.usernameSelector ? [login.usernameSelector] : USERNAME_CANDIDATES);
    const pass = await firstVisible(page, [login.passwordSelector ?? 'input[type=password]']);
    if (!pass) throw new Error('Login failed: no password field found on the login page');
    if (user) await user.fill(creds.username);
    await pass.fill(creds.password);

    let submit: Locator | null = null;
    if (login.submitSelector) submit = page.locator(login.submitSelector).first();
    else {
      const inForm = pass.locator('xpath=ancestor::form[1]').locator('button[type=submit], input[type=submit], button:not([type])');
      if ((await inForm.count()) > 0) submit = inForm.first();
    }
    if (submit) await submit.click({ timeout: 10_000 });
    else await pass.press('Enter');
    await page.waitForLoadState('load', { timeout: 30_000 }).catch(() => undefined);

    try {
      if (login.afterLoginChoose?.length) {
        await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => undefined);
        for (const choice of login.afterLoginChoose) await choose(page, choice);
        // Some apps (e.g. a tenant picker that appears on the sign-in form itself) need the
        // sign-in button pressed again after the choice. Only resubmit if the form is still there.
        await page.waitForTimeout(500);
        if (await pass.isVisible().catch(() => false)) {
          if (submit && (await submit.isVisible().catch(() => false))) await submit.click({ timeout: 10_000 });
          else await pass.press('Enter');
          await page.waitForLoadState('load', { timeout: 30_000 }).catch(() => undefined);
        }
      }
      await waitForSuccess(page, login);
    } catch (err) {
      throw new Error(`${(err as Error).message}${await describeFailure(page, runDir)}`, { cause: err });
    }

    // Let the app finish post-login requests so session cookies are set before saving them.
    await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => undefined);

    const dir = join(runDir, '.auth');
    mkdirSync(dir, { recursive: true });
    const statePath = join(dir, 'state.json');
    await context.storageState({ path: statePath });
    return { statePath, landingUrl: page.url() };
  } finally {
    await context.close();
  }
}
