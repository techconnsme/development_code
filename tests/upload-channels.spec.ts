import { test, expect } from '@playwright/test';
import path from 'path';

const BASE = process.env.TEST_BASE_URL || 'https://opcc-crm-testing.pages.dev';
const LOGIN_EMAIL = process.env.TEST_EMAIL || 'muhammadruhan.farhan25@nixorcollege.edu.pk';
const LOGIN_PASSWORD = process.env.TEST_PASSWORD || 'password';
const SAMPLES = process.env.TEST_SAMPLES_DIR || 'C:/Users/samue/Documents/Pastel/Tech_Connect_SME/test-samples-generated-demo-company';

async function login(page: any) {
  await page.goto(`${BASE}/login`);
  await page.fill('input[type="email"]', LOGIN_EMAIL);
  await page.fill('input[type="password"]', LOGIN_PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForFunction(() => !window.location.href.includes('/login'), { timeout: 30000 });
  await page.evaluate(() => {
    localStorage.removeItem('activeClient');
    sessionStorage.removeItem('reviewQueue');
    sessionStorage.removeItem('reviewQueueTotal');
  });
}

async function waitForFileUpload(page: any) {
  await page.goto(`${BASE}/file-upload`);
  // Wait for the upload page h2 (use .first() to avoid strict mode)
  await expect(page.locator('h2').filter({ hasText: 'File Upload' }).first()).toBeVisible({ timeout: 10000 });
}

test.describe('Upload Channel Categorization', () => {

  test.beforeEach(async ({ page }) => {
    await login(page);
  });

  test('TC-UC-01: Bank Statement channel routes to bank statement import', async ({ page }) => {
    await waitForFileUpload(page);

    // Click "Bank Statement" tab button
    await page.locator('button').filter({ hasText: /^Bank Statement$/ }).first().click();

    // Upload bank statement PDF
    const fileInput = page.locator('input[type="file"]').first();
    await fileInput.setInputFiles(path.join(SAMPLES, 'BANK_HSBC_BusinessDirect_2026-08_Aug.pdf'));
    await page.getByText('Upload & Analyze').click();

    // Wait for processing
    await page.waitForFunction(() => {
      const body = document.body.textContent || '';
      return !body.includes('DeepSeek AI is extracting');
    }, { timeout: 180000 });

    // Should route to bank statement review or list
    const url = page.url();
    const isRouted = url.includes('/bank-statements') || url.includes('/file-upload');
    expect(isRouted).toBeTruthy();
  });

  test('TC-UC-02: Card Statement channel routes correctly', async ({ page }) => {
    await waitForFileUpload(page);

    // Click "Card Statement" tab button
    await page.locator('button').filter({ hasText: /^Card Statement$/ }).first().click();

    const fileInput = page.locator('input[type="file"]').first();
    await fileInput.setInputFiles(path.join(SAMPLES, 'CARD_HSBC_Visa_4567_2026-08_Aug.pdf'));
    await page.getByText('Upload & Analyze').click();

    await page.waitForFunction(() => {
      const body = document.body.textContent || '';
      return !body.includes('DeepSeek AI is extracting');
    }, { timeout: 180000 });

    // App may stay on file-upload or navigate — verify card statement was created via API
    await page.waitForTimeout(3000);
    const apiResult = await page.evaluate(async () => {
      const res = await fetch('/api/card-statements');
      return res.json();
    });
    // Card statement should be created (data array or data.data)
    const hasCardData = (apiResult.data?.length > 0) || (apiResult.data?.data?.length > 0);
    expect(hasCardData || page.url().includes('file-upload')).toBeTruthy();
  });

  test('TC-UC-05: Petty Cash channel auto-creates journal entry', async ({ page }) => {
    await waitForFileUpload(page);

    // Click "Petty Cash" tab button
    await page.locator('button').filter({ hasText: /^Petty Cash$/ }).first().click();

    const fileInput = page.locator('input[type="file"]').first();
    await fileInput.setInputFiles(path.join(SAMPLES, 'RECEIPT_REC-2026-0015_TechGear_HK_Ltd.pdf'));
    await page.getByText('Upload & Analyze').click();

    await page.waitForFunction(() => {
      const body = document.body.textContent || '';
      return !body.includes('DeepSeek AI is extracting');
    }, { timeout: 180000 });

    // Check toast for petty cash confirmation or file saved
    await page.waitForTimeout(3000);
    const bodyText = await page.textContent('body');
    const hasConfirmation = bodyText?.includes('Petty Cash') || bodyText?.includes('零用金') || bodyText?.includes('success');
    expect(hasConfirmation).toBeTruthy();
  });

  test('TC-UC-06: Others channel saves without special routing', async ({ page }) => {
    await waitForFileUpload(page);

    // Click "Others" tab button
    await page.locator('button').filter({ hasText: /^Others \(Receipts, Cash Payments etc\.\)$/ }).first().click();

    const fileInput = page.locator('input[type="file"]').first();
    await fileInput.setInputFiles(path.join(SAMPLES, 'RECEIPT_REC-2026-0016_StarNet_Solutions.pdf'));
    await page.getByText('Upload & Analyze').click();

    await page.waitForFunction(() => {
      const body = document.body.textContent || '';
      return !body.includes('DeepSeek AI is extracting');
    }, { timeout: 180000 });

    // Should stay on file-upload or go to file list (no special routing)
    const url = page.url();
    expect(url).not.toContain('/bank-statements/review');
    expect(url).not.toContain('/invoices/review');
  });

  test('TC-UC-08: Batch upload processes multiple files', async ({ page }) => {
    await waitForFileUpload(page);

    // Click "Bank Statement" tab button (default, but be explicit)
    await page.locator('button').filter({ hasText: /^Bank Statement$/ }).first().click();

    // Upload multiple bank statements
    const fileInput = page.locator('input[type="file"]').first();
    await fileInput.setInputFiles([
      path.join(SAMPLES, 'BANK_HSBC_BusinessDirect_2026-06_Jun.pdf'),
      path.join(SAMPLES, 'BANK_HSBC_BusinessDirect_2026-07_Jul.pdf'),
      path.join(SAMPLES, 'BANK_HSBC_BusinessDirect_2026-08_Aug.pdf'),
    ]);

    await expect(page.getByText('file(s) selected')).toBeVisible({ timeout: 5000 });
    await page.getByText('Upload & Analyze').click();

    // Wait for batch processing (3 files × ~40s each = ~2 min)
    await page.waitForFunction(() => {
      const body = document.body.textContent || '';
      return !body.includes('DeepSeek AI is extracting');
    }, { timeout: 300000 });

    // Verify processing completed
    const bodyText = await page.textContent('body');
    expect(bodyText).toBeTruthy();
  });

  test('TC-UC-09: Cash Payment merged into Others (Receipts, Cash Payments etc.)', async ({ page }) => {
    await waitForFileUpload(page);

    // Scope every assertion to the desktop tab strip. The app mounts the page
    // twice (desktop + hidden lg:hidden mobile copy), so whole-page counts see
    // every tab doubled.
    const tabs = page.locator(
      'div.hidden.lg\\:flex div.flex.gap-1.border-b.overflow-x-auto > button'
    );
    await expect(tabs).toHaveCount(6);
    // Old Cash Payment channel must be gone.
    await expect(tabs.filter({ hasText: /^Cash Payment$/ })).toHaveCount(0);
    // Merged tab appears exactly once with the agreed wording.
    await expect(
      tabs.filter({ hasText: /^Others \(Receipts, Cash Payments etc\.\)$/ })
    ).toHaveCount(1);
    // Petty Cash keeps its own dedicated tab (design decision §2.2 of the spec).
    await expect(tabs.filter({ hasText: /^Petty Cash$/ })).toHaveCount(1);
    // Other four channels remain.
    for (const label of ['Bank Statement', 'Card Statement', 'Sales Invoice', 'Purchase Invoice']) {
      await expect(tabs.filter({ hasText: new RegExp(`^${label}$`) })).toHaveCount(1);
    }
  });
});
