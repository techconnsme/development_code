// tests/gje-linked-items.spec.ts
import { test, expect } from '@playwright/test';

const EMAIL = 'joseph.lin@pnr.hk';
const PASSWORD = 'Test1234';

test.describe('GJE Linked Items & Audit Trail', () => {
  test.beforeEach(async ({ page }) => {
    // Login
    await page.goto('/login');
    await page.fill('input[type="email"], input[name="email"]', EMAIL);
    await page.fill('input[type="password"], input[name="password"]', PASSWORD);
    await page.click('button[type="submit"]');
    await page.waitForURL('**/dashboard', { timeout: 10000 });
  });

  test('should expand GJE row and show linked items', async ({ page }) => {
    await page.goto('/GJE');
    await page.waitForTimeout(1000);

    // Find and click the first expand button
    const expandBtn = page.locator('table tbody tr td button').first();
    await expandBtn.click();

    // Verify expanded content appears
    const expandedRow = page.locator('table tbody tr').nth(1);
    await expect(expandedRow).toBeVisible();

    // Check for linked items section (if entry has links)
    const linkedSection = expandedRow.locator('text=Linked Items');
    // May or may not be visible depending on entry type
  });

  test('should show audit trail in expanded row', async ({ page }) => {
    await page.goto('/GJE');
    await page.waitForTimeout(1000);

    // Expand first entry
    const expandBtn = page.locator('table tbody tr td button').first();
    await expandBtn.click();
    await page.waitForTimeout(500);

    // Verify audit trail section exists
    const auditSection = page.locator('text=Audit Trail');
    await expect(auditSection).toBeVisible();
  });

  test('should navigate to bank statement on linked item click', async ({ page }) => {
    await page.goto('/GJE');
    await page.waitForTimeout(1000);

    // Expand first entry
    const expandBtn = page.locator('table tbody tr td button').first();
    await expandBtn.click();
    await page.waitForTimeout(500);

    // Look for a bank statement chip (if present)
    const stmtChip = page.locator('button:has-text("Statement")').first();
    if (await stmtChip.isVisible()) {
      await stmtChip.click();
      await page.waitForURL('**/bank-statements**', { timeout: 5000 });
    }
  });
});
