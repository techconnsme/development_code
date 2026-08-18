# COA Cost vs Expense Split + P&L Formula Display Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Introduce a `'cost'` account_type for COA 5xxxxx codes (separate from `'expense'` for 6xxxxx/8xxxxx), update every report/consumer, and add an always-visible two-formula banner (Gross Profit, Net Profit) to the Income Statement P&L page.

**Architecture:** Add `'cost'` to the `accounts.account_type` domain via a SQLite table rebuild (CHECK constraints can't be altered in place), retype existing 5xxxxx rows, then thread `'cost'` through the backend (income-statement split into cost/gross_profit, balance sheet, ledger, year-end close, dashboard, chat, admin, card-statements) and frontend (COA Cost section, P&L render order, formula banner). Code and DB migration ship together in one release.

**Tech Stack:** Cloudflare Workers + Hono + D1 (SQLite), React 18 + TypeScript + TanStack Query, Zod, Tailwind. Working dir: `C:\Users\samue\Documents\Pastel\Tech_Connect_SME\Development_code\latest_code`.

## Global Constraints

- **Do NOT modify `api/src/routes/file-storage.ts`** — a parallel agent owns it. The auto-create path there maps 5xxxxx→`'expense'`; the `repairCOA` self-heal normalizes those on COA load instead.
- 8xxxxx (Profits Tax) stays `'expense'`. Only 5xxxxx becomes `'cost'`.
- Production DB: `npx wrangler d1 execute opcc-crm-db --remote --file=<sql>` (run from `api/` dir). Do not use `--command` from the repo root (config mismatch → "More than one account" error).
- `accounts` table rebuild is safe: no FK points at `accounts.id` (verified), no triggers/views reference `accounts`.
- Spec: `docs/superpowers/specs/2026-08-18-coa-cost-expense-split-design.md`.
- Commit after each task. Do NOT push (user said "commit but don't push").

---

### Task 1: Add `'cost'` to the type union + all 5xxxxx template entries

**Files:**
- Modify: `api/src/lib/coa-templates.ts:6` (union), plus 44 `account_code: '5...'` lines (BASE_HK_COA lines 93-100, MANUAL_SKELETON line 177, industry additions lines 236-451)

**Interfaces:**
- Produces: `CoaAccountType` now includes `'cost'`. Every template entry with `account_code` starting with `'5'` has `account_type: 'cost'`. `buildAccountNameMap` (already used by `HK_COA_NAMES`) returns `type: 'cost'` for those codes automatically.

- [ ] **Step 1: Update the union**

Change `api/src/lib/coa-templates.ts:6`:

```ts
export type CoaAccountType = 'asset' | 'liability' | 'equity' | 'revenue' | 'cost' | 'expense';
```

- [ ] **Step 2: Retype every 5xxxxx entry to `'cost'`**

For each of these 44 lines, change `account_type: 'expense'` → `account_type: 'cost'`:
Lines: 93, 94, 95, 96, 97, 98, 99, 100 (BASE_HK_COA: 50000, 51000, 52000, 51100, 51200, 51101, 51102, 51201), 177 (MANUAL_SKELETON 50000), 236-242 (trading COGS), 261-266 (tourism), 331-333 (medical), 384-389 (construction), 415-419 (ict), 444-451 (manufacturing).

Verify each target line has an `account_code: '5xxxx'` BEFORE changing its `account_type` to `'cost'` — 6xxxxx/8xxxxx lines must keep `'expense'`.

- [ ] **Step 3: Verify**

Run: `npx tsc --noEmit` (from `api/`)
Expected: no NEW errors (pre-existing errors in other files remain). Confirm via grep that every `account_code: '5...'` line now has `account_type: 'cost'`:
`Select-String -Path "api\src\lib\coa-templates.ts" -Pattern "account_code: '5[0-9]{4}', account_name: '.*', account_type: 'expense'"` → zero matches.

- [ ] **Step 4: Commit**

```bash
git add api/src/lib/coa-templates.ts
git commit -m "feat: add 'cost' account type to COA template"
```

---

### Task 2: `getCodeType`, Zod enum, and `repairCOA` type normalization

**Files:**
- Modify: `api/src/routes/bookkeeping.ts:17-24` (`getCodeType`), `:622` (`createAccountSchema`), `:522-559` (`repairCOA`)

**Interfaces:**
- Consumes: `CoaAccountType` from Task 1.
- Produces: `getCodeType('5xxxx')` returns `'cost'`. `createAccountSchema` accepts `'cost'`. `repairCOA(db, tenantId)` also normalizes any account where `account_code LIKE '5%'` and `account_type = 'expense'` → `'cost'`.

- [ ] **Step 1: Update `getCodeType`**

Change `api/src/routes/bookkeeping.ts:17-24` from:

```ts
export function getCodeType(code: string): string {
  if (code.startsWith('1')) return 'asset';
  if (code.startsWith('2')) return 'liability';
  if (code.startsWith('3')) return 'equity';
  if (code.startsWith('4')) return 'revenue';
  if (code.startsWith('5') || code.startsWith('6') || code.startsWith('8')) return 'expense';
  return 'expense';
}
```

to:

```ts
export function getCodeType(code: string): string {
  if (code.startsWith('1')) return 'asset';
  if (code.startsWith('2')) return 'liability';
  if (code.startsWith('3')) return 'equity';
  if (code.startsWith('4')) return 'revenue';
  if (code.startsWith('5')) return 'cost';
  return 'expense';
}
```

- [ ] **Step 2: Add `'cost'` to the Zod enum**

Change `api/src/routes/bookkeeping.ts:622`:

```ts
account_type: z.enum(['asset', 'liability', 'equity', 'revenue', 'cost', 'expense']),
```

- [ ] **Step 3: Extend `repairCOA` to normalize stray 5xxxxx→expense rows**

In `repairCOA` (currently `api/src/routes/bookkeeping.ts:522-559`), widen the SELECT to include `account_type` and add a normalization UPDATE inside the loop. Replace the current function body loop start:

```ts
  const rows = await db.prepare(
    'SELECT account_code, account_name, parent_code FROM accounts WHERE user_id = ?'
  ).bind(tenantId).all();
  const accts = (rows.results as any[]);
  if (accts.length === 0) return;

  const existingSet = new Set(accts.map(a => a.account_code));
  const toCreate = new Map<string, { name: string; type: string; parent: string | null }>();

  for (const a of accts) {
    // 1. Fix placeholder name + parent (e.g., account_name == "31201")
    if (a.account_name === a.account_code) {
```

with:

```ts
  const rows = await db.prepare(
    'SELECT account_code, account_name, account_type, parent_code FROM accounts WHERE user_id = ?'
  ).bind(tenantId).all();
  const accts = (rows.results as any[]);
  if (accts.length === 0) return;

  const existingSet = new Set(accts.map(a => a.account_code));
  const toCreate = new Map<string, { name: string; type: string; parent: string | null }>();

  for (const a of accts) {
    // 0. Normalize account_type for 5xxxxx codes (auto-create paths may type them 'expense')
    if (a.account_code?.startsWith('5') && a.account_type === 'expense') {
      await db.prepare(
        'UPDATE accounts SET account_type = ? WHERE user_id = ? AND account_code = ?'
      ).bind('cost', tenantId, a.account_code).run();
      a.account_type = 'cost';
    }
    // 1. Fix placeholder name + parent (e.g., account_name == "31201")
    if (a.account_name === a.account_code) {
```

- [ ] **Step 4: Verify**

Run: `npx tsc --noEmit` (from `api/`)
Expected: no NEW errors. The repair logic itself is verified in Task 8 (data check) and via GET /accounts in the running app.

- [ ] **Step 5: Commit**

```bash
git add api/src/routes/bookkeeping.ts
git commit -m "feat: getCodeType + create schema + repairCOA support 'cost' type"
```

---

### Task 3: Income-statement endpoint — journal path (cost + gross_profit)

**Files:**
- Modify: `api/src/routes/bookkeeping.ts:927-988` (`GET /income-statement`, journal path)

**Interfaces:**
- Consumes: `'cost'` rows in `accounts` (Task 1/2).
- Produces: response now includes `cost`, `cost_accounts`, `gross_profit`. `expenses`/`expense_accounts` = 6xxxxx+8xxxxx only. `net_income = gross_profit − expenses`. Response type shape used by frontend Tasks 10-11.

- [ ] **Step 1: Add `cost` total + `cost_accounts` queries**

Insert after the `expenses` query (after line 947) and before the `revenueAccounts` query (line 950):

```ts
  const cost = await db.prepare(
    `SELECT COALESCE(SUM(jl.debit) - SUM(jl.credit), 0) as amount FROM journal_lines jl
     JOIN journal_entries je ON jl.entry_id = je.id
     JOIN accounts a ON jl.account_code = a.account_code AND je.user_id = a.user_id
     WHERE je.user_id = ? AND je.entry_date >= ? AND je.entry_date <= ? AND a.account_type = 'cost' AND je.status != 'stale'`
  ).bind(tenantId, startDate, endDate).first<{ amount: number }>();
```

Insert after the `expenseAccounts` query (after line 974):

```ts
  const costAccounts = await db.prepare(
    `SELECT jl.account_code, a.account_name,
            COALESCE(SUM(jl.debit) - SUM(jl.credit), 0) as amount
     FROM journal_lines jl
     JOIN journal_entries je ON jl.entry_id = je.id
     JOIN accounts a ON jl.account_code = a.account_code AND je.user_id = a.user_id
     WHERE je.user_id = ? AND je.entry_date >= ? AND je.entry_date <= ?
       AND a.account_type = 'cost' AND je.status != 'stale'
     GROUP BY jl.account_code, a.account_name
     HAVING amount != 0
     ORDER BY jl.account_code`
  ).bind(tenantId, startDate, endDate).all<{ account_code: string; account_name: string; amount: number }>();
```

- [ ] **Step 2: Update the journal-path condition and response**

Change the journal block (lines 976-988) from:

```ts
  // If journal entries exist, use them
  if ((revenue?.amount || 0) > 0 || (expenses?.amount || 0) > 0) {
    const netIncome = (revenue?.amount || 0) - (expenses?.amount || 0);
    return c.json({
      revenue: revenue?.amount || 0,
      expenses: expenses?.amount || 0,
      net_income: netIncome,
      source: 'journal',
      revenue_accounts: revenueAccounts?.results || [],
      expense_accounts: expenseAccounts?.results || [],
      period: { start: startDate, end: endDate },
    });
  }
```

to:

```ts
  // If journal entries exist, use them
  if ((revenue?.amount || 0) > 0 || (cost?.amount || 0) > 0 || (expenses?.amount || 0) > 0) {
    const grossProfit = (revenue?.amount || 0) - (cost?.amount || 0);
    const netIncome = grossProfit - (expenses?.amount || 0);
    return c.json({
      revenue: revenue?.amount || 0,
      cost: cost?.amount || 0,
      gross_profit: grossProfit,
      expenses: expenses?.amount || 0,
      net_income: netIncome,
      source: 'journal',
      revenue_accounts: revenueAccounts?.results || [],
      cost_accounts: costAccounts?.results || [],
      expense_accounts: expenseAccounts?.results || [],
      period: { start: startDate, end: endDate },
    });
  }
```

- [ ] **Step 3: Verify**

Run: `npx tsc --noEmit` (from `api/`). Then confirm against production data for the PnR tenant that the journal path returns the new fields (expect `cost` > 0 since PnR has 5xxxxx activity):

```bash
npx wrangler d1 execute opcc-crm-db --remote --command "SELECT account_code, account_type, COUNT(*) c FROM accounts WHERE user_id='u-83161e0c' AND account_code LIKE '5%' GROUP BY account_type"
```

Expected: this runs now (pre-migration the type is still 'expense' for existing rows — the API response for PnR may show `cost: 0` until the migration runs in Task 8; that's expected).

- [ ] **Step 4: Commit**

```bash
git add api/src/routes/bookkeeping.ts
git commit -m "feat: income statement journal path splits cost + gross profit"
```

---

### Task 4: Income-statement endpoint — bank fallback path split

**Files:**
- Modify: `api/src/routes/bookkeeping.ts:990-1071` (bank fallback)

**Interfaces:**
- Produces: bank fallback returns `cost`, `cost_accounts`, `gross_profit`; `expenses`/`expense_accounts` use `6%|8%` only (was `5%|6%|8%`).

- [ ] **Step 1: Split the bank expense queries**

Change the `bankExpenses` query (line 1003-1011). Replace `AND (account_code LIKE '5%' OR account_code LIKE '6%' OR account_code LIKE '8%' OR ...` with `AND (account_code LIKE '6%' OR account_code LIKE '8%' OR ...` — i.e. drop the `'5%'` branch.

Add a new `bankCost` query after `bankExpenses`:

```ts
  // Cost: 5xxxx codes only
  const bankCost = await db.prepare(
    `SELECT COALESCE(SUM(withdrawal_amount), 0) as amount FROM bank_transactions
     WHERE user_id = ? AND transaction_date >= ? AND transaction_date <= ? AND deleted_at IS NULL
     AND (account_code LIKE '5%')
     AND NOT (account_code LIKE '3%' OR account_code LIKE '1%' OR account_code LIKE '2%')`
  ).bind(tenantId, startDate, endDate).first<{ amount: number }>();
```

- [ ] **Step 2: Split `catExpenses` and `bankExpenseAccounts`**

Change `catExpenses` (line 1019-1022): `WHERE ... (account_code LIKE '6%' OR account_code LIKE '8%') ...` (drop `'5%'`).

Change `bankExpenseAccounts` (line 1042-1053): `AND (account_code LIKE '6%' OR account_code LIKE '8%')` (drop `'5%'`).

Add a `bankCostAccounts` query after `bankExpenseAccounts` (after line 1053):

```ts
  const bankCostAccounts = await db.prepare(
    `SELECT COALESCE(account_code, 'uncategorized') as account_code,
            'Bank Withdrawal' as account_name,
            COALESCE(SUM(withdrawal_amount), 0) as amount
     FROM bank_transactions
     WHERE user_id = ? AND transaction_date >= ? AND transaction_date <= ?
       AND account_code LIKE '5%' AND deleted_at IS NULL
     GROUP BY account_code
     HAVING amount > 0
     ORDER BY account_code`
  ).bind(tenantId, startDate, endDate).all<{ account_code: string; account_name: string; amount: number }>();
```

- [ ] **Step 3: Update the bank response**

Change lines 1055-1071 from:

```ts
  const netIncome = (bankRevenue?.amount || 0) - (bankExpenses?.amount || 0);
  return c.json({
    revenue: bankRevenue?.amount || 0,
    expenses: bankExpenses?.amount || 0,
    net_income: netIncome,
    source: 'bank',
    revenue_accounts: bankRevenueAccounts?.results || [],
    expense_accounts: bankExpenseAccounts?.results || [],
```

to:

```ts
  const grossProfit = (bankRevenue?.amount || 0) - (bankCost?.amount || 0);
  const netIncome = grossProfit - (bankExpenses?.amount || 0);
  return c.json({
    revenue: bankRevenue?.amount || 0,
    cost: bankCost?.amount || 0,
    gross_profit: grossProfit,
    expenses: bankExpenses?.amount || 0,
    net_income: netIncome,
    source: 'bank',
    revenue_accounts: bankRevenueAccounts?.results || [],
    cost_accounts: bankCostAccounts?.results || [],
    expense_accounts: bankExpenseAccounts?.results || [],
```

(Leave the rest of the response — `breakdown` and `period` — unchanged.)

- [ ] **Step 4: Verify**

Run: `npx tsc --noEmit` (from `api/`). Confirm the `'5%'` branch appears only in `bankCost`/`bankCostAccounts`:
`Select-String -Path "api\src\routes\bookkeeping.ts" -Pattern "LIKE '5%'"` → expect matches only inside the two new cost queries (plus unrelated hits if any, review each).

- [ ] **Step 5: Commit**

```bash
git add api/src/routes/bookkeeping.ts
git commit -m "feat: income statement bank fallback splits cost vs expense"
```

---

### Task 5: Balance sheet + ledger + year-end close + profits-tax treat cost as expense-like

**Files:**
- Modify: `api/src/routes/bookkeeping.ts:1148` (balance calc), `:1177` (totalExpenses), `:1303`, `:1330` (ledger debit-natural), `:1698-1703` (YEC expense total), `:1733-1739` (YEC expense accounts), `:1796-1801` (tax expense)

**Interfaces:**
- Consumes: `'cost'` rows from Tasks 1-2.
- Produces: `'cost'` accounts are debit-natural, count toward `totalExpenses`, and are closed to retained earnings at year-end, exactly like `'expense'`.

- [ ] **Step 1: Balance sheet — `calcBalance` debit-natural**

Change `api/src/routes/bookkeeping.ts:1148`:

```ts
      if (type === 'asset' || type === 'expense' || code.startsWith('1') || code.startsWith('5') || code.startsWith('6') || code.startsWith('8')) {
```

to:

```ts
      if (type === 'asset' || type === 'cost' || type === 'expense' || code.startsWith('1') || code.startsWith('5') || code.startsWith('6') || code.startsWith('8')) {
```

- [ ] **Step 2: Balance sheet — `totalExpenses` classification**

Change line 1177:

```ts
      } else if (row.account_code?.startsWith('5') || row.account_code?.startsWith('6') || row.account_code?.startsWith('8') || accountType === 'expense') {
```

to:

```ts
      } else if (row.account_code?.startsWith('5') || row.account_code?.startsWith('6') || row.account_code?.startsWith('8') || accountType === 'cost' || accountType === 'expense') {
```

- [ ] **Step 3: Ledger `isDebitNatural` (journal path)**

Change line 1303:

```ts
      const isDebitNatural = row.account_type === 'asset' || row.account_type === 'expense';
```

to:

```ts
      const isDebitNatural = row.account_type === 'asset' || row.account_type === 'cost' || row.account_type === 'expense';
```

- [ ] **Step 4: Ledger `isDebitNatural` (bank fallback)**

Change line 1330:

```ts
  const push = (g: AccountGroup, e: LedgerEntry) => { const last = g.entries.length > 0 ? g.entries[g.entries.length - 1].balance : 0; const isDebitNat = g.account_type === 'asset' || g.account_type === 'expense'; const change = isDebitNat ? (e.debit - e.credit) : (e.credit - e.debit); e.balance = last + change; g.entries.push(e); g.total_debit += e.debit; g.total_credit += e.credit; };
```

to:

```ts
  const push = (g: AccountGroup, e: LedgerEntry) => { const last = g.entries.length > 0 ? g.entries[g.entries.length - 1].balance : 0; const isDebitNat = g.account_type === 'asset' || g.account_type === 'cost' || g.account_type === 'expense'; const change = isDebitNat ? (e.debit - e.credit) : (e.credit - e.debit); e.balance = last + change; g.entries.push(e); g.total_debit += e.debit; g.total_credit += e.credit; };
```

- [ ] **Step 5: Year-end close — expense total (line ~1698)**

Change the `expenses` query at line 1698-1703: `AND a.account_type = 'expense'` → `AND a.account_type IN ('expense', 'cost')`.

- [ ] **Step 6: Year-end close — expense accounts closing (line ~1733)**

Change the `expAccounts` query at line 1733-1739: `AND a.account_type = 'expense'` → `AND a.account_type IN ('expense', 'cost')`.

- [ ] **Step 7: Profits-tax provision — expense query (line ~1796)**

Change the `expenses` query at line 1796-1801: `AND a.account_type = 'expense'` → `AND a.account_type IN ('expense', 'cost')`.

- [ ] **Step 8: Verify**

Run: `npx tsc --noEmit` (from `api/`). Grep to confirm all four `account_type = 'expense'` filters that should be expense-like were widened:
`Select-String -Path "api\src\routes\bookkeeping.ts" -Pattern "account_type = 'expense'|account_type IN \('expense'|account_type === 'expense'|account_type === 'cost'"` → review each match: the balance-sheet/ledger lines have `'cost'` added; YEC + tax have `IN ('expense', 'cost')`; the income-statement expense totals (Task 3) intentionally remain `= 'expense'`.

- [ ] **Step 9: Commit**

```bash
git add api/src/routes/bookkeeping.ts
git commit -m "feat: balance sheet, ledger, year-end close, tax treat cost as expense-like"
```

---

### Task 6: Other backend consumers (dashboard, chat, admin, card-statements)

**Files:**
- Modify: `api/src/routes/dashboard.ts:90-95`, `:204-209`; `api/src/routes/chat.ts:437`, `:442`, `:466`; `api/src/routes/admin.ts:753`; `api/src/routes/card-statements.ts:472`

**Interfaces:**
- Consumes: `'cost'` rows.
- Produces: expense totals include `'cost'`; chat balance-sheet debit-natural includes `'cost'`; `add_account` accepts `'cost'`; card auto-type maps 5→`'cost'`.

- [ ] **Step 1: Dashboard MTD expense (line ~90-95)**

Change `AND a.account_type = 'expense'` → `AND a.account_type IN ('expense', 'cost')` in the `expFromGL` query (line 94).

- [ ] **Step 2: Dashboard period expense (line ~204-209)**

Change `AND a.account_type = 'expense'` → `AND a.account_type IN ('expense', 'cost')` in the `pExp` GL query (line 208).

- [ ] **Step 3: Chat balance-sheet debit-natural (line 437)**

Change line 437:

```ts
          const bal = (r.account_type === 'asset' || r.account_type === 'expense' || (r.account_code||'').startsWith('1') || (r.account_code||'').startsWith('5')) ? (r.total_debit - r.total_credit) : (r.total_credit - r.total_debit);
```

to:

```ts
          const bal = (r.account_type === 'asset' || r.account_type === 'cost' || r.account_type === 'expense' || (r.account_code||'').startsWith('1')) ? (r.total_debit - r.total_credit) : (r.total_credit - r.total_debit);
```

This also fixes the latent quirk where 6xxxxx relied on `startsWith('5')` — now type-based.

- [ ] **Step 4: Chat balance-sheet expense bucket (line 442)**

Change line 442:

```ts
          else if (r.account_code?.startsWith('5') || r.account_type === 'expense') exp += bal;
```

to:

```ts
          else if (r.account_type === 'cost' || r.account_type === 'expense' || r.account_code?.startsWith('5')) exp += bal;
```

- [ ] **Step 5: Chat `add_account` validTypes (line 466)**

Change line 466:

```ts
      const validTypes = ['asset', 'liability', 'equity', 'revenue', 'expense'];
```

to:

```ts
      const validTypes = ['asset', 'liability', 'equity', 'revenue', 'cost', 'expense'];
```

- [ ] **Step 6: Admin audit expense (line 753)**

Change line 753:

```ts
       COALESCE(SUM(CASE WHEN a.account_type = 'expense' THEN jl.debit ELSE 0 END), 0) as total_expenses
```

to:

```ts
       COALESCE(SUM(CASE WHEN a.account_type IN ('expense', 'cost') THEN jl.debit ELSE 0 END), 0) as total_expenses
```

- [ ] **Step 7: Card-statements auto-type (line 472)**

Change line 472:

```ts
      const type = code.startsWith('1') ? 'asset' : code.startsWith('2') ? 'liability' : code.startsWith('3') ? 'equity' : code.startsWith('4') ? 'revenue' : 'expense';
```

to:

```ts
      const type = code.startsWith('1') ? 'asset' : code.startsWith('2') ? 'liability' : code.startsWith('3') ? 'equity' : code.startsWith('4') ? 'revenue' : code.startsWith('5') ? 'cost' : 'expense';
```

- [ ] **Step 8: Verify**

Run: `npx tsc --noEmit` (from `api/`). Confirm all four `'expense'` → `IN ('expense', 'cost')` edits are present in dashboard/admin.

- [ ] **Step 9: Commit**

```bash
git add api/src/routes/dashboard.ts api/src/routes/chat.ts api/src/routes/admin.ts api/src/routes/card-statements.ts
git commit -m "feat: dashboard/chat/admin/card-statements recognize 'cost' type"
```

---

### Task 7: Fresh-DB schema + seed (schema.sql, coa-hk.sql)

**Files:**
- Modify: `api/src/db/schema.sql:181`; `api/src/db/coa-hk.sql` lines 94, 96, 97, 99, 100, 102, 103, 104

**Interfaces:**
- Produces: fresh DBs accept `'cost'` (CHECK) and seed 5xxxxx as `'cost'`.

- [ ] **Step 1: Update schema.sql CHECK constraint**

Change `api/src/db/schema.sql:181`:

```sql
  account_type TEXT NOT NULL CHECK (account_type IN ('asset', 'liability', 'equity', 'revenue', 'expense')),
```

to:

```sql
  account_type TEXT NOT NULL CHECK (account_type IN ('asset', 'liability', 'equity', 'revenue', 'cost', 'expense')),
```

- [ ] **Step 2: Update coa-hk.sql 5xxxxx seeds**

For each of these lines in `api/src/db/coa-hk.sql`, change `'expense'` → `'cost'` (the code at the start of the row is `'5xxxx'`): 94 (50000), 96 (51000), 97 (52000), 99 (51100), 100 (51200), 102 (51101), 103 (51102), 104 (51201). Do NOT touch 6xxxxx/8xxxxx rows.

- [ ] **Step 3: Verify**

`Select-String -Path "api\src\db\coa-hk.sql" -Pattern "'5[0-9]{4}'"` → each match is a row now carrying `'cost'`. `Select-String -Path "api\src\db\schema.sql" -Pattern "account_type IN"` → shows `'cost'`.

- [ ] **Step 4: Commit**

```bash
git add api/src/db/schema.sql api/src/db/coa-hk.sql
git commit -m "feat: schema + seed accept 'cost' account type"
```

---

### Task 8: Production migration (table rebuild + retype)

**Files:**
- Create: `api/src/db/migration-account-type-cost.sql`
- Run against production (from `api/`).

**Interfaces:**
- Consumes: production `accounts` table (currently CHECK without `'cost'`, 969 expense rows of which 125 are 5xxxxx).
- Produces: `accounts` table CHECK includes `'cost'`; all `5xxxxx` rows become `account_type = 'cost'`. Idempotent — safe to re-run.

- [ ] **Step 1: Write the migration file**

Create `api/src/db/migration-account-type-cost.sql`:

```sql
-- Migration: add 'cost' to accounts.account_type + retype 5xxxxx rows
-- Run with: cd api && npx wrangler d1 execute opcc-crm-db --remote --file=src/db/migration-account-type-cost.sql
-- Idempotent: rebuild only runs when the current table lacks 'cost' support.

-- SQLite cannot ALTER a CHECK constraint, so rebuild the table in place.
-- Idempotency note: on a re-run, accounts_new is dropped by the first statement,
-- then recreated, re-copied (CASE is a no-op on already-'cost' rows), and renamed.
-- This makes the file safe to run repeatedly.
DROP TABLE IF EXISTS accounts_new;
CREATE TABLE IF NOT EXISTS accounts_new (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  account_code TEXT NOT NULL,
  account_name TEXT NOT NULL,
  account_type TEXT NOT NULL CHECK (account_type IN ('asset', 'liability', 'equity', 'revenue', 'cost', 'expense')),
  parent_code TEXT,
  opening_balance REAL DEFAULT 0,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(user_id, account_code)
);

INSERT INTO accounts_new (id, user_id, account_code, account_name, account_type, parent_code, opening_balance, is_active, created_at)
SELECT id, user_id, account_code, account_name,
       CASE WHEN account_code LIKE '5%' THEN 'cost' ELSE account_type END,
       parent_code, opening_balance, is_active, created_at
FROM accounts;

DROP TABLE accounts;
ALTER TABLE accounts_new RENAME TO accounts;
```

Note: idempotent by design — `DROP TABLE IF EXISTS accounts_new` guarantees a clean rebuild on every run, and the `CASE` becomes a no-op once rows are already `'cost'`.

- [ ] **Step 2: Back up sanity count (pre-run)**

From `api/`:

```bash
npx wrangler d1 execute opcc-crm-db --remote --command "SELECT account_type, COUNT(*) c FROM accounts GROUP BY account_type"
```

Expected: `expense` = 969, `cost` = 0 (or absent).

- [ ] **Step 3: Run the migration**

From `api/`:

```bash
npx wrangler d1 execute opcc-crm-db --remote --file=src/db/migration-account-type-cost.sql
```

Expected: success, rows_written ≈ 1870 (table copy).

- [ ] **Step 4: Verify post-migration**

```bash
npx wrangler d1 execute opcc-crm-db --remote --command "SELECT account_type, COUNT(*) c FROM accounts GROUP BY account_type"
npx wrangler d1 execute opcc-crm-db --remote --command "SELECT account_code, account_type FROM accounts WHERE user_id='u-83161e0c' AND account_code LIKE '5%'"
```

Expected: `cost` = 125, `expense` = 844, other types unchanged; PnR 5xxxxx rows all `cost`.

- [ ] **Step 5: Re-run idempotency check**

Run the migration file again, then repeat the count query. Expected: counts identical (`cost` = 125, `expense` = 844) — rebuild is idempotent.

- [ ] **Step 6: Commit**

```bash
git add api/src/db/migration-account-type-cost.sql
git commit -m "feat: migration adds 'cost' account type (table rebuild + retype 5xxxxx)"
```

---

### Task 9: Frontend COA page — Cost section

**Files:**
- Modify: `frontend/src/pages/ChartOfAccounts.tsx:16` (`TYPE_ORDER`), `:18-24` (`TYPE_LABELS`), `:26-32` (`TYPE_COLORS`), `:92-94` (`expandedTypes`)

**Interfaces:**
- Consumes: `account_type` from GET /accounts (now includes `'cost'`).
- Produces: `TYPE_ORDER`/`TYPE_LABELS`/`TYPE_COLORS` include `cost`; COA renders a Cost section between Revenue and Expenses; account dropdowns offer Cost; `expandedTypes` defaults `cost: true`.

- [ ] **Step 1: Update `TYPE_ORDER` (line 16)**

```ts
const TYPE_ORDER = ['asset', 'liability', 'equity', 'revenue', 'cost', 'expense'] as const;
```

- [ ] **Step 2: Update `TYPE_LABELS` (lines 18-24)**

Add after the `revenue` entry:

```ts
  cost: tr('Cost', '直接成本', '直接成本'),
```

- [ ] **Step 3: Update `TYPE_COLORS` (lines 26-32)**

Add after the `revenue` entry (distinct from expense's amber):

```ts
  cost: 'bg-orange-50 text-black font-bold dark:bg-orange-900/30 dark:text-white',
```

- [ ] **Step 4: Update `expandedTypes` initial state (lines 92-94)**

```ts
  const [expandedTypes, setExpandedTypes] = useState<Record<string, boolean>>({
    asset: true, liability: true, equity: true, revenue: true, cost: true, expense: true,
  });
```

- [ ] **Step 5: Verify**

Run: `npm run build` (from `frontend/`). Expected: build succeeds. Confirm the Cost section renders after Revenue and before Expenses in the running app (manual check after deploy).

- [ ] **Step 6: Commit**

```bash
git add frontend/src/pages/ChartOfAccounts.tsx
git commit -m "feat: COA page shows separate Cost section"
```

---

### Task 10: Frontend CoaPreview — type, labels, ranges

**Files:**
- Modify: `frontend/src/components/CoaPreview.tsx:14` (`CoaAccountType`), `:36` (`TYPE_ORDER`), `:38-44` (`TYPE_LABELS`), `:46-52` (`TYPE_COLORS`), `:54-61` (`TYPE_CODE_RANGE`)

**Interfaces:**
- Consumes: `'cost'` type.
- Produces: preview/renumber treat cost codes in `50000-59999`, expense in `60000-89999`.

- [ ] **Step 1: Update the union (line 14)**

```ts
export type CoaAccountType = 'asset' | 'liability' | 'equity' | 'revenue' | 'cost' | 'expense';
```

- [ ] **Step 2: Update `TYPE_ORDER` (line 36)**

```ts
const TYPE_ORDER: CoaAccountType[] = ['asset', 'liability', 'equity', 'revenue', 'cost', 'expense'];
```

- [ ] **Step 3: Update `TYPE_LABELS` (lines 38-44)**

Add after the `revenue` entry:

```ts
  cost: tr('Cost', '直接成本', '直接成本'),
```

- [ ] **Step 4: Update `TYPE_COLORS` (lines 46-52)**

Add after the `revenue` entry:

```ts
  cost: 'bg-orange-50 text-black font-bold dark:bg-orange-900/30 dark:text-white',
```

- [ ] **Step 5: Split `TYPE_CODE_RANGE` (lines 54-61)**

Change the block from:

```ts
/** Code range per type for renumbering. Expense spans 50000-69999 and 80000-89999. */
const TYPE_CODE_RANGE: Record<string, { start: number; end: number }> = {
  asset: { start: 10000, end: 19999 },
  liability: { start: 20000, end: 29999 },
  equity: { start: 30000, end: 39999 },
  revenue: { start: 40000, end: 49999 },
  expense: { start: 50000, end: 89999 },
};
```

to:

```ts
/** Code range per type for renumbering. Cost spans 50000-59999, Expense 60000-89999. */
const TYPE_CODE_RANGE: Record<string, { start: number; end: number }> = {
  asset: { start: 10000, end: 19999 },
  liability: { start: 20000, end: 29999 },
  equity: { start: 30000, end: 39999 },
  revenue: { start: 40000, end: 49999 },
  cost: { start: 50000, end: 59999 },
  expense: { start: 60000, end: 89999 },
};
```

- [ ] **Step 6: Verify**

Run: `npm run build` (from `frontend/`). Expected: build succeeds.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/components/CoaPreview.tsx
git commit -m "feat: CoaPreview recognizes cost type + code range"
```

---

### Task 11: Frontend P&L render order (Revenue → Cost → Gross Profit → Expenses → Net Income)

**Files:**
- Modify: `frontend/src/pages/Bookkeeping.tsx:32` (`expandedPL`), `:559-686` (P&L JSX)

**Interfaces:**
- Consumes: income-statement response fields `cost`, `cost_accounts`, `gross_profit` (Tasks 3-4).
- Produces: P&L tab renders Revenue, then Cost (from `cost_accounts`), then a Gross Profit subtotal, then Expenses, then Net Income.

- [ ] **Step 1: Add `cost` to `expandedPL` default (line 32)**

Change:

```ts
  const [expandedPL, setExpandedPL] = useState<Record<string, boolean>>({});
```

to:

```ts
  const [expandedPL, setExpandedPL] = useState<Record<string, boolean>>({ cost: true });
```

(Existing keys `revenue`/`expenses` are set via toggle clicks as today.)

- [ ] **Step 2: Insert the Cost section between Revenue and Expenses**

In `frontend/src/pages/Bookkeeping.tsx`, between the closing of the Revenue section (`</div>` at line 618) and the Expenses section (`<div className="border-t">` at line 620), insert a Cost section mirroring the Revenue block (lines 564-618). It uses `cost_accounts` and `cost`:

```tsx
            {/* Cost section */}
            <div className="border-t">
              <button
                onClick={() => setExpandedPL(prev => ({ ...prev, cost: !prev.cost }))}
                className="w-full flex items-center gap-3 px-4 py-3 hover:bg-muted/50 transition-colors text-left"
              >
                <span className="shrink-0 text-muted-foreground">
                  {expandedPL.cost ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                </span>
                <span className="flex-1 font-medium text-sm">
                  {tr('Cost', '直接成本', '直接成本')}
                </span>
                <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-orange-100 text-orange-800 border border-orange-200">
                  {(incomeStatement.cost_accounts || []).length} {tr('COA Accounts', '科目', '科目')}
                </span>
                <span className="font-semibold text-orange-600 text-sm ml-2">
                  HKD {((incomeStatement.cost || 0)).toLocaleString(undefined, { minimumFractionDigits: 2 })}
                </span>
              </button>

              <div className={`expand-collapse ${expandedPL.cost ? 'expand-collapse-open' : 'expand-collapse-closed'}`}>
                <div className="border-t bg-muted/10">
                  {(incomeStatement.cost_accounts || []).length === 0 ? (
                    <p className="px-10 py-3 text-xs text-muted-foreground">
                      {tr('No linked COA accounts', '沒有關聯科目', '没有关联科目')}
                    </p>
                  ) : (
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b text-xs text-muted-foreground">
                          <th className="text-left py-2 px-4 font-medium">{tr('Account Code', '科目編號', '科目编号')}</th>
                          <th className="text-left py-2 px-4 font-medium">{tr('Account Name', '科目名稱', '科目名称')}</th>
                          <th className="text-right py-2 px-4 font-medium">{tr('Amount', '金額', '金额')}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {(incomeStatement.cost_accounts || []).map((acct: any) => (
                          <tr
                            key={acct.account_code}
                            onClick={() => setSelectedPLAccount(selectedPLAccount === acct.account_code ? null : acct.account_code)}
                            className={`border-b border-muted/20 hover:bg-muted/30 cursor-pointer transition-colors ${selectedPLAccount === acct.account_code ? 'bg-blue-50 dark:bg-blue-950/30 ring-1 ring-blue-300' : ''}`}
                          >
                            <td className="py-1.5 px-4 font-mono text-xs">{acct.account_code}</td>
                            <td className="py-1.5 px-4">{acct.account_name}</td>
                            <td className="py-1.5 px-4 text-right font-mono text-orange-600">
                              HKD {(acct.amount || 0).toLocaleString(undefined, { minimumFractionDigits: 2 })}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </div>
              </div>
            </div>
```

- [ ] **Step 3: Insert the Gross Profit subtotal between Cost and Expenses**

After the Cost section's closing `</div>` (the block just added) and before `{/* Expenses section */}` at line 620, insert:

```tsx
            {/* Gross Profit subtotal */}
            <div className="border-t flex justify-between items-center px-4 py-3 bg-orange-50/40 dark:bg-orange-950/20">
              <span className="font-bold text-sm">
                {tr('Gross Profit', '毛利', '毛利')}
              </span>
              <span className={`font-bold text-sm ${(incomeStatement.gross_profit || 0) >= 0 ? 'text-orange-600' : 'text-red-600'}`}>
                HKD {(incomeStatement.gross_profit || 0).toLocaleString(undefined, { minimumFractionDigits: 2 })}
              </span>
            </div>
```

- [ ] **Step 4: Verify**

Run: `npm run build` (from `frontend/`). Expected: build succeeds.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/pages/Bookkeeping.tsx
git commit -m "feat: P&L tab renders Cost + Gross Profit subtotal"
```

---

### Task 12: PnlFormulaBanner component

**Files:**
- Create: `frontend/src/components/PnlFormulaBanner.tsx`
- Modify: `frontend/src/pages/Bookkeeping.tsx` (render banner at top of P&L)

**Interfaces:**
- Consumes: income-statement response (any object with `revenue`, `cost`, `gross_profit`, `expenses`, `net_income`).
- Produces: `PnlFormulaBanner({ data }: { data: { revenue: number; cost: number; gross_profit: number; expenses: number; net_income: number } })` — always-visible, always-stacked formula cards.

- [ ] **Step 1: Write the component**

Create `frontend/src/components/PnlFormulaBanner.tsx`:

```tsx
import { tr } from '../lib/i18nHelpers';

interface PnlData {
  revenue: number;
  cost: number;
  gross_profit: number;
  expenses: number;
  net_income: number;
}

interface PnlFormulaBannerProps {
  data: PnlData;
}

function Term({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div className="flex flex-col items-center px-3 py-2 rounded-lg bg-background border">
      <span className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</span>
      <span className={`text-sm font-mono font-semibold ${value < 0 ? 'text-red-600' : color}`}>
        {(value || 0).toLocaleString(undefined, { minimumFractionDigits: 2 })}
      </span>
    </div>
  );
}

function FormulaRow({ left, op, right, resultLabel, resultValue, color }: {
  left: { label: string; value: number };
  op: string;
  right: { label: string; value: number };
  resultLabel: string;
  resultValue: number;
  color: string;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Term label={left.label} value={left.value} color={color} />
      <span className="text-lg font-bold text-muted-foreground">{op}</span>
      <Term label={right.label} value={right.value} color={color} />
      <span className="text-lg font-bold text-muted-foreground">=</span>
      <div className="flex flex-col items-center px-3 py-2 rounded-lg bg-background border border-primary/30">
        <span className="text-[10px] uppercase tracking-wide text-muted-foreground">{resultLabel}</span>
        <span className={`text-sm font-mono font-bold ${resultValue < 0 ? 'text-red-600' : color}`}>
          {(resultValue || 0).toLocaleString(undefined, { minimumFractionDigits: 2 })}
        </span>
      </div>
    </div>
  );
}

export default function PnlFormulaBanner({ data }: PnlFormulaBannerProps) {
  return (
    <div className="space-y-3 p-4 bg-card border rounded-xl">
      <p className="text-xs font-medium text-muted-foreground">
        {tr('Formula', '公式', '公式')}
      </p>
      <FormulaRow
        left={{ label: tr('Revenue', '收入', '收入'), value: data.revenue }}
        op="−"
        right={{ label: tr('Cost', '直接成本', '直接成本'), value: data.cost }}
        resultLabel={tr('Gross Profit', '毛利', '毛利')}
        resultValue={data.gross_profit}
        color="text-orange-600"
      />
      <FormulaRow
        left={{ label: tr('Gross Profit', '毛利', '毛利'), value: data.gross_profit }}
        op="−"
        right={{ label: tr('Expenses', '支出', '支出'), value: data.expenses }}
        resultLabel={tr('Net Profit', '淨利', '净利')}
        resultValue={data.net_income}
        color="text-green-600"
      />
    </div>
  );
}
```

- [ ] **Step 2: Render the banner in the P&L tab**

In `frontend/src/pages/Bookkeeping.tsx`, add the import near the other imports:

```tsx
import PnlFormulaBanner from '../components/PnlFormulaBanner';
```

Then, at the top of the P&L content (`{/* P&L Tab */}` block, just before `<div className="flex gap-4">` at line 560), insert:

```tsx
      <PnlFormulaBanner data={{
        revenue: incomeStatement.revenue || 0,
        cost: incomeStatement.cost || 0,
        gross_profit: incomeStatement.gross_profit || 0,
        expenses: incomeStatement.expenses || 0,
        net_income: incomeStatement.net_income || 0,
      }} />
```

(Place it above the existing `<div className="flex gap-4">` wrapper — i.e., the P&L Tab block becomes banner + the flex row below it. Verify the enclosing parent still has `space-y-*` or add a wrapper margin if needed.)

- [ ] **Step 3: Verify**

Run: `npm run build` (from `frontend/`). Expected: build succeeds. The banner must handle undefined fields gracefully (`|| 0`) in case the API has not been updated yet during local dev.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/components/PnlFormulaBanner.tsx frontend/src/pages/Bookkeeping.tsx
git commit -m "feat: P&L formula banner (Gross Profit / Net Profit equations)"
```

---

### Task 13: Other frontend spots (MissingCodesModal, CardStatementReview, ledger badges)

**Files:**
- Modify: `frontend/src/components/MissingCodesModal.tsx:34-40`; `frontend/src/pages/CardStatementReview.tsx:262`; `frontend/src/pages/Bookkeeping.tsx:921-926` (GJE type badge + normal side)

**Interfaces:**
- Consumes: `'cost'` account_type from API.
- Produces: cost accounts appear in card-expense dropdowns, get a badge color, and are Dr-normal in journal entry forms.

- [ ] **Step 1: MissingCodesModal color (line 34-40)**

Add to `TYPE_COLORS`:

```ts
  cost: 'bg-orange-100 text-orange-700',
```

- [ ] **Step 2: CardStatementReview expense dropdown (line 262)**

Change:

```tsx
          {accounts.filter((a: any) => a.account_type === 'expense').map((a: any) => (
```

to:

```tsx
          {accounts.filter((a: any) => a.account_type === 'expense' || a.account_type === 'cost').map((a: any) => (
```

- [ ] **Step 3: Bookkeeping GJE type badge + normal side (lines 921-927)**

Change the `typeBadge` map (lines 921-924) to add `cost`:

```tsx
                      const typeBadge = matchedAccount ? ({
                        asset: 'bg-blue-100 text-blue-700', liability: 'bg-orange-100 text-orange-700',
                        equity: 'bg-green-100 text-green-700', revenue: 'bg-emerald-100 text-emerald-700', cost: 'bg-orange-100 text-orange-700', expense: 'bg-red-100 text-red-700',
                      } as Record<string, string>)[matchedAccount.account_type] || '' : '';
```

Change the `normalSide` line (925-927) from:

```tsx
                      const normalSide = matchedAccount ? (
                        matchedAccount.account_type === 'asset' || matchedAccount.account_type === 'expense' ? 'Dr' : 'Cr'
                      ) : '';
```

to:

```tsx
                      const normalSide = matchedAccount ? (
                        matchedAccount.account_type === 'asset' || matchedAccount.account_type === 'cost' || matchedAccount.account_type === 'expense' ? 'Dr' : 'Cr'
                      ) : '';
```

- [ ] **Step 4: Verify**

Run: `npm run build` (from `frontend/`). Expected: build succeeds.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/MissingCodesModal.tsx frontend/src/pages/CardStatementReview.tsx frontend/src/pages/Bookkeeping.tsx
git commit -m "feat: cost type in card dropdown, badges, Dr-normal side"
```

---

### Task 14: Full verification (typecheck + build)

**Files:** none — verification only.

- [ ] **Step 1: API typecheck**

From `api/`:

```bash
npx tsc --noEmit
```

Expected: only the pre-existing errors (GITHUB_TOKEN/RESEND_API_KEY/MAILGUN_API_KEY bindings, `requireHigherTier`, `paddedPw`, `project` property, `chat.ts` bcrypt, `file-storage.ts` Uint8Array, `bookkeeping.ts:1369/1506`). No new errors from our changes.

- [ ] **Step 2: Frontend build**

From `frontend/`:

```bash
npm run build
```

Expected: `tsc -b` and `vite build` both succeed.

- [ ] **Step 3: Confirm no diff in file-storage.ts**

```bash
git -C "C:\Users\samue\Documents\Pastel\Tech_Connect_SME\Development_code\latest_code" diff --stat -- api/src/routes/file-storage.ts
```

Expected: shows only the pre-existing OCR agent changes (not ours). Confirm none of our tasks touched that file.

- [ ] **Step 4: Commit any remaining**

```bash
git add -A
git commit -m "chore: verification pass for cost/expense split"
```

(Only if there are uncommitted changes; otherwise skip.)

---

### Task 15: Deploy (optional — coordinated with parallel agent)

**Files:** none — deployment only.

**Note:** Deploying the API will include the parallel agent's uncommitted `file-storage.ts` and `schema.sql` changes. Coordinate timing with that agent before deploying. The user instructed "commit but don't push" — a deploy is separate from push and should only happen when the user requests it.

- [ ] **Step 1: Deploy API (when user requests)**

From `api/`:

```bash
npx wrangler deploy
```

- [ ] **Step 2: Deploy frontend Pages (when user requests)**

From `frontend/` (matching the standing deploy command in earlier specs):

```bash
npm run build
npx wrangler pages deploy dist --project-name=opcc-crm-testing --branch=main
```

(Set `CLOUDFLARE_ACCOUNT_ID=8c00cc4647a9cf5d8deb5d6a354001e0` as needed per the standing deploy.)

- [ ] **Step 3: Post-deploy regression check**

- Login as a PnR user (`joseph.lin@pnr.hk`), open Chart of Accounts → verify separate Cost / 直接成本 and Expenses / 支出 sections.
- Open Income Statement → verify banner shows both formulas with figures, and sections render Revenue → Cost → Gross Profit → Expenses → Net Income.
- Run `regression-tests/` suite (`npx playwright test` from `regression-tests/`) and fix any failures.
