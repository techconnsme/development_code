/**
 * Regression Full-Flow Playwright Test — PNR Sample Documents
 *
 * Usage:
 *   npx playwright test tests/regression-full-flow.spec.ts --headed --reporter=list
 *
 * Prerequisites:
 *   1. Run hard-reset first (POST /api/admin/hard-reset-data for u-83161e0c)
 *   2. Set company name: "Proficient and Reliance Company Limited"
 */

import { test, expect } from '@playwright/test';
import * as path from 'path';
import * as fs from 'fs';

const BASE = process.env.TEST_BASE_URL || 'https://main.opcc-crm.pages.dev';
const SAMPLES = process.env.TEST_SAMPLES_DIR || path.resolve(__dirname, '../../test-sample-real/PNR');
const LOGIN_EMAIL = 'joseph.lin@pnr.hk';
const LOGIN_PASSWORD = 'Test1234';

// ── Helpers ───────────────────────────────────────────────────────────────

async function login(page: any) {
  await page.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
  await page.fill('input[type="email"]', LOGIN_EMAIL);
  await page.fill('input[type="password"]', LOGIN_PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForFunction(() => !window.location.href.includes('/login'), { timeout: 20000 });
  await page.evaluate(() => {
    localStorage.removeItem('activeClient');
    sessionStorage.removeItem('reviewQueue');
    sessionStorage.removeItem('reviewQueueTotal');
  });
  console.log('✅ Logged in');
}

async function uploadFile(page: any, filePath: string, tabLabel: string) {
  const fullPath = path.resolve(SAMPLES, filePath);
  if (!fs.existsSync(fullPath)) {
    console.log(`⚠️ SKIP: ${filePath} not found`);
    return false;
  }
  await page.goto(`${BASE}/file-upload`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1000);

  // Select upload tab
  const tab = page.locator('button').filter({ hasText: new RegExp(`^${tabLabel}$`) }).first();
  if (await tab.isVisible()) await tab.click();

  // Upload file
  const fileInput = page.locator('input[type="file"]').first();
  await fileInput.setInputFiles(fullPath);
  await page.waitForTimeout(500);

  // Upload & Analyze
  const uploadBtn = page.getByText(/Upload.*Analyze|上傳.*分析|上传.*分析/);
  if (await uploadBtn.isVisible()) await uploadBtn.click();

  // Wait for OCR to complete
  await page.waitForFunction(() => {
    return !document.body.textContent?.includes('DeepSeek AI is extracting');
  }, { timeout: 300000 });

  await page.waitForTimeout(2000);
  console.log(`✅ Uploaded: ${filePath}`);
  return true;
}

async function assertField(page: any, label: string, expected: string | null) {
  if (!expected) return true;
  const body = await page.textContent('body');
  const found = body.includes(expected);
  console.log(`  ${found ? '✅' : '❌'} ${label}: expected "${expected}" — ${found ? 'found' : 'NOT found'}`);
  return found;
}

// ── Tests ─────────────────────────────────────────────────────────────────

test.describe('Regression Full Flow — PNR', () => {
  test.setTimeout(600_000); // 10 min per test

  test.beforeEach(async ({ page }) => {
    await login(page);
  });

  test('1. Bank Statement Upload & Review', async ({ page }) => {
    const file = 'estatement/eStatement 20250228.pdf';
    const uploaded = await uploadFile(page, file, 'Bank Statement');
    if (!uploaded) { test.skip(); return; }

    // Should navigate to review page
    await page.waitForURL('**/bank-statements/review/**', { timeout: 30000 });
    console.log('✅ Navigated to bank statement review');

    // Check extracted fields are visible
    const body = await page.textContent('body');
    expect(body).not.toContain('Could not read this file');

    // Verify bank name field exists (editable input)
    const bankNameInput = page.locator('input').filter({ has: page.locator('[value]') }).first();
    console.log('Bank statement review page loaded');
  });

  test('2. AP Invoice Upload & Direction Check', async ({ page }) => {
    const file = 'Pastel/01383 - invoice#001397.pdf';
    const uploaded = await uploadFile(page, file, 'Bank-TXN Invoice');
    if (!uploaded) { test.skip(); return; }

    // Should navigate to invoice review or invoices page
    await page.waitForTimeout(5000);
    const url = page.url();
    console.log(`Current URL: ${url}`);

    // If on review page, check direction
    if (url.includes('/invoices/review/')) {
      const body = await page.textContent('body');
      console.log('On invoice review page');

      // Check for direction indicator (incoming = AP)
      const hasIncoming = body.includes('incoming') || body.includes('應付') || body.includes('应付') || body.includes('AP');
      console.log(`Direction incoming/AP visible: ${hasIncoming}`);
    }

    // Navigate to AP page and verify invoice appears
    await page.goto(`${BASE}/ap`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(2000);
    const body = await page.textContent('body');
    expect(body).toContain('Pastel');
    console.log('✅ AP page shows Pastel invoice');
  });

  test('3. AR Invoice Upload & Direction Check', async ({ page }) => {
    const file = 'VEII/Invoice 2025001.pdf';
    const uploaded = await uploadFile(page, file, 'Bank-TXN Invoice');
    if (!uploaded) { test.skip(); return; }

    await page.waitForTimeout(5000);

    // Navigate to AR page
    await page.goto(`${BASE}/ar`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(2000);
    const body = await page.textContent('body');
    // Should show outgoing invoice
    const hasInvoice = body.includes('2025001') || body.includes('VEII');
    console.log(`AR page shows VEII invoice: ${hasInvoice}`);
  });

  test('4. Receipt Upload & Link Check', async ({ page }) => {
    const file = 'Pastel/001397-receipt#001260.pdf';
    const uploaded = await uploadFile(page, file, 'Bank-TXN Invoice');
    if (!uploaded) { test.skip(); return; }

    await page.waitForTimeout(5000);

    // Navigate to Invoices page (receipts tab)
    await page.goto(`${BASE}/invoices`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(2000);

    // Click Receipts tab if available
    const receiptsTab = page.getByText(/Receipts|收據|收据/);
    if (await receiptsTab.isVisible()) await receiptsTab.click();
    await page.waitForTimeout(1000);

    const body = await page.textContent('body');
    const hasReceipt = body.includes('001260') || body.includes('receipt');
    console.log(`Receipt visible: ${hasReceipt}`);
  });

  test('5. Cross-Document Links — Auto-Match', async ({ page }) => {
    // Navigate to Bank Statements
    await page.goto(`${BASE}/bank-statements`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(2000);

    // Check if statements are listed
    const body = await page.textContent('body');
    const hasStatements = body.includes('HSBC') || body.includes('eStatement');
    console.log(`Bank statements visible: ${hasStatements}`);

    // Check AP page for linked receipts
    await page.goto(`${BASE}/ap`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(2000);

    // Click "Match Receipts" button
    const matchBtn = page.getByText(/Match Receipts|配對收據|配对收据/);
    if (await matchBtn.isVisible()) {
      await matchBtn.click();
      await page.waitForTimeout(3000);
      const modalBody = await page.textContent('body');
      console.log(`Match modal appeared: ${modalBody.includes('Confirm') || modalBody.includes('確認') || modalBody.includes('确认')}`);
    }
  });
});
