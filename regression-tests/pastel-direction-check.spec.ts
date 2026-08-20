import { test, expect } from '@playwright/test';
import fs from 'fs';
import path from 'path';

// Pastel supplier-invoice verification:
// Uploads the 15 canonical Pastel "01383 - invoice#..." PDFs (one per
// invoice number, no v2/v3 variants) under test-sample-real/PNR/Pastel via
// the PURCHASE Invoice channel for Proficient and Reliance Company Limited,
// verifies direction=incoming, counterparty = Pastel Tech Limited, and the
// exact printed total for each invoice. Clean imports land in the Purchase
// Invoices list; flagged imports go through the review page (AP toggle).
//
// Regression target: 2026-08-18 direction-resolver + pdf-text OCR deploy —
// these invoices used to be silently marked outgoing with $0 totals.

const PASTEL_DIR = path.resolve(
  __dirname,
  '../../../test-sample-real/PNR/Pastel',
);

// One canonical file per invoice number (skip v2/v3 variants + receipts).
const SAMPLES = [
  '01383 - invoice#001397.pdf',
  '01383 - invoice#001414.pdf',
  '01383 - invoice#001417 2.pdf',
  '01383 - invoice#001441.pdf',
  '01383 - invoice#001442.pdf',
  '01383 - invoice#001458.pdf',
  '01383 - invoice#001467.pdf',
  '01383 - invoice#001473.pdf',
  '01383 - invoice#001484.pdf',
  '01383 - invoice#001500.pdf',
  '01383 - invoice#001507.pdf',
  '01383 - invoice#001511.pdf',
  '01383 - invoice#001521.pdf',
  '01383 - invoice#001541 .pdf',
  '01383 - invoice#001547.pdf',
];

// Printed "Total amount due" per invoice (extracted from the PDF text layer).
const EXPECTED_TOTALS: Record<string, number> = {
  '01383 - invoice#001397.pdf': 19600,
  '01383 - invoice#001414.pdf': 15300,
  '01383 - invoice#001417 2.pdf': 42535.8,
  '01383 - invoice#001441.pdf': 40050,
  '01383 - invoice#001442.pdf': 14950,
  '01383 - invoice#001458.pdf': 5600,
  '01383 - invoice#001467.pdf': 4150,
  '01383 - invoice#001473.pdf': 5100,
  '01383 - invoice#001484.pdf': 18194,
  '01383 - invoice#001500.pdf': 13350,
  '01383 - invoice#001507.pdf': 20550,
  '01383 - invoice#001511.pdf': 8250,
  '01383 - invoice#001521.pdf': 17800,
  '01383 - invoice#001541 .pdf': 24200,
  '01383 - invoice#001547.pdf': 34200,
};

test('Pastel invoices are detected as incoming purchase invoices with correct counterparty and totals', async ({ page }) => {
  test.setTimeout(1_800_000); // up to 30 min for the full batch with OCR
  test.slow();

  console.log(`[PASTEL-CHECK] ${SAMPLES.length} sample(s)`);

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
    const pdfPath = path.join(PASTEL_DIR, file);
    console.log(`\n[PASTEL-CHECK] ── ${file} ──`);

    // ── Upload via Purchase Invoice channel ──
    await page.goto('/file-upload');
    await page.getByRole('button', { name: /Purchase Invoice/ }).click();

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
    console.log(`  import: invoice_id=${invoiceId} direction=${importData.direction} needs_direction_review=${importData.needs_direction_review} company_not_detected=${importData.company_not_detected} total_mismatch=${!!importData.total_mismatch} ocr_source=${importData.ocr_source}`);

    await page.waitForURL(u => !u.pathname.includes('/file-upload'), { timeout: 90_000 });

    let direction = importData.direction ?? null;
    let vendor: string | null = null;
    let invoiceNumber = '?';
    let items: any[] = [];
    let total: number | null = null;
    let needsReview = '';

    // Uploads land on File Storage. When the import is flagged, open the
    // review page directly from the returned invoice id to verify the AP
    // toggle and captured fields.
    const needsFlag = importData.needs_direction_review || importData.company_not_detected || importData.needs_review || !!importData.total_mismatch;
    if (needsFlag && invoiceId) {
      await page.goto(`/invoices/review/${invoiceId}`);
      await page.waitForURL(u => u.pathname.includes('/invoices/review/'), { timeout: 60_000 });

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

      // DOM check: the AP (incoming) toggle is highlighted (AP active style
      // is orange; the AR toggle uses blue)
      const apButton = page.getByRole('button', { name: /AP — Billed us/ });
      await expect(apButton, `${file}: AP toggle should be active`).toHaveClass(/bg-(blue|orange)-100/);

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

    // ── Assertions ──
    expect(direction, `${file}: direction should be incoming`).toBe('incoming');
    expect(vendor ?? '', `${file}: counterparty should be Pastel`).toMatch(/pastel/i);
    expect(items.length, `${file}: should have line items`).toBeGreaterThan(0);
    expect(total, `${file}: total should be ${EXPECTED_TOTALS[file]}`).toBe(EXPECTED_TOTALS[file]);

    results.push({ file, invoice_number: invoiceNumber, direction, vendor, total, needs_review: needsReview, items });
  }

  // ── Purchase Invoices subpage: counterparty column correct ──
  console.log('\n[PASTEL-CHECK] ── Verifying Purchase Invoices listing ──');
  await page.goto('/invoices');
  await page.getByRole('button', { name: /Purchase Invoices|採購發票/ }).click().catch(() => {});
  await page.waitForTimeout(2_000);

  const pastelRows = page.locator('tr', { hasText: 'Pastel' });
  const rowCount = await pastelRows.count();
  console.log(`  rows mentioning "Pastel": ${rowCount}`);
  expect(rowCount, 'Purchase Invoices list should show the uploaded Pastel invoices').toBeGreaterThanOrEqual(results.length);

  console.log('\n[PASTEL-CHECK] SUMMARY:');
  for (const r of results) {
    console.log(`  ${r.file} → ${r.invoice_number} | ${r.direction} | ${r.vendor} | $${r.total} | flags: ${r.needs_review || '(none)'}`);
  }
});
