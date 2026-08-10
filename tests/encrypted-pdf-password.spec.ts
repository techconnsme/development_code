import { test, expect } from '@playwright/test';
import path from 'path';

const BASE = 'https://c5e898a7.opcc-crm-testing.pages.dev';
const EMAIL = 'joseph.lin@pnr.hk';
const PASSWORD = 'Test1234';
const ESTATEMENT = path.resolve('C:/Users/samue/Documents/Pastel/Tech_Connect_SME/test-sample-real/PNR/estatement/eStatement 20250228.pdf');

test.describe('UI File Upload → Encrypted PDF Flow', () => {

  test.beforeEach(async ({ page }) => {
    await page.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
    await page.fill('input[type="email"]', EMAIL);
    await page.fill('input[type="password"]', PASSWORD);
    await page.click('button[type="submit"]');
    await page.waitForFunction(() => !window.location.href.includes('/login'), { timeout: 20000 });
    await page.waitForTimeout(1000);
  });

  test('upload-encrypted-estatement-via-ui', async ({ page }) => {
    // ── Step 1: Go to File Upload ──
    await page.goto(`${BASE}/file-upload`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(2000);
    console.log('1. File Upload page loaded');

    // Find the Bank Statement upload tab/button
    const bankTab = page.locator('button:has-text("Bank Statement"), button:has-text("Bank"), button:has-text("銀行")').first();
    if (await bankTab.isVisible().catch(() => false)) {
      await bankTab.click();
      await page.waitForTimeout(500);
    }

    // Upload file via hidden input[type=file]
    const fileInput = page.locator('input[type="file"]').first();
    await fileInput.setInputFiles(ESTATEMENT);
    console.log('2. File selected for upload');
    await page.waitForTimeout(2000);

    // Click upload/process button
    const uploadBtn = page.locator('button:has-text("Upload"), button:has-text("Process"), button:has-text("Scan")').first();
    if (await uploadBtn.isVisible().catch(() => false)) {
      await uploadBtn.click();
      console.log('3. Upload button clicked');
    }

    // Wait for processing (upload + OCR + import-document)
    await page.waitForTimeout(25000);
    console.log('4. Waited for processing');

    await page.screenshot({ path: 'test-results/ui-upload-after-process.png', fullPage: true });

    // ── Step 2: Go to File Storage, expand folders, look for result ──
    await page.goto(`${BASE}/file-storage`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(3000);

    // Expand folders by clicking buttons with "Bank" text
    const allButtons = page.locator('button');
    const btnCount = await allButtons.count();
    for (let i = 0; i < btnCount; i++) {
      const btn = allButtons.nth(i);
      const text = await btn.textContent().catch(() => '');
      if (text && /Bank|bank/.test(text)) {
        await btn.click().catch(() => {});
        await page.waitForTimeout(400);
      }
    }

    await page.screenshot({ path: 'test-results/ui-upload-file-storage.png', fullPage: true });

    // Check for encrypted badge (🔒) or error message about encryption
    const lockBadge = page.locator('button:has-text("🔒")');
    const badgeCount = await lockBadge.count();
    console.log(`5. 🔒 Encrypted badges in File Storage: ${badgeCount}`);

    // Also check for any error/status text
    const pageText = await page.textContent('body');
    const hasEncrypted = (pageText || '').includes('encrypted');
    const hasLock = (pageText || '').includes('🔒');
    console.log(`   Page has 'encrypted': ${hasEncrypted}, has '🔒': ${hasLock}`);

    // ── Step 3: Go to Bank Statements — should be empty ──
    await page.goto(`${BASE}/bank-statements`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(3000);

    await page.screenshot({ path: 'test-results/ui-upload-bank-statements.png', fullPage: true });

    const bsPageText = await page.textContent('body');
    const hasNull = (bsPageText || '').includes('-null');
    const hsbcCount = ((bsPageText || '').match(/HSBC/gi) || []).length;
    console.log(`6. Bank Statements: has '-null': ${hasNull}, 'HSBC' mentions: ${hsbcCount}`);

    // Assertions
    expect(badgeCount).toBeGreaterThan(0);        // File Storage shows 🔒 Encrypted badge
    expect(hasNull).toBe(false);                   // No "-null HSBC" garbage entries
  });

});
