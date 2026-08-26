import { test, expect, chromium } from '@playwright/test';

// Non-mutating E2E for the invoice posting editor + entry-flow lineage map.
// WAIVER: the posting SAVE path itself is intentionally NOT exercised here —
// saves rewrite shared ground-truth financial data in the test DB. Manual
// verification of save/reset lives in task report §Step 5.

const BASE = process.env.TEST_BASE_URL || 'https://opcc-crm-testing.pages.dev';
const LOGIN_EMAIL = process.env.TEST_EMAIL || 'joseph.lin@pnr.hk';
const LOGIN_PASSWORD = process.env.TEST_PASSWORD || 'Test1234';

// Login hits /api/auth/login which runs pure-JS bcryptjs on the Worker — it sits
// at Cloudflare's CPU ceiling and intermittently returns CF 1102. We therefore
// authenticate ONCE per run and reuse the JWT. Reuse stages at /login (NOT '/',
// whose unauthenticated queries can 401 → api.ts deletes the token).
// The app session mechanism is `Bearer ${localStorage.token}` (frontend api.ts).
let cachedToken: string | null = null;
let cachedUser: string | null = null;
const sleep = (ms: number) => new Promise(res => setTimeout(res, ms));

async function attemptLogin(page: any): Promise<boolean> {
  await page.goto(`${BASE}/login`);
  // Wait out bundle load so the submit handler is actually attached — a click
  // landing before React hydrates is a silent no-op
  await page.waitForLoadState('networkidle').catch(() => {});
  await page.fill('input[type="email"]', LOGIN_EMAIL);
  await page.fill('input[type="password"]', LOGIN_PASSWORD);
  const loginResp = page.waitForResponse(
    (r: any) => r.url().includes('/api/auth/login') && r.request().method() === 'POST'
  ).catch(() => null);
  await page.click('button[type="submit"]');
  try {
    await page.waitForFunction(() => !window.location.href.includes('/login'), null, { timeout: 10000 });
  } catch {
    return false; // silent no-op or worker 1102 — caller retries
  }
  // Prefer the response body (localStorage may already have been cleared by a
  // racing 401 interceptor); fall back to localStorage.
  try {
    const resp = await loginResp;
    if (resp && resp.ok()) {
      const body = await resp.json();
      if (body?.token) {
        cachedToken = body.token;
        cachedUser = body.user ? JSON.stringify(body.user) : null;
        return true;
      }
    }
  } catch { /* fall through */ }
  cachedToken = await page.evaluate(() => localStorage.getItem('token'));
  cachedUser = await page.evaluate(() => localStorage.getItem('user'));
  return !!(cachedToken && cachedUser);
}

// Authenticate ONCE before the run: /api/auth/login runs pure-JS bcryptjs on the
// Worker, which sits at Cloudflare's CPU ceiling and intermittently fails with
// CF 1102. The hook retries patiently; tests then reuse the cached session.
test.beforeAll(async () => {
  if (cachedToken) return;
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    for (let i = 0; i < 12 && !cachedToken; i++) {
      await attemptLogin(page).catch(() => false);
      if (!cachedToken) await sleep(10000);
    }
  } finally {
    await browser.close();
  }
}, 300_000);

async function login(page: any) {
  if (cachedToken) {
    await page.goto(`${BASE}/login`);
    // AuthContext restores the session from BOTH 'token' and 'user' keys
    await page.evaluate(({ t, u }: { t: string; u: string | null }) => {
      localStorage.setItem('token', t);
      if (u) localStorage.setItem('user', u);
      localStorage.setItem('i18nextLng', 'en'); // deterministic English selectors
    }, { t: cachedToken, u: cachedUser });
    return;
  }
  // Fallback (hook should have populated the cache): two quick tries
  for (let i = 0; i < 2; i++) {
    if (await attemptLogin(page)) break;
    if (i === 1) throw new Error('Login unavailable — worker /auth/login repeatedly erroring (CF 1102)');
    await sleep(15000);
  }
  await page.evaluate(() => localStorage.setItem('i18nextLng', 'en')); // deterministic English selectors
}

test('TC-LIN-01: lineage map renders on a paid invoice', async ({ page }) => {
  await login(page);
  await page.goto(`${BASE}/ap`);
  // Known paid PnR fixture invoice INV-MT1MBYTQ (has a posted JE + payment link).
  // The AP page mounts a hidden duplicate table (same ids); .first() picks the visible one.
  const row = page.locator('#inv-row-i-872c3a1e').first();
  await row.waitFor({ timeout: 15000 });
  await row.locator('td').first().click();
  const panel = page.getByTestId('invoice-detail-panel');
  await expect(panel).toBeVisible({ timeout: 15000 });
  await expect(panel.getByTestId('lineage-map')).toBeVisible({ timeout: 15000 });
  await expect(panel.getByTestId('lineage-pivot')).toBeVisible(); // holding account badge
});

test('TC-LIN-02: editor opens with role dropdowns, Save gated, Cancel restores', async ({ page }) => {
  await login(page);
  await page.goto(`${BASE}/ap`);
  const row = page.locator('#inv-row-i-872c3a1e').first();
  await row.waitFor({ timeout: 15000 });
  await row.locator('td').first().click();
  const panel = page.getByTestId('invoice-detail-panel');
  await expect(panel).toBeVisible({ timeout: 15000 });
  await panel.getByTestId('edit-posting').click();
  const selects = panel.locator('select');
  await expect(selects).toHaveCount(2);
  // ADAPTED vs brief: entering edit mode intentionally SEEDS the draft with the
  // invoice's current classification (plan §Task 4: setDraft from label/holding
  // JE lines), so on this fully-posted fixture both dropdowns start prefilled
  // and Save starts enabled — not empty/disabled as the brief sketched.
  const saveBtn = panel.getByRole('button', { name: /Save posting/i });
  // Prefill applies synchronously to the draft (Save enabled at once) but the
  // <option> lists arrive via the async COA query — poll until both selects
  // actually carry their prefilled value (unknown value renders as '')
  await expect(async () => {
    expect(await selects.nth(0).inputValue()).not.toBe('');
    expect(await selects.nth(1).inputValue()).not.toBe('');
  }).toPass({ timeout: 15000 });
  const labelValue = await selects.nth(0).inputValue();
  const holdingValue = await selects.nth(1).inputValue();
  expect(labelValue, 'label role preselected from current JE').not.toBe('');
  expect(holdingValue, 'holding role preselected from current JE').not.toBe('');
  // Gating: clearing a role (placeholder option) must disable Save.
  // ADAPTED vs brief: the brief tried label:=holding to trip the must-differ rule,
  // but the two role pools are disjoint by allowedTypes (revenue/expense vs
  // asset/liability) so no shared option exists — the placeholder reset is the
  // reachable gating path. Nothing is saved either way (shared-DB waiver).
  await selects.nth(1).selectOption('');
  await expect(saveBtn).toBeDisabled();
  await expect(panel.getByRole('button', { name: /Cancel/i })).toBeEnabled();
  // Cancel discards everything (never saves — shared-DB waiver)
  await panel.getByRole('button', { name: /Cancel/i }).click();
  await expect(panel.locator('select')).toHaveCount(0);
});

test('TC-LIN-03: settles strip on a matched bank transaction', async ({ page }) => {
  await login(page);
  await page.goto(`${BASE}/bank-statements`);
  // ADAPTED vs brief: the generic locator ('main button, div[role="row"], tr') does not
  // match the live DOM — statement headers are div[id^="stmt-row-"] > div, and only ONE
  // statement can be expanded at a time (single expandedId state). We therefore walk the
  // statements client-side until we find a confirmed invoice-linked transaction.
  // All interactions are read-only UI expansions; assertions are unchanged.
  const stmtRows = page.locator('[id^="stmt-row-"]');
  await stmtRows.first().waitFor({ timeout: 15000 });
  const matchedRow = page.locator('tr[id^="tx-"]').filter({ has: page.locator('span.text-green-700') }).first();
  const count = await stmtRows.count();
  for (let i = 0; i < count; i++) {
    await stmtRows.nth(i).locator('> div').first().click();
    // Let the statement detail query finish before sampling its transaction rows
    await stmtRows.nth(i).getByText(/Loading transactions/i)
      .waitFor({ state: 'hidden', timeout: 10000 }).catch(() => {});
    try {
      await matchedRow.waitFor({ timeout: 3000 });
      break;
    } catch {
      if (i === count - 1) {
        throw new Error('No statement contains a confirmed invoice-linked transaction (green badge)');
      }
    }
  }
  // Confirmed invoice links render a green badge whose text is the invoice number;
  // card-statement links never produce this badge, so the row below always has an
  // invoice behind it (i.e. linked_invoices is populated).
  // Click the description cell — several cells stopPropagation and would not expand.
  await matchedRow.locator('td').nth(1).click();
  await expect(page.getByTestId('settles-strip')).toBeVisible({ timeout: 15000 });
  await expect(page.getByTestId('settles-strip')).toContainText(/JE-PMT|#\d{4,}|INV|0014|44\d/i);
});
