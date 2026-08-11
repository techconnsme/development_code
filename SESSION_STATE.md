# Session State — 2026-08-11

## Deployed URLs

| | URL |
|---|---|
| **Frontend** | `https://main.opcc-crm.pages.dev` |
| **API** | `https://opcc-crm-api.ruhan-farhan.workers.dev` |

## Test Credentials

| User | Email | Password | Role |
|------|-------|----------|------|
| Joseph Lin (PNR) | `joseph.lin@pnr.hk` | `Test1234` | supervisor, firm_admin |
| QA Tester | `muhammadruhan.farhan25@gmail.com` | `Ruhan123` | firm `firm-ruhan01` |
| Demo Supervisor | `muhammadruhan.farhan25@nixorcollege.edu.pk` | `password` | supervisor |

## Completed Today

### 1. AP Invoice PDF View Fix
- `AP.tsx`: Eye icon now shows original uploaded PDF via iframe instead of HTML bill preview
- `Invoices.tsx`, `BankStatements.tsx`: Added `?inline=1` to file-storage download URLs

### 2. COA Missing Codes — New Modal
- `MissingCodesModal.tsx`: Shows exactly which codes are missing + transactions referencing them
- Per-code "Create Account" button (calls `POST /bookkeeping/accounts/ensure`)
- Per-transaction "Reassign" dropdown + "Post to GL" button
- "View Details" replaces old "Create Missing" + "Use Industry Template" buttons
- `POST /bookkeeping/accounts/ensure`: Creates account + missing parents recursively
- Fixed `getParentCandidates` infinite recursion bug (self-reference for XX000 codes)
- Fixed bare-code COA names (auto-resolve from HK_COA_NAMES)

### 3. Dashboard Revamp
- Replaced Tasks Due with Documents to Review (→ `/review-queue`)
- Unreconciled card clickable → `MatchSuggestionsModal` (bank→invoice, bank→card, receipt→invoice)
- New link-coverage stats: %Bank→Invoice, %Invoice→Receipt, %Full Chain
- Deleted Reconciliation Status panel
- New API: `GET /api/dashboard/link-stats`

### 4. Global Fiscal Year Filter
- `DateFilterContext.tsx`: React context with localStorage persistence
- `DateFilterSelect.tsx`: Sidebar dropdown under company selector
- Defaults to most recent **completed** fiscal year
- Wired to: COA, Bookkeeping/GJE, BankStatements, Invoices, AP, AR, Dashboard
- BankStatements now filters by `period_end` range (not single year)
- COA shows cumulative balance note (not filtered by sidebar FY)
- New API: `POST /bookkeeping/post-transaction/:id` — single-tx GL posting

### 5. Hard-Reset API
- `POST /api/admin/hard-reset-data`: Hard-deletes ALL transactional data
- Keeps COA accounts, company settings, user accounts
- Access: admin, firm_admin, or higher-tier users

### 6. Regression Test Suite
- `tests/REGRESSION_SUITE.md`: Master document with ground truth tables
- `tests/regression-ground-truth.json`: Machine-readable expected values
- `tests/run-regression-api.ts`: API verification script (78 checks across 15 documents)
- `tests/regression-full-flow.spec.ts`: Playwright browser test (5 tests)

## Regression Test Results: 65/78 (83%)

### ✅ What's Working
- Bank statements: account # `147-162101-838`, bank HSBC, transactions, balances
- VEII invoices: direction outgoing, customer "Value Exchange Int'l (Hong Kong) Ltd"
- EHSIA invoice: direction incoming, vendor "Empower Health and Sports Informatics association"
- Respect invoice: direction incoming
- MuseLabs invoice: direction incoming
- All receipts: import correctly with receipt numbers and totals
- Cross-document: continuity chain, auto-match endpoints

### ❌ Remaining Failures (13) — OCR Quality Issues
| Issue | Files |
|-------|-------|
| DeepSeek misidentifies vendor as "Joseph Lin" | Pastel `#001414`, `#001547-v3` |
| Vendor empty | Pastel `#001397`, MuseLabs `INV022-1319` |
| Total=0 (OCR missed amount) | Pastel `#001397`, Respect `I0105` |
| Receipts not auto-linked | 3 receipts (amount-based matching fails for multi-invoice receipts) |
| Bank name OCR variance | One statement returns full legal name vs "HSBC" |

Root cause: DeepSeek/toMarkdown OCR pipeline. Direction detection logic is correct — failures are PDF parsing issues.

## Key Files Modified This Session

### API
- `api/src/routes/bookkeeping.ts` — `ensureMissingAccounts`, `getParentCandidates`, `getMissingParentChain`, `POST /accounts/ensure`, `GET /missing-codes/details`, `POST /post-transaction/:id`, auto-resolve bare-code names
- `api/src/routes/dashboard.ts` — `GET /link-stats`, `review_queue_total`, date range params
- `api/src/routes/bank-statements.ts` — `period_end` date range filter
- `api/src/routes/invoices.ts` — `start_date`/`end_date` filter
- `api/src/routes/file-storage.ts` — `limit` query param
- `api/src/routes/admin.ts` — `POST /hard-reset-data`
- `api/src/lib/company-matcher.ts` — (reverted fuzzy match change)

### Frontend
- `frontend/src/lib/fiscalYear.ts` — **NEW** shared `buildFiscalYearOptions`
- `frontend/src/contexts/DateFilterContext.tsx` — **NEW** global FY context
- `frontend/src/components/DateFilterSelect.tsx` — **NEW** sidebar FY dropdown
- `frontend/src/components/MatchSuggestionsModal.tsx` — **NEW** link suggestions modal
- `frontend/src/components/MissingCodesModal.tsx` — **NEW** COA missing codes modal
- `frontend/src/pages/Dashboard.tsx` — Full revamp
- `frontend/src/pages/ChartOfAccounts.tsx` — Cumul. balance note, global FY, removed local FY
- `frontend/src/pages/Bookkeeping.tsx` — Global FY, removed local FY + dropdowns
- `frontend/src/pages/BankStatements.tsx` — Global FY filter, inline=1 fix
- `frontend/src/pages/Invoices.tsx` — Global FY filter, inline=1 fix
- `frontend/src/pages/AP.tsx` — Global FY filter, PDF view fix, FileText import
- `frontend/src/pages/AR.tsx` — Global FY filter
- `frontend/src/components/Layout.tsx` — DateFilterProvider + DateFilterSelect

### Tests
- `tests/REGRESSION_SUITE.md` — **NEW**
- `tests/regression-ground-truth.json` — **NEW**
- `tests/run-regression-api.ts` — **NEW**
- `tests/regression-full-flow.spec.ts` — **NEW**

## Running Regression Tests

```bash
# Reset + API verification
cd latest_code
npx tsx tests/run-regression-api.ts

# Playwright UI tests
npx playwright test tests/regression-full-flow.spec.ts --headed --reporter=list
```

## Sample Documents

- `test-sample-real/PNR/estatement/` — 18 HSBC bank statements
- `test-sample-real/PNR/Pastel/` — 50 Pastel invoices + receipts
- `test-sample-real/PNR/VEII/` — 58 VEII invoices + receipts
- `test-sample-real/PNR/Muselab/`, `Respect/`, `EHSIA/`, `Gov/`, `VTC/`
- `test-sample-real/PNR/Travel Expense/Shanghai-Nanjing/` — 32 expense receipts
- `test-sample-real/EHSIA/` — EHSIA company documents

## Joseph Lin (PNR) Data Snapshot

- User ID: `u-83161e0c`
- Company: "Proficient and Reliance Company Limited"
- Bank: HSBC Business Direct, Account `147-162101-838`
- 12 COA accounts, 117 journal entries (all posted), 21 unmatched bank transactions
- 5 invoices (4 incoming AP + 1 outgoing AR), HKD 46,200 AP + HKD 20,550 AR
- Fiscal year: Apr–Mar (default FY 2025-2026)
