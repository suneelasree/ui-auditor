// Real-browser helpers for the Web UI sign-in flow. The server takes these as injectable
// functions so tests can swap in fakes without opening windows.
import { chromium, type Page } from 'playwright';

const PASSWORD = 'input[type=password]';

async function passwordVisible(page: Page): Promise<boolean> {
  return (await page.locator(PASSWORD).filter({ visible: true }).count().catch(() => 0)) > 0;
}

/**
 * Does this page show a sign-in form? Loads it headlessly (with a saved session when given) and
 * waits a little, because single-page apps draw their sign-in form after the page loads.
 */
export async function checkAccess(url: string, sessionPath?: string): Promise<{ needsSignIn: boolean }> {
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ ignoreHTTPSErrors: true, storageState: sessionPath });
    const page = await context.newPage();
    await page.goto(url, { waitUntil: 'load', timeout: 45_000 });
    await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => undefined);
    const deadline = Date.now() + 6_000;
    while (Date.now() < deadline) {
      if (await passwordVisible(page)) return { needsSignIn: true };
      await page.waitForTimeout(400);
    }
    // Loading the page may have refreshed a rotating session token; keep the saved copy current.
    if (sessionPath) await context.storageState({ path: sessionPath }).catch(() => undefined);
    return { needsSignIn: false };
  } finally {
    await browser.close();
  }
}

export interface SignInWindow {
  /** Resolves once the user appears to be signed in (a sign-in form was shown and is now gone). */
  waitForSignedIn(): Promise<void>;
  saveState(path: string): Promise<void>;
  close(): Promise<void>;
  onClosed(cb: () => void): void;
}

/** Opens a visible browser window at the URL so the user can sign in themselves (password, SSO, MFA, tenant...). */
export async function openSignInWindow(url: string): Promise<SignInWindow> {
  const browser = await chromium.launch({ headless: false, args: ['--window-size=1200,860'] });
  const context = await browser.newContext({ viewport: null, ignoreHTTPSErrors: true });
  const page = await context.newPage();
  const closedCbs: (() => void)[] = [];
  let closed = false;
  const markClosed = () => {
    if (closed) return;
    closed = true;
    closedCbs.forEach((cb) => cb());
  };
  browser.on('disconnected', markClosed);
  page.on('close', markClosed);
  await page.goto(url, { waitUntil: 'load', timeout: 45_000 }).catch(() => undefined);

  return {
    async waitForSignedIn() {
      // Signed in = we have seen a sign-in form, and now no password field has been visible for ~3s.
      let seenForm = false;
      let clearSince = 0;
      while (!closed) {
        const active = context.pages().at(-1) ?? page;
        const visible = await passwordVisible(active);
        if (visible) {
          seenForm = true;
          clearSince = 0;
        } else if (seenForm) {
          clearSince ||= Date.now();
          if (Date.now() - clearSince >= 3_000) {
            await active.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => undefined);
            return;
          }
        }
        await new Promise((r) => setTimeout(r, 700));
      }
      throw new Error('The sign-in window was closed');
    },
    async saveState(path) {
      await context.storageState({ path });
    },
    async close() {
      await browser.close().catch(() => undefined);
    },
    onClosed(cb) {
      if (closed) cb();
      else closedCbs.push(cb);
    },
  };
}
