import { test } from '@playwright/test';

const BASE = 'https://23092956.opcc-crm-testing.pages.dev';

test('Debug: Check bank-statements API response', async ({ page }) => {
  // Login first to get token
  await page.goto(`${BASE}/login`);
  await page.fill('input[type="email"]', 'muhammadruhan.farhan25@nixorcollege.edu.pk');
  await page.fill('input[type="password"]', 'password');
  await page.click('button[type="submit"]');
  await page.waitForFunction(() => !window.location.href.includes('/login'), { timeout: 15000 });
  await page.evaluate(() => localStorage.removeItem('activeClient'));

  // Make API call and check response
  const result = await page.evaluate(async () => {
    const token = localStorage.getItem('token');
    const res = await fetch('/api/bank-statements', {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    const data = await res.json();
    return { status: res.status, data };
  });

  console.log('Status:', result.status);
  console.log('Data type:', typeof result.data);
  console.log('Has .data?', result.data && 'data' in result.data);
  if (result.data?.data) {
    console.log('data.data is array?', Array.isArray(result.data.data));
    console.log('data.data length:', result.data.data.length);
  }
  console.log('Full response keys:', Object.keys(result.data || {}));
});
