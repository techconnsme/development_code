import { test, expect } from '@playwright/test';
import path from 'path';
import fs from 'fs';
import os from 'os';

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
    // Deterministic UI language for this test's text selectors
    localStorage.setItem('i18nextLng', 'en');
  });
}

test.describe('Cancel upload rollback', () => {

  test('TC-CANCEL-01: cancelling a type-mismatch upload deletes the uploaded file', async ({ page }) => {
    // Use a uniquely-named copy so previous runs can't pollute the result
    const uniqueName = `CANCEL_TEST_${Date.now()}.pdf`;
    const tmpPath = path.join(os.tmpdir(), uniqueName);
    fs.copyFileSync(path.join(SAMPLES, 'BANK_HSBC_BusinessDirect_2026-08_Aug.pdf'), tmpPath);

    try {
      await login(page);
      await page.goto(`${BASE}/file-upload`);
      await expect(page.locator('h2').filter({ hasText: 'File Upload' }).first()).toBeVisible({ timeout: 10000 });

      // Choose "Others" so the OCR-detected bank statement mismatches the channel
      await page.locator('button').filter({ hasText: /^Others \(Receipts, Cash Payments etc\.\)$/ }).first().click();

      const fileInput = page.locator('input[type="file"]').first();
      await fileInput.setInputFiles(tmpPath);
      await page.getByText('Upload & Analyze').click();

      // Wait for OCR to finish and the type-mismatch dialog to appear
      await expect(page.getByText('Document Type Mismatch')).toBeVisible({ timeout: 180000 });

      // Cancel the upload
      await page.getByText('Cancel', { exact: true }).click();
      await expect(page.getByText('Document Type Mismatch')).toBeHidden({ timeout: 10000 });

      // Give the (future) rollback DELETE call a moment to complete
      await page.waitForTimeout(3000);

      // The uploaded file must no longer be listed in File Storage
      const fileListJson = await page.evaluate(async () => {
        const res = await fetch('/api/file-storage');
        return JSON.stringify(await res.json());
      });
      expect(fileListJson).not.toContain(uniqueName);
    } finally {
      try { fs.unlinkSync(tmpPath); } catch {}
    }
  });
});
