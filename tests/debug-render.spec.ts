import { test } from '@playwright/test';

const BASE = 'https://23092956.opcc-crm-testing.pages.dev';

test('Debug: Check render state', async ({ page }) => {
  // Capture ALL console messages
  const logs: string[] = [];
  page.on('console', (msg) => {
    logs.push(`[${msg.type()}] ${msg.text()}`);
  });

  await page.goto(`${BASE}/login`);
  await page.fill('input[type="email"]', 'muhammadruhan.farhan25@nixorcollege.edu.pk');
  await page.fill('input[type="password"]', 'password');
  await page.click('button[type="submit"]');
  await page.waitForFunction(() => !window.location.href.includes('/login'), { timeout: 15000 });
  await page.evaluate(() => {
    localStorage.removeItem('activeClient');
    sessionStorage.removeItem('reviewQueue');
    sessionStorage.removeItem('reviewQueueTotal');
  });

  await page.goto(`${BASE}/bank-statements`);

  // Wait for React to render
  await page.waitForTimeout(8000);

  // Check React Query cache state
  const cacheState = await page.evaluate(() => {
    // Access React Query devtools if available
    const qc = (window as any).__REACT_QUERY_DEVTOOLS__;
    return { hasDevtools: !!qc };
  });

  // Check what text is visible in the main area
  const mainContent = await page.evaluate(() => {
    // Find the main content area (after the sidebar)
    const main = document.querySelector('main') || document.querySelector('.p-6');
    if (!main) return 'No main element found';
    const paragraphs = main.querySelectorAll('p');
    return Array.from(paragraphs).map(p => p.textContent).join(' | ');
  });

  console.log('Main content text:', mainContent);
  console.log('DevTools:', cacheState);

  // Dump console logs (last 20)
  const recentLogs = logs.slice(-20);
  for (const l of recentLogs) console.log(l);

  await page.screenshot({ path: 'test-results/bank-statements-render.png', fullPage: true });
});
