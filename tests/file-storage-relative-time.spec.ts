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
  await page.waitForFunction(() => !window.location.href.includes('/login'), null, { timeout: 30000 });
  await page.evaluate(() => {
    localStorage.removeItem('activeClient');
    localStorage.setItem('i18nextLng', 'en'); // deterministic English selectors
  });
}

test('TC-TIME-01: fresh upload shows relative time in File Storage', async ({ page }) => {
  const uniqueName = `TIME_TEST_${Date.now()}.pdf`;
  const tmpPath = path.join(os.tmpdir(), uniqueName);
  fs.copyFileSync(path.join(SAMPLES, 'BANK_HSBC_BusinessDirect_2026-08_Aug.pdf'), tmpPath);

  try {
    await login(page);
    await page.goto(`${BASE}/file-upload`);
    await expect(page.locator('h2').filter({ hasText: 'File Upload' }).first()).toBeVisible({ timeout: 10000 });

    const fileInput = page.locator('input[type="file"]').first();
    await fileInput.setInputFiles(tmpPath);
    await page.getByText('Upload & Analyze').click();

    // Wait for OCR/import to finish (page navigates away to /bank-statements)
    await page.waitForFunction(() => !window.location.href.includes('/file-upload'), null, { timeout: 240000 });

    await page.goto(`${BASE}/file-storage`);
    // Expand the "Bank Statements" folder in the tree (folder button shows a file count)
    await page.locator('main button').filter({ hasText: /Bank Statements\s*\(\d+\)/ }).first().click();

    // The fresh upload's row must show a relative age, not a bare date
    const row = page.locator('div').filter({ hasText: uniqueName }).first();
    await expect(row).toBeVisible({ timeout: 15000 });
    await expect(row).toContainText(/ago|now/, { timeout: 15000 });
  } finally {
    try { fs.unlinkSync(tmpPath); } catch {}
  }
});
