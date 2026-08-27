# Multi-Account Bank Statements — Design (IN PROGRESS, DEFERRED)

**Status:** ⏸️ Deferred mid-brainstorm on 2026-08-26. Decisions 1–4 are confirmed; design section 1 was presented but **not yet approved**; sections 2–3 not yet presented. Resume from "Where we left off" below.
**Session context:** PNR / Tech Connect SME (joseph.lin@pnr.hk), same session that fixed the bank_name inconsistency (see "Related completed work").

---

## 1. Problem (verified with live data + sample PDFs)

Some bank statement PDFs contain transaction sections for **more than one account** of the same company. Confirmed in `Tech_Connect_SME/test-sample-real/PNR/estatement/`:

| Sample file | Accounts with activity sections |
|---|---|
| `eStatement 20250530.pdf` | HKD Current (B/F 10,500) + HKD Savings `147-162101-838` (B/F 20,500) |
| `eStatement 20250630.pdf` | HKD Current `147-162101-001` + HKD Savings `147-162101-838` |
| all other months | single section (HKD Savings `147-162101-838`) |

Account numbers seen in *descriptions* (e.g. `CR TO 521-305565-838 SWEEP`, `CR TO 484-485073-838`) are **counterparty/other-company accounts**, not extra sections — those companies have their own statements (EHSIA's `521-305565-838` statements live in `test-sample-real/EHSIA/eStatement/`).

**Current behavior (buggy):** the DeepSeek parse prompt asks for one flat transaction list, so both sections get flattened into the single statement row for the primary account (`147-162101-838`). Verified in production D1 for u-83161e0c May/Jun 2025:

- HKD Current transactions recorded as if on the savings account (`CHEQUE 948151/948152`, `FROM PROFICIENCY & R SWEEP`, `DEBIT INTEREST`)
- Two `B/F BALANCE` rows per statement (one per section), stored with 0 amounts
- Internal sweeps double-counted: `CR TO 147-162101-001 SWEEP` (−10,000) and `FROM PROFICIENCY & R SWEEP` (+10,000) both stored → net-zero on balance (so GL balances are right) but activity inflated and per-account reconciliation impossible
- `reconcileDirections` (balance-reconcile.ts) runs on mixed running-balance anchors from two different accounts → direction-repair operates on inconsistent data

The same PDFs were imported into 6 test tenants (u-83161e0c, u-1456de5e, u-21e2a52a, u-ac7f1e56, u-d0757ac1, u-e5ea0d2b — see account `147-162101-838` / `521-305565-838`).

## 2. Confirmed decisions (user-approved, 2026-08-26)

1. **Model: split per account.** Each account section becomes its own `bank_statements` row (own account_number, opening/closing balance, continuity chain). Sweeps become internal transfers with no P&L impact.
2. **COA: own leaf per account.** Each bank account number gets its own leaf under 11100. Existing tenants' single-account statements keep mapping to 11102 — new leaves are only auto-created for account numbers never seen before in the tenant.
3. **Existing data: grandfather.** Already-imported flattened statements stay as-is (GL impact is net-zero; only activity totals inflated). Splitting applies to imports from this change onward. Note this in the spec.
4. **Mechanism: AI-first + verification.** Change the parse prompt to output per-account structure (generic across banks); verify with per-section running-balance anchor math + portfolio-total cross-check; fall back to flat import + `needs_review` flag on failure.

## 3. Design presented so far — Section 1: big picture + parse layer (NOT yet approved)

**Big picture.** One PDF → N `bank_statements` rows sharing the same `r2_key`/file. Each row: own `account_number`, `account_type` (printed section label e.g. "HKD Savings"/"HKD Current"), own opening/closing balances, own transactions. **No schema migration** — all columns exist already.

**Parse prompt** output schema changes to:

```json
{
  "bank_name": "...",
  "currency": "HKD",
  "portfolio_total": 103504.83,
  "accounts": [{
    "account_number": "147-162101-838",
    "account_type": "HKD Savings",
    "opening_balance": 103487.65,
    "closing_balance": 103504.83,
    "transactions": []
  }]
}
```

Model instructions: one entry per "Account Activities" section; single-account statements → array of one; keep B/F BALANCE rows (zero-amount anchors). **Legacy wrapper**: old flat responses (`transactions` at top level) wrap into a single-account array, so the GLM-retry path keeps working.

**Verification** (new lib, e.g. `api/src/lib/statement-split.ts`), per section:
1. `reconcileDirections` per section (anchors now consistent → stricter than today)
2. `opening + deposits − withdrawals == closing` (ε 0.01)
3. `Σ closing == portfolio_total` if a printed total was parsed
4. duplicate-section guard: same account_number twice → merge

**Failure behavior:** never block — fall back to flat single-statement import + existing `needs_review` flag.

## 4. Still to design (sections 2–3, not yet presented)

**Section 2 — import + COA + sweeps:**
- `importStatementFromFile` (file-storage.ts ~line 374 onward) loops over accounts → N inserts; status/balance-check flow runs per statement
- **Dedup rethink**: today's r2_key dedup assumes 1 row per file (`file-storage.ts` ~line 70, ~line 393; `bank-statements.ts` ~line 1287, ~line 1484). Proposed: reject file as duplicate if ANY section's (account_number, year, month) exists — atomic per physical statement
- Same shape change for `chat.ts` `import_bank_statement` tool (~line 1348) and `bank-statements.ts` `POST /import`
- **COA allocation**: reuse the existing per-bank leaf mechanism (`transaction-categorizer.ts` ~lines 259–290 NON-HSBC pattern; `resolveBankAccountCode` ~line 286; `getTemporaryAccount` in coa-temporary). Resolution order: `statements.account_code` → existing statement with same (bank_name, account_number) → default (HSBC→11102). Leaf name e.g. `HSBC — HKD Current 147-162101-001`
- **Sweep treatment**: detect `CR TO <acct> SWEEP` / `FROM ... SWEEP` where <acct> is a tenant-known account or a sibling section in the same file → categorize as own-account transfer; JE = Dr target leaf / Cr source leaf, no P&L. Check existing transfer handling at `bank-statements.ts` ~line 705 ("Real bank account as contra")

**Section 3 — continuity, UI, testing, rollout:**
- Continuity (`bank-statements.ts` `/continuity` ~line 991) already groups by (account_number, currency) → split statements form their own chains automatically; group bank_name label should pick the section's statement
- Frontend: BankStatements.tsx title is `{year}-{MM} {bank_name}` (~line 393) — append `· {account_type}` when present so same-month sibling rows are distinguishable; File Storage linked-statements display must handle N rows per r2_key
- **Tests**: unit fixtures from the real 20250530/20250630 pdftotext output (two sections), legacy flat wrapper, per-section reconcile, portfolio cross-check, dedup; regression: single-account imports (EHSIA samples) unchanged; integration: sweep posts as transfer
- Rollout: API deploy + small frontend label change; grandfathered months documented

## 5. Related completed work (same session, already deployed)

**bank_name canonicalization** — API worker `2d52d20d` (2026-08-26): `matchBankName` aliases added (`hsbcbusinessdirect`, `hsbchongkong`, `bankofhongkong`); new helpers `canonicalizeBankName` / `normalizeBankNameForStorage` / `resolveStatementBankName` in `company-matcher.ts`; wired into file-storage import, chat tool, `POST /import`, `POST /upload`; 64 rows backfilled; tests `api/tests/bank-name-canonical.test.ts` (26 cases). See memory `tecs-deployment-state.md` for the deploy entry. **This work is independent and already live — do not redo it.**

## 6. Where we left off / how to resume

1. Ask the user to confirm design **section 1** (parse layer above) — it was presented but the session was paused before approval.
2. Present design sections 2 and 3 (sketched above), get approval.
3. Write the finished spec (this file, remove the DEFERRED banner), self-review, user review, then invoke `superpowers:writing-plans`.
4. Implementation notes: TDD as before; test convention is `npx tsx tests/<name>.test.ts` with node:assert (no vitest); deploy via `cd api && CLOUDFLARE_ACCOUNT_ID=8c00cc4647a9cf5d8deb5d6a354001e0 npx wrangler deploy`, then report frontend URL `https://main.opcc-crm-testing.pages.dev`.
5. Sample fixtures: `Tech_Connect_SME/test-sample-real/PNR/estatement/` (multi-account: 20250530, 20250630; single-account: all others), `Tech_Connect_SME/test-sample-real/EHSIA/eStatement/` (single-account).
