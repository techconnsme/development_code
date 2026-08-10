import { test, expect } from '@playwright/test';

const BASE = 'https://0a37a767.opcc-crm-testing.pages.dev';
// Using Joseph Lin PNR account
const EMAIL = 'joseph.lin@pnr.hk';
const PASSWORD = 'Test1234';

test.describe('Encrypted PDF Password Flow', () => {

  // Shared helper: navigate to File Storage and expand folders
  async function openFileStorage(page: any) {
    await page.goto(`${BASE}/file-storage`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(3000);
    // Expand ALL collapsible folders by clicking every chevron-right icon
    await page.locator('.lucide-chevron-right').first().click().catch(() => {});
    await page.waitForTimeout(500);
    await page.locator('.lucide-chevron-right').first().click().catch(() => {});
    await page.waitForTimeout(500);
    await page.locator('.lucide-chevron-right').first().click().catch(() => {});
    await page.waitForTimeout(500);
  }

  test.beforeEach(async ({ page }) => {
    // Login
    await page.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
    await page.fill('input[type="email"]', EMAIL);
    await page.fill('input[type="password"]', PASSWORD);
    await page.click('button[type="submit"]');
    await page.waitForFunction(() => !window.location.href.includes('/login'), { timeout: 20000 });
  });

  test('Encrypted badges visible in File Storage', async ({ page }) => {
    await openFileStorage(page);

    const badgeCount = await page.locator('button:has-text("Encrypted"), button:has-text("已加密"), button:has-text("已加密")').count();
    console.log(`Found ${badgeCount} encrypted file badge(s)`);

    expect(badgeCount).toBeGreaterThan(0);
    await page.screenshot({ path: 'test-results/encrypted-badges-visible.png', fullPage: true });
  });

  test('Click encrypted badge opens password modal', async ({ page }) => {
    await openFileStorage(page);

    // Click the first encrypted badge
    await page.locator('button:has-text("Encrypted"), button:has-text("已加密"), button:has-text("已加密")').first().click();
    await page.waitForTimeout(1000);

    // Verify modal appears
    const modal = page.locator('text=Encrypted PDF').first();
    await expect(modal).toBeVisible({ timeout: 5000 });

    // Verify modal elements
    const lockIcon = page.locator('.lucide-lock').first();
    await expect(lockIcon).toBeVisible();

    const passwordInput = page.locator('input[type="password"]');
    await expect(passwordInput).toBeVisible();

    const unlockBtn = page.locator('button:has-text("Unlock")').first();
    await expect(unlockBtn).toBeVisible();

    const cancelBtn = page.locator('button:has-text("Cancel")').first();
    await expect(cancelBtn).toBeVisible();

    await page.screenshot({ path: 'test-results/password-modal-open.png' });
  });

  test('Wrong password shows error message', async ({ page }) => {
    await openFileStorage(page);

    // Open modal
    await page.locator('button:has-text("Encrypted"), button:has-text("已加密"), button:has-text("已加密")').first().click();
    await page.waitForTimeout(1000);

    // Type wrong password
    const passwordInput = page.locator('input[type="password"]');
    await passwordInput.fill('wrongpassword123');
    await page.waitForTimeout(300);

    // Click unlock
    const unlockBtn = page.locator('button:has-text("Unlock")').first();
    await unlockBtn.click();
    await page.waitForTimeout(3000);

    // Should show error message
    const errorMsg = page.locator('text=Wrong password').first();
    await expect(errorMsg).toBeVisible({ timeout: 10000 });

    await page.screenshot({ path: 'test-results/wrong-password-error.png' });
  });

  test('Cancel button dismisses modal', async ({ page }) => {
    await openFileStorage(page);

    // Open modal
    await page.locator('button:has-text("Encrypted"), button:has-text("已加密"), button:has-text("已加密")').first().click();
    await page.waitForTimeout(1000);

    // Verify modal is open
    await expect(page.locator('text=Encrypted PDF').first()).toBeVisible();

    // Click Cancel
    const cancelBtn = page.locator('button:has-text("Cancel")').first();
    await cancelBtn.click();
    await page.waitForTimeout(500);

    // Modal should be gone
    const modal = page.locator('text=Encrypted PDF').first();
    await expect(modal).not.toBeVisible({ timeout: 3000 });

    await page.screenshot({ path: 'test-results/modal-dismissed.png', fullPage: true });
  });

  test('Empty password field disables Unlock button', async ({ page }) => {
    await openFileStorage(page);

    // Open modal
    await page.locator('button:has-text("Encrypted"), button:has-text("已加密"), button:has-text("已加密")').first().click();
    await page.waitForTimeout(1000);

    // Unlock button should be disabled with empty password
    const unlockBtn = page.locator('button:has-text("Unlock")').first();
    await expect(unlockBtn).toBeDisabled();

    // Type something — button should enable
    const passwordInput = page.locator('input[type="password"]');
    await passwordInput.fill('test');
    await page.waitForTimeout(300);

    await expect(unlockBtn).toBeEnabled();

    // Clear — button should disable again
    await passwordInput.fill('');
    await page.waitForTimeout(300);
    await expect(unlockBtn).toBeDisabled();

    await page.screenshot({ path: 'test-results/unlock-disabled-empty.png' });
  });

  test('Closing by clicking backdrop works', async ({ page }) => {
    await openFileStorage(page);

    // Open modal
    await page.locator('button:has-text("Encrypted"), button:has-text("已加密"), button:has-text("已加密")').first().click();
    await page.waitForTimeout(1000);

    // Verify modal is open
    await expect(page.locator('text=Encrypted PDF').first()).toBeVisible();

    // Click the backdrop (semi-transparent overlay)
    const backdrop = page.locator('.fixed.inset-0.bg-black\\/50').first();
    await backdrop.click({ position: { x: 10, y: 10 } });
    await page.waitForTimeout(500);

    // Modal should be gone
    const modal = page.locator('text=Encrypted PDF').first();
    await expect(modal).not.toBeVisible({ timeout: 3000 });

    await page.screenshot({ path: 'test-results/backdrop-dismiss.png' });
  });

});
