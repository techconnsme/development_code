import { test, expect, type Page } from '@playwright/test';

const BASE = process.env.TEST_BASE_URL || 'https://opcc-crm-testing.pages.dev';
// Credentials proven in tests/regression-language-switch.spec.ts
const EMAIL = 'muhammadruhan.farhan25@gmail.com';
const PASSWORD = 'Ruhan123';

async function login(page: Page) {
  await page.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
  await page.fill('input[type="email"]', EMAIL);
  await page.fill('input[type="password"]', PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForFunction(() => !window.location.href.includes('/login'), { timeout: 20000 });
}

test('payroll demo: list, extension, collapse, monthly COA entries', async ({ page }) => {
  await login(page);
  await page.goto(`${BASE}/payroll`, { waitUntil: 'networkidle' });

  // 7 sample staff rows (row buttons carry the EMP-xxxx staff no.)
  // Layout mounts every page twice (desktop main + mobile lg:hidden copy),
  // so count only the visible copy (house practice: .first()/nth for multi-match)
  const rows = page.locator('button', { hasText: /EMP-00/ }).filter({ visible: true });
  await expect(rows).toHaveCount(7);

  // Click a staff row → detail extends (names are locale-dependent, so match any)
  await rows.filter({ hasText: 'EMP-0001' }).click();
  await expect(page.getByText(/Chan Tai Man|陳大文|陈大文/).first()).toBeVisible();
  await expect(page.getByText(/Monthly Payment Status|每月支付狀態|每月支付状态/)).toBeVisible();

  // All 12 months render (first and last)
  await expect(page.getByText(/Jan 2026|2026年1月/).first()).toBeVisible();
  await expect(page.getByText(/Dec 2026|2026年12月/).first()).toBeVisible();

  // Expand January → both COA blocks with real codes
  await page.getByText(/Jan 2026|2026年1月/).first().click();
  // All 12 months' JE blocks render in the DOM (CSS accordion), so .first() = the
  // expanded January block; a multi-match locator in a single-element expect throws
  // a Playwright strict-mode violation, which is why .first() pins the assertion
  // to the first (January) match
  await expect(page.getByText(/Salary Payment|薪金支付/).first()).toBeVisible();
  await expect(page.getByText(/MPF Remittance|強積金供款|强积金供款/).first()).toBeVisible();
  await expect(page.getByText('61201', { exact: true }).first()).toBeVisible();
  await expect(page.getByText('21204', { exact: true }).first()).toBeVisible();

  // Screenshot for human review (test-results, not playwright-report: the HTML
  // reporter wipes its output dir when finalizing, deleting files written in-test)
  await page.screenshot({ path: 'test-results/payroll-demo.png', fullPage: true });

  // Collapse via close button
  await page.locator('button[aria-label="Close"]').click();
  await expect(page.getByText(/Monthly Payment Status|每月支付狀態|每月支付状态/)).toBeHidden();

  // Re-open via row click, then collapse by re-clicking the same row
  await rows.filter({ hasText: 'EMP-0001' }).click();
  await expect(page.getByText(/Monthly Payment Status|每月支付狀態|每月支付状态/)).toBeVisible();
  await rows.filter({ hasText: 'EMP-0001' }).click();
  await expect(page.getByText(/Monthly Payment Status|每月支付狀態|每月支付状态/)).toBeHidden();

  // Capped staff (45,000) shows the 1,500 MPF cap figures
  await rows.filter({ hasText: 'EMP-0001' }).click();
  await expect(page.getByText('1,500.00').first()).toBeVisible();

  // Below-minimum staff (EMP-0005, 6,000): employee MPF 0, employer still 5% (300),
  // and the zero-amount Cr 21204 line is filtered out of the salary block
  await rows.filter({ hasText: 'EMP-0005' }).click();
  // The detail panel is already open at 480px here, so the staff-row name div is
  // squeezed to 0 width (minmax(0,1fr) column) and counts as hidden; the visible
  // match is the detail-panel header, so pin with filter({ visible: true })
  await expect(page.getByText(/Cheung Mei Ling|張美玲|张美玲/).filter({ visible: true }).first()).toBeVisible();
  await page.getByText(/Jan 2026|2026年1月/).first().click();
  await expect(page.getByText('300.00').first()).toBeVisible();
  await expect(page.getByText('0.00').first()).toBeVisible();
  await expect(page.getByText('21204', { exact: true }).filter({ visible: true })).toHaveCount(0);

  // Alternate salary debit accounts: director debits 61102, consultant debits 51201
  await page.locator('button[aria-label="Close"]').click();
  await rows.filter({ hasText: 'EMP-0006' }).click();
  await page.getByText(/Jan 2026|2026年1月/).first().click();
  await expect(page.getByText('61102', { exact: true }).filter({ visible: true }).first()).toBeVisible();
  await rows.filter({ hasText: 'EMP-0006' }).click(); // collapse via row re-click
  await rows.filter({ hasText: 'EMP-0007' }).click();
  await page.getByText(/Jan 2026|2026年1月/).first().click();
  await expect(page.getByText('51201', { exact: true }).filter({ visible: true }).first()).toBeVisible();
});
