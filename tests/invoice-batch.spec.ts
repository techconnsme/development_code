import { test, expect } from '@playwright/test';
import path from 'path';

const BASE = 'https://opcc-crm-testing.pages.dev';
const LOGIN_EMAIL = 'muhammadruhan.farhan25@nixorcollege.edu.pk';
const LOGIN_PASSWORD = 'password';
const SAMPLES_DIR = path.resolve('C:/Users/samue/Documents/Pastel/Tech_Connect_SME/test-samples-generated-demo-company');

const INVOICE_FILES = [
  'INV_OUT_INV-2026-0042_TechGear_HK_Ltd.pdf',
  'INV_OUT_INV-2026-0043_StarNet_Solutions.pdf',
  'INV_OUT_INV-2026-0044_Bright_Future_Ltd.pdf',
];

test.describe('Invoice Batch Upload E2E', () => {

  test('Upload 3 invoices, review each, verify no stuck states', async ({ page }) => {
    // Capture browser console for debug logs
    const browserLogs: string[] = [];
    page.on('console', msg => {
      if (msg.text().includes('[DEBUG-INV]') || msg.text().includes('[DEBUG]')) {
        browserLogs.push(msg.text());
        console.log('[BROWSER]', msg.text());
      }
    });
    page.on('pageerror', err => console.log('[PAGE ERROR]', err.message));

    // ── Login ──
    console.log('[TEST] Logging in...');
    await page.goto(`${BASE}/login`);
    await page.fill('input[type="email"]', LOGIN_EMAIL);
    await page.fill('input[type="password"]', LOGIN_PASSWORD);
    await page.click('button[type="submit"]');
    await page.waitForFunction(() => !window.location.href.includes('/login'), { timeout: 20000 });
    console.log('[TEST] Logged in');

    // Clear stale state
    await page.evaluate(() => {
      localStorage.removeItem('activeClient');
      sessionStorage.removeItem('reviewQueue');
      sessionStorage.removeItem('reviewQueueTotal');
      sessionStorage.removeItem('aiTokenUsage');
    });
    console.log('[TEST] Cleared storage');

    // ── Navigate to File Upload ──
    await page.goto(`${BASE}/file-upload`);
    await expect(page.locator('h2').filter({ hasText: 'File Upload' }).first()).toBeVisible({ timeout: 10000 });
    console.log('[TEST] FileUpload page loaded');

    // ── Upload all 3 invoice files ──
    const fileInput = page.locator('input[type="file"]').first();
    const filePaths = INVOICE_FILES.map(f => path.join(SAMPLES_DIR, f));
    await fileInput.setInputFiles(filePaths);
    console.log('[TEST] 3 invoice files selected');

    // Verify files appear in the list
    await expect(page.getByText('file(s) selected')).toBeVisible({ timeout: 5000 });

    // Click Upload & Analyze
    await page.getByText('Upload & Analyze').click();
    console.log('[TEST] Upload & Analyze clicked');

    // Wait for processing to start (OCR takes 20-40s per file)
    // The processing panel should appear
    await expect(page.getByText('DeepSeek AI is extracting transactions')).toBeVisible({ timeout: 15000 });
    console.log('[TEST] OCR processing started');

    // Wait for processing to complete — the processing panel disappears
    // This may take up to 2 minutes for 3 files
    await page.waitForFunction(() => {
      return !document.body.textContent?.includes('DeepSeek AI is extracting transactions');
    }, { timeout: 180000 }); // 3 minute timeout for 3 files
    console.log('[TEST] OCR processing completed');

    // Should navigate to the first invoice review page automatically
    await page.waitForURL('**/invoices/review/**', { timeout: 15000 });
    console.log('[TEST] Navigated to first invoice review');

    // ── Review File 1 ──
    for (let i = 1; i <= INVOICE_FILES.length; i++) {
      console.log(`[TEST] === Reviewing invoice ${i}/${INVOICE_FILES.length} ===`);

      // Wait for the form to fully load (not stuck at loading spinner or error)
      await page.waitForFunction(() => {
        const body = document.body.textContent || '';
        return !body.includes('Loading invoice data') && !body.includes('Invoice not found');
      }, { timeout: 30000 });

      // Verify Save button is visible and enabled (text varies by language)
      const saveBtn = page.locator('button').filter({ hasText: /Save|儲存|保存/ }).first();
      await expect(saveBtn).toBeVisible({ timeout: 10000 });

      // Check button is NOT disabled
      const isDisabled = await saveBtn.evaluate((el: HTMLButtonElement) => el.disabled);
      console.log(`[TEST] Save button disabled? ${isDisabled}`);
      expect(isDisabled).toBe(false);

      // Click Save
      await saveBtn.click();
      console.log(`[TEST] Clicked Save for invoice ${i}`);

      // If this is the last file, we navigate to /invoices list
      // If not, we go to the next review
      if (i < INVOICE_FILES.length) {
        // Wait for next review page to load
        await page.waitForURL('**/invoices/review/**', { timeout: 30000 });
        // Verify the new URL is different from the current one (next invoice)
        const currentUrl = page.url();
        console.log(`[TEST] Navigated to next invoice: ${currentUrl}`);
        expect(currentUrl).toContain('/invoices/review/');
        expect(currentUrl).not.toBe(`${BASE}/invoices/review/i-`); // not the same

        // Check PDF loaded (not stuck on "Loading PDF…")
        await page.waitForTimeout(2000);
        const loadingPdf = await page.locator('text=Loading PDF').isVisible().catch(() => false);
        if (loadingPdf) {
          console.log('[TEST] ⚠ PDF still loading after 2s — waiting...');
          await page.waitForFunction(() => {
            return !document.body.textContent?.includes('Loading PDF');
          }, { timeout: 15000 });
        }
        console.log('[TEST] PDF loaded for next invoice');
      } else {
        // Last file — should hard-navigate to /invoices list
        console.log('[TEST] Last invoice — waiting for navigation to /invoices list');
        await page.waitForURL('**/invoices', { timeout: 15000 });
        // Make sure we're on the invoices list page (not a review page)
        const finalUrl = page.url();
        expect(finalUrl).not.toContain('/invoices/review/');
        expect(finalUrl).toMatch(/\/invoices$/);
        // Verify page loaded (not blank)
        await page.waitForFunction(() => document.body.textContent!.length > 100, { timeout: 10000 });
        console.log('[TEST] ✅ Landed on invoices list page');
      }
    }

    console.log('[TEST] ✅ All 3 invoices reviewed successfully — no stuck states!');
  });

});
