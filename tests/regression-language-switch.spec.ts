import { test, expect } from '@playwright/test';
import path from 'path';

const BASE = 'https://opcc-crm-testing.pages.dev';
const EMAIL = 'muhammadruhan.farhan25@gmail.com';
const PASSWORD = 'Ruhan123';

test('Language switch preserves file upload state', async ({ page }) => {
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
  const tab = page.locator('button').filter({ hasText: /Bank-TXN|銀行交易/i }).first();
  await tab.click();
  await page.waitForTimeout(500);

  // Verify English header
  const heading = page.locator('h2').first();
  await expect(heading).toBeVisible();
  const initialText = await heading.textContent();

  // Switch to Chinese (繁)
  const zhBtn = page.locator('button').filter({ hasText: '繁' }).first();
  await zhBtn.click();
  await page.waitForTimeout(1000);

  // Verify heading changed language
  const afterZhText = await heading.textContent();
  expect(afterZhText).not.toBe(initialText);
  console.log('Language changed: EN → 繁');

  // Switch back to English
  const enBtn = page.locator('button').filter({ hasText: 'EN' }).first();
  await enBtn.click();
  await page.waitForTimeout(1000);

  // Verify heading returns to English
  const afterEnText = await heading.textContent();
  expect(afterEnText).toBe(initialText);
  console.log('Language changed back: 繁 → EN ✅');

  // Verify page didn't reload/reset (tab should still be Bank-TXN Invoice)
  const tabActive = page.locator('button').filter({ hasText: /Bank-TXN|銀行交易/i }).first();
  const tabClass = await tabActive.getAttribute('class');
  expect(tabClass).toContain('primary');
  console.log('✅ Tab still selected after language switch');
});
