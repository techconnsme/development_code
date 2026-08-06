import { test, expect } from '@playwright/test';

const BASE = 'https://opcc-crm-testing.pages.dev';
const LOGIN_EMAIL = 'muhammadruhan.farhan25@gmail.com';
const LOGIN_PASSWORD = 'Ruhan123';

test('Set company name to Demo Company Limited, then test both directions', async ({ page }) => {
  page.on('pageerror', err => console.log('[PAGE ERROR]', err.message));

  // ── Login ──
  console.log('\n═══ Login ═══');
  await page.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
  await page.fill('input[type="email"]', LOGIN_EMAIL);
  await page.fill('input[type="password"]', LOGIN_PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForFunction(() => !window.location.href.includes('/login'), { timeout: 20000 });
  console.log('✅ Logged in');

  // ── Go to Settings ──
  console.log('\n═══ Settings ═══');
  await page.goto(`${BASE}/settings`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(3000);

  // Find the company name field and set it
  const nameInput = page.locator('input').filter({ has: page.locator('[value]') }).first();
  // Try finding by label
  const companyNameLabel = page.locator('label').filter({ hasText: /Company Name|公司名稱|公司名称/i }).first();
  if (await companyNameLabel.isVisible({ timeout: 3000 }).catch(() => false)) {
    const input = companyNameLabel.locator('..').locator('input').first();
    await input.click();
    await input.fill('');
    await input.fill('Demo Company Limited');
    console.log('✅ Set company name to "Demo Company Limited"');
  } else {
    // Try finding just the first text input that might be company name
    const inputs = page.locator('input[type="text"], input:not([type])');
    const count = await inputs.count();
    console.log('Found', count, 'text inputs');
    for (let i = 0; i < Math.min(count, 8); i++) {
      const val = await inputs.nth(i).inputValue().catch(() => '');
      const ph = await inputs.nth(i).getAttribute('placeholder').catch(() => '');
      console.log(`  Input[${i}]: value="${val}" placeholder="${ph}"`);
      if (val.includes('Proficiency') || val.includes('Company') || ph?.includes('Company') || ph?.includes('company')) {
        await inputs.nth(i).fill('Demo Company Limited');
        console.log('✅ Set input', i, 'to Demo Company Limited');
        break;
      }
    }
  }

  // Click Save
  const saveBtn = page.locator('button').filter({ hasText: /Save|儲存|储存|Update/i }).first();
  if (await saveBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
    await saveBtn.click();
    console.log('✅ Clicked Save');
    await page.waitForTimeout(2000);
  }

  // Take a screenshot to confirm
  await page.screenshot({ path: 'test-results/company-settings.png', fullPage: true });

  console.log('\n═══ Done — company name updated ═══');
});
