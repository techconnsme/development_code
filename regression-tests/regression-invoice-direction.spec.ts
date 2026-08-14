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
    localStorage.setItem('i18nextLng', 'en'); // deterministic English selectors
  });
}

function copyUniqueSample(): string {
  const uniqueName = `DIR_TEST_${Date.now()}.pdf`;
  const tmpPath = path.join(os.tmpdir(), uniqueName);
  fs.copyFileSync(path.join(SAMPLES, 'BILL_IN_INV-FEDEX-2026-0812_FedEx_Express_Hong_Kong.pdf'), tmpPath);
  return tmpPath;
}

test.describe('Invoice direction channels', () => {
  test('TC-DIR-01: purchase invoice under Sales Invoice tab shows mismatch, cancel rolls back', async ({ page }) => {
    const tmpPath = copyUniqueSample();
    try {
      await login(page);
      await page.goto(`${BASE}/file-upload`);
      await expect(page.locator('h2').filter({ hasText: 'File Upload' }).first()).toBeVisible({ timeout: 10000 });

      // Pick Sales Invoice — the sample is an incoming (purchase) invoice
      await page.locator('button').filter({ hasText: /^Sales Invoice$/ }).first().click();

      const fileInput = page.locator('input[type="file"]').first();
      await fileInput.setInputFiles(tmpPath);
      await page.getByText('Upload & Analyze').click();

      // Mismatch dialog appears and names the detected direction
      await expect(page.getByText('Document Type Mismatch')).toBeVisible({ timeout: 240000 });
      await expect(page.getByText(/Purchase Invoice/).first()).toBeVisible();

      // Cancel must roll back the uploaded file
      await page.getByText('Cancel', { exact: true }).click();
      await expect(page.getByText('Document Type Mismatch')).toBeHidden({ timeout: 10000 });
      await page.waitForTimeout(3000);

      const fileListJson = await page.evaluate(async () => JSON.stringify(await (await fetch('/api/file-storage')).json()));
      expect(fileListJson).not.toContain(path.basename(tmpPath));
    } finally {
      try { fs.unlinkSync(tmpPath); } catch {}
    }
  });

  test('TC-DIR-02: Force keeps the chosen direction (Sales Invoice → outgoing)', async ({ page }) => {
    const tmpPath = copyUniqueSample();
    try {
      await login(page);
      await page.goto(`${BASE}/file-upload`);
      await expect(page.locator('h2').filter({ hasText: 'File Upload' }).first()).toBeVisible({ timeout: 10000 });

      await page.locator('button').filter({ hasText: /^Sales Invoice$/ }).first().click();
      const fileInput = page.locator('input[type="file"]').first();
      await fileInput.setInputFiles(tmpPath);
      await page.getByText('Upload & Analyze').click();

      await expect(page.getByText('Document Type Mismatch')).toBeVisible({ timeout: 240000 });
      await page.getByText(/Force as/).click();

      // Re-import finishes; the file row must carry direction = outgoing
      await page.waitForFunction(() => {
        const body = document.body.textContent || '';
        return !body.includes('Re-importing as');
      }, { timeout: 240000 });
      await page.waitForTimeout(5000);

      const data = await page.evaluate(async () => await (await fetch('/api/file-storage')).json());
      const row = (data?.data || []).find((f: any) => f.filename === path.basename(tmpPath));
      expect(row?.direction).toBe('outgoing');
      // User-declared direction must not resurface as a review prompt
      expect(row?.invoice_needs_review || '').not.toContain('direction');
    } finally {
      try { fs.unlinkSync(tmpPath); } catch {}
    }
  });
});
