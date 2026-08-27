import { test, expect } from '@playwright/test';

const BASE = process.env.TEST_BASE_URL || 'https://opcc-crm-testing.pages.dev';
const LOGIN_EMAIL = process.env.TEST_EMAIL || 'muhammadruhan.farhan25@nixorcollege.edu.pk';
const LOGIN_PASSWORD = process.env.TEST_PASSWORD || 'password';

async function login(page: any) {
  await page.goto(`${BASE}/login`);
  await page.fill('input[type="email"]', LOGIN_EMAIL);
  await page.fill('input[type="password"]', LOGIN_PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForFunction(() => !window.location.href.includes('/login'), null, { timeout: 30000 });
  await page.evaluate(() => {
    localStorage.removeItem('activeClient');
    localStorage.setItem('i18nextLng', 'en');
  });
}

test.describe('Expanded GJE modal (non-mutating)', () => {
  test('GJE-01: modal opens with auto-number preview', async ({ page }) => {
    await login(page);
    await page.goto(`${BASE}/GJE`);
    await page.getByRole('button', { name: /New Entry|Create/ }).first().click();
    await expect(page.getByText('Create / Edit Journal Entry').first()).toBeVisible({ timeout: 10000 });
    // voucher preview shows an MJ- number (auto)
    await expect(page.getByText(/MJ-\d{6}-\d{3}/).first()).toBeVisible({ timeout: 10000 });
    // Post disabled while unbalanced (empty lines)
    const postBtn = page.getByRole('button', { name: /^Post Entry$|^Post without documents$/ }).first();
    await expect(postBtn).toBeDisabled();
    // Cancel closes the modal
    await page.getByRole('button', { name: 'Cancel' }).click();
  });

  test('GJE-02: attachments section renders', async ({ page }) => {
    await login(page);
    await page.goto(`${BASE}/GJE`);
    await page.getByRole('button', { name: /New Entry|Create/ }).first().click();
    await expect(page.getByText('Supporting documents').first()).toBeVisible({ timeout: 10000 });
    // attach documents link exists
    await expect(page.getByText('+ attach documents').first()).toBeVisible();
    await page.getByRole('button', { name: 'Cancel' }).click();
  });

  test('GJE-03: reverse button exists on rows', async ({ page }) => {
    await login(page);
    await page.goto(`${BASE}/GJE`);
    // Wait for entries to load
    await page.waitForTimeout(2000);
    // If there are entries, reverse buttons should be present
    const rows = page.locator('table tbody tr');
    const count = await rows.count();
    if (count > 0) {
      await expect(page.locator('[title="Reverse entry"]').first()).toBeVisible();
    }
  });
});
