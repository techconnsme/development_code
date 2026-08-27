# AI Agentic Test Plan — Feature Verification

**Account:** muhammadruhan.farhan25@nixorcollege.edu.pk
**Test Data:** `Tech_Connect_SME/test-samples-generated-demo-company/` (13 PDFs for Demo Company Limited)
**Base URL:** `https://opcc-crm-testing.pages.dev`

---

## Test Data Map

| File | Type | Key Data Points |
|------|------|-----------------|
| `BANK_HSBC_BusinessDirect_2026-06_Jun.pdf` | Bank Statement | HSBC, 636-438897-001, Jun 2026, 11 txns, opening $255K, closing $258,475.20 |
| `BANK_HSBC_BusinessDirect_2026-07_Jul.pdf` | Bank Statement | HSBC, 636-438897-001, Jul 2026, 11 txns, opening $258K, closing $357,140.50 |
| `BANK_HSBC_BusinessDirect_2026-08_Aug.pdf` | Bank Statement | HSBC, 636-438897-001, Aug 2026, 11 txns, opening $357K, closing $431,516.30 |
| `BANK_HangSeng_Integrated_2026-08_Aug.pdf` | Bank Statement | Hang Seng, 295-137856-001, Aug 2026, 9 txns, opening $185K, closing $209,965.50 |
| `BANK_SCB_Business_2026-08_Aug.pdf` | Bank Statement | Standard Chartered, 372-1-123456-7, Aug 2026, 7 txns, opening $95K, closing $139,380 |
| `CARD_HSBC_Visa_4567_2026-08_Aug.pdf` | Card Statement | HSBC Visa ****4567, Aug 2026, 10 txns ($47,450 purchases, $50K payment) |
| `INV_OUT_INV-2026-0042_TechGear_HK_Ltd.pdf` | Invoice (AR) | INV-2026-0042, TechGear HK Ltd, $45,000, PAID |
| `INV_OUT_INV-2026-0043_StarNet_Solutions.pdf` | Invoice (AR) | INV-2026-0043, StarNet Solutions, $28,500, PAID |
| `INV_OUT_INV-2026-0044_Bright_Future_Ltd.pdf` | Invoice (AR) | INV-2026-0044, Bright Future Ltd, $62,000, PAID (2 instalments) |
| `BILL_IN_INV-CBS-2026-0712_CloudBase_Services_Ltd.pdf` | Bill (AP) | INV-CBS-2026-0712, CloudBase Services, $8,500 |
| `BILL_IN_PO-2026-0891_Pacific_Office_Supplies.pdf` | Bill (AP) | PO-2026-0891, Pacific Office Supplies, $12,800 |
| `RECEIPT_REC-2026-0015_TechGear_HK_Ltd.pdf` | Receipt | REC-2026-0015, TechGear, $45,000 |
| `RECEIPT_REC-2026-0016_StarNet_Solutions.pdf` | Receipt | REC-2026-0016, StarNet, $28,500 |

### Pre-linked Reconciliation Scenarios

| # | Scenario | Documents | Expected Outcome |
|---|----------|-----------|------------------|
| 1 | AR: Invoice → Receipt → Bank Deposit | INV-0042 + REC-0015 + HSBC Jun | Auto-match $45K deposit to invoice |
| 2 | AR: Invoice → Receipt → Bank Deposit | INV-0043 + REC-0016 + HSBC Jul | Auto-match $28.5K deposit to invoice |
| 3 | AP: Bill → Card Transaction | PO-2026-0891 + CARD Aug | Link $12,800 card charge to AP bill |
| 4 | AP: Bill → Bank Payment | INV-CBS-2026-0712 + HSBC Aug | Link $8,500 FPS OUT to AP bill |
| 5 | Inter-Bank Transfer | HangSeng Aug + HSBC Aug | Match $50K transfer between accounts |
| 6 | Instalment Payment | INV-0044 + HSBC Jun ($30K) + HSBC Jul ($32K) | Match two deposits to one invoice |

---

## Feature 1: Upload Source Categorization (6 Channels)

**Source:** `frontend/src/pages/FileUpload.tsx` lines 12-30, 337-396

### TC-UC-01: Bank Statement Channel
- **Action:** Select "Bank Statement" channel → upload `BANK_HSBC_BusinessDirect_2026-08_Aug.pdf`
- **Expected:** File classified as `bank_statement`, folder = "Bank Statements", routes to `/bank-statements/review/:id`
- **Assertions:** `category === 'bank_statement'`, statement created with `bank_name = 'HSBC'`, `account_number = '636-438897-001'`

### TC-UC-02: Card Statement Channel
- **Action:** Select "Card Statement" channel → upload `CARD_HSBC_Visa_4567_2026-08_Aug.pdf`
- **Expected:** File classified as `card_statement`, folder = "Card Statements", routes to card statement review
- **Assertions:** `category === 'card_statement'`, card_issuer = 'HSBC', card_number_last4 = '4567'

### TC-UC-03: Bank-TXN Invoice Channel
- **Action:** Select "Bank-TXN Invoice" channel → upload `INV_OUT_INV-2026-0042_TechGear_HK_Ltd.pdf`
- **Expected:** File classified as `bank_invoice`, folder = "Invoices", routes to `/invoices/review/:id`
- **Assertions:** `category === 'bank_invoice'`, invoice created with customer = 'TechGear HK Ltd', total = 45000

### TC-UC-04: (Retired 2026-08-27) Cash Payment merged into Others
- The "Cash Payment"/"Cash Invoice" channel was removed; see TC-UC-06 and the
  design doc `docs/superpowers/specs/2026-08-27-fileupload-cash-payment-to-others-design.md`.
- Invoice documents uploaded under the merged Others channel reach invoice
  review via the OCR mismatch dialog ("detected as Invoice" → Switch).

### TC-UC-05: Petty Cash Channel
- **Action:** Select "Petty Cash" channel → upload a receipt PDF
- **Expected:** File classified as `petty_cash`, folder = "Petty Cash", auto-creates journal entry (Dr 67001, Cr 11101)
- **Assertions:** `category === 'petty_cash'`, journal entry exists with `reference_type = 'petty_cash'`, Dr Petty Cash Expenses / Cr Cash on Hand

### TC-UC-06: Others (Receipts, Cash Payments etc.) Channel
- **Action:** Select "Others (Receipts, Cash Payments etc.)" channel → upload any file
- **Expected:** File classified as `general`, folder = "Others", saved without special routing
- **Assertions:** `category === 'general'`, no auto-created statements/invoices/entries

### TC-UC-07: Channel Mismatch Detection
- **Action:** Select "Bank Statement" channel → upload an invoice PDF
- **Expected:** Mismatch dialog appears: "uploaded as Bank Statement but OCR detected as Invoice"
- **Assertions:** MismatchDialog rendered, user can Force or Switch channel

### TC-UC-08: Batch Multi-Channel Upload
- **Action:** Select 3 files (bank stmt + invoice + receipt) with "Bank Statement" channel
- **Expected:** All 3 processed, bank stmt routed to review, invoice routed to review, receipt saved
- **Assertions:** Batch progress bar completes, reviewQueue populated with correct types

---

## Feature 2: Petty Cash Under Expenses

**Source:** `frontend/src/pages/FileUpload.tsx` lines 348-384, `api/src/lib/coa-templates.ts` lines 160-162

### TC-PC-01: Petty Cash Auto-Journal Entry
- **Action:** Upload via Petty Cash channel with amount > 0
- **Expected:** Journal entry created: Dr 67001 (Petty Cash Expenses) / Cr 11101 (Cash on Hand)
- **Assertions:**
  - `journal_entries` row with `reference_type = 'petty_cash'`
  - Two `journal_lines`: code 67001 debit = amount, code 11101 credit = amount
  - COA accounts 67000 and 67001 exist in chart

### TC-PC-02: Petty Cash Zero Amount Handling
- **Action:** Upload via Petty Cash channel where OCR fails to extract amount
- **Expected:** File saved but no journal entry created (pettyAmount = 0)
- **Assertions:** File record exists, no journal entry with `reference_type = 'petty_cash'`

### TC-PC-03: Petty Cash COA Accounts Exist
- **Action:** After seeding COA, check accounts list
- **Expected:** Account 67000 (零用金 Petty Cash) and 67001 (零用金支出 Petty Cash Expenses) exist
- **Assertions:** `GET /api/bookkeeping/accounts` includes both codes with `account_type = 'expense'`

---

## Feature 3: Auto-Direct Valid Uploads / Halt Errors

**Source:** `api/src/routes/file-storage.ts` lines 42-431 (importStatementFromFile), lines 434-997 (importInvoiceFromFile)

### TC-AD-01: Valid Bank Statement Auto-Directs to Bookkeeping
- **Action:** Upload valid `BANK_HSBC_BusinessDirect_2026-08_Aug.pdf` via Bank Statement channel
- **Expected:** OCR succeeds → DeepSeek parses → statement created with status `draft` → auto-categorize → auto-generate journal entries
- **Assertions:**
  - `bank_statements` row with `status = 'draft'`
  - `bank_transactions` rows (11 for HSBC Aug)
  - Journal entries auto-generated with voucher numbers `B-HSBC-202608-001` through `011`
  - Auto-categorization applied (salary, rent, utilities, etc.)

### TC-AD-02: Valid Invoice Auto-Directs to Bookkeeping
- **Action:** Upload valid `INV_OUT_INV-2026-0042_TechGear_HK_Ltd.pdf` via invoice channel
- **Expected:** OCR succeeds → DeepSeek parses → invoice created with `status = 'pending_review'` or `'active'`
- **Assertions:** `invoices` row with `invoice_number = 'INV-2026-0042'`, `total = 45000`, `customer_id` linked to TechGear HK Ltd

### TC-AD-03: OCR Failure Halts for Review
- **Action:** Upload a corrupted/empty PDF
- **Expected:** OCR fails → file saved with `ocr_status = 'failed'` → no auto-routing → user can reprocess
- **Assertions:** `file_records.ocr_status = 'failed'`, no bank_statements/invoices created, `POST /api/file-storage/reprocess` can retry

### TC-AD-04: Duplicate Statement Detection
- **Action:** Upload same bank statement PDF twice
- **Expected:** Second upload detects duplicate (by r2_key) → returns `is_duplicate = true`
- **Assertions:** Response includes `duplicate_info.type`, only one `bank_statements` row for that r2_key

### TC-AD-05: Invalid Date Handling
- **Action:** Upload statement with unparseable dates
- **Expected:** Graceful error, transaction dates fall back to period_start/period_end
- **Assertions:** No crash, transactions created with best-guess dates

---

## Feature 4: General Journal Entries (Dr/Cr)

**Source:** `api/src/routes/bookkeeping.ts` lines 91-110 (entries CRUD), lines 1051-1184 (auto-generate)

### TC-GJ-01: Manual Journal Entry with Dr/Cr
- **Action:** `POST /api/bookkeeping/entries` with balanced debits/credits
- **Expected:** Entry created with entry_number, lines with explicit debit/credit values
- **Assertions:**
  - `journal_entries` row with `entry_number` format `JE-YYYYMMDD-XXX`
  - Two or more `journal_lines` with correct debit/credit
  - Sum of debits == Sum of credits

### TC-GJ-02: Unbalanced Entry Rejected
- **Action:** `POST /api/bookkeeping/entries` where debits ≠ credits
- **Expected:** 400 error "Debits must equal credits"
- **Assertions:** No entry created, error message returned

### TC-GJ-03: Auto-Generated Voucher Numbers
- **Action:** `POST /api/bookkeeping/auto-generate-entries` after importing bank statements
- **Expected:** Voucher format `B-{BANK}-{YYYYMM}-{SEQ}` (e.g., `B-HSBC-202608-001`)
- **Assertions:**
  - All entries for HSBC Aug have `entry_number` matching `B-HSBC-202608-XXX`
  - All entries for Hang Seng Aug match `B-HANGSENG-202608-XXX`
  - All entries for SCB Aug match `B-STANDARDC-202608-XXX`
  - Sequence numbers are sequential (001, 002, 003...)

### TC-GJ-04: Voucher Sequence Continuity
- **Action:** Generate entries for 3 months of HSBC statements (Jun, Jul, Aug)
- **Expected:** Each month gets its own sequence starting at 001
- **Assertions:** `B-HSBC-202606-001` through `011`, `B-HSBC-202607-001` through `011`, `B-HSBC-202608-001` through `011`

### TC-GJ-05: Reversal Entry
- **Action:** `POST /api/bookkeeping/entries/:id/reverse`
- **Expected:** New entry with swapped debits/credits, same accounts
- **Assertions:** Original entry unchanged, new entry has `description` containing "Reversal"

### TC-GJ-06: Journal Entry per Bank Transaction Type
- **Action:** Auto-generate entries from HSBC Aug transactions
- **Expected:** Correct Dr/Cr per transaction type:
  - Deposit → Dr 11101 (Cash on Hand) / Cr 41101 (Revenue) or 21201 (Director Loan)
  - Withdrawal → Dr 62303 (Software) or 51101 (Subcontractor) / Cr 11101
  - Interest → Dr 11101 / Cr 42101 (Bank Interest)
  - Payroll → Dr expense / Cr 11101

---

## Feature 5: Expense Restructuring

**Source:** `api/src/routes/expense-receipts.ts`, `api/src/routes/bookkeeping.ts` (post-invoice, post-payment)

### TC-EX-01: Cash Expense with Receipt
- **Action:** Upload receipt via expense-receipts with `category = 'office'`, `payment_method = 'cash'`
- **Expected:** Journal entry: Dr 62401 (Stationery) / Cr 11101 (Cash on Hand)
- **Assertions:** `expense_receipts` row + `journal_entries` row with correct codes

### TC-EX-02: Employee Reimbursement (Credit Account)
- **Action:** Upload expense with `payment_method` not cash/bank_transfer
- **Expected:** Journal entry: Dr expense / Cr 21101 (Trade Creditors)
- **Assertions:** Credit account code is `21101` not `11101`

### TC-EX-03: Expense Category Mapping
- **Action:** Upload expenses with each category (rent, utilities, travel, office, software, insurance, professional, meals, advertising, bank)
- **Expected:** Each maps to correct COA code:
  - rent → 62101, utilities → 62201, travel → 64301, office → 62401
  - software → 62303, insurance → 63301, professional → 63101
  - meals → 64202, advertising → 64101, bank → 65101
- **Assertions:** Journal lines use correct `account_code` for each category

### TC-EX-04: Default Expense Category
- **Action:** Upload expense with no category
- **Expected:** Maps to 66203 (Miscellaneous 其他雜項)
- **Assertions:** `account_code = '66203'` in journal line

### TC-EX-05: Invoice Posting to GL (Dr AR, Cr Revenue)
- **Action:** `POST /api/bookkeeping/post-invoice/:id` for INV-2026-0042
- **Expected:** Journal entry: Dr 11201 (Trade Debtors) / Cr 41101 (Professional Services)
- **Assertions:** Entry exists, amounts = $45,000, `reference_type = 'invoice'`

### TC-EX-06: Payment Receipt Posting to GL (Dr Cash, Cr AR)
- **Action:** `POST /api/bookkeeping/post-payment/:transactionId` for matched payment
- **Expected:** Journal entry: Dr 11101 (Cash on Hand) / Cr 11201 (Trade Debtors)
- **Assertions:** Entry exists, `reference_type = 'payment'`

---

## Feature 6: Voucher Number Generation

**Source:** `api/src/routes/bookkeeping.ts` lines 1036-1049

### TC-VN-01: Voucher Format
- **Action:** Auto-generate entries for HSBC transactions
- **Expected:** Format `B-HSBC-YYYYMM-XXX` where XXX is zero-padded 3-digit sequence
- **Assertions:** Regex match `/^B-HSBC-\d{6}-\d{3}$/`

### TC-VN-02: Bank Code Normalization
- **Action:** Check voucher prefixes for all 3 banks
- **Expected:**
  - HSBC → `B-HSBC`
  - Hang Seng Bank → `B-HANGSENG` (first 6 chars, uppercase, no spaces)
  - Standard Chartered → `B-STANDARDC` (first 6 chars)
- **Assertions:** Correct prefix extraction

### TC-VN-03: Sequence Increment
- **Action:** Generate multiple entries for same bank/month
- **Expected:** Sequences increment: 001, 002, 003...
- **Assertions:** No gaps, no duplicates

### TC-VN-04: Monthly Reset
- **Action:** Generate entries for Jun, Jul, Aug of same bank
- **Expected:** Each month starts at 001
- **Assertions:** `B-HSBC-202606-001`, `B-HSBC-202607-001`, `B-HSBC-202608-001`

---

## Feature 7: Card Statement → COA Mapping

**Source:** `api/src/routes/card-statements.ts`, `api/src/routes/bookkeeping.ts`

### TC-CS-01: Card Statement Import
- **Action:** Upload `CARD_HSBC_Visa_4567_2026-08_Aug.pdf`
- **Expected:** Card statement created with 10 transactions, card_issuer = 'HSBC', last4 = '4567'
- **Assertions:** `card_statements` row, 10 `card_transactions` rows

### TC-CS-02: Card Transaction Auto-Categorization
- **Action:** After import, check card transaction categories
- **Expected:** Transactions categorized by description pattern matching:
  - "PACIFIC OFFICE SUPPLIES" → office supplies
  - "AMAZON WEB SERVICES" → cloud/software
  - "APPLE STORE" → equipment
  - "LUNCH MEETING" → entertainment/meals
- **Assertions:** `category` field populated on card_transactions

### TC-CS-03: Card Payment Links to Bank Statement
- **Action:** Card payment of $50,000 on Aug 25 should match HSBC withdrawal
- **Expected:** Auto-match links card payment to HSBC bank transaction
- **Assertions:** `card_transactions` linked to `bank_transactions` or matched by amount/date

### TC-CS-04: Card-to-Bank Reconciliation
- **Action:** After importing both card statement and HSBC Aug statement
- **Expected:** $12,800 Pacific Office card charge matches PO-2026-0891 AP bill
- **Assertions:** Invoice matched to card transaction

---

## Feature 8: Document Linkage Controls

**Source:** `api/src/routes/bank-statements.ts` (auto-match, match-suggestions), `api/src/routes/file-storage.ts`

### TC-DL-01: Invoice-to-Bank Auto-Match
- **Action:** Import HSBC Jun statement + upload INV-0042 ($45,000)
- **Expected:** Auto-match: Jun 2 "FPS INWARD - TECHGEAR HK LTD - INV-0042 SETTLEMENT" = $45,000
- **Assertions:** `bank_transactions.invoice_id` linked, `invoices.status` = 'paid' (or 'sent')

### TC-DL-02: Receipt-to-Invoice Auto-Link
- **Action:** Upload INV-0042 + REC-0015
- **Expected:** Receipt linked to invoice, invoice marked as paid
- **Assertions:** `invoices.payment_status = 'paid'` or equivalent

### TC-DL-03: Cross-Period Continuity Check
- **Action:** Import HSBC Jun + Jul statements
- **Expected:** Continuity chain shows: Jun closing $258,475.20 = Jul opening $258,475.20
- **Assertions:** `GET /api/bank-statements/continuity` shows no gaps/overlaps for HSBC account

### TC-DL-04: Missing Document Alert
- **Action:** Import bank statement with transactions that don't match any invoice
- **Expected:** Missing document % calculated, alerts shown
- **Assertions:** Audit stats include `missing_document_pct`, `receipt_vs_expense_pct`

### TC-DL-05: Cascade Soft-Delete
- **Action:** Delete a bank statement that has transactions and journal entries
- **Expected:** Transactions soft-deleted, journal entries marked `status = 'stale'`, file record preserved
- **Assertions:** `bank_statements.deleted_at` set, `bank_transactions.deleted_at` set, `journal_entries.status = 'stale'`

### TC-DL-06: Recycle Bin Restore
- **Action:** Delete statement, then restore from recycle bin within 30 days
- **Expected:** Statement, transactions, and journal entries restored
- **Assertions:** `deleted_at` cleared, transactions active again, journal entries restored from stale

---

## Feature 9: COA Balance Hiding (Reconciled)

**Source:** `api/src/routes/bank-statements.ts` (reconcile endpoint)

### TC-COA-01: Hide Fully Reconciled Accounts
- **Action:** Reconcile a bank statement, then view bank statement list
- **Expected:** Accounts with fully reconciled balances hidden from COA display
- **Assertions:** After reconciliation, those accounts don't appear in COA dropdown for new entries

### TC-COA-02: COA Account Balance Computation
- **Action:** `GET /api/bookkeeping/accounts` with `as_of` date parameter
- **Expected:** Balances computed from journal entries (journal-first, bank fallback)
- **Assertions:** Asset accounts show debit balance, liability/equity show credit balance

---

## Feature 10: Audit Stats

**Source:** `api/src/routes/bank-statements.ts`, `api/src/routes/bookkeeping.ts`

### TC-AS-01: Missing Document Percentage
- **Action:** After importing statements with unmatched transactions
- **Expected:** Stats show `missing_document_pct` = (unmatched txns / total txns) * 100
- **Assertions:** Percentage is non-negative, ≤ 100%

### TC-AS-02: Receipt vs Expense Percentage
- **Action:** After importing invoices and receipts
- **Expected:** `receipt_vs_expense_pct` = (receipts total / expenses total) * 100
- **Assertions:** Percentage computed correctly from matched data

### TC-AS-03: Real-Time Stats Update
- **Action:** Import a statement, check stats, import another, check again
- **Expected:** Stats update in real-time after each import
- **Assertions:** Second stats call shows changed percentages

---

## Test Execution Order

1. **Setup:** Login, clear state, seed COA
2. **Channel Tests (TC-UC-01 to TC-UC-08):** Verify upload categorization
3. **Bank Statement Import (TC-AD-01):** Import all 5 bank statements
4. **Card Statement Import (TC-CS-01):** Import card statement
5. **Invoice Import (TC-AD-02):** Import 3 AR invoices + 2 AP bills
6. **Receipt Import:** Import 2 receipts
7. **Voucher Numbering (TC-VN-01 to TC-VN-04):** Verify auto-generated vouchers
8. **Auto-Match (TC-DL-01 to TC-DL-02):** Verify reconciliation linkages
9. **Journal Entries (TC-GJ-01 to TC-GJ-06):** Verify Dr/Cr correctness
10. **Expense Entries (TC-EX-01 to TC-EX-06):** Verify expense routing
11. **Petty Cash (TC-PC-01 to TC-PC-03):** Verify petty cash auto-journal
12. **Continuity (TC-DL-03):** Verify statement chain
13. **Audit Stats (TC-AS-01 to TC-AS-03):** Verify real-time stats
14. **Cleanup:** Delete test data, verify cascade

---

## Playwright Config Requirements

```typescript
// playwright.config.ts
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  timeout: 300_000, // 5 min per test (OCR is slow)
  expect: { timeout: 30_000 },
  use: {
    baseURL: 'https://opcc-crm-testing.pages.dev',
    headless: true,
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'chromium', use: { browserName: 'chromium' } },
  ],
});
```

## Environment Variables Required

```bash
TEST_EMAIL=muhammadruhan.farhan25@nixorcollege.edu.pk
TEST_PASSWORD=password
TEST_BASE_URL=https://opcc-crm-testing.pages.dev
TEST_SAMPLES_DIR=C:/Users/samue/Documents/Pastel/Tech_Connect_SME/test-samples-generated-demo-company
```
