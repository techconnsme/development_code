import { test, expect } from '@playwright/test';

const BASE = process.env.TEST_BASE_URL || 'https://opcc-crm-testing.pages.dev';
const LOGIN_EMAIL = process.env.TEST_EMAIL || 'joseph.lin@pnr.hk';
const LOGIN_PASSWORD = process.env.TEST_PASSWORD || 'Test1234';

async function login(page: any) {
  await page.goto(`${BASE}/login`);
  await page.fill('input[type="email"]', LOGIN_EMAIL);
  await page.fill('input[type="password"]', LOGIN_PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForFunction(() => !window.location.href.includes('/login'), null, { timeout: 30000 });
  await page.evaluate(() => localStorage.setItem('i18nextLng', 'en')); // deterministic English selectors
}

async function expandFirstRow(page: any, route: string) {
  await page.goto(`${BASE}${route}`);
  await page.locator('tbody tr').first().waitFor({ timeout: 15000 });
  // Click the FIRST CELL of the first invoice row (never the actions column)
  await page.locator('tbody tr').first().locator('td').first().click();
  const panel = page.getByTestId('invoice-detail-panel');
  await expect(panel).toBeVisible({ timeout: 15000 });
  return panel;
}

test('TC-PANEL-01: AP row expands with all three sections', async ({ page }) => {
  await login(page);
  const panel = await expandFirstRow(page, '/ap');
  await expect(panel.getByText('Line items')).toBeVisible();
  await expect(panel.getByText(/Linked bank transactions|Not yet posted to GL|GL postings/).first()).toBeVisible();
  // Line items table renders at least a Total row
  await expect(panel.getByText('Total')).toBeVisible();
});

test('TC-PANEL-02: AR row expands with all three sections', async ({ page }) => {
  await login(page);
  const panel = await expandFirstRow(page, '/ar');
  await expect(panel.getByText('Line items')).toBeVisible();
  await expect(panel.getByText(/Linked bank transactions|Not yet posted to GL|GL postings/).first()).toBeVisible();
});

// WAIVER: TC-PANEL-03 intentionally does not click Confirm/Unlink. Those
// mutations write to the shared ground-truth test DB (confirm posts GL
// entries + flips invoice status; unlink resets status for the whole
// group). Endpoint behaviour is covered by BankStatements-page flows;
// panel wiring was verified manually during development.
test('TC-PANEL-03: linked transaction rows show status, and group slices show allocated amount', async ({ page }) => {
  await login(page);
  await page.goto(`${BASE}/ap`);
  // The first AP invoice has no bank links in this dataset; target the known paid PnR
  // invoice INV-MT1MBYTQ instead, which has a confirmed direct 1:1 bank transaction link.
  // The AP page mounts a hidden duplicate of the table (same ids); .first() picks
  // the visible instance.
  const row = page.locator('#inv-row-i-872c3a1e').first();
  await row.waitFor({ timeout: 15000 });
  await row.locator('td').first().click();
  const panel = page.getByTestId('invoice-detail-panel');
  await expect(panel).toBeVisible({ timeout: 15000 });
  const rows = panel.getByTestId('linked-tx-row');
  // Non-vacuous: this paid invoice must render at least one linked transaction row
  await expect(rows.first()).toBeVisible({ timeout: 15000 });
  // Each row carries a status chip
  await expect(rows.first().getByText(/Confirmed|Suggested|unmatched/)).toBeVisible();
  // Group-payment slices: every 'Group' row must also show its allocated slice ("of <tx amount>")
  const groupRows = await rows.getByText('Group').count();
  if (groupRows > 0) {
    for (let i = 0; i < groupRows; i++) {
      await expect(rows.nth(i).getByText(/^of /)).toBeVisible();
    }
  }
});

test('TC-PANEL-04: action buttons do not toggle expansion', async ({ page }) => {
  await login(page);
  await page.goto(`${BASE}/ap`);
  await page.locator('tbody tr').first().waitFor({ timeout: 15000 });
  // The Eye button has a stable title ("View" via tr()); clicking it must open the
  // eye modal — never the inline detail panel
  await page.locator('tbody tr').first().locator('button[title="View"]').click();
  // Positive assertion: the eye modal overlay actually opened (guards against a
  // vacuous pass if the click did nothing at all)
  await expect(page.locator('[role="dialog"], .fixed.inset-0').first()).toBeVisible({ timeout: 10000 });
  // The inline detail panel must NOT have been toggled open by the action button
  await expect(page.getByTestId('invoice-detail-panel')).toHaveCount(0);
});
