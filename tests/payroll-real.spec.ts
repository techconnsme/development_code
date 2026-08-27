import { test, expect, type Page } from '@playwright/test';

const BASE = process.env.TEST_BASE_URL || 'https://opcc-crm-testing.pages.dev';
const EMAIL = process.env.TEST_EMAIL || 'muhammadruhan.farhan25@gmail.com';
const PASSWORD = process.env.TEST_PASSWORD || 'Ruhan123';

async function login(page: Page) {
  await page.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
  await page.fill('input[type="email"]', EMAIL);
  await page.fill('input[type="password"]', PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForFunction(() => !window.location.href.includes('/login'), { timeout: 20000 });
}

test('payroll toggle: demo default intact, real view renders and persists', async ({ page }) => {
  await login(page);

  // Fresh browser context → localStorage empty → demo default
  await page.goto(`${BASE}/payroll`, { waitUntil: 'networkidle' });
  await expect(page.locator('button', { hasText: /EMP-00/ }).filter({ visible: true }).first()).toBeVisible();

  // Toggle → Real mode
  await page.getByText(/Real data|實際資料|实际资料/).first().click();
  await expect(page.getByText(/Add employee|新增員工|新增员工/).first()).toBeVisible();
  // Demo chip hidden in real mode
  await expect(page.getByText(/Demo data|演示數據|演示数据/).filter({ visible: true })).toHaveCount(0);
  await page.screenshot({ path: 'test-results/payroll-real.png', fullPage: true });

  // Persistence across reload
  await page.reload({ waitUntil: 'networkidle' });
  await expect(page.getByText(/Add employee|新增員工|新增员工/).first()).toBeVisible();

  // Back to Demo restores the demo view (chip + subtitle return)
  await page.getByText(/Demo data|演示數據|演示数据/).first().click();
  await expect(page.getByText(/Sample payroll for demonstration\.|薪資演示樣本。|薪资演示样本。/)).toBeVisible();
  await expect(page.locator('button', { hasText: /EMP-00/ }).filter({ visible: true }).first()).toBeVisible();
});
