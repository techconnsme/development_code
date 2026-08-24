import { test } from '@playwright/test';
import path from 'path';

// LIVE OBSERVATION RUN — does auto bank→invoice matching link ONE bank tx to
// MULTIPLE invoices (1:N)? Ground truth from LINKS_REPORT §4.1:
//   57,580.80 (19 Sep) = #001414 15,300 + #001417v2 42,280.80
//   55,000.00 (05 Nov) = #001441 40,050 + #001442 14,950
//   27,544.00 (05 Feb) = #001458v2 5,200 + #001467-v2 4,150 + #001484-v2 18,194
// Uploads the 7 component invoices for joseph.lin@pnr.hk, then clicks
// "Auto-Match Invoices" on the Bank Statements page and reports what the
// engine suggests for the three combined payments.
// SUGGEST-ONLY: no match is confirmed. Data change = the 7 uploaded invoices.

const SAMPLES_DIR = path.resolve(
  __dirname,
  '../../../test-sample-real/PNR/Pastel',
);

const FILES = [
  '01383 - invoice#001414.pdf',
  '01383 - invoice#001417v2.pdf',
  '01383 - invoice#001441.pdf',
  '01383 - invoice#001442.pdf',
  '01383 - invoice#001458v2.pdf',
  '01383 - invoice#001467-v2.pdf',
  '01383 - invoice#001484-v2.pdf',
];

const COMBINED_TXS = [57580.8, 55000, 27544];

test('observe whether auto-match links combined payments to 2+ invoices', async ({ page }) => {
  test.setTimeout(1_800_000);
  test.slow();

  console.log(`[1N-CHECK] uploading ${FILES.length} Pastel invoices as Purchase Invoice (AP)`);

  // ── Login ──
  await page.goto('/login');
  await page.locator('input[type=email]').fill('joseph.lin@pnr.hk');
  await page.locator('input[type=password]').fill('Test1234');
  await page.locator('button[type=submit]').click();
  await page.waitForURL(u => !u.pathname.includes('/login'), { timeout: 30_000 });
  const acceptBtn = page.getByRole('button', { name: 'Accept' });
  if (await acceptBtn.isVisible().catch(() => false)) await acceptBtn.click();

  const imported: Array<{ file: string; invoiceId: string | null; flags: boolean }> = [];

  const skipUpload = process.env.SKIP_UPLOAD === '1';
  if (skipUpload) {
    console.log('[1N-CHECK] SKIP_UPLOAD=1 — using invoice rows already in the tenant');
  }

  for (const file of skipUpload ? [] : FILES) {
    console.log(`\n[1N-CHECK] ── uploading ${file} ──`);
    await page.goto('/file-upload');
    await page.getByRole('button', { name: /Purchase Invoice/ }).click();

    const importRespPromise = page.waitForResponse(
      r => r.url().includes('/file-storage/') && r.url().includes('/import-document') && r.request().method() === 'POST',
      { timeout: 240_000 },
    );
    // Current build: the chooser is a sr-only <input type=file> with no label
    // association — target it directly (Playwright can set files on hidden inputs).
    await page.locator('input[type=file]').first().setInputFiles(path.join(SAMPLES_DIR, file));
    const tokenWidget = page.locator('div.fixed.bottom-4.right-4');
    if (await tokenWidget.isVisible().catch(() => false)) {
      await tokenWidget.getByRole('button', { name: '✕' }).click().catch(() => {});
    }
    await page.getByRole('button', { name: /Upload & Analyze|上傳/ }).click();

    const importResp = await importRespPromise;
    const importData = await importResp.json();
    const invoiceId: string | null = importData.invoice_id ?? null;
    const flags = !!(importData.needs_direction_review || importData.company_not_detected || importData.needs_review || importData.total_mismatch);
    console.log(`  import: invoice_id=${invoiceId} flags=${flags} direction=${importData.direction}`);

    if (flags && invoiceId) {
      // Flagged import → resolve on the review page (keep AP/incoming), Save.
      await page.goto(`/invoices/review/${invoiceId}`);
      await page.waitForURL(u => u.pathname.includes('/invoices/review/'), { timeout: 60_000 });
      await page.waitForTimeout(1_500);
      const apButton = page.getByRole('button', { name: /AP — We received/ }).first();
      const isAp = await apButton.count();
      console.log(`  review: AP toggle present=${isAp > 0} (incoming default)`);
      await page.getByRole('button', { name: /Save/ }).first().click();
      await page.waitForURL(u => !u.pathname.includes('/review'), { timeout: 60_000 });
      await page.waitForTimeout(800);
    } else {
      await page.waitForURL(u => !u.pathname.includes('/file-upload'), { timeout: 90_000 });
      await page.waitForTimeout(1_200);
    }
    imported.push({ file, invoiceId, flags });
  }

  // ── Bank Statements: trigger auto-match and capture the engine's answer ──
  console.log('\n[1N-CHECK] ── Bank Statements → Auto-Match Invoices ──');
  await page.goto('/bank-statements');
  await page.waitForTimeout(3_000);

  // The Auto-Match button renders inside an EXPANDED statement card — expand one first.
  // Cards are labelled by period, e.g. "2025-09 HSBC", not by file name.
  await page.getByText(/2025-09 HSBC/).first().click();
  await page.waitForTimeout(2_000);

  const autoRespPromise = page.waitForResponse(
    r => r.url().includes('/bank-statements/auto-match') && r.request().method() === 'POST',
    { timeout: 120_000 },
  );
  await page.getByRole('button', { name: /Auto-Match Invoices|自動配對發票/ }).click();
  const autoResp = await autoRespPromise;
  const autoData = await autoResp.json();
  const matched = (autoData.matched || []) as any[];

  console.log(`  engine returned ${matched.length} suggestion(s); unmatched_count=${autoData.unmatched_count}`);
  for (const m of matched) {
    if ((m.invoice_ids?.length ?? 0) >= 2) {
      console.log(`    ${m.direction}: tx amount=${m.amount} → ${m.invoice_ids.length}-invoice group [${m.invoices.map((i: any) => i.invoice_number).join(' + ')}] amount=${m.amount} confidence=${m.confidence} | ${m.reason}`);
    } else {
      console.log(`    ${m.direction}: tx amount=${m.amount} → invoice ${m.invoice_number} (${m.invoice_id}) confidence=${m.confidence} | ${m.reason}`);
    }
  }

  const combinedSuggestions = matched.filter(m => COMBINED_TXS.includes(m.amount));
  console.log('\n[1N-CHECK] RESULT for the 3 combined payments:');
  if (combinedSuggestions.length === 0) {
    console.log('  NONE of 57,580.80 / 55,000 / 27,544 got any suggestion.');
  } else {
    for (const m of combinedSuggestions) {
      if ((m.invoice_ids?.length ?? 0) >= 2) {
        console.log(`  ${m.amount} → suggested ${m.invoice_ids.length}-invoice group [${m.invoices.map((i: any) => i.invoice_number).join(' + ')}] (confidence=${m.confidence})`);
      } else {
        console.log(`  ${m.amount} → suggested SINGLE invoice ${m.invoice_number} (confidence=${m.confidence})`);
      }
    }
  }
  console.log('  → 1:N (one tx = 2+ invoices) suggestions: ' +
    (combinedSuggestions.some(m => (m as any).invoice_ids?.length > 1) ? 'YES' : 'NONE (engine is strictly 1:1)'));

  // Hold the modal open for live observation (HOLD_MS env, default 15s)
  await page.waitForTimeout(1_500);
  await page.screenshot({ path: 'test-results/1n-auto-match-result.png', fullPage: true }).catch(() => {});
  const hold = Number(process.env.HOLD_MS || 15_000);
  console.log(`[1N-CHECK] holding ${hold} ms for observation...`);
  await page.waitForTimeout(hold);

  console.log('\n[1N-CHECK] IMPORTED (now in tenant):');
  for (const i of imported) console.log(`  ${i.file} → invoice_id=${i.invoiceId} flags=${i.flags}`);
});
