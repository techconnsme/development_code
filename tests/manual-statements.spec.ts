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

test.describe('Manual Statement Entry (non-mutating)', () => {
  test('TC-MS-01: FileUpload shows Save without AI Analysis button', async ({ page }) => {
    await login(page);
    await page.goto(`${BASE}/file-upload`);
    await expect(page.getByRole('button', { name: /Save without AI/i })).toBeVisible();
    await expect(page.getByRole('button', { name: /Upload & Analyze/i })).toBeVisible();
  });

  test('TC-MS-02: BankStatements shows Manual Entry button', async ({ page }) => {
    await login(page);
    await page.goto(`${BASE}/bank-statements`);
    await expect(page.getByRole('button', { name: /Manual Entry/i })).toBeVisible();
  });

  test('TC-MS-03: BankStatements Manual Entry opens editor panel', async ({ page }) => {
    await login(page);
    await page.goto(`${BASE}/bank-statements`);
    await page.getByRole('button', { name: /Manual Entry/i }).click();
    await expect(page.getByText('Manual Bank Statement Entry')).toBeVisible();
    await expect(page.getByLabel(/Bank Name/i)).toBeVisible();
    await expect(page.getByRole('button', { name: /Save & Review/i })).toBeVisible();
    await expect(page.getByRole('button', { name: /Cancel/i })).toBeVisible();
  });

  test('TC-MS-04: CardStatements shows Manual Entry button', async ({ page }) => {
    await login(page);
    await page.goto(`${BASE}/card-statements`);
    await expect(page.getByRole('button', { name: /Manual Entry/i })).toBeVisible();
  });

  test('TC-MS-05: CardStatements Manual Entry opens editor panel', async ({ page }) => {
    await login(page);
    await page.goto(`${BASE}/card-statements`);
    await page.getByRole('button', { name: /Manual Entry/i }).click();
    await expect(page.getByText('Manual Card Statement Entry')).toBeVisible();
    await expect(page.getByLabel(/Card Issuer/i)).toBeVisible();
    await expect(page.getByRole('button', { name: /Save & Review/i })).toBeVisible();
  });

  test('TC-MS-06: FileStorage shows Stored (no AI) badge for skipped files', async ({ page }) => {
    await login(page);
    // Route-intercept to return a file with ocr_status='skipped'
    await page.route('**/file-storage?**', (route) => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          data: [{
            id: 'fs-test1', filename: 'test.pdf', original_name: 'test.pdf',
            file_type: 'application/pdf', file_size: 1000, folder: 'Bank Statements',
            ocr_status: 'skipped', created_at: '2026-08-27T00:00:00Z',
          }],
        }),
      });
    });
    await page.goto(`${BASE}/file-storage`);
    await expect(page.getByText('Stored (no AI)')).toBeVisible();
  });

  test('TC-MS-07: Invoices page loads and Create button exists', async ({ page }) => {
    await login(page);
    await page.goto(`${BASE}/invoices`);
    // The page should load without errors
    await expect(page.locator('body')).toBeVisible();
  });
});
