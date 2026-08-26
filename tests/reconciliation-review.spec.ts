import { test, expect } from '@playwright/test';

const BASE = process.env.TEST_BASE_URL || 'http://localhost:5173';
const LOGIN_EMAIL = process.env.TEST_EMAIL || 'joseph.lin@pnr.hk';
const LOGIN_PASSWORD = process.env.TEST_PASSWORD || 'Test1234';

async function login(page: any) {
  await page.goto(`${BASE}/login`);
  await page.fill('input[type="email"]', LOGIN_EMAIL);
  await page.fill('input[type="password"]', LOGIN_PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForFunction(() => !window.location.href.includes('/login'), { timeout: 20000 });
}

test.describe('Review vs Ledger (reconciliation review)', () => {
  test('panel renders figures and suggestions; pre-fill opens posting editor', async ({ page }) => {
    await login(page);
    await page.goto(`${BASE}/bank-statements`);
    await expect(page.locator('body')).toContainText(/Bank Statements|銀行月結單|银行月结单/i, { timeout: 15000 });

    // Expand the first statement card (rendered as a clickable div with "<YYYY-MM> <Bank>")
    await page.waitForFunction(() => /Statements \(\d+\)/.test(document.body.innerText), { timeout: 15000 });
    const stmtCount = await page.evaluate(() =>
      parseInt((document.body.innerText.match(/Statements \((\d+)\)/) || [])[1] || '0', 10));
    test.skip(stmtCount === 0, 'No statements in the selected fiscal year');
    await page.getByText(/\d{4}-\d{2} \S+/).first().click();

    // Open the review
    await page.locator('button', { hasText: /Review vs Ledger|對帳審查|对账审查/ }).first().click();

    // Panel shows Bank/Books/Gap figures
    const modal = page.locator('.fixed.inset-0 .bg-card');
    await expect(modal).toBeVisible({ timeout: 15000 });
    await expect(modal).toContainText(/Bank|銀行|银行/);
    await expect(modal).toContainText(/Books|帳面|账面/);
    await expect(modal).toContainText(/Gap|差額|差额/);
    await expect(modal).toContainText(/After suggestions|建議後|建议后/);

    // If any suggestion items rendered, Pre-fill must open the row's posting editor or show the hint toast
    const items = modal.getByTestId('review-item');
    if (await items.count() > 0) {
      await items.first().getByTestId('review-prefill').click();
      await expect(
        page.getByText(/review and save|確認後保存|确认后保存|Suggested:/).first()
      ).toBeVisible({ timeout: 8000 });
    }
    await modal.locator('button', { hasText: /Close|關閉|关闭/ }).click();
  });
});
