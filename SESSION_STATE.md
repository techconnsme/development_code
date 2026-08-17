# Session State — 2026-08-17/18 (evening session)

## Deployed URLs (latest)

| | URL |
|---|---|
| **Frontend (test)** | https://d85f468d.opcc-crm-testing.pages.dev |
| **API Worker** | https://opcc-crm-api.ruhan-farhan.workers.dev (version `7884689d`) |

## Test Credentials (verified)

| User | Email | Password | Notes |
|------|-------|----------|-------|
| Joseph Lin (PnR) | joseph.lin@pnr.hk | **Test1234** | firm f-f10e2458; client EHSIA fc-769f1c52 → u-8e3759d7 |
| EHSIA company (firm client) | Joseph@sample.com | — | tenant u-8e3759d7 |
| Demo Supervisor | muhammadruhan.farhan25@nixorcollege.edu.pk | password | u-a21aaae1 |

## What was done this session

### Data operations (live D1)
- Hard-deleted ALL of Joseph Lin's uploads + derived data early in the session (SQL kept in `api/hard-delete-joseph-uploads.sql`, keys in `api/r2-keys-to-delete.txt`)
- Hard-deleted EHSIA `Invoice #E2025501.pdf` repeatedly during testing; **account currently clean** (0 VEII invoices, 1 unrelated invoice left)
- Soft-deleted 151 orphan transactions under soft-deleted statements (+133 JEs staled)
- Corrected company name spelling: **"Proficiency and Reliance Company Limited"** (users + company_settings for u-83161e0c)
- Backfilled 20 company_settings rows with NULL id (`id = 'cs-' || user_id`)
- **NOT run**: backfill of the 16 accounts missing company_settings (user deferred — login self-heal handles them progressively)

### Code fixes (all deployed + pushed except last batch)
1. **A1** — gated waitUntil auto-import blocks (upload double-created records)
2. **A2/A3** — fixed `forcedType` / `glmUsage` TDZ ReferenceErrors (empty-OCR + GLM fallbacks were dead code)
3. **A4/B** — invoice discard soft-deletes invoice + file (bank-statement style), Recycle Bin invoices section, `/file-storage/recycle` subpage grouped by file type
4. **A5** — GLM key → `c.env.GLM_API_KEY`; **Z.AI balance EXHAUSTED (429 "Insufficient balance") — recharge needed for GLM-OCR**
5. **A6** — Documents page: no `documents` table exists anywhere (feature decision pending)
6. **Unified matching** — `/bank-statements/auto-match` is the only engine (suggest-only, `?direction=`, currency check); `PATCH /transactions/:id/match` hardened (direction/amount/currency/idempotency validation, server-side GL posting via `api/src/lib/post-payment.ts`, file payment_status sync, unlink reverts everything); retired `/file-storage/auto-match-invoices` + `confirm-match`
7. **Shared `AutoMatchReviewModal`** — 95vw, animated accordion dual-PDF preview (statement+invoice side by side), used by Bank Statements / File Storage / AP ("Match Bank Payments") / AR ("Match Bank Deposits") / dashboard
8. **Printed-total cross-check** — EN+ZH HK total labels, three-signal credibility rule (printed vs AI vs item sum); fixes EHSIA $480 vs $4,800 class
9. **Direction detection** — own-name fallback to `users.company_name`; `company_not_detected` flag in fallback branch; `company_settings` self-heal on login + staff creation
10. **New-company flag** — `new_counterparty` + `new_company` review flag + 🆕 banner on review page; batch skip works (live DB lookup)
11. **PDF previews in firm-client contexts** — iframes can't send X-Active-Client → `?client=` param on download URLs + `iframeClientParam()` helper
12. **COA account editing** — "Hide reconciled COA" default OFF; lock now keys off real `is_reconciled` (bank_reconciliations row) not `balance_status='ok'`
13. **firms.ts** — client creation now writes `company_settings.id` (was NULL — SQLite TEXT PK quirk)

### Playwright test (passed)
- `regression-tests/veii-direction-check.spec.ts` — uploads all 15 `test-sample-real/PNR/VEII/Invoice *.pdf` as Sales Invoices, verifies direction=outgoing + vendor="Value Exchange Int'l (Hong Kong) Ltd" + line items + Expenses page listing. **15/15 passed.** Run: `TEST_BASE_URL=<url> npx playwright test tests/veii-direction-check.spec.ts --headed`
- Gotchas learned: upload page needs "Upload & Analyze" click after file selection; clean imports go to Expenses list (not review page); dismiss floating AI Token Usage widget

## Still open (audit findings not yet fixed)
- **C1 double-posting** (import auto-JE + post-payment for matched txs), **D1** invoice delete FK crash, **E1** unvalidated confirm-receipt-match, **B1** needs_review never cleared, plus C2–C10 / D2–D10 / E2–E6 from the 2026-08-17 audit (30 findings total, ~10 fixed)
- Z.AI recharge for GLM-OCR
- Documents page: create table (R2-backed) or retire the feature
- 10 accounts with no company name anywhere — will be flagged at import until set

## Key files
- `api/src/lib/post-payment.ts` (NEW) — shared GL payment helper
- `frontend/src/components/AutoMatchReviewModal.tsx` (NEW) — unified match review modal
- `api/src/lib/company-matcher.ts` — fuzzy matcher (scores ~97 for Proficient/Proficiency)
- `regression-tests/veii-direction-check.spec.ts` (NEW)
