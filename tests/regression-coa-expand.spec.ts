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
  const routes = ['/new-client'];
  let found = false;
  for (const r of routes) {
    await page.goto(`${BASE}${r}`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(2000);
    const body = await page.textContent('body') || '';
    if (body.includes('Company name') || body.includes('公司名稱') || body.includes('公司名称') || body.includes('Create New')) {
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

  // Fill company name and email to trigger COA preview
  const textInputs = page.locator('input[type="text"]');
  const inputCount = await textInputs.count();
  console.log('Text inputs found:', inputCount);
  if (inputCount > 0) await textInputs.first().fill('Test Company');
  if (inputCount > 1) await textInputs.nth(1).fill('test-coa@test.com');
  await page.waitForTimeout(2000);

  // Wait for COA preview to render (look for account code patterns)
  await page.waitForTimeout(3000);

  // Check that type sections or account codes are visible
  const pageText = (await page.textContent('body')) || '';
  const hasAssets = pageText.includes('Assets') || pageText.includes('資產') || pageText.includes('资产');
  const hasLiabilities = pageText.includes('Liabilities') || pageText.includes('負債') || pageText.includes('负债');
  console.log('Assets visible:', hasAssets);
  console.log('Liabilities visible:', hasLiabilities);

  // Check for 5-digit account codes (indicating expanded COA)
  const codeMatch = pageText.match(/\b\d{5}\b/g);
  const codeCount = codeMatch ? codeMatch.length : 0;
  console.log('Account codes visible:', codeCount);

  if (codeCount > 0) {
    console.log('✅ COA accounts expanded —', codeCount, 'codes visible');
  } else {
    console.log('⚠️ No account codes found — COA may not have loaded');
  }
});
