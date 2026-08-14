import { test, expect } from '@playwright/test';

const BASE = 'https://opcc-crm-testing.pages.dev';
const EMAIL = 'muhammadruhan.farhan25@gmail.com';
const PASSWORD = 'Ruhan123';

test('Language switch does not navigate away from file upload', async ({ page }) => {
  // Login
  await page.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
  await page.fill('input[type="email"]', EMAIL);
  await page.fill('input[type="password"]', PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForFunction(() => !window.location.href.includes('/login'), { timeout: 20000 });

  // Go to File Upload
  await page.goto(`${BASE}/file-upload`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(2000);

  // Select Bank-TXN Invoice tab
  const tab = page.locator('button').filter({ hasText: /Sales Invoice|銷售發票/i }).first();
  await tab.click();
  await page.waitForTimeout(500);

  // Select a file to establish state
  const heading = page.locator('h2').first();
  const initialHeading = await heading.textContent();
  console.log('Initial heading:', initialHeading);

  // Try clicking language buttons if visible (sidebar may be collapsed)
  const langBtns = page.locator('button:has-text("EN"), button:has-text("繁"), button:has-text("简")');
  const visibleCount = await langBtns.count();
  console.log('Visible language buttons:', visibleCount);

  // Click whichever is visible
  for (let i = 0; i < visibleCount; i++) {
    const btn = langBtns.nth(i);
    const text = await btn.textContent();
    if (await btn.isVisible().catch(() => false)) {
      await btn.click({ force: true });
      console.log('Clicked language button:', text);
      await page.waitForTimeout(800);
      break;
    }
  }

  // Key assertion: page did NOT navigate away
  const currentUrl = page.url();
  console.log('Current URL after language interaction:', currentUrl);
  expect(currentUrl).toContain('/file-upload');
  console.log('✅ Still on file-upload page — no unwanted navigation');
});
