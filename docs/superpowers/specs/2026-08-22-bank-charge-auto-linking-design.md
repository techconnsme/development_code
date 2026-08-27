# Bank Charge Auto-Linking to COA — Design

**Date:** 2026-08-22
**Status:** Approved (design reviewed in session)
**Scope:** Bank statement + card statement auto-categorization, GL auto-posting, review UI visibility

---

## 1. Problem

Bank charges appearing on imported bank statements are not reliably linked to the correct
Chart of Accounts (COA) account. The codebase contains **four divergent copies** of
categorization heuristics that disagree with each other and with the 5-digit HK COA template,
so bank charges frequently land in the wrong expense accounts (or none at all), polluting
GL reports.

### Current state (verified)

| Site | Location | Behavior | Issues |
|---|---|---|---|
| Import auto-categorize | `api/src/routes/file-storage.ts:429-481` | ~30 inline regex rules at import; then auto-JE per transaction contra `11101` | Stale codes `22020`/`41020`; missing real HSBC fee descriptors; contra always Cash on Hand; creates placeholder accounts named as their code |
| Manual auto-categorize (bank) | `api/src/routes/bank-statements.ts:1218-1332` | Separate ~15-rule copy | Duplicates rules with slight differences |
| Manual auto-categorize (card) | `api/src/routes/card-statements.ts:402-424` | ~21 rules | **Wrong codes**: `BANK CHARGE→65102` (Loan Interest), `ADVERTISING→65101` (Bank Service Fee), most others misaligned with template; `62304` does not exist → junk account |
| PATCH JE regeneration | `api/src/routes/bank-statements.ts:592-697` | Inline heuristics rebuild a draft JE after tx edit | Fourth rule copy; always contra `11101` |

The default COA already has correct targets under group 65000 Finance & Banking
(`api/src/lib/coa-templates.ts:148-152`): `65100 銀行費用 Bank Charges` (category),
`65101 銀行手續費 Bank Service Fee`, `65102 貸款利息 Loan Interest`, `65200 匯兌差額`,
`65201 匯兌損失`. Bank accounts exist: `11102 滙豐銀行 HSBC`, `11103 其他銀行 Other Bank`
(`coa-templates.ts:36-38`). `bank_statements.account_code` column already exists
(`schema.sql`) and `post-payment.ts` already prefers it over `11101`.

## 2. Evidence from real statements

All sampled real eStatements (`Tech_Connect_SME/test-sample-real/EHSIA/eStatement/`,
`test-sample-real/PNR/estatement/`) are **HSBC Business Direct**. Extracted descriptors:

**Bank charges found (withdrawals) — mostly MISSED by current rules:**
- `CHARGES` — bare word; the dominant descriptor ($5 cheque-handling charge). Two-line format:
  line 1 `CHARGES`, line 2 shared cheque ref e.g. `HC125B0521391053   05NOV` (same ref as the
  related deposit row)
- `MONTHLY SERVICE FEE` (200.00), `PAPER STATEMENT FEE` (20.00),
  `ACCOUNT APPLICATION FEE` (1,300.00, spans two lines), `BLG CQBK FEE` (100.00)

**Direction-critical interest pair:** `CREDIT INTEREST` (deposit, savings) vs
`DEBIT INTEREST` (withdrawal, current-account overdraft, prefixed by period text like
`28MAY25 TO 27JUN25`). A single direction-blind `/INTEREST/→42101` rule misroutes debit interest to income.

**Fee refund (deposit):** `REFUND MONTHLY FEE250509163829754` — should credit back 65101, not book income.

**Internal transfers between own accounts:** `FROM PROFICIENCY & R / SWEEP (30MAY25)`,
`CR TO 147-162101-838 / NA0315864086(03OCT25)` — must not be booked as income/expense.

**Tax payment:** `INLAND REVENUE DEPAR[TMENT] / HC…` — truncated at 20 chars; current
`IRD|PROFITS TAX` patterns do not match.

**Structural realities:**
1. Descriptions span **two lines**; OCR concatenates them, leaving ref numbers and dates embedded
2. Counterparty names truncate at 20 chars (`SMART CITY CONSORTIU`, `PROFICIENCY & R C LD`)
3. Privacy masking occurs (`LIN P** K**** J*****`)
4. Charge rows share a reference number with their paired deposit row
5. Generated samples (`test-samples-generated/generate.py`) confirm formats for HSBC
   BusinessDirect/Hang Seng/SC: `BANK CHARGES-MONTHLY FEE`, `FPS INWARD-*`, `PAYROLL-*`,
   `AUTO DEBIT-HKT TELECOM`, `INTEREST-SAVINGS ACCOUNT`, `INTEREST CREDIT`
6. Several date lines carry **multiple transactions** — one `17 Jun` block on
   eStatement202506 holds three separate txs (CHARGES 5.00 / SMART CITY 7,800 /
   MR LAI KIN CHEONG 3,000), each amount on its own continuation line.

**Multi-invoice & split payments (audited 2026-08-24; full list in
`test-sample-real/LINKS_REPORT.txt` §4):**
- One bank transaction can settle **2-3 invoices**: PASTEL TECH 19 Sep 57,580.80 =
  #001414 + #001417v2; 5 Nov 55,000 = #001441 + #001442; 5 Feb 27,544 =
  #001458v2 + #001467-v2 + #001484-v2. EHSIA side: none (all 1:1). Relevant to
  §4.6.1: a tx with `invoice_id` is a payment leg — combined payments mean one leg
  may settle several invoices, so skip logic must not assume 1 tx = 1 invoice.
- Split payments exist in the other direction: VEII 2025006 (38,544) = two ECQ
  deposits 11,550 + 26,994 on the same day; founders' funding 52,000 each =
  50,000 + 2,000 (PNR), and EHSIA funding RS = 50,000 + 2,000.
- Net-zero test transfers appear on both accounts: PNR 09 Jan +100/−100
  (047-711106-833) and PNR/EHSIA 03 Oct +10/−10 (521-305565-838) — covered by the
  internal_transfer handling in §4.6.1.

## 3. Goals / Non-goals

**Goals**
- One shared categorization engine used by all four sites
- Correct COA codes everywhere (bank charge → 65101; debit interest → 65102; etc.)
- Real-descriptor coverage incl. fuzzy matching for truncation/masking/noise
- Auto-post JEs at import time using the actual bank account as contra
- Show assigned COA account on the statement review UI with manual override
- Fix card-statement codes and stale import codes

**Non-goals (future work)**
- DB-driven admin-editable rules
- AI/LLM classification fallback
- Internal-transfer pairing across two statements (auto netting both sides)
- Cleanup/backfill of historically misposted transactions

## 4. Design

### 4.1 New module: `api/src/lib/transaction-categorizer.ts`

Dependency-free, Workers-compatible (mirrors `company-matcher.ts` conventions).

```ts
export type RuleTag = 'bank_charge' | 'fee_refund' | 'interest_income' | 'interest_expense'
  | 'income' | 'internal_transfer' | 'tax' | 'director' | 'expense' | 'ignore';

export interface CategorizeRule {
  pattern: RegExp;                    // tested against NORMALIZED description
  code: string;                       // COA account code
  tag: RuleTag;
  direction?: 'deposit' | 'withdrawal'; // default: any
}

export interface CategorizeResult {
  code: string;
  tag: RuleTag;
  confidence: 'exact' | 'fuzzy';
}

export function normalizeDescription(raw: string): string;
export function categorizeTransaction(
  desc: string,
  dir: 'deposit' | 'withdrawal'
): CategorizeResult | null;           // null = leave uncategorized
export function resolveBankAccountCode(bankName?: string | null): '11102' | '11103';
```

### 4.2 `normalizeDescription`

Uppercase → collapse newlines/multi-whitespace to single spaces → strip noise tokens:
cheque refs (`HC[0-9A-Z]{10,}`), transfer refs (`N[0-9A-Z]?\d{9,}` and `(16JUN25)` style
suffixes), `REF:[0-9A-Z]{4}\s?\d{4}`, bracketed dates, bare dates (`19MAR`), standalone
amounts, asterisks kept for masked names. Example:
`"CHARGES\nHC125B0521391053   05NOV"` → `"CHARGES"`.

### 4.3 Tier 1 — exact rules (ordered, first match wins; direction-aware)

| # | Normalized pattern | Dir | Code / Tag |
|---|---|---|---|
| 1 | `B/?F BALANCE`, `承上結餘` | any | ignore |
| 2 | `REFUND .*FEE`, `FEE REFUND` | dep | 65101 fee_refund |
| 3 | `DEBIT INTEREST`, `OVERDRAWN`, `透支利息` | wd | 65102 interest_expense |
| 4 | `^CHARGES?\b` | wd | 65101 bank_charge |
| 5 | `BANK CHARGE(S)?\|SERVICE (CHARGE\|FEE)\|手續費\|銀行費\|银行费`; `MONTHLY SERVICE FEE\|ACCOUNT APPLICATION FEE\|PAPER STATEMENT FEE\|STATEMENT FEE`; `BLG CQBK\|CHEQUE (BOOK \|HANDLING )?(CHARGE\|FEE)\|支票費`; `FPS (FEE\|CHARGE)`; `WIRE TRANSFER (FEE\|CHARGE)\|TT (FEE\|CHARGE)\|REMITTANCE (FEE\|CHARGE)\|匯款費用`; `MIN(IMUM)? BAL(ANCE)? FEE\|MAINTENANCE FEE\|年費\|月費` | wd | 65101 bank_charge |
| 6 | `CREDIT INTEREST`, `利息收入`, `INTEREST (PAID\|CREDIT)` | dep | 42101 interest_income |
| 7 | `\bSWEEP\b`, `^CR TO \d{3}` | any | internal_transfer tag (code `11103` marker, see §4.6) |
| 8 | `INLAND REVENUE\|稅務局\|PROFITS? TAX\|\bIRD\b\|稅` | wd | 21301 tax |
| 9+ | Existing catalog carried over with corrected codes: rent 62101, salaries/payroll/MPF 61201/61202, utilities 62201/62202/62200, telecom 62301, hosting 62302, software 62303, audit 63101, secretary 63102, legal 63103, insurance 63300, advertising/marketing 64101, local transport 64301, overseas travel 64302, meals/entertainment 64202, pantry/supermarket 62402, stationery/printing 62401, subcontractor/PASTEL TECH 51101, client payments/CHEQUE DEPOSIT/FPS INWARD/INWARD REMITTANCE 41101, interest fallback 42101, director names (incl. masked-initials skeleton match) 21201/31201, VISA DEBIT card purchases 62303, misc/outclearing 66203 |

Stale-code fixes inside carried-over rules: director direct credit `22020`→`21201`;
direct-credit income `41020`→`41101`.

### 4.4 Tier 2 — fuzzy fallback (only when Tier 1 misses)

Pure functions, no I/O. Reuses `levenshtein()` from `company-matcher.ts`.
- Tokenize normalized description (drop pure digits/refs); score tokens/phrases against a
  keyword dictionary via Levenshtein ratio and prefix matching (handles HSBC 20-char
  truncation: `CONSORTIU` ≈ `CONSORTIUM`)
- Masked-name tolerance: strip `*`, compare initials skeleton against configured person
  aliases (e.g., `LIN P K J` ↔ `LIN PUI KEUNG JOSEPH`)
- Accept best match only when score ≥ 0.85 → `{confidence:'fuzzy'}`
- Otherwise return `null` — transaction stays uncategorized for user assignment.
  Never guesses silently.

### 4.5 `resolveBankAccountCode`

`/HSBC|滙豐|汇丰/i → '11102'`; else `'11103'`. Hang Seng/others land on Other Bank until
dedicated accounts exist.

### 4.6 Integration points

1. **Import** (`importStatementFromFile`, file-storage.ts):
   - Replace inline rules with shared engine
   - Resolve + persist `bank_statements.account_code` if empty
   - Create missing accounts via existing `ensureMissingAccounts()` +
     `buildAccountNameMap()` (proper bilingual names; removes placeholder defect)
   - Auto-JE loop keeps refSet idempotency; changes:
     - **Skip** txs where `invoice_id IS NOT NULL` (payment leg owns them; shrinks known C1
       double-posting finding)
     - Contra side = resolved bank code (not `11101`)
     - Defaults unchanged (deposit → 41101, withdrawal → 62303)
     - `internal_transfer` rows get **no JE** and stay uncategorized — a wrong entry is worse
       than none; count reported in import response
2. **`POST /bank-statements/:id/auto-categorize`**: use shared engine (keep duplicate-period
   guard and compliance-item completion extras)
3. **`POST /card-statements/:id/auto-categorize`**: replace rules with shared catalog
   (corrected codes per §4.3)
4. **`PATCH /bank-statements/transactions/:id`** JE-regeneration block: replace inline
   heuristics with shared engine + statement bank code; keep draft status and
   `B-{BANK}-{YYYYMM}-{SEQ}` numbering
5. **`POST /bookkeeping/auto-generate-entries`**: call shared engine first; keep existing
   extras (director ≥5000 heuristic, outclearing) as fallbacks; add `65101`,`65102`,`21301`
   to `collectTransactionCodes()` essentials

### 4.7 Frontend (small)

Statement review page (`frontend/src/pages/BankStatementReview.tsx`): each transaction row
shows an assigned-COA chip (account code + name from one accounts fetch) and a dropdown to
override — PATCH `/transactions/:id` already accepts `account_code` and regenerates the JE.

## 5. Error handling

- All categorization remains best-effort try/catch — an import never fails because of it
- Fuzzy tier is pure/deterministic; no network, no AI quota
- Per-tx JE creation failures logged and skipped, batch continues
- Rules only emit codes ensured to exist in tenant COA before JE write

## 6. Testing

Project convention: `npx tsx tests/<file>.test.ts`.

New `tests/categorizer.test.ts`, built from both extracted corpora:

- Real EHSIA/PNR descriptors: bare `CHARGES`+ref noise, `MONTHLY SERVICE FEE`,
  `PAPER STATEMENT FEE`, `ACCOUNT APPLICATION FEE` (two-line), `BLG CQBK FEE`,
  `DEBIT INTEREST` vs `CREDIT INTEREST` directionality, `REFUND MONTHLY FEE25…` deposit,
  `INLAND REVENUE DEPAR`, `SWEEP`/`CR TO …`, `B/F BALANCE` ignore,
  truncated names via fuzzy tier, masked `LIN P** K**** J*****`
- Generated-sample formats: `BANK CHARGES-MONTHLY FEE`, `FPS INWARD-*`, `PAYROLL-*`,
  `AUTO DEBIT-HKT`, `INTEREST-SAVINGS ACCOUNT`
- Fuzzy threshold boundary cases (accept ≥0.85 / reject below)
- Card-mapping corrections (no rule emits 65102 for BANK CHARGE, 65101 for ADVERTISING, or nonexistent 62304)

Regression: re-run `tests/direction-resolver.test.ts`, `tests/printed-total.test.ts`,
`tests/pdf-layout.test.ts`.

Post-deploy QA: upload `eStatement 202504.pdf` (richest fee month: monthly service fee,
paper statement fee, BLG CQBK, account application fee) as Joseph Lin; verify JEs land in
65101 with 11102 contra.

## 7. Rollout notes

- No schema migration required (`bank_statements.account_code` exists)
- Historical misposted data untouched (cleanup script = future work)
- Deploy path is esbuild (`npx wrangler deploy`); no type-check gate (pre-existing tsc errors documented in SESSION_STATE.md)

---

## Self-review record

- Placeholder scan: clean — all sections concrete
- Consistency: §4.3 rule table matches corpus findings in §2; §4.6 wiring covers all four sites found in §1
- Scope: single implementation plan sized (~1 new lib, 5 integration edits, 1 test file, 1 small UI change)
- Ambiguity: internal-transfer handling explicitly "no JE + uncategorized" (§4.6.1); fuzzy threshold explicit (§4.4)
