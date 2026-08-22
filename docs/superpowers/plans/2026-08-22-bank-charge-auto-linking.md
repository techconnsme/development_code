# Bank Charge Auto-Linking Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Auto-link bank-statement transactions (especially bank charges) to correct COA accounts via one shared categorization engine, auto-post JEs at import with the real bank account as contra, fix card-statement codes, surface COA in review UI.

**Architecture:** New pure lib `api/src/lib/transaction-categorizer.ts` (normalize → Tier-1 regex rules → Tier-2 fuzzy via reused `levenshtein`). All 4 rule sites call it. Import path persists statement bank code (`11102` HSBC / `11103` other), skips JE for invoice-matched + internal-transfer rows.

**Tech Stack:** TypeScript, Cloudflare Workers, D1, React; tests run with `npx --yes tsx`.

**Spec:** `docs/superpowers/specs/2026-08-22-bank-charge-auto-linking-design.md`

## Global Constraints

- No new npm dependencies.
- Workers-compatible: no Node APIs in `api/src/lib/`.
- Categorization is best-effort: every integration wrapped so import never fails because of it.
- Never reference `journal_lines.project` column (does not exist in live D1).
- Normalized descriptions are UPPERCASE, hyphens/slashes/punctuation collapsed to spaces (CJK kept). Patterns must not contain `-`, `/`, or `.` inside tokens.
- Test runner from repo root: `npx --yes tsx tests/categorizer.test.ts`.
- Deploy path uses esbuild — avoid syntax that only tsc would catch being introduced broken.

---

### Task 1: Categorizer module (TDD)

**Files:**
- Create: `api/src/lib/transaction-categorizer.ts`
- Test: `tests/categorizer.test.ts`

**Interfaces (produced):**
```ts
export type RuleTag = 'bank_charge' | 'fee_refund' | 'interest_income' | 'interest_expense'
  | 'income' | 'internal_transfer' | 'tax' | 'director' | 'expense' | 'ignore';
export interface CategorizeRule { pattern: RegExp; code: string; tag: RuleTag; direction?: 'deposit' | 'withdrawal'; }
export interface CategorizeResult { code: string; tag: RuleTag; confidence: 'exact' | 'fuzzy'; }
export function normalizeDescription(raw: string): string;
export function categorizeTransaction(rawDesc: string, dir?: 'deposit' | 'withdrawal'): CategorizeResult | null;
export function resolveBankAccountCode(bankName?: string | null): '11102' | '11103';
export function isDirectorDescription(normDesc: string): boolean;
```
`code === ''` ⇒ no posting (tag `ignore` / `internal_transfer`); `null` ⇒ uncategorized.

- [ ] **Step 1: Write failing test** `tests/categorizer.test.ts` — self-running asserts via `node:assert/strict`, corpus = real EHSIA/PNR descriptors + generated-sample formats. Cases: bare `CHARGES`+ref noise→65101(wd); `MONTHLY SERVICE FEE`, `PAPER STATEMENT FEE`, two-line `ACCOUNT APPLICATION\nFEE`, `BLG CQBK FEE`, `FPS FEE`, `WIRE TRANSFER FEE`, `HANG SENG CARD FEE`, `HSBC CREDIT CARD FEE`→65101; `28MAY25 TO 27JUN25\nDEBIT INTEREST`(wd)→65102 vs `CREDIT INTEREST`(dep)→42101; `REFUND MONTHLY FEE25\n0509163829754`(dep)→65101 fee_refund; `B/F BALANCE`→'' ignore; `FROM PROFICIENCY & R\nSWEEP (30MAY25)`→internal_transfer ''; `CR TO WEB HOSTING (27OCT25)`(wd)→NOT transfer→62302; `INLAND REVENUE DEPAR\nHC…`(wd)→21301; masked `LIN P** K**** J*****\nHC…`(dep)→21201 director; `SZETO CHI MAN\nATM TRANSFER (20MAR25)`(dep)→21201; truncation fuzzy `SMART CITY CONSORTIU`→null (no category word); typo `SERVCE FEE`(wd)→65101 fuzzy; `FEES`(wd)→65101 fuzzy; generated formats `BANK CHARGES-MONTHLY FEE`→65101, `FPS INWARD-CUSTOMER PAYMENT`(dep)→41101, `PAYROLL-JULY 2026`(wd)→61201, `AUTO DEBIT-HKT TELECOM`(wd)→62301, `INTEREST-SAVINGS ACCOUNT`(dep)→42101, `GOOGLE ADS`→64101 not 62303, direction guard: `DEBIT INTEREST` passed as dep→null; `resolveBankAccountCode('HSBC')='11102'`, `'Hang Seng Bank'/'未知'/'null'='11103'`; normalizeDescription strips refs/dates/amounts.
- [ ] **Step 2: Run** `npx --yes tsx tests/categorizer.test.ts` → FAILS (module missing)
- [ ] **Step 3: Implement module** per spec §4: `normalizeDescription` (uppercase→collapse ws→strip `HC[0-9A-Z]{8,}`, `N[A-Z]{0,2}\d{8,}`, `REF:[A-Z0-9]{4}\s?\d{4}`, `(03NOV25)`/`19MAR` dates, digit-bearing tokens, punctuation except `& * ` and CJK); ordered `CATEGORIZE_RULES` (~45 rules exactly as spec §4.3 table: ignore→fee_refund→interest_expense→bank-charge block(^CHARGES first)→interest_income(dep)→internal_transfer(`\bSWEEP\b|^CR TO\s*$|^FROM\s*$`)→tax(INLAND REVENUE|稅務局|PROFITS? TAX|IRD|TAX|稅, wd)→catalog wd(PASTEL TECH/SUB CONTRACT→51101, AUDIT/DELOITTE/KPMG/PWC→63101, SECRETARY/HKICS→63102, LEGAL/BAKER MCKENZIE→63103, INSURANCE→63300, SALARY/PAYROLL/WAGE→61201, MPF/MANULIFE→61202, RENT→62101, CLP/HK ELECTRIC/ELECTRICITY/電費→62201, WATER→62202, UTILITIES→62200, GOOGLE ADS/ADVERTISING/MARKETING→64101 BEFORE software, WEB HOSTING/DOMAIN/DNS→62302, HKT/TELECOM/BROADBAND/MOBILE/PHONE/PCCW→62301, SOFTWARE/SUBSCRIPTION/AWS/MICROSOFT/ADOBE/CLOUD→62303, VISA DEBIT→62303, MTR/UBER/TAXI/OCTOPUS→64301, CATHAY/AIRLINE/HOTEL/FLIGHT/TRAVEL→64302, DELIVEROO/FOODPANDA/RESTAURANT/CAFE/STARBUCKS/DINING/MEAL→64202, COMMISSION→64201, ENTERTAINMENT→64202, OFFICE SUPPLIES/WHSMITH/OFFICE DEPOT/STATIONERY/PRINTING→62401, PARKNSHOP/WELLCOME/SUPERMARKET/GROCERY/AEON/PANTRY→62402, APPLE/SHOPEE/AMAZON/SHOPPING→66203, COURIER/POSTAGE/SF EXPRESS→66203, REPAIR/MAINTENANCE→66203, DONATION→66202, OUTCLEARING/CHEQUE RETURN/退票→66203, TRANSFER DEBIT→66203; catalog dep(CLIENT PAYMENT/CUSTOMER PAYMENT/FPS INWARD/INWARD REMITTANCE/CHEQUE DEPOSIT/DEPOSIT MACHINE/ECQ DEPOSIT/CREDIT TRANSFER/收款/入賬→41101)); director names JOSEPH LIN/LIN PUI KEUNG/SZETO CHI MAN/LAI KIN CHEONG + masked `LIN P\*\* K\*\*\*\* J\*\*\*\*\*` + initials `LIN P K J` → dep always, wd only when `/TRANSFER|FPS|ATM|SWEEP|轉賬/` present → 21201; fuzzy tier: FUZZY_KEYWORDS [{CHARGE,65101,wd},{FEE,65101,wd},{HANDLING,65101,wd},{SUBSCRIPTION,62303},{ADVERTIS,64101},{RENTAL,62101},{SALARY,61201},{PAYROLL,61201},{UTILITIES,62200},{INSURANCE,63300},{TELECOM,62301},{HOSTING,62302}], similarity=1−lev/maxLen with flat 0.9 for prefix relation (either side ≥4 chars), threshold ≥0.85; `resolveBankAccountCode`: `/HSBC|滙豐|汇丰/i→11102 else 11103`. Reuse `levenshtein` from `./company-matcher`.
- [ ] **Step 4: Run** → all PASS
- [ ] **Step 5: Commit** `git add api/src/lib/transaction-categorizer.ts tests/categorizer.test.ts && git commit -m "feat: shared transaction categorizer engine"`

### Task 2: Wire import (`file-storage.ts`)

**Files:** Modify `api/src/routes/file-storage.ts` (imports top; replace rules block ≈427-481; rework auto-JE block ≈526-601).

- [ ] Add imports: `categorizeTransaction, resolveBankAccountCode` from `../lib/transaction-categorizer`; `ensureMissingAccounts` from `../lib/ensure-accounts`.
- [ ] Before old rules block: resolve+persist stmt bank code if empty (`UPDATE bank_statements SET account_code=? WHERE id=? AND user_id=?`), keep var `stmtBankCode`.
- [ ] Replace inline rules loop with: per tx (account_code IS NULL) `const r = categorizeTransaction(desc, tx.deposit_amount>0?'deposit':'withdrawal')`; skip when `!r || r.code===''`; else UPDATE bank_transactions.account_code=r.code.
- [ ] Auto-JE block: ensure accounts via `ensureMissingAccounts(db, userId, codeList, createdCount)` (delete placeholder-name INSERT); load acctMap from accounts table w/ `HK_COA_NAMES[code]?.name || code` fallback (import HK_COA_NAMES from lib/ensure-accounts); loop guards: `if (refSet.has(tx.id) || tx.invoice_id) continue;` compute `r=categorizeTransaction(...)`; skip JE when `!r || r.code===''`; contra lines use `stmtBankCode` instead of `'11101'` (keep acctMap name lookup); defaults deposit→41101 / withdrawal→62303 unchanged; count `skipped_transfers` returned in response.
- [ ] Verify: `npx --yes tsx tests/categorizer.test.ts` still passes (lib untouched); grep no remaining stale codes 22020/41020 in file-storage.ts.
- [ ] Commit: `feat: wire categorizer into statement import with real-bank contra`

### Task 3: Wire bank auto-categorize endpoint (`bank-statements.ts:1218-1332`)

- [ ] Replace inline `rules`+director overrides (1246-1315) with engine call per tx (same direction logic); keep dup-period guard + auditLog + compliance completion (track matched codes in-loop into a Set for complianceMap check).
- [ ] Also persist stmt bank code if empty (same helper pattern as Task 2).
- [ ] Grep confirms no duplicate rule copies remain in this file's auto-categorize route.
- [ ] Commit: `refactor: bank auto-categorize uses shared engine`

### Task 4: Fix card auto-categorize (`card-statements.ts:393-439`)

- [ ] Replace `rules` array + loop with engine (`direction:'withdrawal'`); keep response shape `{ success, categorized, total }`.
- [ ] Spot-check via grep: no rule writes 65102 for BANK CHARGE / 65101 for ADVERTISING / nonexistent 62304.
- [ ] Commit: `fix: card auto-categorize codes aligned to COA template`

### Task 5: PATCH JE-regen heuristics (`bank-statements.ts:592-697`)

- [ ] Extend fullTx SELECT (≈601-606) with `bs.account_code AS stmt_account_code`.
- [ ] `const stmtBankCode = fullTx.stmt_account_code || resolveBankAccountCode(fullTx.bank_name);`
- [ ] Replace line-building (≈638-682): OUTCLEARING special-case kept; then `const r = categorizeTransaction(desc, dir)`; assigned = `r?.code && r.code !== stmtBankCode && r.code !== '21201' ? r.code : null`; deposit: Dr stmtBankCode / Cr assigned ?? director ?? interest?? legacy fallbacks (42101 INTEREST PAYMENT, ≥5000 DIRECT CREDIT→21201, default 41101); withdrawal: Dr assigned ?? supplier?51101:62303 / Cr stmtBankCode. Names via existing accountMap (`||code`). Status draft + numbering untouched.
- [ ] Commit: `refactor: PATCH regen uses engine + real bank contra`

### Task 6: bookkeeping auto-generate-entries (`bookkeeping.ts`)

- [ ] Line 65 essentials += `'65101','65102','21301','11102','11103'`.
- [ ] Import engine; in tx loop (1461+) before heuristics: `const cat = categorizeTransaction(desc, tx.deposit_amount>0?'deposit':'withdrawal'); const stmtBankCode = resolveBankAccountCode(tx.bank_name);` skip row when `cat && cat.code === ''` and no pre-assigned account_code; prefer `tx.account_code` (existing behavior), else `cat?.code`, else legacy heuristics; replace all `'11101'` contra pushes in this handler with `stmtBankCode`.
- [ ] Remove `, project` + `l.project || null` from the journal_lines INSERT at ≈1530-1531 (column absent in live D1).
- [ ] Commit: `refactor: auto-generate-entries uses engine; drop phantom project column`

### Task 7: Review UI Account column (`frontend/src/pages/BankStatementReview.tsx`)

- [ ] Add `account_code?: string | null;` to `Transaction` interface (line ~60).
- [ ] `useQuery(['coa-options'], () => api('/bookkeeping/accounts'))` → rows at `.data`; build options `[ {code,name} ]` sorted by code.
- [ ] Table header add `<th>COA</th>` before delete col; row cell: `<select value={e.account_code ?? tx.account_code ?? ''} onChange={ev => upTx('account_code', ev.target.value)}> <option value="">—</option> …options </select>` styled like other inputs (text-xs).
- [ ] Save flow already PATCHes arbitrary fields via saveTxMut — no change needed (allowedFields includes account_server-side).
- [ ] Commit: `feat: show/override COA account on statement review rows`

### Task 8: Verification

- [ ] `npx --yes tsx tests/categorizer.test.ts` → all pass
- [ ] `cd api && npx esbuild src/index.ts --bundle --format=esm --outfile=NUL --external:*` style smoke (or `npm run build` if defined) → bundles without error
- [ ] `git log --oneline -8` shows one commit per task
