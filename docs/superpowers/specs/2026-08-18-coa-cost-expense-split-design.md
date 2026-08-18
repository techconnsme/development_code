# COA Cost vs Expense Split — New 'cost' Account Type + P&L Formula Display

**Date:** 2026-08-18
**Status:** Design approved — awaiting implementation plan

## Problem

The system models a **single `account_type = 'expense'` bucket** for COA codes 5xxxxx (Direct Costs / 直接成本), 6xxxxx (Operating Expenses / 營運支出), and 8xxxxx (Profits Tax / 利得稅). Every report and page treats them as one undifferentiated "Expenses / 支出" group — even though the account hierarchy already distinguishes them (`50000` Direct Costs vs `60000` Operating Expenses parents).

Product wants:

1. **Cost (5xxxxx) separated from Expense (6xxxxx)** across the whole product, with standard accounting presentation:
   - Chart of Accounts: two separate sections (Cost / 直接成本, then Expenses / 支出).
   - Income Statement (P&L): Revenue → Cost → **Gross Profit subtotal** → Expenses → Net Income.
   - All other consumers that treat them as one bucket (Balance Sheet, Dashboard, year-end close, chat/AI, account creation) must recognize the new type.
2. **A visual formula display** at the top of the Income Statement page showing, with figures under each term:
   - Card 1: `Gross Profit = Revenue − Cost`
   - Card 2: `Net Profit = Gross Profit − Expenses`

## Requirements

### 1. Data model: new `'cost'` account_type

- Add `'cost'` to the `accounts.account_type` domain.
- `5xxxxx` codes → `'cost'`; `6xxxxx` and `8xxxxx` → stay `'expense'`.
- Production today: 969 `expense` accounts → **125 are `5xxxxx`** (become `cost`), **844 stay `expense'`**.
- **Critical constraint:** SQLite cannot alter a CHECK constraint in place. The production `accounts` table has `CHECK (account_type IN ('asset','liability','equity','revenue','expense'))`. Adding `'cost'` requires a **table rebuild** migration:
  1. `CREATE TABLE accounts_new` with the extended CHECK (same columns, constraints, `UNIQUE(user_id, account_code)`).
  2. `INSERT INTO accounts_new SELECT ...` with `CASE WHEN account_code LIKE '5%' THEN 'cost' ELSE account_type END`.
  3. `DROP TABLE accounts; ALTER TABLE accounts_new RENAME TO accounts;`
  4. Idempotent guards (check whether `'cost'` is already allowed / whether a row already typed `'cost'` before rebuilding).
- No other table has an FK pointing at `accounts.id` (verified: only `users(id)` is referenced; `journal_lines`/`bank_transactions` store `account_code` as plain text) — the rebuild is safe.
- **Deploy together:** the migration runs in the same release as the code changes, so no writer can insert `'cost'` before consumers understand it.

### 2. Backend (`api/`)

#### `api/src/lib/coa-templates.ts`
- `CoaAccountType` union adds `'cost'`.
- `BASE_HK_COA` / `MANUAL_SKELETON` / industry templates: every `5xxxxx` entry changes `account_type: 'expense'` → `'cost'`. (6xxxxx and 8xxxxx stay `'expense'`.)

#### `api/src/routes/bookkeeping.ts`
- `getCodeType()` (line ~17): `code.startsWith('5')` → `'cost'`; keep 6/8 → `'expense'`.
- `createAccountSchema` (line ~622): `z.enum([...])` adds `'cost'`.
- **`GET /income-statement`** (line ~927):
  - New `cost` total: `WHERE ... a.account_type = 'cost'`.
  - New `cost_accounts` breakdown (mirror of `expense_accounts`).
  - `gross_profit = revenue − cost`.
  - `expenses` / `expense_accounts` unchanged but now semantically = 6xxxxx + 8xxxxx.
  - `net_income = gross_profit − expenses`.
  - Response adds: `cost`, `cost_accounts`, `gross_profit`.
  - Bank-transaction fallback path (line ~990): split `account_code LIKE '5%'` (cost) from `'6%' OR '8%'` (expenses); same new response fields.
- **Balance sheet** (line ~1147): expense classification and `totalExpenses` include `account_type = 'cost'`.
- **Ledger** `isDebitNatural` (lines ~1303, ~1330): `account_type === 'expense' || account_type === 'cost'`.
- **Year-end close** (lines ~1691-1746): include `'cost'` accounts in the expense-like closing entries (they close to retained earnings exactly like expenses).
- **Profits tax provision** (lines ~1789-1800): include `'cost'` in the expense side.
- `ensureMissingAccounts` / `POST /accounts/ensure`: already derive `name`/`type`/`parent` from `HK_COA_NAMES` — no change needed; new 5xxxxx accounts get `'cost'` from the templates automatically.
- **`repairCOA` self-heal** (added last task, line ~522): extend so any account still typed `'expense'` whose code starts with `'5'` is normalized to `'cost'`. This covers `file-storage.ts:537` (auto-create maps 5xxxxx→`'expense'`) **without editing that file** (owned by the parallel OCR agent).

#### Other backend consumers
- `api/src/routes/dashboard.ts` (lines ~82-95, ~190-213): MTD / period expense totals include `account_type = 'cost'`.
- `api/src/routes/chat.ts` (line ~442): balance-sheet expense bucket includes `'cost'`; `add_account` validTypes (line ~466) adds `'cost'`. Also fix the latent quirk at line ~437 where the debit-natural check only does `startsWith('5')` — make it type-aware (`'cost'` and `'expense'` both debit-natural).
- `api/src/routes/admin.ts` (lines ~752-753): audit stats expense counts include `'cost'`.
- `api/src/routes/card-statements.ts` (line ~472): auto-type missing codes — `startsWith('5')` → `'cost'`, `'4'` → `'revenue'`, else `'expense'`.
- `api/src/db/schema.sql` (line ~181): CHECK constraint adds `'cost'` (for fresh DBs).
- `api/src/db/coa-hk.sql`: seed 5xxxxx rows typed `'cost'` (fresh DBs).

### 3. Frontend

#### `frontend/src/pages/ChartOfAccounts.tsx`
- `TYPE_ORDER` (line ~16): `['asset','liability','equity','revenue','cost','expense']`.
- `TYPE_LABELS` (lines ~18-24): add `cost: tr('Cost', '直接成本', '直接成本')`.
- `TYPE_COLORS` (lines ~26-32): add a `cost` color (distinct from expense's amber, e.g. orange).
- Grouping loop (line ~275) and section headers (lines ~468-492) pick up the new type automatically.
- `expandedTypes` initial state (lines ~92-94): add `cost: true`.

#### `frontend/src/components/CoaPreview.tsx`
- `CoaAccountType` union (line ~14) adds `'cost'`.
- `TYPE_ORDER` (line ~36), `TYPE_LABELS` (lines ~38-44), `TYPE_COLORS` (lines ~46-52) add `'cost'`.
- **`TYPE_CODE_RANGE`** (lines ~54-61): split `expense: { start: 50000, end: 89999 }` into `cost: { start: 50000, end: 59999 }` and `expense: { start: 60000, end: 89999 }` so renumbering stays in-range.

#### `frontend/src/pages/Bookkeeping.tsx` (P&L tab)
- New render order: Revenue section → **Cost section** (from `cost_accounts`) → **Gross Profit subtotal** → Expenses section → Net Income.
- `expandedPL` state (line ~32): add a `cost` key.
- Cost/Gross Profit rows mirror the existing Revenue/Expenses styling.

#### New: `frontend/src/components/PnlFormulaBanner.tsx`
- Always-visible banner at the top of the P&L area (above Revenue), **always stacked vertically**.
- Card 1: `Gross Profit = Revenue − Cost` — each term label with its HKD figure underneath.
- Card 2: `Net Profit = Gross Profit − Expenses` — same layout.
- Reads directly from the existing `incomeStatement` query response (`revenue`, `cost`, `gross_profit`, `expenses`, `net_income`) — no new endpoint.
- Styling matches existing card/border conventions in `Bookkeeping.tsx`; each formula rendered as a light "equation chip"; negative figures in red.

#### Other frontend spots
- `frontend/src/components/MissingCodesModal.tsx` (lines ~34-40): add `'cost'` to `TYPE_COLORS`.
- `frontend/src/pages/CardStatementReview.tsx` (line ~262): expense dropdown includes `cost` accounts (categorizing to a cost account is legitimate).
- Ledger / trial-balance type badges in `Bookkeeping.tsx` (lines ~518, ~921-926, ~1211): add `'cost'` to badge maps and normal-side logic (`'cost'` is debit-natural → Dr).

## Data Flow

```
GET /bookkeeping/income-statement?start_date=...&end_date=...
  → journal path: cost (account_type='cost'), expenses (account_type='expense')
  → or bank fallback: cost (code LIKE '5%'), expenses (code LIKE '6%' OR '8%')
  → gross_profit = revenue − cost; net_income = gross_profit − expenses
  → { revenue, cost, gross_profit, expenses, net_income, revenue_accounts, cost_accounts, expense_accounts }

P&L tab renders:
  PnlFormulaBanner (Gross Profit = Revenue − Cost; Net Profit = Gross Profit − Expenses)
  Revenue section → Cost section → Gross Profit subtotal → Expenses section → Net Income
```

## Edge Cases & Error Handling

| Scenario | Handling |
|----------|----------|
| Custom 5xxxxx code typed `'expense'` (e.g. from file-storage auto-create) | `repairCOA` normalizes to `'cost'` on next COA load |
| Zero cost accounts | Cost section hidden (same as empty sections today); formula shows HKD 0 |
| Zero revenue | Gross Profit = negative of cost, rendered in red; formula still displayed |
| Migration re-run | Idempotent guards skip rebuild if `'cost'` already allowed |
| Cost account selected in a Dr/Cr journal entry | Debit-natural handled via `account_type === 'cost'` |
| Year-end close with cost accounts present | Closed to retained earnings with expenses |

## Testing

### Migration verification
- After rebuild + UPDATE: `SELECT account_type, COUNT(*) FROM accounts GROUP BY account_type` → `cost` = 125, `expense` = 844 (+ other types unchanged).
- Re-run migration → no change / no error (idempotent).

### API tests
- `GET /bookkeeping/income-statement` returns `cost`, `cost_accounts`, `gross_profit`, and `expenses` that exclude 5xxxxx.
- Bank-fallback path splits `5%` vs `6%|8%` correctly.
- `gross_profit = revenue − cost`; `net_income = gross_profit − expenses`.

### E2E / UI
- COA page shows Cost and Expenses as two separate sections.
- P&L shows Revenue → Cost → Gross Profit → Expenses → Net Income.
- Formula banner shows both formulas with figures under each term.
- Adding a new 5xxxxx account via the COA page creates it as `'cost'`.
- `tsc --noEmit` (api) and frontend build pass.

## Files Affected

| File | Change |
|------|--------|
| `api/src/db/migration-account-type-cost.sql` | **New** — rebuild `accounts` + retype 5xxxxx → `'cost'` |
| `api/src/db/schema.sql` | CHECK constraint adds `'cost'` |
| `api/src/db/coa-hk.sql` | Seed 5xxxxx as `'cost'` |
| `api/src/lib/coa-templates.ts` | Union + all 5xxxxx entries → `'cost'` |
| `api/src/routes/bookkeeping.ts` | `getCodeType`, Zod enum, income-statement split, balance sheet, ledger, year-end close, `repairCOA` type normalization |
| `api/src/routes/dashboard.ts` | Expense totals include `'cost'` |
| `api/src/routes/chat.ts` | Balance-sheet bucket, validTypes, debit-natural fix |
| `api/src/routes/admin.ts` | Audit expense counts include `'cost'` |
| `api/src/routes/card-statements.ts` | Auto-type 5→`'cost'` |
| `frontend/src/pages/ChartOfAccounts.tsx` | `TYPE_ORDER/LABELS/COLORS` + cost section |
| `frontend/src/components/CoaPreview.tsx` | Union, order, labels, colors, `TYPE_CODE_RANGE` split |
| `frontend/src/pages/Bookkeeping.tsx` | P&L render order + Cost/Gross Profit sections + `expandedPL.cost` |
| `frontend/src/components/PnlFormulaBanner.tsx` | **New** — formula display |
| `frontend/src/components/MissingCodesModal.tsx` | Cost color/badge |
| `frontend/src/pages/CardStatementReview.tsx` | Expense dropdown includes cost accounts |

## Out of scope

- Splitting 8xxxxx (Profits Tax) into its own group — stays `'expense'`.
- Dashboard/chat/admin get only the minimal "include cost in expense totals" change, not separate cost breakouts.
- Any edits to `api/src/routes/file-storage.ts` (parallel OCR agent owns it; handled via `repairCOA` self-heal).
