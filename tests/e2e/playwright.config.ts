import { defineConfig, devices } from '@playwright/test';

// Fixed port (override with UIA_E2E_PORT): Playwright needs to know the URL up front.
const port = Number(process.env.UIA_E2E_PORT) || 3199;
const baseURL = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: '.',
  testMatch: /.*\.spec\.ts/,
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  use: { baseURL, trace: 'retain-on-failure' },
  webServer: {
    command: 'npx tsx tests/e2e/start-e2e-server.ts',
    cwd: '../..',
    url: `${baseURL}/api/config`,
    reuseExistingServer: false,
    timeout: 120_000,
    env: { UIA_E2E_PORT: String(port) },
    stdout: 'pipe',
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'] }, grep: /@desktop/ },
    { name: 'mobile', use: { ...devices['Desktop Chrome'], viewport: { width: 375, height: 812 }, hasTouch: true }, grep: /@mobile/ },
  ],
});
