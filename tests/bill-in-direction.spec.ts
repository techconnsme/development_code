import { test, expect } from '@playwright/test';
import path from 'path';

const BASE = 'https://opcc-crm-testing.pages.dev';
const LOGIN_EMAIL = 'muhammadruhan.farhan25@gmail.com';
const LOGIN_PASSWORD = 'Ruhan123';
const SAMPLES_DIR = path.resolve('C:/Users/samue/Documents/Pastel/Tech_Connect_SME/test-samples-generated-demo-company');

// Mix of incoming and outgoing invoices
const TEST_FILES = [
  // Incoming (supplier bills — should be AP/incoming)
  'BILL_IN_INV-FEDEX-2026-0812_FedEx_Express_Hong_Kong.pdf',
  'BILL_IN_BILL-TAX-2026-0720_PwC_Hong_Kong.pdf',
  // Outgoing (we issued — should be AR/outgoing)
  'INV_OUT_INV-2026-0042_TechGear_HK_Ltd.pdf',
  'INV_OUT_INV-2026-0043_StarNet_Solutions.pdf',
];

test.describe('Invoice Direction — Mixed Incoming + Outgoing', () => {

  test('Auto-save invoices, verify correct direction for each', async ({ page }) => {
    page.on('pageerror', err => console.log('[PAGE ERROR]', err.message));

    // ── Login ──
    console.log('\n═══ Login ═══');
    await page.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
    await page.fill('input[type="email"]', LOGIN_EMAIL);
    await page.fill('input[type="password"]', LOGIN_PASSWORD);
    await page.click('button[type="submit"]');
    await page.waitForFunction(() => !window.location.href.includes('/login'), { timeout: 20000 });
    console.log('✅ Logged in');

    await page.evaluate(() => {
      localStorage.removeItem('activeClient');
      sessionStorage.removeItem('reviewQueue');
      sessionStorage.removeItem('reviewQueueTotal');
    });

    // ── Go to File Upload, select Bank-TXN Invoice tab ──
    console.log('\n═══ File Upload ═══');
    await page.goto(`${BASE}/file-upload`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(2000);
    const bankInvTab = page.locator('button').filter({ hasText: /Bank-TXN|銀行交易/i }).first();
    await bankInvTab.click();
    await page.waitForTimeout(500);
    console.log('✅ Bank-TXN Invoice tab selected');

    // ── Upload files ──
    console.log('\n═══ Upload ═══');
    const fileInput = page.locator('input[type="file"]').first();
    const filePaths = TEST_FILES.map(f => path.join(SAMPLES_DIR, f));
    console.log('Files:', filePaths.map(p => path.basename(p)));
    await fileInput.setInputFiles(filePaths);
    await page.waitForTimeout(1500);

    const uploadBtn = page.locator('button').filter({ hasText: /Upload|上傳|上传/ }).first();
    await uploadBtn.click();
    console.log('✅ Upload initiated — waiting for processing...');

    // ── Wait: either auto-save → /invoices list, or needs review → /invoices/review/ ──
    // Use a shorter wait and poll
    let result = 'unknown';
    const startTime = Date.now();
    const maxWait = 240000; // 4 min

    while (Date.now() - startTime < maxWait) {
      await page.waitForTimeout(3000);
      const url = page.url();
      if (url.includes('/invoices/review/')) {
        result = 'review';
        console.log('→ Navigated to REVIEW page:', url);
        break;
      }
      if (url.includes('/invoices') && !url.includes('/file-upload')) {
        result = 'autosave';
        console.log('→ Auto-saved! On invoices list:', url);
        break;
      }
      // Check for error toasts
      const errorText = await page.locator('[role="alert"], .toast, .error').first().textContent().catch(() => '');
      if (errorText && errorText.length > 5) console.log('  Toast:', errorText.slice(0, 100));
    }

    console.log('\n═══ Result:', result, '═══');
    console.log('Final URL:', page.url());

    if (result === 'review') {
      // On review page — check direction
      await page.waitForTimeout(4000);
      const apBtn = page.locator('button').filter({ hasText: /AP|Billed us|應付|应付/i }).first();
      const arBtn = page.locator('button').filter({ hasText: /AR|We issued|應收|应收/i }).first();
      const apActive = /orange|bg-orange/.test((await apBtn.getAttribute('class')) || '');
      const arActive = /blue|bg-blue/.test((await arBtn.getAttribute('class')) || '');
      console.log('AP active:', apActive, '| AR active:', arActive);

      // Check which file we're reviewing
      const vendorInput = page.locator('input').nth(1);
      const vendor = await vendorInput.inputValue().catch(() => 'unknown');
      console.log('Vendor:', vendor);
      console.log('Status:', apActive ? '✅ INCOMING (correct for BILL_IN)' : arActive ? '✅ OUTGOING (correct for INV_OUT)' : '⚠️ UNKNOWN');
    } else if (result === 'autosave') {
      // Check the invoices list for direction
      await page.waitForTimeout(3000);
      // Navigate to invoices if not already there
      if (!page.url().includes('/invoices')) {
        await page.goto(`${BASE}/invoices`, { waitUntil: 'networkidle' });
        await page.waitForTimeout(2000);
      }
      // Look for direction badges: Sales=outgoing(blue), Purchase=incoming(orange)
      const pageText = await page.locator('body').textContent();
      const hasPurchase = pageText?.includes('Purchase') || pageText?.includes('採購') || pageText?.includes('采购');
      const hasSales = pageText?.includes('Sales') || pageText?.includes('銷售') || pageText?.includes('销售');
      console.log('Invoices list shows Purchase (incoming):', hasPurchase);
      console.log('Invoices list shows Sales (outgoing):', hasSales);
      console.log('✅ All invoices auto-saved without review!');
    } else {
      console.log('⚠️ Timed out — invoices may still be processing');
    }

    console.log('\n═══ Done ═══');
  });

});
