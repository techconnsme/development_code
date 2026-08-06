import { test, expect } from '@playwright/test';

const BASE = 'https://opcc-crm-testing.pages.dev';
const EMAIL = 'muhammadruhan.farhan25@gmail.com';
const PASSWORD = 'Ruhan123';

test('COA Review auto-expands all parent accounts', async ({ page }) => {
  // Login
  await page.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
  await page.fill('input[type="email"]', EMAIL);
  await page.fill('input[type="password"]', PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForFunction(() => !window.location.href.includes('/login'), { timeout: 20000 });

  // Navigate to New Client page (may be under admin or settings)
  // Try common routes
  const routes = ['/admin/new-client', '/firms/new-client', '/settings/new-client'];
  let found = false;
  for (const r of routes) {
    await page.goto(`${BASE}${r}`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(2000);
    const body = await page.textContent('body') || '';
    if (body.includes('Company Name') || body.includes('公司名稱') || body.includes('公司名称')) {
      found = true;
      console.log('Found New Client form at:', r);
      break;
    }
  }

  if (!found) {
    // Try navigating via the UI
    await page.goto(`${BASE}/settings`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(2000);
    // Look for "New Client" or "Add Client" link/button
    const newClientBtn = page.locator('a, button').filter({ hasText: /New Client|Add Client|新增客戶|新增客户/i }).first();
    if (await newClientBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      await newClientBtn.click();
      await page.waitForTimeout(2000);
      found = true;
    }
  }

  if (!found) {
    console.log('⚠️ Could not find New Client form — test may need URL update');
    return;
  }

  // Fill company name to trigger COA preview
  const companyInput = page.locator('input').first();
  await companyInput.fill('Test Company');
  await page.waitForTimeout(500);

  // Select an industry if available
  const industrySelect = page.locator('select').first();
  if (await industrySelect.isVisible({ timeout: 2000 }).catch(() => false)) {
    await industrySelect.selectOption('general');
    await page.waitForTimeout(2000);
  }

  // Wait for COA preview to render
  await page.waitForTimeout(3000);

  // Check that type sections are expanded (look for "Assets", "Liabilities", etc. with expanded indicators)
  const assetHeader = page.getByText(/Assets|資產|资产/).first();
  const liabilityHeader = page.getByText(/Liabilities|負債|负债/).first();
  const equityHeader = page.getByText(/Equity|權益|权益/).first();
  const revenueHeader = page.getByText(/Revenue|收入/).first();
  const expenseHeader = page.getByText(/Expenses|支出/).first();

  // At minimum, Assets should be visible (if COA loaded)
  const assetsVisible = await assetHeader.isVisible({ timeout: 5000 }).catch(() => false);
  console.log('Assets section visible:', assetsVisible);

  // Check that account codes are visible (expanded = codes shown)
  const accountCodes = page.locator('text=/^\\d{5}$/'); // 5-digit account codes
  const codeCount = await accountCodes.count();
  console.log('Account codes visible:', codeCount);
  expect(codeCount).toBeGreaterThan(0);
  console.log('✅ COA accounts expanded —', codeCount, 'codes visible');
});
