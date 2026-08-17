import { test, expect } from '@playwright/test';
import fs from 'fs';
import path from 'path';

// VEII sales-invoice verification (headed observation run):
// Uploads every "Invoice *.pdf" under test-sample-real/PNR/VEII as a SALES
// invoice for Proficient and Reliance Company Limited, verifies on the review
// page that OCR detected direction=outgoing and captured the right
// transactions/counterparty, saves each one, then checks the Expenses
// (Invoices) list shows the correct vendor/customer name.

const VEII_DIR = path.resolve(
  __dirname,
  '../../../test-sample-real/PNR/VEII',
);

const SAMPLES = fs
  .readdirSync(VEII_DIR)
  .filter(f => /^Invoice .*\.pdf$/i.test(f))
  .sort();

test('VEII "Invoice " PDFs are detected as outgoing sales invoices with correct counterparty', async ({ page }) => {
  test.setTimeout(1_800_000); // up to 30 min for the full batch with OCR
  test.slow();

  console.log(`[VEII-CHECK] ${SAMPLES.length} sample(s):`, SAMPLES);

  // ── Login ──
  await page.goto('/login');
  await page.locator('input[type=email]').fill('joseph.lin@pnr.hk');
  await page.locator('input[type=password]').fill('Test1234');
  await page.locator('button[type=submit]').click();
  await page.waitForURL(u => !u.pathname.includes('/login'), { timeout: 30_000 });

  // Dismiss cookie banner if present
  const acceptBtn = page.getByRole('button', { name: 'Accept' });
  if (await acceptBtn.isVisible().catch(() => false)) await acceptBtn.click();

  const results: Array<Record<string, any>> = [];

  for (const file of SAMPLES) {
    const pdfPath = path.join(VEII_DIR, file);
    console.log(`\n[VEII-CHECK] ── ${file} ──`);

    // ── Upload via Sales Invoice channel ──
    await page.goto('/file-upload');
    await page.getByRole('button', { name: /Sales Invoice/ }).click();

    const importRespPromise = page.waitForResponse(
      r => r.url().includes('/file-storage/') && r.url().includes('/import-document') && r.request().method() === 'POST',
      { timeout: 240_000 },
    );
    await page.getByLabel('Select Files').first().setInputFiles(pdfPath);
    // Dismiss the floating "AI Token Usage" widget if it overlays the buttons
    const tokenWidget = page.locator('div.fixed.bottom-4.right-4');
    if (await tokenWidget.isVisible().catch(() => false)) {
      await tokenWidget.getByRole('button', { name: '✕' }).click().catch(() => {});
    }
    // Selection only stages the file — the user must press Upload & Analyze
    await page.getByRole('button', { name: /Upload & Analyze|上傳/ }).click();

    const importResp = await importRespPromise;
    const importData = await importResp.json();
    const invoiceId: string | null = importData.invoice_id ?? null;
    console.log(`  import: invoice_id=${invoiceId} direction=${importData.direction} needs_direction_review=${importData.needs_direction_review} company_not_detected=${importData.company_not_detected} new_counterparty=${importData.new_counterparty} total_mismatch=${!!importData.total_mismatch}`);

    // Clean imports (no review flags) go straight to the Expenses list;
    // flagged imports go to the review page.
    await page.waitForURL(u => !u.pathname.includes('/file-upload'), { timeout: 90_000 });

    let direction = importData.direction ?? null;
    let vendor: string | null = null;
    let invoiceNumber = '?';
    let items: any[] = [];
    let total: number | null = null;
    let needsReview = '';

    const onReviewPage = page.url().includes('/invoices/review/');
    if (onReviewPage) {
      // Review page: capture the review API payload
      const reviewRespPromise = page.waitForResponse(
        r => r.url().includes('/api/invoices/') && r.url().includes('/review'),
        { timeout: 60_000 },
      );
      const reviewResp = await reviewRespPromise.catch(() => null);
      const data = reviewResp ? await reviewResp.json() : {};
      invoiceNumber = data.invoice_number ?? '?';
      direction = data.direction ?? direction;
      vendor = data.vendor_name ?? null;
      items = (data.items || []).map((it: any) => ({
        description: it.description, qty: it.quantity, unit: it.unit_price, amount: it.amount,
      }));
      total = data.total ?? null;
      needsReview = data.needs_review || '';
      await page.waitForTimeout(1_500);

      // DOM check: the AR (outgoing) toggle is highlighted
      const arButton = page.getByRole('button', { name: /AR — We issued/ });
      await expect(arButton, `${file}: AR toggle should be active`).toHaveClass(/bg-blue-100/);

      // Save
      await page.getByRole('button', { name: /Save/ }).first().click();
      await page.waitForURL(u => !u.pathname.includes('/review'), { timeout: 60_000 });
      await page.waitForTimeout(800);
    } else {
      // Clean import — fetch the saved record via the API
      const data = await page.evaluate(async (id) => {
        const token = localStorage.getItem('token') || '';
        const r = await fetch(`/api/invoices/${id}`, { headers: { Authorization: `Bearer ${token}` } });
        return r.json();
      }, invoiceId);
      invoiceNumber = data.invoice_number ?? '?';
      direction = data.direction ?? direction;
      vendor = data.vendor_name ?? data.customer_name ?? null;
      items = (data.items || []).map((it: any) => ({
        description: it.description, qty: it.quantity, unit: it.unit_price, amount: it.amount,
      }));
      total = data.total ?? null;
      needsReview = data.needs_review || '';
      await page.waitForTimeout(1_500);
    }

    console.log(`  invoice: ${invoiceNumber} | direction: ${direction} | vendor: ${vendor} | total: ${total}`);
    console.log(`  needs_review: ${needsReview || '(none)'}`);
    console.log(`  items: ${JSON.stringify(items)}`);

    // ── Assertions: OCR detection ──
    expect(direction, `${file}: direction should be outgoing`).toBe('outgoing');
    expect(vendor, `${file}: counterparty should be Value Exchange`).toContain('Value Exchange');
    expect(items.length, `${file}: should have line items`).toBeGreaterThan(0);

    results.push({ file, invoice_number: invoiceNumber, direction, vendor, total, needs_review: needsReview, items });
  }

  // ── Expenses (Invoices) subpage: counterparty column correct ──
  console.log('\n[VEII-CHECK] ── Verifying Expenses subpage listing ──');
  await page.goto('/invoices');
  await page.waitForTimeout(2_000);

  const valueExchangeRows = page.locator('tr', { hasText: 'Value Exchange' });
  const rowCount = await valueExchangeRows.count();
  console.log(`  rows mentioning "Value Exchange": ${rowCount}`);
  expect(rowCount, 'Expenses list should show the uploaded VEII invoices').toBeGreaterThanOrEqual(results.length);

  // Spot-check one row's visible text
  const firstRowText = await valueExchangeRows.first().innerText();
  console.log(`  first row text: ${firstRowText.replace(/\s+/g, ' ').slice(0, 200)}`);

  console.log('\n[VEII-CHECK] SUMMARY:');
  for (const r of results) {
    console.log(`  ${r.file} → ${r.invoice_number} | ${r.direction} | ${r.vendor} | $${r.total} | flags: ${r.needs_review || '(none)'}`);
  }
});
