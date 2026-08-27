# File Upload → Always File Storage + Per-File Status Badges — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** After every File Upload, land on File Storage (never bookkeeping/review pages), and show a summary + underlying-record status badge for every file in File Storage.

**Architecture:** Two frontend-only changes. (1) In `FileUpload.tsx`, every upload calls `uploadFile` with `skipNavigation=true` so anything needing review is queued in `sessionStorage.reviewQueue` instead of navigated to; `handleUpload` then unconditionally routes to `/file-storage`. (2) In `FileStorage.tsx`, derive per-file summary/record statuses from fields the existing `GET /file-storage` API already returns (`ocr_status`, `invoice_status`, `invoice_needs_review`, `stmt_status`, `card_status`, and the link ids) and render badges in each folder-tree row.

**Tech Stack:** React 18, React Router 6, TanStack Query, TypeScript, Tailwind CSS, i18next (en / zh-Hant / zh-Hans via `tr()`), Playwright regression tests (against the deployed `opcc-crm-testing.pages.dev`).

## Global Constraints

- **No backend changes.** `api/src/routes/file-storage.ts` already returns every field needed (`GET /file-storage` at lines 2019-2032). Do not modify the API or DB.
- **No new dependencies.** Use existing imports and `tr()` from `frontend/src/lib/i18nHelpers.ts`.
- All new user-facing labels must be trilingual via `tr(en, zhHant, zhHans)` and follow the existing badge class pattern `bg-{color}-100 text-{color}-700 dark:bg-{color}-900/30 dark:text-{color}-300`.
- File Storage's own inline upload flow (uploads started from the File Storage page) keeps today's behavior — out of scope.
- Verification = `cd frontend && npm run build` (runs `tsc -b && vite build`). There is no frontend unit-test framework; the regression specs run against the deployed site and are the acceptance suite.

---

### Task 1: FileUpload — always land on File Storage

**Files:**
- Modify: `frontend/src/pages/FileUpload.tsx:502-509` (batch init), `:522` (skipNavigation call), `:571-621` (routing/toast)

**Interfaces:**
- Consumes: existing `uploadFile(file, skipNavigation, fileIndex, totalFiles)`, `pushToQueue(...)`, `nav`, `tr`, `toast`, `storedTokens`, `reviewCount`, `ok`, `encryptedCount`, `hasError`.
- Produces: `handleUpload` always ends with `setTimeout(() => nav('/file-storage'), 800)` when `ok > 0`; files needing review stay queued in `sessionStorage.reviewQueue` for the File Storage banner.

- [ ] **Step 1: Make batch-state init unconditional (remove the `isBatch` guard)**

Replace lines 502-509:

```tsx
    const isBatch = files.length > 1;

    if (isBatch) {
      batchRef.current = { total: files.length, done: 0, bank: 0, invoice: 0, card: 0 };
      setBatchProgress({ done: 0, total: files.length, currentFile: '' });
      clearTokenUsage();
      setTokenCardDismissed(false);
      sessionStorage.removeItem('reviewQueue');
      sessionStorage.removeItem('reviewQueueTotal');
    }
```

with:

```tsx
    const isBatch = files.length > 1;

    batchRef.current = { total: files.length, done: 0, bank: 0, invoice: 0, card: 0 };
    setBatchProgress({ done: 0, total: files.length, currentFile: '' });
    clearTokenUsage();
    setTokenCardDismissed(false);
    sessionStorage.removeItem('reviewQueue');
    sessionStorage.removeItem('reviewQueueTotal');
```

(`isBatch` stays — still used by the error counter at line 537.)

- [ ] **Step 2: Always skip navigation inside `uploadFile`**

Replace line 522:

```tsx
        const status = await uploadFile(file, isBatch, idx, files.length);
```

with:

```tsx
        const status = await uploadFile(file, true, idx, files.length);
```

- [ ] **Step 3: Replace the routing block with an unconditional `/file-storage` route**

Replace lines 571-621 (the whole `if (ok > 0) { ... }` body) with:

```tsx
    if (ok > 0) {
      queryClient.invalidateQueries({ queryKey: ['file-storage'] });
      queryClient.invalidateQueries({ queryKey: ['accounts'] });
      queryClient.invalidateQueries({ queryKey: ['bookkeeping'] });

      if (batchRef.current.bank > 0 || batchRef.current.card > 0) {
        try { await api('/bookkeeping/auto-generate-entries', { method: 'POST' }); } catch {}
      }

      // Always land on File Storage. Files that need review stay queued in
      // sessionStorage.reviewQueue and surface via the banner on that page.
      if (reviewCount > 0) {
        toast.success(tr(
          `${reviewCount} file(s) need review. ${ok - reviewCount} auto-saved.`,
          `${reviewCount} 個文件需要審核。${ok - reviewCount} 個已自動儲存。`,
          `${reviewCount} 个文件需要审核。${ok - reviewCount} 个已自动储存。`,
        ));
      } else {
        toast.success(tr(
          `Successfully processed and saved ${ok} file(s)${storedTokens?.total > 0 ? ` · Tokens: ~${storedTokens.total.toLocaleString()}` : ''}.`,
          `已成功處理並儲存 ${ok} 個文件${storedTokens?.total > 0 ? ` · Tokens: ~${storedTokens.total.toLocaleString()}` : ''}。`,
          `已成功处理并储存 ${ok} 个文件${storedTokens?.total > 0 ? ` · Tokens: ~${storedTokens.total.toLocaleString()}` : ''}。`,
        ));
      }
      setTimeout(() => nav('/file-storage'), 800);
    }
```

Note: the old code removed `reviewQueue` in the success path; the new code intentionally keeps it when `reviewCount > 0` so the File Storage banner works. When `reviewCount === 0` nothing was pushed, so nothing to clean up.

- [ ] **Step 4: Build to verify**

Run: `cd frontend && npm run build`
Expected: PASS (tsc + vite). If TypeScript flags an unused import/variable (e.g. `ArrowRight` if you removed mismatch code — you didn't), leave imports as-is; nothing else changed.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/pages/FileUpload.tsx
git commit -m "feat(upload): always route to File Storage after upload"
```

---

### Task 2: FileStorage — summary + underlying-record status badges

**Files:**
- Modify: `frontend/src/pages/FileStorage.tsx:36-41` (after `fileIcon`), `:179-212` (file-row metadata)

**Interfaces:**
- Consumes: `FileItem` fields already typed at `FileStorage.tsx:64-92` (`ocr_status`, `invoice_id`, `invoice_status`, `invoice_needs_review`, `statement_id`, `stmt_status`, `card_statement_id`, `card_status`), `tr()`.
- Produces: two helpers, `summaryStatus(f: FileItem)` and `recordStatus(f: FileItem)`, both returning `null` or `{ label, labelZh, labelCn, cls? }`. Later tasks only rely on the two helpers rendering badges.

- [ ] **Step 1: Add the status helpers after `fileIcon` (line 41)**

Insert these two functions between `fileIcon` and `autoFolder`:

```tsx
// Summary status badge — priority order per spec (see design doc).
function summaryStatus(f: FileItem): { label: string; labelZh: string; labelCn: string; cls: string } | null {
  if (f.ocr_status === 'encrypted') return null; // rendered as the existing unlock button
  if (f.ocr_status === 'processing' || f.ocr_status === 'pending') {
    return { label: 'Processing', labelZh: '處理中', labelCn: '处理中', cls: 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300' };
  }
  if (f.ocr_status === 'failed' || f.ocr_status === 'unclear') {
    return { label: 'Could not read', labelZh: '無法讀取', labelCn: '无法读取', cls: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300' };
  }
  const needsReview =
    (f.invoice_id && (f.invoice_needs_review || f.invoice_status === 'pending_review')) ||
    (f.statement_id && (f.stmt_status === 'draft' || f.stmt_status === 'pending_review')) ||
    (f.card_statement_id && f.card_status === 'draft');
  if (needsReview) {
    return { label: 'Needs Review', labelZh: '需審核', labelCn: '需审核', cls: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300' };
  }
  if (f.invoice_id || f.statement_id || f.card_statement_id) {
    return { label: 'Processed', labelZh: '已處理', labelCn: '已处理', cls: 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300' };
  }
  return { label: 'Stored', labelZh: '已儲存', labelCn: '已储存', cls: 'bg-gray-100 text-gray-700 dark:bg-gray-900/30 dark:text-gray-300' };
}

const RECORD_STATUS_LABELS: Record<string, { en: string; zhHant: string; zhHans: string }> = {
  draft: { en: 'Draft', zhHant: '草稿', zhHans: '草稿' },
  pending_review: { en: 'Pending Review', zhHant: '待審核', zhHans: '待审核' },
  active: { en: 'Active', zhHant: '有效', zhHans: '有效' },
  sent: { en: 'Sent', zhHant: '已寄出', zhHans: '已寄出' },
  paid: { en: 'Paid', zhHant: '已付款', zhHans: '已付款' },
};

function recordStatus(f: FileItem): { label: string; labelZh: string; labelCn: string } | null {
  const raw = f.invoice_id ? f.invoice_status : f.statement_id ? f.stmt_status : f.card_statement_id ? f.card_status : null;
  if (!raw) return null;
  const m = RECORD_STATUS_LABELS[raw];
  return m ? { label: m.en, labelZh: m.zhHant, labelCn: m.zhHans } : { label: raw, labelZh: raw, labelCn: raw };
}
```

- [ ] **Step 2: Render the two badges in each file row**

In the file-row metadata `<div className="flex items-center gap-2 text-xs text-muted-foreground">` (currently `FileStorage.tsx:179-212`), insert immediately after the `FileTimeLabel` line (line 181) and before the invoice direction badge (line 182):

```tsx
                    {(() => { const s = summaryStatus(f); return s ? (
                      <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${s.cls}`}>{tr(s.label, s.labelZh, s.labelCn)}</span>
                    ) : null; })()}
                    {(() => { const r = recordStatus(f); return r ? (
                      <span className="px-1.5 py-0.5 rounded text-[10px] font-medium border border-border text-muted-foreground"
                        title={tr('Linked record status', '關聯記錄狀態', '关联记录状态')}>{tr(r.label, r.labelZh, r.labelCn)}</span>
                    ) : null; })()}
```

- [ ] **Step 3: Build to verify**

Run: `cd frontend && npm run build`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/pages/FileStorage.tsx
git commit -m "feat(filestorage): show summary and record status badges per file"
```

---

### Task 3: Update regression tests — full flow bank-statement branch

**Files:**
- Modify: `regression-tests/regression-full-flow.spec.ts:91-112`

**Interfaces:**
- Consumes: new post-upload landing on `/file-storage`; existing File Storage queue banner text `queued for review` and `Review Now` button (`FileStorage.tsx:858-883`).

- [ ] **Step 1: Rework test 1 to land on File Storage first**

Replace lines 91-112 (the `waitForURL` + branch):

```ts
    // Statements that need no review are auto-saved and land on the list;
    // reviewable ones go to the review page. Branch on which route we got.
    await page.waitForURL(/\/bank-statements(\/review\/[^/]+)?$/, { timeout: 60000 });
    const url = page.url();

    if (/\/bank-statements\/review\//.test(url)) {
      // Review page — the statement was read successfully: extracted fields shown
      const body = await page.textContent('body');
      expect(body).not.toContain('Could not read this file');
      await expect(page.locator('input').first()).toBeVisible({ timeout: 10000 });
      console.log('✅ Bank statement review page loaded (extracted fields visible)');
    } else {
      // Auto-saved to the list — the statement row must be present. The page
      // defaults to the most recent completed fiscal year (25-26), which
      // excludes the Feb-2025 statement; switch to FY 2024-2025 first.
      await page.evaluate(() => localStorage.setItem('globalFiscalYear', '2024-2025'));
      await page.reload({ waitUntil: 'networkidle' });
      const body = await page.textContent('body');
      expect(body).not.toContain('Could not read this file');
      await expect(page.getByText(/HSBC|eStatement/).first()).toBeVisible({ timeout: 15000 });
      console.log('✅ Bank statement auto-saved (row visible in list)');
    }
```

with:

```ts
    // Uploads always land on File Storage. If the statement needs review, the
    // "queued for review" banner appears there — click Review Now to open it.
    // Otherwise the statement was auto-saved to the Bank Statements list.
    await page.waitForURL(/\/file-storage/, { timeout: 60000 });

    const banner = page.locator('text=/queued for review/');
    if (await banner.isVisible({ timeout: 15000 }).catch(() => false)) {
      await page.getByRole('button', { name: /Review Now/ }).click();
      await page.waitForURL(/\/bank-statements\/review\//, { timeout: 60000 });
      const body = await page.textContent('body');
      expect(body).not.toContain('Could not read this file');
      await expect(page.locator('input').first()).toBeVisible({ timeout: 10000 });
      console.log('✅ Bank statement review page loaded (extracted fields visible)');
    } else {
      // Auto-saved to the list — the statement row must be present. The page
      // defaults to the most recent completed fiscal year (25-26), which
      // excludes the Feb-2025 statement; switch to FY 2024-2025 first.
      await page.evaluate(() => localStorage.setItem('globalFiscalYear', '2024-2025'));
      await page.goto(`${BASE}/bank-statements`, { waitUntil: 'networkidle' });
      await page.waitForTimeout(2000);
      const body = await page.textContent('body');
      expect(body).not.toContain('Could not read this file');
      await expect(page.getByText(/HSBC|eStatement/).first()).toBeVisible({ timeout: 15000 });
      console.log('✅ Bank statement auto-saved (row visible in list)');
    }
```

- [ ] **Step 2: Verify the file parses**

Run: `cd regression-tests && npx tsc --noEmit regression-full-flow.spec.ts` (or `cd .. && npx playwright test regression-full-flow.spec.ts --list`)
Expected: compiles/lists; no syntax errors. The spec only runs meaningfully against the deployed site (post-deploy).

- [ ] **Step 3: Commit**

```bash
git add regression-tests/regression-full-flow.spec.ts
git commit -m "test(regression): bank statement flow lands on File Storage first"
```

---

### Task 4: Update regression tests — review-buttons spec

**Files:**
- Modify: `regression-tests/regression-review-buttons.spec.ts:31-39`

**Interfaces:**
- Consumes: post-upload landing on `/file-storage`; the File Storage banner.

- [ ] **Step 1: Replace the wait-for-review-page block**

Replace lines 31-39:

```ts
  // Wait for review page
  try {
    await page.waitForURL('**/invoices/review/**', { timeout: 240000 });
    console.log('✅ Navigated to review page');
  } catch {
    console.log('⚠️ No review page (may have auto-saved) — checking invoices list');
    await page.goto(`${BASE}/invoices`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(2000);
  }
```

with:

```ts
  // Uploads land on File Storage. If the invoice needs review, the queue
  // banner appears there — click Review Now to reach the review page.
  await page.waitForURL(/\/file-storage/, { timeout: 240000 });
  try {
    const banner = page.locator('text=/queued for review/');
    if (await banner.isVisible({ timeout: 15000 }).catch(() => false)) {
      await page.getByRole('button', { name: /Review Now/ }).click();
      await page.waitForURL('**/invoices/review/**', { timeout: 60000 });
      console.log('✅ Navigated to review page');
    } else {
      throw new Error('no banner');
    }
  } catch {
    console.log('⚠️ No review page (may have auto-saved) — checking invoices list');
    await page.goto(`${BASE}/invoices`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(2000);
  }
```

- [ ] **Step 2: Verify the file parses**

Run: `npx playwright test regression-review-buttons.spec.ts --list`
Expected: lists without error.

- [ ] **Step 3: Commit**

```bash
git add regression-tests/regression-review-buttons.spec.ts
git commit -m "test(regression): review-buttons spec reaches review via File Storage banner"
```

---

### Task 5: Update regression tests — pastel & veii direction checks

**Files:**
- Modify: `regression-tests/pastel-direction-check.spec.ts:104-157`
- Modify: `regression-tests/veii-direction-check.spec.ts:69-121`

**Interfaces:**
- Consumes: post-upload landing on `/file-storage`; `importData.invoice_id`, `importData.needs_direction_review`, `importData.company_not_detected`, `importData.needs_review`, `importData.total_mismatch` from the import response.

- [ ] **Step 1: Rework `pastel-direction-check.spec.ts` to open the review page directly when flagged**

Replace lines 104-157 (from `await page.waitForURL(...)` through the end of the `if/else` that populates `invoiceNumber`/`direction`/`vendor`/`items`/`total`/`needsReview`):

```ts
    await page.waitForURL(u => !u.pathname.includes('/file-upload'), { timeout: 90_000 });

    let direction = importData.direction ?? null;
    let vendor: string | null = null;
    let invoiceNumber = '?';
    let items: any[] = [];
    let total: number | null = null;
    let needsReview = '';

    // Uploads land on File Storage. When the import is flagged, open the
    // review page directly from the returned invoice id to verify the AP
    // toggle and captured fields.
    const needsFlag = importData.needs_direction_review || importData.company_not_detected || importData.needs_review || !!importData.total_mismatch;
    if (needsFlag && invoiceId) {
      await page.goto(`/invoices/review/${invoiceId}`);
      await page.waitForURL(u => u.pathname.includes('/invoices/review/'), { timeout: 60_000 });

      const reviewRespPromise = page.waitForResponse(
        r => r.url().includes('/api/invoices/') && r.url().includes('/review'),
        { timeout: 60_000 },
      );
      const reviewResp = await reviewRespPromise.catch(() => null);
      const data = reviewResp ? await reviewResp.json() : {};
      invoiceNumber = data.invoice_number ?? '?';
      direction = data.direction ?? direction;
      vendor = data.vendor_name ?? null;
      items = (data.items || []).map((it: any) => ({
        description: it.description, qty: it.quantity, unit: it.unit_price, amount: it.amount,
      }));
      total = data.total ?? null;
      needsReview = data.needs_review || '';
      await page.waitForTimeout(1_500);

      // DOM check: the AP (incoming) toggle is highlighted (AP active style
      // is orange; the AR toggle uses blue)
      const apButton = page.getByRole('button', { name: /AP — Billed us/ });
      await expect(apButton, `${file}: AP toggle should be active`).toHaveClass(/bg-(blue|orange)-100/);

      // Save
      await page.getByRole('button', { name: /Save/ }).first().click();
      await page.waitForURL(u => !u.pathname.includes('/review'), { timeout: 60_000 });
      await page.waitForTimeout(800);
    } else {
      // Clean import — fetch the saved record via the API
      const data = await page.evaluate(async (id) => {
        const token = localStorage.getItem('token') || '';
        const r = await fetch(`/api/invoices/${id}`, { headers: { Authorization: `Bearer ${token}` } });
        return r.json();
      }, invoiceId);
      invoiceNumber = data.invoice_number ?? '?';
      direction = data.direction ?? direction;
      vendor = data.vendor_name ?? data.customer_name ?? null;
      items = (data.items || []).map((it: any) => ({
        description: it.description, qty: it.quantity, unit: it.unit_price, amount: it.amount,
      }));
      total = data.total ?? null;
      needsReview = data.needs_review || '';
      await page.waitForTimeout(1_500);
    }
```

- [ ] **Step 2: Rework `veii-direction-check.spec.ts` the same way (AR variant)**

Replace lines 69-121 (from `await page.waitForURL(...)` through the end of the `if/else` that populates the record fields) with the same structure as Step 1 but with the AR toggle check in place of the AP check:

```ts
    await page.waitForURL(u => !u.pathname.includes('/file-upload'), { timeout: 90_000 });

    let direction = importData.direction ?? null;
    let vendor: string | null = null;
    let invoiceNumber = '?';
    let items: any[] = [];
    let total: number | null = null;
    let needsReview = '';

    // Uploads land on File Storage. When the import is flagged, open the
    // review page directly from the returned invoice id to verify the AR
    // toggle and captured fields.
    const needsFlag = importData.needs_direction_review || importData.company_not_detected || importData.needs_review || !!importData.total_mismatch;
    if (needsFlag && invoiceId) {
      await page.goto(`/invoices/review/${invoiceId}`);
      await page.waitForURL(u => u.pathname.includes('/invoices/review/'), { timeout: 60_000 });

      const reviewRespPromise = page.waitForResponse(
        r => r.url().includes('/api/invoices/') && r.url().includes('/review'),
        { timeout: 60_000 },
      );
      const reviewResp = await reviewRespPromise.catch(() => null);
      const data = reviewResp ? await reviewResp.json() : {};
      invoiceNumber = data.invoice_number ?? '?';
      direction = data.direction ?? direction;
      vendor = data.vendor_name ?? null;
      items = (data.items || []).map((it: any) => ({
        description: it.description, qty: it.quantity, unit: it.unit_price, amount: it.amount,
      }));
      total = data.total ?? null;
      needsReview = data.needs_review || '';
      await page.waitForTimeout(1_500);

      // DOM check: the AR (outgoing) toggle is highlighted
      const arButton = page.getByRole('button', { name: /AR — We issued/ });
      await expect(arButton, `${file}: AR toggle should be active`).toHaveClass(/bg-blue-100/);

      // Save
      await page.getByRole('button', { name: /Save/ }).first().click();
      await page.waitForURL(u => !u.pathname.includes('/review'), { timeout: 60_000 });
      await page.waitForTimeout(800);
    } else {
      // Clean import — fetch the saved record via the API
      const data = await page.evaluate(async (id) => {
        const token = localStorage.getItem('token') || '';
        const r = await fetch(`/api/invoices/${id}`, { headers: { Authorization: `Bearer ${token}` } });
        return r.json();
      }, invoiceId);
      invoiceNumber = data.invoice_number ?? '?';
      direction = data.direction ?? direction;
      vendor = data.vendor_name ?? data.customer_name ?? null;
      items = (data.items || []).map((it: any) => ({
        description: it.description, qty: it.quantity, unit: it.unit_price, amount: it.amount,
      }));
      total = data.total ?? null;
      needsReview = data.needs_review || '';
      await page.waitForTimeout(1_500);
    }
```

- [ ] **Step 3: Verify both files parse**

Run: `npx playwright test regression-tests/pastel-direction-check.spec.ts regression-tests/veii-direction-check.spec.ts --list`
Expected: both list without error.

- [ ] **Step 4: Commit**

```bash
git add regression-tests/pastel-direction-check.spec.ts regression-tests/veii-direction-check.spec.ts
git commit -m "test(regression): direction checks open review page directly when flagged"
```

---

### Task 6: Full verification

- [ ] **Step 1: Build**

Run: `cd frontend && npm run build`
Expected: PASS.

- [ ] **Step 2: Regression list (parse check)**

Run: `npx playwright test --list`
Expected: all specs list; no import/syntax errors.

- [ ] **Step 3: Deploy (pages only — no API change) and run regression suite**

```bash
cd frontend
export CLOUDFLARE_ACCOUNT_ID=8c00cc4647a9cf5d8deb5d6a354001e0
npm run build
npx wrangler pages deploy dist --project-name=opcc-crm-testing --branch=main
```

Then from the repo root: `npx playwright test regression-tests/` — debug failures to green. Report the deployed URL.

- [ ] **Step 4: Manual QA (deployed site)**

1. Upload a single clean invoice → lands on File Storage with a green **Processed** badge and the underlying record badge.
2. Upload a file with an OCR mismatch → lands on File Storage, amber **Needs Review** badge + queue banner.
3. Upload an encrypted PDF → **🔒 Encrypted** button (unchanged) on the row.
4. Upload an unsupported/blurry file → red **Could not read** badge.
5. Upload a plain PDF via the **Others** channel → gray **Stored** badge, no record badge.
