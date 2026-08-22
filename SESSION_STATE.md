# Session State — 2026-08-22 (bank charge → COA auto-linking)

## What was done this session (2026-08-22)

### Bank charge auto-linking to COA (spec: docs/superpowers/specs/2026-08-22-bank-charge-auto-linking-design.md)

**New shared engine** `api/src/lib/transaction-categorizer.ts` — replaces 4 divergent inline rule copies:
- `normalizeDescription()` — uppercase/collapse; strips HSBC cheque refs (`HC…`), transfer refs (`NA…`), `REF:xxxx xxxx`, dates `(03NOV25)`/`19MAR`, amounts
- Tier-1 ordered rules (~45) grounded in REAL HSBC Business Direct descriptors: bare `CHARGES`→65101, `MONTHLY SERVICE FEE`/`PAPER STATEMENT FEE`/`ACCOUNT APPLICATION FEE`/`BLG CQBK FEE`→65101, `DEBIT INTEREST`/`INTEREST CHARGE`→65102 vs `CREDIT INTEREST`(dep)→42101, `REFUND …FEE`(dep)→65101 fee_refund, `INLAND REVENUE`→21301, `SWEEP`/bare `CR TO`→internal_transfer(no JE), masked director `LIN P** K**** J*****`→21201
- Tier-2 fuzzy: reused `levenshtein` from company-matcher; prefix-relation=0.9, edit-ratio ≥0.85 else null (no silent guesses)
- `resolveBankAccountCode()`: HSBC/滙豐/Shanghai Banking→11102 else 11103

**Wired into:**
1. `file-storage.ts` import — persists `bank_statements.account_code`; JEs contra = real bank acct (was always 11101); skips invoice-matched txs (C1 double-post shrink) + internal transfers; missing accounts via `ensureMissingAccounts` (proper names, no code-as-name placeholders); response adds `auto_categorized/bank_account_code/skipped_transfers`
2. `bank-statements.ts /:id/auto-categorize` — engine + dup-guard kept; compliance block now reads in-loop matched codes (was reading stale rows = dead code)
3. `card-statements.ts /:id/auto-categorize` — WRONG codes fixed (BANK CHARGE was 65102 Loan Interest, ADVERTISING was 65101 Bank Fee, nonexistent 62304 etc.)
4. `bank-statements.ts PATCH transactions/:id` regen — engine-first, user override wins, contra = stmt bank code, draft status kept
5. `bookkeeping.ts /auto-generate-entries` — engine-first w/ legacy fallbacks, bank contra, essentials += 11102/11103/21301/65101/65102; **removed phantom `journal_lines.project` column ref** (never applied to live D1 — was crashing this endpoint)

**UI:** statement review rows show COA select (fetch `/bookkeeping/accounts`) → PATCH account_code regenerates JE server-side.

**Tests:** `npx --yes tsx tests/categorizer.test.ts` — 46 cases from real corpora. NOTE: root `.gitignore` ignores `tests/` — file force-added (`git add -f`).

**Verified:** wrangler --dry-run bundles OK after each change; frontend `npm run build` OK.

**NOT done:** deploy to worker; post-deploy QA (upload `test-sample-real/EHSIA/eStatement/eStatement 202504.pdf` as joseph.lin@pnr.hk — richest fee month: monthly service/paper statement/CQBK/application fees → expect 65101 with 11102 contra). Historical misposted data untouched.

## Deployed URLs (latest — PRE-this-feature)

| | URL |
|---|---|
| **Frontend (test)** | https://d85f468d.opcc-crm-testing.pages.dev |
| **API Worker** | https://opcc-crm-api.ruhan-farhan.workers.dev (version `34207216`, 2026-08-18) |

## What was done this session (2026-08-18)

### Invoice direction — Pastel incoming invoices were silently marked outgoing

**Root cause:** Pastel invoice template has NO letterhead vendor name and NO "Bill To:" label — the vendor only appears in the bank "A/C Name" section. DeepSeek guessed roles by reading order (swapped parties, or person names like "Joseph Lin" counted as a party), and the old direction logic treated "vendor = our company" as confident outgoing with no review flag.

**Fixes (all deployed):**
1. **`api/src/lib/direction-resolver.ts` (NEW)** — pure `resolveDirection()` replacing the inline direction block:
   - A/C Name cross-check: the A/C Name holder is the invoice issuer (verified across Pastel/VEII/EHSIA) → detects swapped vendor/customer and re-evaluates
   - Rule 6: third-party A/C Name + only our company extracted → incoming from the A/C Name
   - Thin-parse guard: one-party parses without corroboration → `needs_direction_review` (triggers GLM retry + review flag) instead of silent outgoing
   - Person-name filter (`isLikelyPersonName`): "Joseph Lin" etc. no longer counts as an invoice party
   - Reused by the GLM-OCR retry re-check (which previously had a latent ReferenceError on `ownCandidates` — hoisted now)
2. **pdf.js text-layer OCR (NEW first attempt in the invoice OCR cascade)** — free, deterministic, fixes the toMarkdown failures (001397's OCR was nearly empty):
   - `extractPdfText()` drives `pdfjs-dist` directly; the fake worker works in workerd ONLY after publishing the statically-imported worker module at `globalThis.pdfjsWorker` (pdf.js checks it before its runtime import, which workerd can't resolve). Lessons: unpdf's serverless bundle crashes in workerd; the legacy `require()` build silently returned null.
   - `api/src/lib/pdf-layout.ts` (NEW) — position-aware join of pdf.js text items; plain `join(' ')` fragments numbers ("3 4 , 2 00.00" → "34,200.00")
   - `file_records.ocr_text_source` column (schema.sql + live D1 ALTER) so `ocr_source` in responses is honest
3. **`api/src/lib/printed-total.ts` (NEW)** — extracted the printed-total regex; the bare `TOTAL` alternative matched "Monthly Total 1 Jan 2025" dates on the pdf-text OCR (bogus printedTotal=1). Month/date guard added.
4. DeepSeek hint: A/C Name is passed as "bank account of the invoice ISSUER".

**Verified live (Joseph Lin account, then cleaned up):** 4 Pastel invoices all auto-import incoming with correct totals and NO review flags (001397: $19,600; 001414: $15,300; 001458: $5,600; 001547: $34,200); VEII 2025001 still outgoing $45,700 clean. ocr_source = 'pdf-text'.

**Tests (NEW, run with `npx tsx tests/<file>.test.ts`):**
- `tests/direction-resolver.test.ts` — 17 cases (real captures: Pastel swaps, thin parses, VEII outgoing + mirror-swap, EHSIA, person names, legacy fallbacks)
- `tests/printed-total.test.ts` — 6 cases
- `tests/pdf-layout.test.ts` — 5 cases

### Notes
- Z.AI (GLM-OCR) daily quota resets ~midnight UTC; was exhausted mid-session, recovered later — GLM retry works when quota allows.
- Worker bundle: ~1,071 KiB gzip (pdf.js + worker included; deploys fine on this account tier).
- Pre-existing tsc errors untouched (`paddedPw`, `GITHUB_TOKEN` bindings etc.) — deploy path uses esbuild, no type-check.
- unpdf added to api/package.json but NO LONGER USED (its serverless bundle crashes in workerd) — safe to uninstall.
- `pdf_text_diag` + `__build` fields were added to the import-document response for remote debugging (harmless, keep).
- VEII Playwright regression (15 files) not re-run this session; API-level VEII check passed. Run: `TEST_BASE_URL=<url> npx playwright test tests/veii-direction-check.spec.ts --headed`

## Previous session context (2026-08-17/18 evening)



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
