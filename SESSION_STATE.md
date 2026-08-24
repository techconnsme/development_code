# Session State — 2026-08-24 (both-side Dr/Cr account badges on statement lists)

## Credit interest → link auto-N/A (deployed v73118ed0)

Engine-tagged `interest_income` deposits (CREDIT INTEREST → 42101) can never link to an invoice — all 3 engine paths now auto-set `match_status='not_required'` (only when row has no invoice + still unmatched): file-storage import, `bank-statements/:id/auto-categorize`, `generateStatementJournalEntries` (confirm path). PUT `/transactions/:id/posting` guard relaxed: not_required blocks posting ONLY when `account_code IS NULL` (B/F rows) — interest rows keep their JE and stay manually editable. Backfilled 76 existing 42101-deposit unlinked rows → not_required (13 tenants; reversible: set back to NULL). No frontend change needed — amber flag + unreconciled filter already respect not_required.

## Bank Statements page: expand chevrons + slide animations (frontend only)

New `components/SlideOpen.tsx` — grid-template-rows 0fr↔1fr transition, self-managed mounting (double-rAF on open, delayed unmount on close; children render only while open/animating so closed instances cost nothing).

`BankStatements.tsx`:
- Transaction rows: rotating `ChevronDown` cell between Account and Linked Document (colSpan 8/9 → 9/10); expanded posting row now slides (always-rendered tr + SlideOpen; TxPostingPanel keyed by posting.entry_id so state refreshes after save).
- Statement rows: chevron upgraded to single rotating icon; expanded transaction table slides via SlideOpen. Shared detail query is keyed by expandedId, so closing content is FROZEN via `stmtContentRef` (last open JSX replayed while animating shut — avoids wrong-statement rows/loading spinner mid-close).

CardStatements: same treatment (rotating chevrons, SlideOpen at statement + transaction levels, frozen closing content via stmtContentRef, colSpan 6→7).

## Legacy 11101 Cash-on-Hand JEs — root-caused + backfilled (279 JEs, 8 tenants)

User spotted phantom `Cr 11101 Cash on Hand` line in the TxPostingPanel on a bank deposit (over-allocated 100,200/50,100).

**Root cause (2 layers):**
1. **Data**: pre-2026-08-22 auto-JEs hardcoded the fixed side to `11101` instead of the statement's real bank account (SESSION_STATE 08-22: "JEs contra = real bank acct (was always 11101)"). Verified live: `JE-AUTO-645975-b084` = Dr 11101/Cr 41101 on a bank deposit.
2. **Code**: `TxPostingPanel.tsx` derived editable contra lines by `code !== fixedCode` (not by Dr/Cr side) → the `Dr 11101` line rendered as an editable *credit* row.

**Fixes:**
1. **Panel** (`TxPostingPanel.tsx`): contra lines now derived by side (`credit>0`/`debit>0` vs contraSide); fixed row shows the JE's ACTUAL posted fixed line (code+name+amount) — legacy JEs render honestly; Save/Reset-to-auto still rebuild with the statement's real bank code, which permanently corrects them.
2. **Backfill** (`api/backfill-legacy-bank-je-11101.sql`, run on remote D1): all 279 legacy fixed-side 11101 lines retargeted to the statement's real bank — HSBC-family→`11102` (244), and per-tenant NEW accounts for other banks (user decision): Hang Seng→`11104 恒生銀行 Hang Seng Bank` (u-a21aaae1, u-bf5c166e), BOC→`11104`/`11105 中國銀行 Bank of China` (u-5bc78c1c/u-a21aaae1), StanChart→`11106 渣打銀行 Standard Chartered` (u-a21aaae1). Codes follow the COA ordering rule (next sequential leaf under `11100`). Also created missing canonical accounts (u-21e2a52a: 11102; u-d0757ac1: 10000/11000/11100/11102 + re-parented its 11101) and synced affected `bank_statements.account_code` so PATCH-regen/auto-categorize won't reintroduce wrong codes.
   - **Guards held**: contra-must-be-non-asset preserved legit cash↔bank transfers; post-verify 0 bad JEs left; per-tenant names verified.
   - **Engine follow-up (DONE, deployed v27c1505a)**: `resolveBankAccountCode(db, userId, bankName)` is now async + tenant-aware — HSBC→11102 (unchanged); Hang Seng / Bank of China / Standard Chartered → tenant's existing account matched by EN/ZH name fragment, else NEW sequential leaf under 11100 created (ordering rule, proper bilingual name + parent chain ensured); unknown banks → 11103. All 6 call sites updated (bank-journal ×2, bank-statements ×2, bookkeeping auto-generate, file-storage import). Tests: `tests/bank-resolver.test.ts` (20 cases, mock db); categorizer tests updated to async signature. 90/90 green.

## Both-side Dr/Cr badges (earlier this session)

`BankStatements.tsx` + `CardStatements.tsx` Account columns now render ALL posting lines as stacked badges — `Dr`(blue)/`Cr`(orange) prefix + code + name, amount in tooltip; temp-account red tint kept; split label only >2 lines; contra badge click-to-edit. Plan Decision #3 (`2026-08-24-multi-account-posting.md`) completed. Verified `CardStatementReview.tsx:274-275` preview already correct (Cr 11101 matches real card posting).

---

# Session State — 2026-08-22 (bank charge → COA auto-linking + auto-match fix)

## Auto-match "no suggestions" root cause (fixed, deployed 2ed538e2)

Symptom: POST /bank-statements/auto-match returned 0 suggestions everywhere (PNR bank-link rate 4.5%, chain 0%).

Stacked root causes:
1. **Exact-amount-only gate** (`|Δ|<0.01`): real HSBC narrations never carry invoice numbers or exact totals → nothing ever matched. Replaced with graduated tiers in NEW lib `api/src/lib/bank-matcher.ts`: high=narration contains inv#; medium=exact amt in issue→due+7; low=near-amt ≤max(HK$10, 0.5%) ±window; low=counterparty fuzzy ≥80 (company-matcher) within issue−15→due+45 AND amount within ⅓–3× of total. Tests: tests/bank-matcher.test.ts (13 cases).
2. **NULL match_status excluded** by strict `='unmatched'` → now `(IS NULL OR ='unmatched')`; 'skipped' still respected (response adds excluded_skipped). PNR had 61/67 mass-skipped via skip-link toggle — reset to 'unmatched' (data op on u-83161e0c).
3. **Wrong counterparty for AP**: route used COALESCE(cust.name, supp.name); AP invoices carry placeholder customer (=own company) so name tier scored against ourselves. Now direction-aware: incoming→supplier, outgoing→customer.
4. Debug journey gotcha: leftover `bestConfidence` ref after destructure refactor → runtime 500 only visible live (esbuild doesn't catch undefined vars).

Verified live (v `2ed538e2`): PNR now suggests 2 low-confidence Pastel Tech links ($5,100→INV-MT1MAIS6, $27,544→INV-MT2DDQ93). EHSIA=0 is correct-empty (zero open invoices). Deploy propagation takes ~5s — first post-deploy probe can hit the old version.

Link-rate context: global bank↔invoice 30/474 (6.3%), inv↔receipt 3/105, full chain 0/474 structurally (no invoice has both links anywhere).

## Bank charge auto-linking to COA (spec: docs/superpowers/specs/2026-08-22-bank-charge-auto-linking-design.md)

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

**DEPLOYED 2026-08-22:** API version `8d8e1c10` (https://opcc-crm-api.ruhan-farhan.workers.dev); Frontend https://41405f75.opcc-crm-testing.pages.dev

**Live QA (EHSIA tenant u-8e3759d7 via joseph.lin@pnr.hk / X-Active-Client fc-769f1c52):**
- Upload of real `eStatement 202504.pdf` resolved bank_code=**11102** ✓
- ⚠️ Pre-existing upstream issue: tomarkdown OCR text was PERFECT but tx parser returned **0 transactions** (unrelated to this feature; DeepSeek extraction step — investigate separately)
- Engine verified live by inserting the OCR rows then `POST /bank-statements/:id/auto-categorize`: CREDIT INTEREST→42101, SZETO CHI MAN ATM→21201, PAPER STATEMENT FEE/BLG CQBK FEE/MONTHLY SERVICE FEE/ACCOUNT APPLICATION FEE(all two-line)→**65101**, B/F skipped
- `POST /bookkeeping/auto-generate-entries` posted balanced JEs: Dr 65101/Cr **11102** ×4 fees, Dr 11102/Cr 42101, Dr 11102/Cr 21201, voucher `B-HSBC-2025MM-NNN` ✓
- QA data fully cleaned (JEs/lines, transactions, statement, file_record, R2 object) — verified zero rows remain

**NOT done:** historical misposted data untouched.

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

## Sample-data link audit (2026-08-24)

Independently re-parsed all 30 statements (16 PNR + 14 EHSIA, both Current+Savings sections) and every invoice total; exhaustive payee-gated subset matching. Full detail in `test-sample-real/LINKS_REPORT.txt` §4.

**One bank tx = 2+ invoices — only 3 cases exist, all PNR→Pastel:**
- 19 Sep 2025 57,580.80 = Pastel #001414 (15,300) + #001417v2 (42,280.80) — receipt #001281 confirms both
- 5 Nov 2025 55,000 = Pastel #001441 (40,050) + #001442 (14,950) — receipt #001294 confirms both
- 5 Feb 2026 27,544 = Pastel #001458v2 (5,200) + #001467-v2 (4,150) + #001484-v2 (18,194) — THREE invoices
- EHSIA side: NONE (all 1:1)
- ⚠️ Ground-truth conflict: the auto-match suggestion `$27,544→INV-MT2DDQ93` (single invoice, low confidence, from the 2026-08-22 session) cannot be correct — 27,544 is a 3-invoice combined payment. Exact-amount single-invoice matching can never resolve this case; combined-payment handling is a known gap.

**Split payments (one invoice = 2+ txs):**
- VEII 2025006 (38,544) = ECQ 102872 11,550 + ECQ 102871 26,994 (both 4 Feb 2026)
- Founders funding 52,000 each = 50,000 (10 Jan) + 2,000 (27 Jan JL / 1 Feb RS via ATM) — matches Master-PnR.xlsx
- EHSIA funding RS 52,000 = 50,000 (20 Mar) + 2,000 (2 Apr)

**Ruled-out coincidences:** PNR 27 Jan 2,000 ≠ BR deposits 1,000+1,000 (BR is Oct); 27 Oct WEB HOSTING 1,000 ≠ DNS 500 + MuseLab 500 (paid 20 Oct separately); Pastel 001500 (13,350) ≠ 5,100 + 8,250 (those txs belong to 001473/001511).

**Corrections to earlier notes:** EHSIA Respect I0107 total = 4,200 (not 4,400; the 200 AoA/NNC1 line is only on PnR's I0105); EHSIA fee refunds = 3 × `REFUND MONTHLY FEE25` 200.00 (9 May ×2, 16 Jun ×1); VEII 2025002v2 total = 67,130.80 (matches bank 18 Sep exactly).

## Multi-invoice (1:N) combined-payment matching SHIPPED (2026-08-25)

Auto bank→invoice matching now links ONE bank tx to MULTIPLE invoices (combined payments). Spec: `docs/superpowers/specs/2026-08-24-multi-invoice-bank-matching-design.md` · Plan: `docs/superpowers/plans/2026-08-24-multi-invoice-bank-matching.md` (+ task briefs/reports in `.superpowers/sdd/2026-08-24-multi-invoice-bank-matching/`). Code through commit `66969d0`; migration `api/src/db/migration-bank-transaction-invoice-links.sql` applied to REMOTE D1 (indexes idx_btil_tx + idx_btil_inv verified); API worker redeployed (version 0843f0a5) + frontend rebuilt and deployed to Cloudflare Pages.

**Live verification on production (tenant u-83161e0c), all PASS:**
- Auto-match suggests the three Pastel combined payments as group rows with `invoice_ids` sizes **2 / 2 / 3** (57,580.80 / 55,000 / 27,544), reason "Combined payment: …", confidence=medium. This RESOLVES the ground-truth conflict flagged above — 27,544 now suggests its true 3-invoice group instead of a wrong single invoice.
- Headed Playwright run (`SKIP_UPLOAD=1 HOLD_MS=30000 npx playwright test auto-link-onetomany --headed`) passed; deterministic API script `tests/verify-onetomany-live.ts` passed all steps.
- 55,000 group end-to-end: confirm → both invoices paid + payment JE `JE-PMT-MULTI-*` with 3 lines (Dr 21101 ×2 per-invoice allocations + Cr 11102 55,000); unlink → invoices back to `sent`, tx back to `unmatched`. Tenant left as found. Edge case: confirm with empty `invoice_ids` → HTTP 400.

**Anomalies (minor):** spec test logs `invoice undefined` for group rows (it reads single-invoice fields that group rows don't have — engine output correct); first verify-script run hit a script bug parsing GET /transactions (`{data:[...]}` shape), fixed and re-run clean; wrangler 3.x deprecation warning during deploys (non-blocking).

**Follow-up (same day):** hardened verify-onetomany-live.ts landed (a87d76b) �X PARTIAL=1 read-only mode, finally-unlink cleanup guarantee, strict reversion gate (invoices unpaid AND tx unmatched AND invoice_id NULL), exit-code gate; regression-tests/REGRESSION_SUITE.md now records the 3 multi-invoice checks + 1 split-payment case. Fresh PARTIAL=1 production run: exit 0, all 3 group suggestions correct.

**Deferred-minors sweep (2026-08-25):** all remaining 1:N review nits closed or explicitly waived �X matcher JSDoc accuracy + 3 new group tests (27 total), stmtFileIdFor single-JOIN perf fix, typed/expanded validator tests (13), collision-safe COMBINED pane keys, truthful modal consumer list, auto-link-onetomany.spec.ts now git-tracked with shape-aware group logging. Commits f27c452 bf2e260 ad916db 32c2a97; full evidence in .superpowers/sdd ledger.
