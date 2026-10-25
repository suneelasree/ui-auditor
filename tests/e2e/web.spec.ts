import { expect, test } from '@playwright/test';

test('@desktop audit a public page, watch progress, read the report, export to GitHub', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Find UX, accessibility, performance and functional issues');
  await expect(page.getByTestId('more-options')).toHaveAttribute('aria-expanded', 'false');
  // No login fields anywhere in the Web UI.
  await expect(page.locator('input[type="password"]')).toHaveCount(0);

  // Scope heuristic: deep links default to "This page", plain sites to "Whole site".
  await page.getByTestId('url-input').fill('https://example.test/app?tab=1');
  await expect(page.getByTestId('scope-page')).toBeChecked();
  await page.getByTestId('url-input').fill('https://example.test');
  await expect(page.getByTestId('scope-site')).toBeChecked();

  await page.getByTestId('start-audit').click();

  // Progress page
  await expect(page).toHaveURL(/#\/runs\/[A-Za-z0-9-]+$/);
  await expect(page.getByTestId('progress-view')).toBeVisible();
  await expect(page.getByTestId('stage-crawl')).toBeVisible();
  await expect(page.getByTestId('stage-login')).toHaveCount(0);
  await expect(page.getByTestId('stage-competitors')).toHaveCount(0);
  await page.getByTestId('show-log').click();
  await expect(page.getByTestId('progress-log')).toContainText('Crawling https://example.test');

  // Straight to the report when done
  await expect(page.getByTestId('report-view')).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId('report-score')).toContainText('72');
  await expect(page.getByTestId('severity-counts')).toContainText('1 Critical');
  await expect(page.getByTestId('top-issue')).toHaveCount(4);
  await expect(page.getByTestId('top-issue').first()).toContainText('Primary "Search Homes" button hidden on mobile');
  await expect(page.getByTestId('open-report')).toHaveAttribute('target', '_blank');

  // Full report tab
  await page.getByTestId('tab-report').click();
  await expect(page.getByTestId('report-iframe')).toBeVisible();
  await expect(page.frameLocator('[data-testid="report-iframe"]').getByTestId('report-title')).toContainText('example.test');
  await page.getByTestId('tab-findings').click();

  // Findings selection + severity filter
  await expect(page.getByTestId('finding-row')).toHaveCount(4);
  await page.getByTestId('filter-Critical').click();
  await expect(page.getByTestId('finding-row')).toHaveCount(1);
  await page.getByTestId('filter-all').click();
  await page.getByTestId('finding-check-UIA-001').check();
  await page.getByTestId('finding-check-UIA-002').check();
  await expect(page.getByTestId('export-button')).toHaveText('Export (2)');

  // Export preview: nothing sent yet
  await page.getByTestId('export-button').click();
  await expect(page.getByTestId('export-modal')).toBeVisible();
  await expect(page.getByTestId('target-github')).toBeChecked();
  await expect(page.getByTestId('target-jira')).toBeDisabled();
  await page.getByTestId('export-preview-button').click();
  const preview = page.getByTestId('export-preview');
  await expect(preview).toBeVisible();
  await expect(page.getByTestId('preview-item')).toHaveCount(2);
  await expect(preview).toContainText('[UIA-001][Critical] Primary "Search Homes" button hidden on mobile');
  await expect(preview).toContainText('ui-auditor');
  await expect(preview).toContainText('evidence/p1-mobile-el1.png');
  await expect(preview).toContainText('Nothing has been sent yet.');

  // Confirm
  await page.getByTestId('export-confirm').click();
  await expect(page.getByTestId('export-result')).toBeVisible();
  const links = page.getByTestId('created-issue-link');
  await expect(links).toHaveCount(2);
  await expect(links.first()).toHaveText('#1');
  await expect(links.first()).toHaveAttribute('href', /\/o\/r\/issues\/1$/);
  await page.getByTestId('export-done').click();

  // Exported badge, and re-export is skipped
  await expect(page.getByTestId('exported-UIA-001')).toContainText('GitHub #1');
  await page.getByTestId('finding-check-UIA-001').check();
  await page.getByTestId('export-button').click();
  await page.getByTestId('export-preview-button').click();
  await expect(page.getByTestId('preview-skipped')).toContainText('Already exported as #1');
  await expect(page.getByTestId('export-confirm')).toBeDisabled();
  await page.getByTestId('export-close').click();

  // History
  await page.getByTestId('nav-history').click();
  await expect(page.getByTestId('run-row').first()).toContainText('example.test');
});

test('@desktop page behind a sign-in: sign in, audit, then forget the session', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('url-input').fill('https://needs-login.example.test/dashboard');
  await page.getByTestId('start-audit').click();

  const card = page.getByTestId('signin-card');
  await expect(card).toBeVisible({ timeout: 25_000 });
  await expect(card).toContainText('This page needs you to sign in');
  await expect(card).toContainText('your password never touches UI Auditor');
  await expect(page.getByTestId('audit-signin-page')).toBeVisible();

  await page.getByTestId('signin-start').click();
  await expect(page.getByTestId('signin-waiting')).toContainText('Finish signing in in the window that opened');
  await expect(page.getByTestId('signin-done')).toBeVisible();

  // The fake window "signs in" after ~1.5 s; the audit then starts by itself.
  await expect(page).toHaveURL(/#\/runs\/[A-Za-z0-9-]+$/, { timeout: 15_000 });
  await expect(page.getByTestId('stage-login')).toBeVisible();
  await expect(page.getByTestId('report-view')).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId('report-score')).toContainText('72');

  // Home shows the saved session; Forget removes it.
  await page.getByTestId('nav-new').click();
  const chip = page.getByTestId('session-chip');
  await expect(chip).toHaveCount(1);
  await expect(chip).toContainText('needs-login.example.test');
  await chip.getByTestId('session-forget').click();
  await expect(page.getByTestId('session-chip')).toHaveCount(0);
});

test('@desktop shows a friendly error for an invalid URL', async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('url-input').fill('not a url');
  await page.getByTestId('start-audit').click();
  await expect(page.getByTestId('form-error')).toContainText('Enter a web address');

  await page.getByTestId('url-input').fill('https://example.test');
  await page.getByTestId('more-options').click();
  await page.getByTestId('viewport-desktop').uncheck();
  await page.getByTestId('viewport-tablet').uncheck();
  await page.getByTestId('viewport-mobile').uncheck();
  await page.getByTestId('start-audit').click();
  await expect(page.getByTestId('form-error')).toContainText('viewport');
});

test('@mobile home works at 375px without horizontal scroll', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('url-input')).toBeVisible();
  await expect(page.getByTestId('start-audit')).toBeVisible();
  await expect(page.getByTestId('start-audit')).toBeInViewport();
  let overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  await page.getByTestId('more-options').click();
  await expect(page.getByTestId('competitor-1')).toBeVisible();
  overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});

test('@desktop theme toggle switches data-theme and persists after reload', async ({ page }) => {
  await page.goto('/');
  const html = page.locator('html');
  const toggle = page.getByTestId('theme-toggle');
  // Dark by default
  await expect(html).toHaveAttribute('data-theme', 'dark');
  await expect(toggle).toHaveAttribute('aria-label', 'Switch to light theme');

  await toggle.click();
  await expect(html).toHaveAttribute('data-theme', 'light');
  await expect(toggle).toHaveAttribute('aria-label', 'Switch to dark theme');

  // The choice survives a reload (set before first paint by index.html)
  await page.reload();
  await expect(html).toHaveAttribute('data-theme', 'light');
  await expect(page.getByTestId('theme-toggle')).toHaveAttribute('aria-label', 'Switch to dark theme');

  await page.getByTestId('theme-toggle').click();
  await page.reload();
  await expect(html).toHaveAttribute('data-theme', 'dark');
});
