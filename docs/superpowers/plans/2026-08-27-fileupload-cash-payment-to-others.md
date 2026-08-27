# File Upload: merge Cash Payment into Others — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the "Cash Payment" upload channel and fold its role into a renamed "Others (Receipts, Cash Payments etc.)" tab; Petty Cash stays untouched.

**Architecture:** Pure frontend change. The OCR/import pipeline already treats every channel identically; channels are intent declarations used for routing, folder naming, and the mismatch dialog. Deleting the `cash_invoice` entry collapses its branches; TypeScript narrows the union and flags stragglers. The invoice-review path for cash payments survives through the OCR mismatch dialog ("detected as Invoice" → Switch).

**Tech Stack:** React + TypeScript + Vite (`frontend/src/pages/FileUpload.tsx`), Playwright (`tests/upload-channels.spec.ts`, config at `playwright.config.ts`), i18n via `tr()` helper.

**Spec:** `docs/superpowers/specs/2026-08-27-fileupload-cash-payment-to-others-design.md`

## Global Constraints

- Frontend edits are confined to `frontend/src/pages/FileUpload.tsx`. **No backend changes** (`api/src/**` untouched).
- Exact label wording (verbatim):
  - EN: `Others (Receipts, Cash Payments etc.)`
  - 繁: `其他（收據、現金付款等）`
  - 简: `其他（收据、现金付款等）`
- Other labels stay verbatim: `Bank Statement`, `Card Statement`, `Sales Invoice`, `Purchase Invoice`, `Petty Cash`.
- Folder/category of Others unchanged: `folder: 'Others'`, `category: 'general'`.
- Do NOT touch: `frontend/src/pages/PettyCash.tsx`, `frontend/src/pages/Invoices.tsx` (Expenses page tabs), anything under `api/src`.
- Repo rule (AGENTS.md): **never commit without explicit user approval** — where this plan says "Commit", pause and ask the user instead.
- Test env knobs: `TEST_BASE_URL` (default `https://opcc-crm-testing.pages.dev`), `TEST_EMAIL`, `TEST_PASSWORD` (pnr-context account: `joseph.lin@pnr.hk` / `Test1234`). Playwright runs sequentially (`workers: 1`).
- Local UI testing: serve frontend with `npx vite` in `frontend/` (port 5173) and pass `TEST_BASE_URL=http://localhost:5173`. The frontend always calls the remote worker API (`WORKER_API_BASE` hardcoded in `frontend/src/lib/api.ts:5`), so login works from localhost out of the box.

---

### Task 1: Failing Playwright test for the 6-tab strip (RED)

**Files:**
- Modify: `tests/upload-channels.spec.ts`

**Interfaces:**
- Consumes: existing helpers `login(page)`, `waitForFileUpload(page)` in the same spec file (lines 9–26); `BASE` env default unchanged.
- Produces: none (browser-level regression gate for Tasks 2–4).

- [ ] **Step 1: Add the failing test**

Append inside `test.describe('Upload Channel Categorization', ...)` (after TC-UC-08):

```ts
  test('TC-UC-09: Cash Payment merged into Others (Receipts, Cash Payments etc.)', async ({ page }) => {
    await waitForFileUpload(page);

    // Channel tabs live in the border-b row; assert presence/absence by exact
    // label rather than counting all buttons on the page.
    // Old Cash Payment channel must be gone.
    await expect(page.locator('button').filter({ hasText: /^Cash Payment$/ })).toHaveCount(0);
    // Merged tab appears exactly once with the agreed wording.
    await expect(
      page.locator('button').filter({ hasText: /^Others \(Receipts, Cash Payments etc\.\)$/ })
    ).toHaveCount(1);
    // Petty Cash keeps its own dedicated tab (design decision §2.2 of the spec).
    await expect(page.locator('button').filter({ hasText: /^Petty Cash$/ })).toHaveCount(1);
    // Other four channels remain.
    for (const label of ['Bank Statement', 'Card Statement', 'Sales Invoice', 'Purchase Invoice']) {
      await expect(page.locator('button').filter({ hasText: new RegExp(`^${label}$`) })).toHaveCount(1);
    }
  });
```

Notes for the implementer:
- `hasText` with a `^…$` anchored regex means exact visible-text match, so `Others (…) ≠ 舊 “Others”`.
- Parentheses and the trailing dot must be escaped (`\(` `\)` `\.`) or the regex silently becomes a wildcard matcher.
- This test performs no upload → fast (<30 s incl. login).

- [ ] **Step 2: Run to verify it fails**

Start the dev server (keep running):

```
npx vite
```
(workdir: `frontend/`)

Then run, from repo root:

```
$env:TEST_BASE_URL='http://localhost:5173'; $env:TEST_EMAIL='joseph.lin@pnr.hk'; $env:TEST_PASSWORD='Test1234'; npx playwright test tests/upload-channels.spec.ts -g "TC-UC-09"
```

Expected: **FAIL** — two failures at once:
1. `Cash Payment` button currently exists → `toHaveCount(0)` sees 1.
2. No button matches `/^Others \(Receipts, Cash Payments etc\.\)$/` (current label is bare `Others`) → `toHaveCount(1)` sees 0.

If neither assertion fails, the test is broken — fix it before touching production code.

- [ ] **Step 3: Checkpoint (no commit yet)**

Report the failing output verbatim; proceed to Task 2 keeping the dev server up.

---

### Task 2: Implement the merge (GREEN)

**Files:**
- Modify: `frontend/src/pages/FileUpload.tsx` (lines 16, 33, 35, 352, 436)

**Interfaces:**
- Consumes: nothing new.
- Produces: `CHANNELS` array of 6 entries; `UploadChannel` union without `'cash_invoice'`. Downstream code compiles untouched except the two branch edits below.

- [ ] **Step 1: Narrow the channel union (line 16)**

Before:
```ts
type UploadChannel = 'bank_statement' | 'card_statement' | 'sales_invoice' | 'purchase_invoice' | 'cash_invoice' | 'petty_cash' | 'others';
```
After:
```ts
type UploadChannel = 'bank_statement' | 'card_statement' | 'sales_invoice' | 'purchase_invoice' | 'petty_cash' | 'others';
```

- [ ] **Step 2: Edit CHANNELS (lines 33–35)**

Delete the cash_invoice entry and rename others in one contiguous edit of the array body:

Before:
```ts
  { key: 'cash_invoice', label: 'Cash Payment', labelZh: '現金付款', labelCn: '现金付款', folder: 'Invoices', category: 'cash_invoice' },
  { key: 'petty_cash', label: 'Petty Cash', labelZh: '零用金', labelCn: '零用金', folder: 'Petty Cash', category: 'petty_cash' },
  { key: 'others', label: 'Others', labelZh: '其他', labelCn: '其他', folder: 'Others', category: 'general' },
```
After:
```ts
  { key: 'petty_cash', label: 'Petty Cash', labelZh: '零用金', labelCn: '零用金', folder: 'Petty Cash', category: 'petty_cash' },
  { key: 'others', label: 'Others (Receipts, Cash Payments etc.)', labelZh: '其他（收據、現金付款等）', labelCn: '其他（收据、现金付款等）', folder: 'Others', category: 'general' },
```

- [ ] **Step 3: Drop cash_invoice from the invoice-channel sets (lines 352 and 436)**

Line 352, before:
```ts
      const isInvoiceChannel = channel === 'sales_invoice' || channel === 'purchase_invoice' || channel === 'cash_invoice';
```
After:
```ts
      const isInvoiceChannel = channel === 'sales_invoice' || channel === 'purchase_invoice';
```

Line 436, before:
```ts
    } else if ((channel === 'sales_invoice' || channel === 'purchase_invoice' || channel === 'cash_invoice') && result?.invoice_id) {
```
After:
```ts
    } else if ((channel === 'sales_invoice' || channel === 'purchase_invoice') && result?.invoice_id) {
```

(The force-reimport ternary at line 402 already reads `channel === 'sales_invoice' || channel === 'purchase_invoice' ? 'invoice' : channel;` — correct as-is once the union narrows; do not edit.)

- [ ] **Step 4: Verify no stragglers**

```
rg -n "cash_invoice" frontend/src --glob '!*.md'
```
Expected: **no output**. (`docs/` may still mention it historically — allowed.)

- [ ] **Step 5: Run the failing test again**

Same command as Task 1 Step 2. Expected: **PASS** (all five tab-label assertions green).

- [ ] **Step 6: Typecheck/build proof**

Run in `frontend/`: `npx vite build`
Expected: completes without TS errors (catches any missed `cash_invoice` usage outside the grepped spots).

- [ ] **Step 7: Checkpoint — ask user approval before committing**

Proposed commit (only after user says yes):

```
git add frontend/src/pages/FileUpload.tsx tests/upload-channels.spec.ts
git commit -m "feat(upload): fold Cash Payment channel into Others (Receipts, Cash Payments etc.)"
```

---

### Task 3: Update test-plan documentation

**Files:**
- Modify: `tests/TEST_PLAN.md` (TC-UC-04 ~line 59, TC-UC-06 ~line 69)

**Interfaces:** none.

- [ ] **Step 1: Retire TC-UC-04 and refresh TC-UC-06**

Replace the TC-UC-04 block:

```markdown
### TC-UC-04: Cash Invoice Channel
- **Action:** Select "Cash Invoice" channel → upload any invoice PDF
- **Expected:** File classified as `cash_invoice`, folder = "Invoices", routes to invoice review
- **Assertions:** `category === 'cash_invoice'`, invoice created
```

with:

```markdown
### TC-UC-04: (Retired 2026-08-27) Cash Payment merged into Others
- The "Cash Payment"/"Cash Invoice" channel was removed; see TC-UC-06 and the
  design doc `docs/superpowers/specs/2026-08-27-fileupload-cash-payment-to-others-design.md`.
- Invoice documents uploaded under the merged Others channel reach invoice
  review via the OCR mismatch dialog ("detected as Invoice" → Switch).
```

Replace TC-UC-06 heading/action/expected lines:

```markdown
### TC-UC-06: Others Channel
- **Action:** Select "Others" channel → upload any file
- **Expected:** File classified as `general`, folder = "Others", saved without special routing
```

with:

```markdown
### TC-UC-06: Others (Receipts, Cash Payments etc.) Channel
- **Action:** Select "Others (Receipts, Cash Payments etc.)" channel → upload any file
- **Expected:** File classified as `general`, folder = "Others", saved without special routing
```

(Assertions line below each block stays as-is.)

- [ ] **Step 2: Sweep for other stale mentions**

```
rg -n "Cash Payment|Cash Invoice|現金付款" tests/*.md tests/*.spec.ts
```
Expected hits afterwards are limited to: TC-UC-04 retirement note, pnr/sample filenames if any, and expense-category names unrelated to channels (e.g., "Cash Expenses"). Anything asserting the removed tab gets fixed like Step 1.

- [ ] **Step 3: Commit (with prior user approval)**

```
git add tests/TEST_PLAN.md
git commit -m "docs(tests): retire TC-UC-04, update TC-UC-06 for merged Others channel"
```

---

### Task 4: Regression guards

**Files:** none created/modified (verification task).

**Interfaces:** none.

- [ ] **Step 1: Full upload-channels suite**

```
$env:TEST_BASE_URL='http://localhost:5173'; $env:TEST_EMAIL='joseph.lin@pnr.hk'; $env:TEST_PASSWORD='Test1234'; npx playwright test tests/upload-channels.spec.ts
```
Expected: all PASS (or only pre-existing environment-dependent flakes unrelated to tab labels — report them either way). Note TC-UC-01/02/05/06/08 perform real OCR uploads (~40 s each) and hit the shared staging tenant; they were green before this change and must stay green. **Important:** because tasks deliberately avoid `skipping` history-dependent assertions, treat failures in old TCs as regressions to investigate, not fluff to waive.

- [ ] **Step 2: Expenses-page overlap guard**

```
$env:TEST_BASE_URL='http://localhost:5173'; $env:TEST_EMAIL='joseph.lin@pnr.hk'; $env:TEST_PASSWORD='Test1234'; npx playwright test tests/expenses-tabs.spec.ts
```
Expected: PASS — proves the separate Expenses page (Receipts | Petty Cash | Others tabs) is unaffected by the identically-named upload tab.

- [ ] **Step 3: Final checkpoint — ask user approval before committing any remaining files**

If the user approves, commit whichever of the above produced edits are uncommitted; otherwise leave the tree dirty and report status.

---

## Self-review notes (already applied)

- Spec §4 rows all map to Task 2 steps 1–3 (line 402 confirmed no-edit-needed during planning).
- All code blocks contain literal before/after content — no placeholders.
- Label regexes escaped consistently between Task 1 test and Task 2 labels.
