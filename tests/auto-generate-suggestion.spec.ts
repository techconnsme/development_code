import { test, expect } from '@playwright/test';

const EMAIL = 'joseph.lin@pnr.hk';
const PASSWORD = 'Test1234';

test.describe('Auto-generate JDE suggestion panel', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/login');
    await page.fill('input[type="email"], input[name="email"]', EMAIL);
    await page.fill('input[type="password"], input[name="password"]', PASSWORD);
    await page.click('button[type="submit"]');
    await page.waitForURL('**/dashboard', { timeout: 10000 });
  });

  test('clicking Auto-Generate shows suggestion panel', async ({ page }) => {
    await page.goto('/GJE');
    await page.waitForLoadState('networkidle');

    const btn = page.getByRole('button', { name: /auto-generate/i });
    await expect(btn).toBeVisible();
    await btn.click();

    const panel = page.getByTestId('auto-generate-suggestions');
    const loading = page.getByText(/analyzing transactions/i);

    await expect(panel.or(loading)).toBeVisible({ timeout: 10000 });

    if (await loading.isVisible()) {
      await expect(panel).toBeVisible({ timeout: 15000 });
    }

    const rows = page.getByTestId('suggestion-row');
    const doneMsg = page.getByText(/all done/i);
    await expect(rows.first().or(doneMsg)).toBeVisible();
  });

  test('suggestion rows show confidence badges', async ({ page }) => {
    await page.goto('/GJE');
    await page.waitForLoadState('networkidle');

    const btn = page.getByRole('button', { name: /auto-generate/i });
    await btn.click();

    const panel = page.getByTestId('auto-generate-suggestions');
    await expect(panel).toBeVisible({ timeout: 15000 });

    const rows = page.getByTestId('suggestion-row');
    const count = await rows.count();
    if (count > 0) {
      const firstRow = rows.first();
      await expect(firstRow.getByText(/confirmed|needs review/i)).toBeVisible();
    }
  });

  test('Confirm All button appears when confirmed items exist', async ({ page }) => {
    await page.goto('/GJE');
    await page.waitForLoadState('networkidle');

    const btn = page.getByRole('button', { name: /auto-generate/i });
    await btn.click();

    const panel = page.getByTestId('auto-generate-suggestions');
    await expect(panel).toBeVisible({ timeout: 15000 });

    const rows = page.getByTestId('suggestion-row');
    const count = await rows.count();
    if (count > 0) {
      const confirmedBadges = page.getByText('CONFIRMED');
      const confirmedCount = await confirmedBadges.count();
      if (confirmedCount > 0) {
        await expect(page.getByTestId('confirm-all-btn')).toBeVisible();
      }
    }
  });
});
