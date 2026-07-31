import { test, expect } from '@playwright/test';

const BASE = 'https://23092956.opcc-crm-testing.pages.dev';
const LOGIN_EMAIL = 'muhammadruhan.farhan25@nixorcollege.edu.pk';
const LOGIN_PASSWORD = 'password';

async function login(page: any) {
  await page.goto(`${BASE}/login`);
  await page.fill('input[type="email"]', LOGIN_EMAIL);
  await page.fill('input[type="password"]', LOGIN_PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForFunction(() => !window.location.href.includes('/login'), { timeout: 15000 });
  await page.evaluate(() => {
    localStorage.removeItem('activeClient');
    sessionStorage.removeItem('reviewQueue');
    sessionStorage.removeItem('reviewQueueTotal');
  });
}

test('Debug: Capture bank-statements API call', async ({ page }) => {
  // Track network requests
  const apiRequests: any[] = [];
  page.on('request', (req) => {
    if (req.url().includes('bank-statements')) {
      apiRequests.push({ url: req.url(), method: req.method(), timestamp: Date.now() });
    }
  });
  page.on('response', (res) => {
    if (res.url().includes('bank-statements')) {
      console.log(`[RESPONSE] ${res.status()} ${res.url()}`);
    }
  });
  page.on('requestfailed', (req) => {
    if (req.url().includes('bank-statements')) {
      console.log(`[FAILED] ${req.url()} — ${req.failure()?.errorText}`);
    }
  });

  // Capture console errors
  page.on('console', (msg) => {
    if (msg.type() === 'error') console.log(`[CONSOLE ERROR] ${msg.text()}`);
  });

  await login(page);
  await page.goto(`${BASE}/bank-statements`);

  // Wait and see what happens
  await page.waitForTimeout(5000);

  console.log('API requests captured:', apiRequests.length);
  for (const r of apiRequests) console.log(`  ${r.method} ${r.url}`);

  // Take screenshot
  await page.screenshot({ path: 'test-results/bank-statements-debug.png', fullPage: true });

  // Check page text
  const bodyText = await page.textContent('body');
  console.log('Page text preview:', bodyText?.substring(0, 500));
});
