import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './regression-tests',
  fullyParallel: false,
  retries: 0,
  workers: 1,
  reporter: [['list']],
  timeout: 300_000,
  expect: { timeout: 30_000 },
  use: {
    baseURL: process.env.TEST_BASE_URL || 'https://opcc-crm-testing.pages.dev',
    headless: true,
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
