import { test, expect } from '@playwright/test';
import path from 'path';

const BASE = process.env.TEST_BASE_URL || 'https://opcc-crm-testing.pages.dev';
// Joseph Lin's PnR account — the encrypted HSBC eStatement samples belong to his tenant
const EMAIL = process.env.TEST_EMAIL || 'joseph.lin@pnr.hk';
const PASSWORD = process.env.TEST_PASSWORD || 'Test1234';
const SAMPLES = process.env.TEST_SAMPLES_DIR || 'C:/Users/samue/Documents/Pastel/Tech_Connect_SME/test-sample-real/PNR';

test.describe('Encrypted HSBC eStatement import', () => {

  test('TC-ENC-01: encrypted eStatement imports with correct opening balance and reconciled transactions', async ({ page }) => {
    test.setTimeout(600_000);
    await page.goto(`${BASE}/login`);
    await page.fill('input[type="email"]', EMAIL);
    await page.fill('input[type="password"]', PASSWORD);
    await page.click('button[type="submit"]');
    await page.waitForFunction(() => !window.location.href.includes('/login'), { timeout: 30000 });
    await page.evaluate(() => { localStorage.removeItem('activeClient'); localStorage.setItem('i18nextLng', 'en'); });

    await page.goto(`${BASE}/file-upload`);
    await expect(page.locator('h2').filter({ hasText: 'File Upload' }).first()).toBeVisible({ timeout: 10000 });

    // Idempotence: soft-delete any existing August statement so re-runs don't trip the duplicate path
    await page.evaluate(async () => {
      const res = await fetch('/api/bank-statements');
      const json = await res.json();
      const list = json?.data || json || [];
      const rows = Array.isArray(list) ? list : list.data || [];
      for (const s of rows) {
        if (s.statement_month === 8 && s.statement_year === 2025) {
          await fetch(`/api/bank-statements/${s.id}`, { method: 'DELETE' });
        }
      }
    });

    // Bank Statement channel is the default
    const fileInput = page.locator('input[type="file"]').first();
    await fileInput.setInputFiles(path.join(SAMPLES, 'estatement/eStatement 20250831.pdf'));
    await page.getByText('Upload & Analyze').click();

    // Import completes — either auto-saved to the list or routed to review
    await page.waitForFunction(() => !window.location.href.includes('/file-upload'), { timeout: 300000 });
    await page.waitForTimeout(4000);

    // Fetch the August statement via the API and verify the pipeline output
    const stmt = await page.evaluate(async () => {
      const res = await fetch('/api/bank-statements?month=8');
      const json = await res.json();
      const list = json?.data || json || [];
      const rows = Array.isArray(list) ? list : list.data || [];
      const aug = rows.find((s: any) => s.statement_month === 8 && s.statement_year === 2025);
      if (!aug) return null;
      const detail = await (await fetch(`/api/bank-statements/${aug.id}`)).json();
      const d = detail?.data || detail;
      const txs = d?.transactions || [];
      const sum = txs.reduce((acc: number, t: any) => acc + (t.deposit_amount || 0) - (t.withdrawal_amount || 0), 0);
      return {
        opening: d.opening_balance,
        closing: d.closing_balance,
        txCount: txs.length,
        reconciled: Math.abs((d.opening_balance || 0) + sum - (d.closing_balance || 0)) < 0.01,
      };
    });

    expect(stmt).not.toBeNull();
    // August must continue from July's closing balance — the OCR guard's key assertion
    expect(stmt!.opening).toBe(103526.1);
    expect(stmt!.txCount).toBeGreaterThan(0);
    expect(stmt!.reconciled).toBe(true);
  });
});
