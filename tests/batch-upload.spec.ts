import { test, expect } from '@playwright/test';

const BASE = 'https://3cab7987.opcc-crm-testing.pages.dev';
const LOGIN_EMAIL = 'muhammadruhan.farhan25@nixorcollege.edu.pk';
const LOGIN_PASSWORD = 'password';

async function login(page: any) {
  await page.goto(`${BASE}/login`);
  await page.fill('input[type="email"]', LOGIN_EMAIL);
  await page.fill('input[type="password"]', LOGIN_PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForFunction(() => !window.location.href.includes('/login'), { timeout: 20000 });
  await page.evaluate(() => {
    localStorage.removeItem('activeClient');
    sessionStorage.removeItem('reviewQueue');
    sessionStorage.removeItem('reviewQueueTotal');
  });
}

test.describe('Batch Upload & Review Flow', () => {

  test('Bank Statements list loads (not stuck)', async ({ page }) => {
    await login(page);
    await page.goto(`${BASE}/bank-statements`);
    // Wait for the main content to fully load (statements or no-data, NOT stuck at loading)
    await page.waitForFunction(() => {
      const body = document.body.textContent || '';
      return !body.includes('Loading...') && (body.includes('Statement Continuity Chain') || body.includes('No bank statements'));
    }, { timeout: 25000 });
    // Verify list or no-data is visible
    const hasContent = await page.locator('text=Statement Continuity Chain').first().isVisible().catch(() => false);
    expect(hasContent).toBe(true);
    console.log('✅ Bank Statements list loads correctly');
  });

  test('Card Statements list loads (not stuck)', async ({ page }) => {
    await login(page);
    await page.goto(`${BASE}/card-statements`);
    await page.waitForFunction(() => {
      const body = document.body.textContent || '';
      return !body.includes('Loading…') && body.includes('Card Statements');
    }, { timeout: 20000 });
    console.log('✅ Card Statements list loads correctly');
  });

  test('FileUpload page renders', async ({ page }) => {
    await login(page);
    await page.goto(`${BASE}/file-upload`);
    await expect(page.locator('h2').filter({ hasText: 'File Upload' }).first()).toBeVisible({ timeout: 10000 });
    await expect(page.getByText('Select Files').first()).toBeVisible();
    console.log('✅ FileUpload page renders correctly');
  });

  test('Review queue shows error for missing statement (not stuck at loading)', async ({ page }) => {
    await login(page);
    await page.evaluate(() => {
      sessionStorage.setItem('reviewQueue', JSON.stringify([
        { docType: 'bank_statement', reviewId: 'non-existent-id', filename: 'test.pdf', flags: '' }
      ]));
    });
    await page.goto(`${BASE}/bank-statements/review/non-existent-id`);
    // Should show error not loading spinner — "Statement not found." or back link
    await expect(page.getByText('Statement not found').first()).toBeVisible({ timeout: 15000 });
    console.log('✅ Review page shows error, not stuck at loading');
  });

  test('Bank Statements loads with clean state (no stale activeClient)', async ({ page }) => {
    await login(page);
    await page.goto(`${BASE}/bank-statements`);
    await expect(page.getByRole('button').filter({ hasText: 'Statement Continuity Chain' }).first()).toBeVisible({ timeout: 20000 });
    console.log('✅ Bank Statements loads with clean state');
  });

});
