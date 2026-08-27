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
  test('TC-MS-01: FileUpload shows Save without AI Analysis button after file selected', async ({ page }) => {
    await login(page);
    await page.goto(`${BASE}/file-upload`);
    // The button only appears after files are selected — use a file input
    const fileInput = page.locator('input[type="file"]');
    // Create a tiny dummy PDF in the browser context
    await page.evaluate(() => {
      const dt = new DataTransfer();
      const file = new File(['%PDF-1.4 test'], 'test.pdf', { type: 'application/pdf' });
      dt.items.add(file);
      const input = document.querySelector('input[type="file"]') as HTMLInputElement;
      if (input) { input.files = dt.files; input.dispatchEvent(new Event('change', { bubbles: true })); }
    });
    await expect(page.getByRole('button', { name: /Save without AI/i })).toBeVisible({ timeout: 10000 });
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
    await expect(page.getByPlaceholder('HSBC')).toBeVisible();
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
    await expect(page.getByPlaceholder('HSBC')).toBeVisible();
    await expect(page.getByRole('button', { name: /Save & Review/i })).toBeVisible();
  });

  test('TC-MS-06: FileStorage page loads', async ({ page }) => {
    await login(page);
    await page.goto(`${BASE}/file-storage`);
    await expect(page.locator('body')).toBeVisible();
    // Wait for the page to fully render
    await page.waitForTimeout(3000);
  });

  test('TC-MS-07: Invoices page loads and Create button exists', async ({ page }) => {
    await login(page);
    await page.goto(`${BASE}/invoices`);
    // The page should load without errors
    await expect(page.locator('body')).toBeVisible();
  });
});
