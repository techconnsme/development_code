# TeCS Regression Test Plan

**Generated:** 2026-08-06  
**Covers:** All 16 regression fixes from Aug 6 session  
**Base URL (API):** `https://opcc-crm-api.ruhan-farhan.workers.dev`  
**Base URL (Frontend):** Latest Cloudflare Pages preview (run `npx wrangler pages deploy` to get current)  
**Test user:** `muhammadruhan.farhan25@gmail.com` / `Ruhan123`  
**Admin user:** `memonruhan731@gmail.com` / `Hamdan123`

---

## Test Suite Overview

| ID | Test | Type | Covers Fix # |
|---|---|---|---|
| API-01 | Firm auto-created on login | API | #1 |
| API-02 | Firm auto-created on account creation | API | #1 |
| API-03 | Invoice direction: incoming (BILL_IN) | API | #1 |
| API-04 | Invoice direction: outgoing (INV_OUT) | API | #1 |
| API-05 | SLACK invoice not card statement | API | #2 |
| API-06 | RECEIPT_ files classified correctly | API | #3 |
| API-07 | Auto-match receipts to AP invoices | API | #15 |
| API-08 | Auto-detect matches on statement confirm | API | #14 |
| API-09 | File Storage list includes linked records | API | #12 |
| E2E-01 | Language switch preserves upload state | Browser | #4, #11 |
| E2E-02 | Bank Statement save navigates after last | Browser | #5 |
| E2E-03 | Expenses View shows uploaded PDF | Browser | #6 |
| E2E-04 | COA Review auto-expands parents | Browser | #7 |
| E2E-05 | Auto-fill balance button visible | Browser | #8 |
| E2E-06 | Review page: Review Later + Change Type | Browser | #9 |
| E2E-07 | Match popup widened with PDF preview | Browser | #10 |
| E2E-08 | File Storage review icon + amended flag | Browser | #12, #13 |
| E2E-09 | Match Receipts button in Expenses | Browser | #15 |
| E2E-10 | Batch upload BILL_IN + INV_OUT mixed | Browser | #1, #2, #3 |

---

## API Tests

### API-01: Firm auto-created on login

**What it tests:** A user without `firm_id` gets a personal firm auto-created on login.

**Script:** `tests/verify-auto-firm.ts`

```typescript
// 1. Login as a user known to have no firm_id
// 2. Check response includes firm_id and firm_role = 'admin'
// 3. Query GET /firms/my to verify firm exists with correct name
```

**Expected:** Response has `firm_id` (format `f-xxxxxxxx`), `firm_role: 'admin'`, `GET /firms/my` returns firm with name matching user's company_name.

---

### API-02: Firm auto-created on account creation

**What it tests:** New accounts created via admin endpoint get a firm immediately.

**Script:** Create a new test user via `POST /admin/create-account`, then query D1 for `firm_members` entry.

**Steps:**
```
POST /api/admin/create-account
Body: { email: "test-firm-{timestamp}@test.com", password: "Test1234", name: "Firm Test", role: "supervisor", company_name: "Firm Test Co" }

→ Verify response includes id
→ Query D1: SELECT fm.firm_id FROM firm_members fm WHERE fm.user_id = '{id}'
→ Assert firm_id is NOT NULL
```

**Cleanup:** Delete created user via `DELETE /api/admin/tenants/{id}`.

---

### API-03: Invoice direction — incoming

**What it tests:** BILL_IN sample PDFs are correctly classified as `incoming`.

**Script:** `tests/test-invoice-direction-api.ts`

**Steps:**
```
1. Login
2. Read BILL_IN_INV-FEDEX-2026-0812_FedEx_Express_Hong_Kong.pdf from test-samples-generated-demo-company/
3. POST /api/file-storage/upload (base64)
4. POST /api/file-storage/{fileId}/import-document
5. GET /api/invoices/{invoiceId}
6. Assert: direction === 'incoming'
7. Assert: vendor_name includes 'FedEx'
8. Assert: status === 'active' (auto-saved, not pending_review)
```

**Expected:** `direction: "incoming"`, `status: "active"`, `vendor_name` contains "FedEx".

---

### API-04: Invoice direction — outgoing

**What it tests:** INV_OUT sample PDFs correctly classified as `outgoing` when company name matches.

**Prerequisite:** Company name must match the issuer on INV_OUT PDFs ("Demo Company Limited"). Switch to that client before running.

**Steps:**
```
1. Login, set X-Active-Client to the Demo Company Limited client ID
2. Read INV_OUT_INV-2026-0042_TechGear_HK_Ltd.pdf
3. Upload + import-document
4. GET invoice
5. Assert: direction === 'outgoing'
```

**Expected:** `direction: "outgoing"`, `vendor_name` contains "TechGear".

---

### API-05: SLACK invoice not card statement

**What it tests:** BILL_IN_INV-SLACK PDF (contains "Credit Card" + "Visa" in text) is classified as `invoice`, not `card_statement`.

**Steps:**
```
1. Upload BILL_IN_INV-SLACK-2026-0705_Slack_Technologies.pdf
2. POST import-document
3. Assert: type === 'invoice' (not 'card_statement')
```

**Expected:** `type: "invoice"`.

---

### API-06: RECEIPT_ files classified correctly

**What it tests:** RECEIPT_ filenames are recognized as receipts (processed via invoice flow with isReceipt).

**Steps:**
```
1. Upload BILL_IN_RECEIPT-FP-2026-0812_Fortune_Paper___Stationery.pdf
2. POST import-document
3. Assert: type === 'invoice' (receipts go through invoice flow)
4. GET invoice
5. Assert: receipt_number is NOT NULL (isReceipt flag working)
```

**Expected:** `type: "invoice"`, `receipt_number` is set.

---

### API-07: Auto-match receipts to AP invoices

**What it tests:** `POST /invoices/auto-match-receipts` matches receipts to unpaid AP invoices by amount.

**Prerequisite:** Have at least one receipt and one unpaid AP invoice with matching amounts.

**Steps:**
```
1. Login
2. POST /api/invoices/auto-match-receipts
3. Assert response has matched array
4. For each match: assert receipt_id, invoice_id, amounts match within 0.02
```

**Expected:** `matched` array with correct links.

---

### API-08: Auto-detect on statement confirm

**What it tests:** After confirming a bank statement, background job suggests matching invoices.

**Steps:**
```
1. Upload a bank statement PDF with deposit amounts matching existing unpaid invoices
2. Import + confirm via POST /bank-statements/{id}/confirm
3. Wait 5 seconds for background job
4. GET /bank-statements/{id} with transactions
5. Assert: some transactions have match_status = 'suggested'
```

**Expected:** Transactions with matching amounts show `match_status: "suggested"`.

---

### API-09: File Storage list includes linked records

**What it tests:** `GET /file-storage` now returns linked invoice/statement IDs.

**Steps:**
```
1. Upload + process an invoice PDF
2. GET /api/file-storage
3. Find the uploaded file in response
4. Assert: invoice_id is set, invoice_number is present
```

**Expected:** File record has `invoice_id`, `invoice_number`, `invoice_status`.

---

## Browser (E2E) Tests

All browser tests use Playwright. Configuration: `playwright.config.ts` in repo root.

```
npx playwright test tests/regression-{name}.spec.ts --headed --reporter=list
```

### E2E-01: Language switch preserves upload state

**What it tests:** Switching language during file upload doesn't reset the upload form.

**Playwright spec:** Create file `tests/regression-language-switch.spec.ts`

**Steps:**
```
1. Login → navigate to /file-upload
2. Select "Bank-TXN Invoice" tab
3. Select files via input[type="file"]
4. Verify files appear in the list
5. Click the language toggle button (繁/简/EN)
6. Verify files are STILL in the list (not cleared)
7. Switch language again
8. Verify form text updates to new language
```

**Expected:** Files remain selected; UI text changes language.

---

### E2E-02: Bank Statement save navigates after last

**What it tests:** Saving the last bank statement in review queue navigates to /bank-statements list.

**Playwright spec:** Create file `tests/regression-bank-save-redirect.spec.ts`

**Steps:**
```
1. Login → upload 1 bank statement PDF
2. Process → wait for navigation to review page
3. Click "Save to Database"
4. Assert: URL becomes /bank-statements (not stuck on review)
```

**Expected:** After save, navigates to `/bank-statements`.

---

### E2E-03: Expenses View shows uploaded document

**What it tests:** Clicking the "View" icon in Expenses list shows the original PDF, not a generated invoice.

**Playwright spec:** Create file `tests/regression-expenses-view.spec.ts`

**Steps:**
```
1. Login → navigate to /invoices (Expenses)
2. Click the Eye/View icon on any invoice that has an uploaded file
3. In the modal, check the right panel
4. Assert: right panel contains an <iframe> with src containing "/file-storage/" (uploaded PDF)
5. Assert: right panel does NOT contain generated "INVOICE" heading
```

**Expected:** Right panel shows uploaded PDF via iframe, not generated invoice template.

---

### E2E-04: COA Review auto-expands parents

**What it tests:** Chart of Accounts preview in New Client form expands all parent accounts by default.

**Playwright spec:** Create file `tests/regression-coa-expand.spec.ts`

**Steps:**
```
1. Login → navigate to New Client page
2. Select an industry (e.g., "General")
3. Wait for COA preview to load
4. Assert: all type sections (Assets, Liabilities, Equity, Revenue, Expenses) are expanded
5. Assert: parent accounts with children show their children (not collapsed)
```

**Expected:** All type sections and parent accounts are expanded on load.

---

### E2E-05: Auto-fill balance button visible

**What it tests:** The "= HKD xxx" auto-fill button is always visible next to Closing Balance.

**Playwright spec:** Create file `tests/regression-autofill-balance.spec.ts`

**Steps:**
```
1. Upload + process a bank statement PDF
2. Navigate to review page
3. Look for the Closing Balance field
4. Assert: a button/link showing "= HKD" or "auto-fill" is visible next to the label
5. Click the button
6. Assert: Closing Balance input is filled with the computed value
```

**Expected:** Auto-fill button always visible; clicking fills the closing balance.

---

### E2E-06: Review page buttons

**What it tests:** Invoice review page has Review Later and Change Type buttons.

**Playwright spec:** Create file `tests/regression-review-buttons.spec.ts`

**Steps:**
```
1. Upload + process an invoice PDF
2. Navigate to review page
3. Assert: "Review Later" button visible
4. Assert: "Wrong document type?" hint with link visible
5. Click "Review Later"
6. Assert: navigates to next item or back to list
```

**Expected:** Review Later, Save, Discard buttons all visible; Review Later skips current item.

---

### E2E-07: Match popup widened with PDF preview

**What it tests:** The LinkedDocModal (match popup) is wider and shows side-by-side PDF preview.

**Playwright spec:** Create file `tests/regression-match-popup.spec.ts`

**Steps:**
```
1. Navigate to Bank Statements → expand a statement
2. Find an unmatched transaction, click the Link/Match button
3. Assert: modal is wide (max-w-5xl class or width > 800px)
4. Assert: transaction details (description, date, amount) shown at top
5. Assert: right side has PDF preview area
6. In the invoice list, click "View" on an invoice
7. Assert: PDF loads in the right panel
```

**Expected:** Modal is wide, shows tx details, has working PDF preview.

---

### E2E-08: File Storage review icon + amended flag

**What it tests:** File Storage shows Eye icon for processed docs and "Edited" badge.

**Playwright spec:** Create file `tests/regression-filestorage-icons.spec.ts`

**Steps:**
```
1. Navigate to /file-storage
2. Find a file that has been processed into an invoice
3. Assert: an Eye icon link is visible, pointing to /invoices/review/{id}
4. Click the Eye icon
5. Assert: navigates to the review page
6. Go back to file-storage
7. If any file has invoice_needs_review, assert "Edited" badge visible
```

**Expected:** Eye icon links to review page; "Edited" badge on amended records.

---

### E2E-09: Match Receipts button in Expenses

**What it tests:** The "Match Receipts" button exists and triggers matching.

**Playwright spec:** Create file `tests/regression-match-receipts.spec.ts`

**Steps:**
```
1. Navigate to /invoices (Expenses)
2. Assert: "Match Receipts" button visible in header
3. Click "Match Receipts"
4. Assert: toast notification appears (success or "no matches")
```

**Expected:** Button visible; clicking triggers API call and shows result.

---

### E2E-10: Batch upload mixed invoices

**What it tests:** End-to-end batch upload of BILL_IN + INV_OUT files with correct direction.

**Playwright spec:** Update `tests/bill-in-direction.spec.ts`

**Steps:**
```
1. Login, switch to "Demo Company Limited" client
2. Navigate to /file-upload, select Bank-TXN Invoice tab
3. Upload 2 BILL_IN files + 2 INV_OUT files
4. Wait for processing
5. Check invoices list via API
6. Assert: BILL_IN files → direction = 'incoming'
7. Assert: INV_OUT files → direction = 'outgoing'
8. Assert: all status = 'active' (auto-saved without review)
```

**Expected:** Correct directions, all auto-saved.

---

## Running All Tests

### Prerequisites
```bash
cd Tech_Connect_SME/Development_code/latest_code
npm install
npx playwright install chromium
```

### Run API tests
```bash
npx tsx tests/test-invoice-direction-api.ts
npx tsx tests/verify-auto-firm.ts
npx tsx tests/check-all-invoices.ts
```

### Run browser tests
```bash
# All regression E2E tests
npx playwright test tests/regression-*.spec.ts --headed --reporter=list

# Or individually
npx playwright test tests/regression-language-switch.spec.ts --headed
```

### Run the full suite
```bash
# API
npx tsx tests/test-invoice-direction-api.ts
npx tsx tests/verify-auto-firm.ts
npx tsx tests/check-all-invoices.ts

# E2E
npx playwright test tests/bill-in-direction.spec.ts --headed
npx playwright test tests/regression-*.spec.ts --headed --reporter=list
```

---

## Test Data

Sample files are in `../../test-samples-generated-demo-company/` (relative to `latest_code/`):

| Pattern | Count | Expected Direction | Expected Type |
|---|---|---|---|
| `BILL_IN_INV-*` | 8 | incoming | invoice |
| `BILL_IN_BILL-*` | 2 | incoming | invoice |
| `BILL_IN_PO-*` | 1 | incoming | invoice |
| `BILL_IN_RECEIPT-*` | 1 | incoming | receipt→invoice |
| `INV_OUT_INV-*` | 7 | outgoing | invoice |
| `BANK_*` | 6 | N/A | bank_statement |
| `CARD_*` | 2 | N/A | card_statement |

---

## Cleanup Between Runs

```bash
npx tsx tests/cleanup-invoices.ts   # Deletes all invoices + file records
```
