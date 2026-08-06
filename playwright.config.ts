import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  fullyParallel: false, // Sequential — OCR tests are stateful
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 1, // One browser at a time for shared state
  reporter: [
    ['html', { open: 'never' }],
    ['list'],
  ],
  timeout: 300_000, // 5 min per test (OCR + AI is slow)
  expect: {
    timeout: 30_000,
  },
  use: {
    baseURL: process.env.TEST_BASE_URL || 'https://opcc-crm-testing.pages.dev',
    headless: true,
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
