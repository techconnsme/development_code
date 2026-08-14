# Invoice Channel Split — Sales/Purchase Invoice + Cash Payment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split the File Upload `Bank-TXN Invoice` channel into Sales Invoice (forces outgoing) and Purchase Invoice (forces incoming) with direction-based mismatch detection, and rename `Cash Invoice` → `Cash Payment` (label only).

**Architecture:** Channels live entirely in `frontend/src/pages/FileUpload.tsx`. The mismatch dialog gains a direction-based trigger for the two new channels: when OCR's `result.direction` contradicts the chosen tab, the dialog shows the opposing invoice channel as the detected name. Force re-imports with a new optional `direction` query param on `POST /file-storage/:id/import-document`, threaded to `importInvoiceFromFile`.

**Tech Stack:** TypeScript, React, Playwright (`tests/` config; regression specs live in `regression-tests/`), Cloudflare Workers (Hono), Cloudflare Pages.

## Global Constraints

- All user-facing strings trilingual via `tr('English', '繁體中文', '简体中文')`.
- TDD: every behavior change gets a failing test first, run and watched failing, then implemented.
- E2E tests run against the DEPLOYED app (`https://opcc-crm-testing.pages.dev`); RED/GREEN spans a deployment.
- Deploy frontend: `cd frontend && export CLOUDFLARE_ACCOUNT_ID=8c00cc4647a9cf5d8deb5d6a354001e0 && npm run build && npx wrangler pages deploy dist --project-name=opcc-crm-testing --branch=main`
- Deploy API: `cd api && export CLOUDFLARE_ACCOUNT_ID=8c00cc4647a9cf5d8deb5d6a354001e0 && npx wrangler deploy`
- Regression scope for this change: the `regression-tests/` folder (run via `npx playwright test regression-tests/`).
- Tests are gitignored (`tests/` in `.gitignore`); commit them with `git add -f`.
- Commits on `main` (user-approved workflow), push at the end. Test account: demo supervisor `muhammadruhan.farhan25@nixorcollege.edu.pk` / `password`; samples in `C:/Users/samue/Documents/Pastel/Tech_Connect_SME/test-samples-generated-demo-company`.
- Playwright: 1 worker, 300s test timeout; OCR uploads take ~40-90s each.

---

### Task 1: Frontend — channels, labels, direction mismatch

**Files:**
- Modify: `frontend/src/pages/FileUpload.tsx`
- Test: `regression-tests/regression-invoice-direction.spec.ts` (new)

**Interfaces:**
- Produces: `UploadChannel` now includes `'sales_invoice' | 'purchase_invoice'` (no `bank_invoice`); `ChannelDef` gains optional `direction?: 'outgoing' | 'incoming'`; mismatch dialog receives `detectedType` values `'purchase_invoice' | 'sales_invoice'` (labels only — switch/force logic keys off `result.type`).
- Consumes: Task 2's API `direction` query param (Force path) — TC-DIR-02 will fail RED until Task 2 lands (expected).

- [ ] **Step 1: Write the failing test**

Create `regression-tests/regression-invoice-direction.spec.ts`:

```ts
import { test, expect } from '@playwright/test';
import path from 'path';
import fs from 'fs';
import os from 'os';

const BASE = process.env.TEST_BASE_URL || 'https://opcc-crm-testing.pages.dev';
const LOGIN_EMAIL = process.env.TEST_EMAIL || 'muhammadruhan.farhan25@nixorcollege.edu.pk';
const LOGIN_PASSWORD = process.env.TEST_PASSWORD || 'password';
const SAMPLES = process.env.TEST_SAMPLES_DIR || 'C:/Users/samue/Documents/Pastel/Tech_Connect_SME/test-samples-generated-demo-company';

async function login(page: any) {
  await page.goto(`${BASE}/login`);
  await page.fill('input[type="email"]', LOGIN_EMAIL);
  await page.fill('input[type="password"]', LOGIN_PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForFunction(() => !window.location.href.includes('/login'), { timeout: 30000 });
  await page.evaluate(() => {
    localStorage.removeItem('activeClient');
    localStorage.setItem('i18nextLng', 'en'); // deterministic English selectors
  });
}

function copyUniqueSample(): string {
  const uniqueName = `DIR_TEST_${Date.now()}.pdf`;
  const tmpPath = path.join(os.tmpdir(), uniqueName);
  fs.copyFileSync(path.join(SAMPLES, 'BILL_IN_INV-FEDEX-2026-0812_FedEx_Express_Hong_Kong.pdf'), tmpPath);
  return tmpPath;
}

test.describe('Invoice direction channels', () => {
  test('TC-DIR-01: purchase invoice under Sales Invoice tab shows mismatch, cancel rolls back', async ({ page }) => {
    const tmpPath = copyUniqueSample();
    try {
      await login(page);
      await page.goto(`${BASE}/file-upload`);
      await expect(page.locator('h2').filter({ hasText: 'File Upload' }).first()).toBeVisible({ timeout: 10000 });

      // Pick Sales Invoice — the sample is an incoming (purchase) invoice
      await page.locator('button').filter({ hasText: /^Sales Invoice$/ }).first().click();

      const fileInput = page.locator('input[type="file"]').first();
      await fileInput.setInputFiles(tmpPath);
      await page.getByText('Upload & Analyze').click();

      // Mismatch dialog appears and names the detected direction
      await expect(page.getByText('Document Type Mismatch')).toBeVisible({ timeout: 240000 });
      await expect(page.getByText(/Purchase Invoice/).first()).toBeVisible();

      // Cancel must roll back the uploaded file
      await page.getByText('Cancel', { exact: true }).click();
      await expect(page.getByText('Document Type Mismatch')).toBeHidden({ timeout: 10000 });
      await page.waitForTimeout(3000);

      const fileListJson = await page.evaluate(async () => JSON.stringify(await (await fetch('/api/file-storage')).json()));
      expect(fileListJson).not.toContain(path.basename(tmpPath));
    } finally {
      try { fs.unlinkSync(tmpPath); } catch {}
    }
  });

  test('TC-DIR-02: Force keeps the chosen direction (Sales Invoice → outgoing)', async ({ page }) => {
    const tmpPath = copyUniqueSample();
    try {
      await login(page);
      await page.goto(`${BASE}/file-upload`);
      await expect(page.locator('h2').filter({ hasText: 'File Upload' }).first()).toBeVisible({ timeout: 10000 });

      await page.locator('button').filter({ hasText: /^Sales Invoice$/ }).first().click();
      const fileInput = page.locator('input[type="file"]').first();
      await fileInput.setInputFiles(tmpPath);
      await page.getByText('Upload & Analyze').click();

      await expect(page.getByText('Document Type Mismatch')).toBeVisible({ timeout: 240000 });
      await page.getByText(/Force as/).click();

      // Re-import finishes; the file row must carry direction = outgoing
      await page.waitForFunction(() => {
        const body = document.body.textContent || '';
        return !body.includes('Re-importing as');
      }, { timeout: 240000 });
      await page.waitForTimeout(5000);

      const data = await page.evaluate(async () => await (await fetch('/api/file-storage')).json());
      const row = (data?.data || []).find((f: any) => f.filename === path.basename(tmpPath));
      expect(row?.direction).toBe('outgoing');
    } finally {
      try { fs.unlinkSync(tmpPath); } catch {}
    }
  });
});
```

- [ ] **Step 2: Run the test to verify it fails (RED)**

Run: `cd C:/Users/samue/Documents/Pastel/Tech_Connect_SME/Development_code/latest_code && npx playwright test regression-tests/regression-invoice-direction.spec.ts`
Expected: FAIL — no `Sales Invoice` tab exists (deployed app still has `Bank-TXN Invoice`), so the click times out.

- [ ] **Step 3: Implement the frontend changes**

In `frontend/src/pages/FileUpload.tsx`:

(a) Channel type (line 14):
```ts
type UploadChannel = 'bank_statement' | 'card_statement' | 'sales_invoice' | 'purchase_invoice' | 'cash_invoice' | 'petty_cash' | 'others';
```

(b) `ChannelDef` interface — add optional direction:
```ts
interface ChannelDef {
  key: UploadChannel;
  label: string;
  labelZh: string;
  labelCn: string;
  folder: string;
  category: string;
  direction?: 'outgoing' | 'incoming';
}
```

(c) CHANNELS array — replace the two invoice rows (lines 28-29) with:
```ts
  { key: 'sales_invoice', label: 'Sales Invoice', labelZh: '銷售發票', labelCn: '销售发票', folder: 'Invoices', category: 'invoice', direction: 'outgoing' },
  { key: 'purchase_invoice', label: 'Purchase Invoice', labelZh: '採購發票', labelCn: '采购发票', folder: 'Invoices', category: 'invoice', direction: 'incoming' },
  { key: 'cash_invoice', label: 'Cash Payment', labelZh: '現金付款', labelCn: '现金付款', folder: 'Invoices', category: 'cash_invoice' },
```

(d) Mismatch block (currently `if (detectedType && detectedType !== channel) {` with `isInvoiceChannel = channel === 'bank_invoice' || channel === 'cash_invoice'`) — replace with:
```ts
    // Direction-based mismatch for invoice channels: detected direction must agree with the chosen tab
    const invoiceDirectionMismatch = (channel === 'sales_invoice' || channel === 'purchase_invoice')
      && detectedType === 'invoice'
      && !!result?.direction
      && result.direction !== channelDef.direction;
    const mismatchDetectedChannelKey = invoiceDirectionMismatch
      ? (result.direction === 'incoming' ? 'purchase_invoice' : 'sales_invoice')
      : detectedType;

    if ((detectedType && detectedType !== channel) || invoiceDirectionMismatch) {
      const isInvoiceChannel = channel === 'sales_invoice' || channel === 'purchase_invoice' || channel === 'cash_invoice';
      const isInvoiceDetected = detectedType === 'invoice';
      if (!(isInvoiceChannel && isInvoiceDetected && !invoiceDirectionMismatch)) {
        const action = await showMismatchDialog({
          channel: channelDef,
          detectedType: mismatchDetectedChannelKey,
          inferredValues: extractInferredValues(result),
          fileId,
          result,
          fileName: file.name,
        });
```
(The switch/cancel branches below stay as-is; the force branch gets the direction param in (e).)

(e) Force branch — inside the existing `if (action === 'force') {` block, replace the fetch URL construction:
```ts
          setProcessingMsg(tr(`Re-importing as ${channelLabel(channelDef)}…`, `重新匯入為${channelLabel(channelDef)}…`, `重新汇入为${channelLabel(channelDef)}…`));
          const forcedType = channel === 'sales_invoice' || channel === 'purchase_invoice' ? 'invoice' : channel;
          const directionParam = channelDef.direction ? `&direction=${channelDef.direction}` : '';
          const forceResp = await fetch(
            `${WORKER_API_BASE}/file-storage/${fileId}/import-document?force=true&type=${encodeURIComponent(forcedType)}${directionParam}`,
            { method: 'POST', headers }
          );
```

(f) Routing block (line 375): `} else if ((channel === 'bank_invoice' || channel === 'cash_invoice') && result?.invoice_id) {` →
```ts
    } else if ((channel === 'sales_invoice' || channel === 'purchase_invoice' || channel === 'cash_invoice') && result?.invoice_id) {
```

- [ ] **Step 4: Build and deploy the frontend**

Run: `cd frontend && export CLOUDFLARE_ACCOUNT_ID=8c00cc4647a9cf5d8deb5d6a354001e0 && npm run build && npx wrangler pages deploy dist --project-name=opcc-crm-testing --branch=main`
Expected: build passes; deployment URL printed.

- [ ] **Step 5: Run the new spec — TC-DIR-01 must pass; TC-DIR-02 still fails (API pending)**

Run: `npx playwright test regression-tests/regression-invoice-direction.spec.ts`
Expected: `TC-DIR-01` PASSES (dialog + cancel rollback). `TC-DIR-02` FAILS — Force re-imports without the direction param, so the row stays `incoming`. This is the expected RED for Task 2; record it.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/pages/FileUpload.tsx && git add -f regression-tests/regression-invoice-direction.spec.ts
git commit -m "feat: split invoice upload channels into Sales/Purchase with direction mismatch detection"
```
(Note: `regression-tests/` is NOT gitignored — only `tests/` is; verify with `git check-ignore`.)

---

### Task 2: API — direction override on import-document

**Files:**
- Modify: `api/src/routes/file-storage.ts` (import-document route ~line 3215; `importInvoiceFromFile` signature line 1099, direction computation line 1682, return line 1785; three call sites at lines 3365, 3373, 3525)

**Interfaces:**
- Consumes: frontend Force request `POST /file-storage/{id}/import-document?force=true&type=invoice&direction=outgoing|incoming`.
- Produces: `importInvoiceFromFile(..., directionOverride?: string | null)` — 8th param, optional; `direction` in the result reflects the override; `needs_direction_review` is false when an override is present.

- [ ] **Step 1: Confirm TC-DIR-02 RED** (already run in Task 1 Step 5 — reuse that failure as evidence; do not re-run)

- [ ] **Step 2: Implement the API change**

(a) Signature (line 1099-1101):
```ts
async function importInvoiceFromFile(
  fileId: string, userId: string, db: D1Database, fileBucket: R2Bucket, ai: any, deepseekKey: string, glmApiKey?: string,
  directionOverride?: string | null,
): Promise<{ success: boolean; invoice_id?: string; error?: string; items_count?: number; ocr_failed?: boolean; parsed?: any }> {
```

(b) Direction computation (line 1682):
```ts
  const direction = directionOverride || (isReceipt ? 'incoming' : (isIncoming ? 'incoming' : 'outgoing'));
```

(c) Return (line 1785):
```ts
    needs_direction_review: directionOverride ? false : needsDirectionReview,
```

(d) import-document route (after line 3220, next to the existing `const force = ...`):
```ts
  const directionQuery = c.req.query('direction');
  const directionOverride = (directionQuery === 'outgoing' || directionQuery === 'incoming') ? directionQuery : null;
```

(e) Pass the override at the three import-document call sites — append `, directionOverride` as the final argument:
- line ~3365 (`forcedType === 'invoice'` branch): `importInvoiceFromFile(fileId, tenantId, db, c.env.FILE_BUCKET, c.env.AI, c.env.DEEPSEEK_API_KEY, c.env.GLM_API_KEY, directionOverride)`
- line ~3373 (`filenameInvoice > filenameBank` branch): same append
- line ~3525 (detected-invoice branch): same append

Other call sites (2161, 2266, 2390, 2660, 2685, 3592) are untouched — the param is optional.

- [ ] **Step 3: Deploy the API worker**

Run: `cd api && export CLOUDFLARE_ACCOUNT_ID=8c00cc4647a9cf5d8deb5d6a354001e0 && npx wrangler deploy`
Expected: new version ID printed.

- [ ] **Step 4: Run the new spec — both tests must pass (GREEN)**

Run: `npx playwright test regression-tests/regression-invoice-direction.spec.ts`
Expected: `TC-DIR-01` and `TC-DIR-02` both PASS.

- [ ] **Step 5: Commit**

```bash
git add api/src/routes/file-storage.ts
git commit -m "feat: direction override param on import-document for forced invoice direction"
```

---

### Task 3: Update existing regression specs + run suite + debug

**Files:**
- Modify: `regression-tests/regression-full-flow.spec.ts` (lines 106, 134, 150)
- Modify: `regression-tests/regression-language-switch.spec.ts` (line 20)
- Modify: `regression-tests/regression-review-buttons.spec.ts` (line 23)

- [ ] **Step 1: Update tab references**

`regression-tests/regression-full-flow.spec.ts`:
- Line 106 (test 2, AP = incoming, file `Pastel/01383 - invoice#001397.pdf`): `'Bank-TXN Invoice'` → `'Purchase Invoice'`
- Line 134 (test 3, AR = outgoing, file `VEII/Invoice 2025001.pdf`): `'Bank-TXN Invoice'` → `'Sales Invoice'`
- Line 150 (test 4, receipt = incoming, file `Pastel/001397-receipt#001260.pdf`): `'Bank-TXN Invoice'` → `'Purchase Invoice'`

`regression-tests/regression-language-switch.spec.ts` line 20:
```ts
  const tab = page.locator('button').filter({ hasText: /Bank-TXN|銀行交易/i }).first();
```
→
```ts
  const tab = page.locator('button').filter({ hasText: /Sales Invoice|銷售發票/i }).first();
```

`regression-tests/regression-review-buttons.spec.ts` line 23 (sample `BILL_IN_INV-FEDEX-...` is incoming):
```ts
  const tab = page.locator('button').filter({ hasText: /Bank-TXN|銀行交易/i }).first();
```
→
```ts
  const tab = page.locator('button').filter({ hasText: /Purchase Invoice|採購發票/i }).first();
```

- [ ] **Step 2: Run the regression suite**

Run: `npx playwright test regression-tests/`
Expected: all specs pass. Each spec uploads real documents — the run takes ~15-30 min with 1 worker.

- [ ] **Step 3: Debug failures to green**

For any failure: read the error + `test-results/**/error-context.md`; distinguish test-selector issues (fix the spec) from app regressions (fix the app code, redeploy per the deploy commands, re-run just the failing spec). Re-run the failing spec until green, then re-run the full `regression-tests/` folder once more.

- [ ] **Step 4: Commit + push**

```bash
git add regression-tests/ && git commit -m "test: update regression specs for Sales/Purchase invoice channels"
git push origin main
```

---

## Self-Review Notes

- Spec coverage: channels/labels ✅ (Task 1c), direction mismatch + detected names ✅ (Task 1d), Force direction ✅ (Task 1e + Task 2), cancel rollback ✅ (Task 1 test, relies on shipped cancel-delete), Cash Payment label-only ✅ (Task 1c — behavior paths unchanged), regression updates + run + debug ✅ (Task 3), deploys + both URLs ✅.
- Placeholder scan: none — all code blocks concrete.
- Type consistency: `directionOverride` optional 8th param; call sites append-only; `mismatchDetectedChannelKey` feeds only the dialog label (switch/force use `detectedType`/`channelDef.direction`). Frontend force URL `type=invoice&direction=...` matches Task 2's query parsing.
