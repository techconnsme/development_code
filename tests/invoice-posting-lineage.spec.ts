import { test, expect, chromium } from '@playwright/test';

// Non-mutating E2E for the AuditTrailModal popup: audit chain, GL-leg lineage
// map, and posting editor gating — routed through the popup entry buttons.
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

test('TC-LIN-01: audit trail popup renders chain + lineage map for a paid invoice', async ({ page }) => {
  await login(page);
  await page.goto(`${BASE}/ap`);
  // Known paid PnR fixture invoice INV-MT1MBYTQ (has a posted JE + payment link).
  // The AP page mounts a hidden duplicate table (same ids); .first() picks the
  // visible one. The audit-trail button sits in the row's LAST cell (actions td),
  // NOT the expansion row below it — scope the click to the row itself.
  const row = page.locator('#inv-row-i-872c3a1e').first();
  await row.waitFor({ timeout: 15000 });
  await row.getByTestId('audit-trail-btn').click();
  const modal = page.getByTestId('audit-trail-modal'); // mounted once per AP page
  await expect(modal).toBeVisible({ timeout: 15000 });
  await expect(modal.getByTestId('lineage-map')).toBeVisible({ timeout: 15000 });
  await expect(modal.getByTestId('lineage-pivot')).toBeVisible(); // holding account badge
  await expect(modal.getByTestId('audit-chain')).toContainText(/INV-MT1MBYTQ/i);
});

test('TC-LIN-02: popup editor opens with role dropdowns, Save gated, Cancel closes', async ({ page }) => {
  await login(page);
  await page.goto(`${BASE}/ap`);
  const row = page.locator('#inv-row-i-872c3a1e').first();
  await row.waitFor({ timeout: 15000 });
  await row.getByTestId('audit-trail-btn').click();
  const modal = page.getByTestId('audit-trail-modal');
  await expect(modal).toBeVisible({ timeout: 15000 });
  await modal.getByTestId('edit-posting').click();
  const selects = modal.locator('select');
  await expect(selects).toHaveCount(2);
  // ADAPTED vs brief: entering edit mode intentionally SEEDS the draft with the
  // invoice's current classification (AuditTrailModal onClick: setDraft from
  // label/holding JE lines), so on this fully-posted fixture both dropdowns start
  // prefilled and Save starts enabled — not empty/disabled as the brief sketched.
  const saveBtn = modal.getByRole('button', { name: /Save posting/i });
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
  await expect(modal.getByRole('button', { name: /Cancel/i })).toBeEnabled();
  // Cancel discards everything (never saves — shared-DB waiver)
  await modal.getByRole('button', { name: /Cancel/i }).click();
  await expect(modal.locator('select')).toHaveCount(0);
});

test('TC-LIN-03: bank transaction opens popup chain with hops + lineage map', async ({ page }) => {
  await login(page);
  await page.goto(`${BASE}/bank-statements`);
  // ADAPTED vs brief: the generic locator ('main button, div[role="row"], tr') does not
  // match the live DOM — statement headers are div[id^="stmt-row-"] > div, and only ONE
  // statement AND one transaction can be expanded at a time (single expandedId /
  // expandedTxId states). All interactions are read-only UI expansions.
  //
  // ADAPTED vs brief (candidate walk): some CONFIRMED links outlive their bill — a
  // soft-deleted AP invoice keeps its junction row, so its tx still shows the green
  // badge and the 'View audit trail' button, but GET /invoices/:id (correctly) 404s
  // and the popup renders the bank chain WITHOUT GL legs. We therefore try every
  // green-badge row, statement by statement, until one opens a popup WITH a
  // lineage-map (i.e. a live link). Stale candidates are closed, never mutated.
  const stmtRows = page.locator('[id^="stmt-row-"]');
  await stmtRows.first().waitFor({ timeout: 15000 });
  const matchedRows = page.locator('tr[id^="tx-"]').filter({ has: page.locator('span.text-green-700') });
  let modal: any = null;
  const stmtCount = await stmtRows.count();
  outer:
  for (let i = 0; i < stmtCount; i++) {
    await stmtRows.nth(i).locator('> div').first().click();
    // Let the statement detail query finish before sampling its transaction rows
    await stmtRows.nth(i).getByText(/Loading transactions/i)
      .waitFor({ state: 'hidden', timeout: 10000 }).catch(() => {});
    const rowCount = await matchedRows.count();
    for (let j = 0; j < rowCount; j++) {
      // Confirmed invoice links render a green badge whose text is the invoice number;
      // card-statement links never produce this badge, so every candidate here has
      // linked_invoices populated (the gate for the popup button).
      // Click the description cell — several cells stopPropagation and would not expand.
      await matchedRows.nth(j).locator('td').nth(1).click();
      try {
        await page.getByTestId('settles-strip').waitFor({ state: 'visible', timeout: 5000 });
      } catch { continue; } // expansion didn't land on a tx with links — next candidate
      if (!await page.getByTestId('audit-trail-btn').isVisible().catch(() => false)) continue;
      await page.getByTestId('audit-trail-btn').click();
      const m = page.getByTestId('audit-trail-modal');
      await expect(m).toBeVisible({ timeout: 15000 });
      try {
        // Live link → invoice details resolve and GL legs render. Stale link
        // (soft-deleted bill) → 404 leaves the popup chain-only; give the query
        // a bounded window, then discard this candidate.
        await m.getByTestId('lineage-map').first().waitFor({ state: 'visible', timeout: 10000 });
        modal = m;
        break outer;
      } catch {
        await m.locator('button').first().click(); // header ✕ — backdrop click needs the card
        await expect(m).toBeHidden({ timeout: 5000 });
      }
    }
  }
  expect(modal, 'no statement contains a confirmed link to a LIVE invoice (all candidates stale)').not.toBeNull();
  // tx-context chain: statement chip → transaction chip → invoice (with → hops)
  await expect(modal.getByTestId('audit-chain')).toContainText('→');
  // At least one invoice leg rendered (guaranteed by the walk; asserted per brief)
  await expect(modal.getByTestId('lineage-map').first()).toBeVisible({ timeout: 15000 });
});
