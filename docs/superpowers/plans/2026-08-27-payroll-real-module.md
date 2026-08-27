# Real Payroll Module Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn demo-only `/payroll` into a real HK payroll module (employees, monthly runs, 3 GL journal entries) behind a Demo ⇄ Real header toggle.

**Architecture:** Dedicated `/api/payroll` Hono module with 3 new D1 tables (`payroll_employees`, `payroll_runs`, `payroll_run_items`). Pure computation/JE-building logic lives in `api/src/lib/` for testability; routes are thin DB glue reusing `nextManualVoucherNumber`, `findParentAccountError`, `checkPeriodOpen`, `createSnapshot`. Frontend splits `Payroll.tsx` into a shell with a segmented Demo/Real toggle, the untouched demo view, and a new real view wired to React Query.

**Tech Stack:** Hono + Cloudflare Workers/D1, Zod, React 18 + React Query + Tailwind, Playwright (root), plain-ts `ok()` test scripts run with `npx tsx`.

**Spec:** `docs/superpowers/specs/2026-08-27-payroll-real-module-design.md`

## Global Constraints

- All tables carry `user_id` tenancy; handlers read `const tenantId = c.get('client_user_id') || user.id`.
- Journal lines NEVER set the `project` column — it does not exist in live D1 (AP-AR-GL-FIX-HANDOFF.md gotcha). Omit it from all INSERTs here.
- MPF constants (verbatim from `frontend/src/lib/mpf.ts:7-10`): `MPF_MIN_MONTHLY_INCOME = 7100`, `MPF_MAX_MONTHLY_INCOME = 30000`, `MPF_RATE = 0.05`, `MPF_MAX_CONTRIBUTION = 1500`. Do NOT use the proposed 40,000/2,000 cap.
- Fixed COA codes: bank default `11102`, salary payable `21203`, MPF payable `21204`, ER-MPF expense `61202`. Employee salary accounts among `51201 | 61102 | 61201`.
- Account names come from the tenant `accounts` table, never hardcoded, in GL postings. (Bilingual display names in the FRONTEND may use the hardcoded REAL_COA mirror like `samplePayroll.ts` does.)
- Unit tests are plain `.test.ts` scripts under `tests/` using the hand-rolled `ok(pass, label)` harness (see `tests/manual-booking.test.ts`) run via `npx tsx tests/<name>.test.ts` from repo root. No vitest anywhere.
- Playwright specs go in `tests/*.spec.ts` (root), following the login pattern in `tests/payroll-demo.spec.ts:8-14`.
- Migrations are standalone `api/src/db/migration-*.sql` files applied manually via wrangler (precedent: `migration-journal-entry-snapshots.sql` is NOT merged into schema.sql).
- Trilingual copy everywhere via `tr(en, zhHant, zhHans)` from `../lib/i18nHelpers`.
- Style borders inline: `style={{ borderColor: 'hsl(var(--border))' }}`; icons from lucide-react.
- Commit after every task; conventional commits (`feat:`, `test:`, `docs:` prefixes seen in history).

---

### Task 1: Server-side MPF library (port of frontend logic)

**Files:**
- Create: `api/src/lib/mpf.ts`
- Test: `tests/payroll-mpf.test.ts`

**Interfaces:**
- Consumes: nothing (pure module).
- Produces: `computeMpf(grossMonthly: number): { employee: number; employer: number; net: number }`; constants `MPF_MIN_MONTHLY_INCOME`, `MPF_MAX_MONTHLY_INCOME`, `MPF_RATE`, `MPF_MAX_CONTRIBUTION`. Task 2 imports `computeMpf` from `'./mpf'`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/payroll-mpf.test.ts
// Run: npx tsx tests/payroll-mpf.test.ts
import { computeMpf, MPF_MAX_CONTRIBUTION } from '../api/src/lib/mpf';

let pass = 0, fail = 0;
function ok(cond: boolean, label: string) {
  if (cond) { pass++; } else { fail++; console.error(`FAIL: ${label}`); }
}

// Regression table from spec docs/superpowers/specs/2026-08-20-payroll-demo-design.md:98-106
ok(computeMpf(6000).employee === 0, 'below min: employee 0');
ok(computeMpf(6000).employer === 300, 'below min: employer 5% of 6,000');
ok(computeMpf(9500).net === 9025, '9,500 net = 9,025');
ok(computeMpf(22500).employee === 1125 && computeMpf(22500).employer === 1125, '22,500 → 1,125 both');
ok(computeMpf(28000).employee === 1400 && computeMpf(28000).employer === 1400, '28,000 → 1,400 both');
ok(computeMpf(35000).employee === MPF_MAX_CONTRIBUTION, '35,000 employee capped 1,500');
ok(computeMpf(45000).employer === 1500, '45,000 employer capped 1,500');
ok(computeMpf(0).employee === 0 && computeMpf(0).employer === 0, 'zero salary → zeros');
ok(computeMpf(-5).employee === 0 && computeMpf(-5).employer === 0, 'negative clamps to 0');

console.log(`payroll-mpf: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx tests/payroll-mpf.test.ts`
Expected: FAIL — cannot find module '../api/src/lib/mpf'

- [ ] **Step 3: Write minimal implementation**

```ts
// api/src/lib/mpf.ts
// Server-side port of frontend/src/lib/mpf.ts (HK MPF, rules in force 2026-08).
// 5% each side; relevant income below HK$7,100 → employee exempt (0), employer still 5%;
// maximum relevant income HK$30,000 → cap HK$1,500 per side.

export const MPF_MIN_MONTHLY_INCOME = 7100;
export const MPF_MAX_MONTHLY_INCOME = 30000;
export const MPF_RATE = 0.05;
export const MPF_MAX_CONTRIBUTION = 1500;

export interface MpfResult {
  employee: number;
  employer: number;
  net: number;
}

export function computeMpf(grossMonthly: number): MpfResult {
  const gross = Math.max(0, grossMonthly);
  const employer = Math.min(Math.round(gross * MPF_RATE), MPF_MAX_CONTRIBUTION);
  const employee =
    gross < MPF_MIN_MONTHLY_INCOME ? 0 : Math.min(Math.round(gross * MPF_RATE), MPF_MAX_CONTRIBUTION);
  return { employee, employer, net: gross - employee };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx tests/payroll-mpf.test.ts`
Expected: `payroll-mpf: 9 passed, 0 failed`

- [ ] **Step 5: Commit**

```bash
git add api/src/lib/mpf.ts tests/payroll-mpf.test.ts
git commit -m "feat(payroll): server-side HK MPF calculation library"
```

---

### Task 2: Run computation + JE composition core (pure)

**Files:**
- Create: `api/src/lib/payroll-core.ts`
- Test: `tests/payroll-core.test.ts`

**Interfaces:**
- Consumes: `computeMpf` from Task 1.
- Produces (used by Tasks 5–8):
  - `interface RunEmployeeInput { id: string; monthly_salary: number; expense_account_code: string; hire_date: string; termination_date: string | null }`
  - `interface RunItem { employee_id: string; gross: number; ee_mpf: number; er_mpf: number; net: number; expense_account_code: string }`
  - `interface RunTotals { total_gross: number; total_ee_mpf: number; total_er_mpf: number; total_net: number }`
  - `interface JeLineDraft { dr: boolean; code: string; name: string; amount: number }`
  - `periodBounds(periodMonth: string): { start: string; end: string }` — end = last day of month, `YYYY-MM-DD`
  - `isActiveInPeriod(emp: RunEmployeeInput, start: string, end: string): boolean`
  - `computeRunItems(emps: RunEmployeeInput[], periodMonth: string): { items: RunItem[]; totals: RunTotals }`
  - `const LIFE_CYCLE_ACCOUNTS = { BANK_DEFAULT: '11102', SALARY_PAYABLE: '21203', MPF_PAYABLE: '21204', ER_MPF_EXPENSE: '61202' }`
  - `type TransitionTarget = 'accrued' | 'paid' | 'settled' | 'cancelled'`
  - `canTransition(from: string, to: TransitionTarget): boolean` — allowed: draft→accrued/cancelled, accrued→paid/cancelled, paid→settled
  - `buildAccrualLines(items: RunItem[], totals: RunTotals, accountName: (code: string) => string): JeLineDraft[]`
  - `buildPaymentLines(totals: RunTotals, bankCode: string, accountName: (code: string) => string): JeLineDraft[]`
  - `buildSettlementLines(totals: RunTotals, bankCode: string, accountName: (code: string) => string): JeLineDraft[]`

- [ ] **Step 1: Write the failing test**

```ts
// tests/payroll-core.test.ts
// Run: npx tsx tests/payroll-core.test.ts
import {
  computeRunItems, periodBounds, canTransition,
  buildAccrualLines, buildPaymentLines, buildSettlementLines, LIFE_CYCLE_ACCOUNTS,
  type RunEmployeeInput, type RunItem, type RunTotals,
} from '../api/src/lib/payroll-core';

let pass = 0, fail = 0;
function ok(cond: boolean, label: string) {
  if (cond) { pass++; } else { fail++; console.error(`FAIL: ${label}`); }
}

// ── periodBounds ──
ok(periodBounds('2026-02').end === '2026-02-28', 'Feb leap-year-adjacent end');
ok(periodBounds('2024-02').end === '2024-02-29', 'leap Feb end');
ok(periodBounds('2026-12').end === '2026-12-31', 'Dec end');
ok(periodBounds('2026-08').start === '2026-08-01', 'Aug start');

// ── tenure gating ──
const EMPS: RunEmployeeInput[] = [
  { id: 'EMP-0001', monthly_salary: 20000, expense_account_code: '61201', hire_date: '2024-01-01', termination_date: null },
  { id: 'EMP-0002', monthly_salary: 10000, expense_account_code: '61201', hire_date: '2026-09-01', termination_date: null },      // hires after Aug
  { id: 'EMP-0003', monthly_salary: 10000, expense_account_code: '61102', hire_date: '2024-01-01', termination_date: '2026-07-31' }, // left before Aug
];

// ── computeRunItems ──
const aug = computeRunItems(EMPS, '2026-08');
ok(aug.items.length === 1, 'only in-tenure employee included');
ok(aug.totals.total_gross === 20000 && aug.totals.total_net === 19000, 'totals from survivor (EE mpf 1,000)');
ok(aug.items[0].ee_mpf === 1000 && aug.items[0].er_mpf === 1000, 'item mpf values');

const crossYear = computeRunItems([
  { id: 'A', monthly_salary: 6000, expense_account_code: '61201', hire_date: '2023-01-01', termination_date: null },
], '2026-01');
ok(crossYear.totals.total_gross === 6000 && crossYear.totals.total_er_mpf === 300 && crossYear.totals.total_ee_mpf === 0, 'below-min aggregated');

// ── transitions ──
ok(canTransition('draft', 'accrued') && canTransition('accrued', 'paid') && canTransition('paid', 'settled'), 'happy path');
ok(canTransition('draft', 'cancelled') && canTransition('accrued', 'cancelled'), 'cancellable before settlement');
ok(!canTransition('paid', 'accrued') && !canTransition('settled', 'cancelled') && !canTransition('draft', 'paid'), 'illegal hops rejected');

// ── accrual lines: per-account aggregation (61201 gross 20,000 + 61102 gross 10,000; EE/ER 1,500+750) ──
const ITEMS: RunItem[] = [
  { employee_id: 'EMP-0001', gross: 20000, ee_mpf: 1000, er_mpf: 1000, net: 19000, expense_account_code: '61201' },
  { employee_id: 'EMP-0004', gross: 10000, ee_mpf: 500, er_mpf: 500, net: 9500, expense_account_code: '61102' },
];
const TOTALS: RunTotals = { total_gross: 30000, total_ee_mpf: 1500, total_er_mpf: 1500, total_net: 28500 };
const NAMES = (code: string) => `NAME-${code}`;
const acc = buildAccrualLines(ITEMS, TOTALS, NAMES);
const drSum = acc.filter(l => l.dr).reduce((s, l) => s + l.amount, 0);
const crSum = acc.filter(l => !l.dr).reduce((s, l) => s + l.amount, 0);
ok(acc.length === 5, '5 lines: 2 salary accts + 61202 + 21204 + 21203');
ok(drSum === crSum && drSum === 31500, 'Dr = Cr = gross + ER (31,500)');
ok(acc[0].code === '61102' && acc[0].amount === 10000, 'expense lines sorted by code, 61102 first');
ok(acc[1].code === '61201' && acc[1].amount === 20000, '61201 aggregated gross');
ok(acc[2].dr && acc[2].code === '61202' && acc[2].amount === 1500, 'ER expense line');
ok(!acc[3].dr && acc[3].code === '21204' && acc[3].amount === 3000, 'MPF payable = EE+ER');
ok(!acc[4].dr && acc[4].code === '21203' && acc[4].amount === 28500, 'salary payable = net');

// zero-amount filtering: a below-min-only run drops the EE portion implicitly (21204 = ER only here)
const MIN_ITEMS: RunItem[] = [{ employee_id: 'X', gross: 6000, ee_mpf: 0, er_mpf: 300, net: 6000, expense_account_code: '61201' }];
const MIN_TOTALS: RunTotals = { total_gross: 6000, total_ee_mpf: 0, total_er_mpf: 300, total_net: 6000 };
const minAcc = buildAccrualLines(MIN_ITEMS, MIN_TOTALS, NAMES);
ok(minAcc.find(l => l.code === '21204')!.amount === 300, '21204 carries ER even when EE is 0');

// ── payment & settlement ──
const pay = buildPaymentLines(TOTALS, '11102', NAMES);
ok(pay.length === 2 && pay[0].dr && pay[0].code === '21203' && pay[0].amount === 28500, 'payment Dr 21203 net');
ok(!pay[1].dr && pay[1].code === '11102' && pay[1].amount === 28500, 'payment Cr bank net');

const set = buildSettlementLines(TOTALS, '11102', NAMES);
ok(set.length === 2 && set[0].dr && set[0].code === LIFE_CYCLE_ACCOUNTS.MPF_PAYABLE && set[0].amount === 3000, 'settlement Dr 21204 EE+ER');
ok(!set[1].dr && set[1].code === '11102' && set[1].amount === 3000, 'settlement Cr bank');

console.log(`payroll-core: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx tests/payroll-core.test.ts`
Expected: FAIL — cannot find module '../api/src/lib/payroll-core'

- [ ] **Step 3: Write minimal implementation**

```ts
// api/src/lib/payroll-core.ts
// Pure payroll run computation + journal-entry composition for /api/payroll.
import { computeMpf } from './mpf';

export interface RunEmployeeInput {
  id: string;
  monthly_salary: number;
  expense_account_code: string;
  hire_date: string;
  termination_date: string | null;
}

export interface RunItem {
  employee_id: string;
  gross: number;
  ee_mpf: number;
  er_mpf: number;
  net: number;
  expense_account_code: string;
}

export interface RunTotals {
  total_gross: number;
  total_ee_mpf: number;
  total_er_mpf: number;
  total_net: number;
}

export interface JeLineDraft {
  dr: boolean;
  code: string;
  name: string;
  amount: number;
}

export const LIFE_CYCLE_ACCOUNTS = {
  BANK_DEFAULT: '11102',
  SALARY_PAYABLE: '21203',
  MPF_PAYABLE: '21204',
  ER_MPF_EXPENSE: '61202',
} as const;

/** Last day of 'YYYY-MM' as 'YYYY-MM-DD'. */
export function periodBounds(periodMonth: string): { start: string; end: string } {
  const [y, m] = periodMonth.split('-').map(Number);
  if (!y || !m || m < 1 || m > 12) throw new Error(`Invalid period_month: ${periodMonth}`);
  const end = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
  return { start: `${periodMonth}-01`, end };
}

export function isActiveInPeriod(emp: RunEmployeeInput, start: string, end: string): boolean {
  return emp.hire_date <= end && (!emp.termination_date || emp.termination_date >= start);
}

export function computeRunItems(
  employees: RunEmployeeInput[],
  periodMonth: string,
): { items: RunItem[]; totals: RunTotals } {
  const { start, end } = periodBounds(periodMonth);
  const items: RunItem[] = [];
  let total_gross = 0, total_ee_mpf = 0, total_er_mpf = 0, total_net = 0;
  for (const emp of [...employees].sort((a, b) => a.id.localeCompare(b.id))) {
    if (!isActiveInPeriod(emp, start, end)) continue;
    const mpf = computeMpf(emp.monthly_salary);
    items.push({
      employee_id: emp.id,
      gross: emp.monthly_salary,
      ee_mpf: mpf.employee,
      er_mpf: mpf.employer,
      net: mpf.net,
      expense_account_code: emp.expense_account_code,
    });
    total_gross += emp.monthly_salary;
    total_ee_mpf += mpf.employee;
    total_er_mpf += mpf.employer;
    total_net += mpf.net;
  }
  return { items, totals: { total_gross, total_ee_mpf, total_er_mpf, total_net } };
}

// Lifecycle: draft → accrued → paid → settled; cancellable until paid.
const TRANSITIONS: Record<string, string[]> = {
  draft: ['accrued', 'cancelled'],
  accrued: ['paid', 'cancelled'],
  paid: ['settled'],
  settled: [],
  cancelled: [],
};

export type TransitionTarget = 'accrued' | 'paid' | 'settled' | 'cancelled';

export function canTransition(from: string, to: TransitionTarget): boolean {
  return (TRANSITIONS[from] || []).includes(to);
}

/** Aggregated accrual: one salary-expense line per distinct account, then ER expense, MPF payable, salary payable. */
export function buildAccrualLines(
  items: RunItem[],
  totals: RunTotals,
  accountName: (code: string) => string,
): JeLineDraft[] {
  const byAccount = new Map<string, number>();
  for (const it of items) {
    byAccount.set(it.expense_account_code, (byAccount.get(it.expense_account_code) || 0) + it.gross);
  }
  const lines: JeLineDraft[] = [...byAccount.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([code, amount]) => ({ dr: true, code, name: accountName(code), amount }));
  lines.push({ dr: true, code: LIFE_CYCLE_ACCOUNTS.ER_MPF_EXPENSE, name: accountName(LIFE_CYCLE_ACCOUNTS.ER_MPF_EXPENSE), amount: totals.total_er_mpf });
  lines.push({ dr: false, code: LIFE_CYCLE_ACCOUNTS.MPF_PAYABLE, name: accountName(LIFE_CYCLE_ACCOUNTS.MPF_PAYABLE), amount: totals.total_ee_mpf + totals.total_er_mpf });
  lines.push({ dr: false, code: LIFE_CYCLE_ACCOUNTS.SALARY_PAYABLE, name: accountName(LIFE_CYCLE_ACCOUNTS.SALARY_PAYABLE), amount: totals.total_net });
  return lines.filter((l) => l.amount !== 0);
}

export function buildPaymentLines(totals: RunTotals, bankCode: string, accountName: (code: string) => string): JeLineDraft[] {
  return [
    { dr: true, code: LIFE_CYCLE_ACCOUNTS.SALARY_PAYABLE, name: accountName(LIFE_CYCLE_ACCOUNTS.SALARY_PAYABLE), amount: totals.total_net },
    { dr: false, code: bankCode, name: accountName(bankCode), amount: totals.total_net },
  ].filter((l) => l.amount !== 0);
}

export function buildSettlementLines(totals: RunTotals, bankCode: string, accountName: (code: string) => string): JeLineDraft[] {
  const mpfTotal = totals.total_ee_mpf + totals.total_er_mpf;
  return [
    { dr: true, code: LIFE_CYCLE_ACCOUNTS.MPF_PAYABLE, name: accountName(LIFE_CYCLE_ACCOUNTS.MPF_PAYABLE), amount: mpfTotal },
    { dr: false, code: bankCode, name: accountName(bankCode), amount: mpfTotal },
  ].filter((l) => l.amount !== 0);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx tests/payroll-core.test.ts`
Expected: `payroll-core: 22 passed, 0 failed`

- [ ] **Step 5: Commit**

```bash
git add api/src/lib/payroll-core.ts tests/payroll-core.test.ts
git commit -m "feat(payroll): run computation, lifecycle guard, JE composition"
```

---

### Task 3: Database migration

**Files:**
- Create: `api/src/db/migration-payroll.sql`

**Interfaces:**
- Produces: tables `payroll_employees`, `payroll_runs`, `payroll_run_items` consumed by Tasks 4–5 SQL.

Note: do NOT merge into schema.sql (precedent: `journal_entry_snapshots` also ships as migration only). Follow the edit checks below; skipping because these are DDL files, no unit test applies.

```sql
-- api/src/db/migration-payroll.sql
CREATE TABLE IF NOT EXISTS payroll_employees (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  employee_number TEXT NOT NULL,
  name TEXT NOT NULL,
  title TEXT,
  gender TEXT CHECK (gender IN ('M','F')),
  marital_status TEXT CHECK (marital_status IN ('single','married')),
  monthly_salary REAL NOT NULL CHECK (monthly_salary >= 0),
  expense_account_code TEXT NOT NULL DEFAULT '61201',
  hire_date TEXT NOT NULL,
  termination_date TEXT,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(user_id, employee_number)
);

CREATE TABLE IF NOT EXISTS payroll_runs (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  period_month TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  total_gross REAL NOT NULL DEFAULT 0,
  total_ee_mpf REAL NOT NULL DEFAULT 0,
  total_er_mpf REAL NOT NULL DEFAULT 0,
  total_net REAL NOT NULL DEFAULT 0,
  accrual_entry_id TEXT REFERENCES journal_entries(id),
  payment_entry_id TEXT REFERENCES journal_entries(id),
  mpf_entry_id TEXT REFERENCES journal_entries(id),
  bank_account_code TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(user_id, period_month)
);

CREATE TABLE IF NOT EXISTS payroll_run_items (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES payroll_runs(id) ON DELETE CASCADE,
  employee_id TEXT NOT NULL REFERENCES payroll_employees(id),
  gross REAL NOT NULL,
  ee_mpf REAL NOT NULL,
  er_mpf REAL NOT NULL,
  net REAL NOT NULL,
  expense_account_code TEXT NOT NULL,
  UNIQUE(run_id, employee_id)
);

CREATE INDEX IF NOT EXISTS idx_payroll_employees_user ON payroll_employees(user_id, is_active);
CREATE INDEX IF NOT EXISTS idx_payroll_runs_user ON payroll_runs(user_id, period_month);
CREATE INDEX IF NOT EXISTS idx_payroll_items_run ON payroll_run_items(run_id);
```

Steps (manual task — adjust checkboxes accordingly):

- [ ] Create the file with the exact SQL above.
- [ ] Apply to LOCAL dev DB to validate syntax: `cd api && npx wrangler d1 execute opcc-crm-db --local --file=src/db/migration-payroll.sql` — Expected: success output, no errors.
- [ ] Verify tables exist: `cd api && npx wrangler d1 execute opcc-crm-db --local --command="SELECT name FROM sqlite_master WHERE name LIKE 'payroll_%'"` — Expected: all 3 tables listed.
- [ ] Apply to REMOTE/staging DB when deploying later — record (do not run) this command in the PR description: `npx wrangler d1 execute opcc-crm-db --remote --file=src/db/migration-payroll.sql`.
- [ ] Commit:

```bash
git add api/src/db/migration-payroll.sql
git commit -m "feat(db): payroll employees/runs/items tables migration"
```

---

### Task 4: Payroll API — module scaffold + employees CRUD

**Files:**
- Create: `api/src/routes/payroll.ts`
- Modify: `api/src/index.ts` (imports near line 43; mounting near line 152)
- Test: `tests/payroll-schemas.test.ts`

**Interfaces:**
- Consumes: middleware from `'../middleware/auth'` (`authMiddleware`, `bookkeeperMiddleware`); `Bindings, Variables` from `'../types'`.
- Produces:
  - `payrollRoutes` (default-named export, Hono instance) mounted at `/api/payroll`.
  - Exported for tests: `employeeCreateSchema`, `employeeUpdateSchema`, `runCreateSchema`, `markPaidSchema` (Zod schemas).
  - Route surface (all responses `{ ...rows }` JSON, errors `{ error: string }`):
    - `GET /employees`, `POST /employees`, `PATCH /employees/:id`, `DELETE /employees/:id`
    - ids use the house prefix format `` `emp-${uuidv4().slice(0, 8)}` ``
- `zValidator` import from `'@hono/zod-validator'` (house pattern, bookkeeping.ts:4).

- [ ] **Step 1: Write the failing schema tests**

```ts
// tests/payroll-schemas.test.ts
// Run: npx tsx tests/payroll-schemas.test.ts
import { employeeCreateSchema, employeeUpdateSchema, runCreateSchema, markPaidSchema } from '../api/src/routes/payroll';

let pass = 0, fail = 0;
function ok(cond: boolean, label: string) {
  if (cond) { pass++; } else { fail++; console.error(`FAIL: ${label}`); }
}

const valid = { employee_number: 'EMP-0101', name: 'Chan Siu Ming', gender: 'M' as const, marital_status: 'single' as const, monthly_salary: 18000, expense_account_code: '61201', hire_date: '2026-01-15' };

ok(employeeCreateSchema.safeParse(valid).success, 'full valid payload passes');
ok(employeeCreateSchema.safeParse({ employee_number: 'EMP-X', name: 'Y', gender: 'M', marital_status: 'single', monthly_salary: 12000, hire_date: '2026-01-01' }).success, 'defaults applied (title/account optional)');
ok(!employeeCreateSchema.safeParse({ ...valid, gender: 'X' }).success, 'bad gender rejected');
ok(!employeeCreateSchema.safeParse({ ...valid, monthly_salary: -1 }).success, 'negative salary rejected');
ok(!employeeCreateSchema.safeParse({ ...valid, hire_date: 'not-a-date' }).success, 'bad hire_date rejected');
ok(employeeUpdateSchema.safeParse({ monthly_salary: 20000 }).success, 'partial update parses');
ok(employeeUpdateSchema.safeParse({}).success, 'empty update object parses (no-op patch)');
ok(runCreateSchema.safeParse({ period_month: '2026-08' }).success, 'run create valid');
ok(!runCreateSchema.safeParse({ period_month: 'Aug 2026' }).success, 'run create rejects malformed month');
ok(markPaidSchema.safeParse({ bank_account_code: '11102' }).success, 'mark-paid valid');
ok(!markPaidSchema.safeParse({}).success, 'mark-paid requires bank_account_code');

console.log(`payroll-schemas: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx tests/payroll-schemas.test.ts`
Expected: FAIL — cannot find module '../api/src/routes/payroll'

- [ ] **Step 3: Implement module scaffold + employee routes**

```ts
// api/src/routes/payroll.ts
import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { v4 as uuidv4 } from 'uuid';
import { Bindings, Variables } from '../types';
import { authMiddleware, bookkeeperMiddleware } from '../middleware/auth';
import { findParentAccountError } from '../lib/account-guard';
import { checkPeriodOpen } from '../lib/period-guard';
import { nextManualVoucherNumber } from '../lib/manual-booking';
import { createSnapshot } from '../lib/journal-snapshots';

// ── Zod schemas (exported for tests + reuse below) ──────────────────────────
export const employeeCreateSchema = z.object({
  employee_number: z.string().min(1).max(50),
  name: z.string().min(1).max(200),
  title: z.string().max(200).optional(),
  gender: z.enum(['M', 'F']),
  marital_status: z.enum(['single', 'married']),
  monthly_salary: z.number().min(0).max(999999999),
  expense_account_code: z.string().regex(/^\d{4,6}$/).default('61201'),
  hire_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  termination_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  is_active: z.boolean().optional(),
});

export const employeeUpdateSchema = employeeCreateSchema.partial();

export const runCreateSchema = z.object({
  period_month: z.string().regex(/^\d{4}-\d{2}$/),
});

export const markPaidSchema = z.object({
  bank_account_code: z.string().regex(/^\d{4,6}$/),
});

// Copy the auditLog helper VERBATIM from api/src/routes/bookkeeping.ts:79 (same body).
async function auditLog(db: any, userId: string, action: string, entityType: string, entityId: string | null | undefined, changes?: object) {
  /* paste of bookkeeping.ts:79 body — unchanged */
}

const payroll = new Hono<{ Bindings: Bindings; Variables: Variables }>();
payroll.use('*', authMiddleware);

// ── Employees CRUD ───────────────────────────────────────────────────────────
payroll.get('/employees', async (c) => {
  const tenantId = c.get('client_user_id') || c.get('user').id;
  const rows = await c.env.DB.prepare(
    'SELECT * FROM payroll_employees WHERE user_id = ? ORDER BY is_active DESC, employee_number'
  ).bind(tenantId).all();
  return c.json(rows.results);
});

payroll.post('/employees', bookkeeperMiddleware, zValidator('json', employeeCreateSchema), async (c) => {
  const user = c.get('user');
  const tenantId = c.get('client_user_id') || user.id;
  const db = c.env.DB;
  const d = c.req.valid('json');
  const id = `emp-${uuidv4().slice(0, 8)}`;

  const dup = await db.prepare('SELECT id FROM payroll_employees WHERE user_id = ? AND employee_number = ?')
    .bind(tenantId, d.employee_number).first();
  if (dup) return c.json({ error: `Employee number ${d.employee_number} already exists` }, 409);

  await db.prepare(
    `INSERT INTO payroll_employees (id, user_id, employee_number, name, title, gender, marital_status, monthly_salary, expense_account_code, hire_date, termination_date, is_active)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(id, tenantId, d.employee_number, d.name, d.title || null, d.gender, d.marital_status, d.monthly_salary,
    d.expense_account_code, d.hire_date, d.termination_date || null, d.is_active === false ? 0 : 1).run();
  await auditLog(db, user.id, 'create', 'payroll_employee', id, { employee_number: d.employee_number });
  return c.json(await db.prepare('SELECT * FROM payroll_employees WHERE id = ?').bind(id).first(), 201);
});

payroll.patch('/employees/:id', bookkeeperMiddleware, zValidator('json', employeeUpdateSchema), async (c) => {
  const user = c.get('user');
  const tenantId = c.get('client_user_id') || user.id;
  const db = c.env.DB;
  const id = c.req.param('id');
  const existing = await db.prepare('SELECT * FROM payroll_employees WHERE id = ? AND user_id = ?').bind(id, tenantId).first();
  if (!existing) return c.json({ error: 'Employee not found' }, 404);

  const d = c.req.valid('json');
  const cur = existing as any;
  const next = {
    employee_number: d.employee_number ?? cur.employee_number,
    name: d.name ?? cur.name,
    title: d.title ?? cur.title,
    gender: d.gender ?? cur.gender,
    marital_status: d.marital_status ?? cur.marital_status,
    monthly_salary: d.monthly_salary ?? cur.monthly_salary,
    expense_account_code: d.expense_account_code ?? cur.expense_account_code,
    hire_date: d.hire_date ?? cur.hire_date,
    termination_date: d.termination_date === undefined ? cur.termination_date : d.termination_date,
    is_active: d.is_active === undefined ? cur.is_active : (d.is_active ? 1 : 0),
  };
  if (next.employee_number !== cur.employee_number) {
    const dup = await db.prepare('SELECT id FROM payroll_employees WHERE user_id = ? AND employee_number = ? AND id != ?')
      .bind(tenantId, next.employee_number, id).first();
    if (dup) return c.json({ error: `Employee number ${next.employee_number} already exists` }, 409);
  }
  await db.prepare(
    `UPDATE payroll_employees SET employee_number=?, name=?, title=?, gender=?, marital_status=?, monthly_salary=?, expense_account_code=?, hire_date=?, termination_date=?, is_active=?, updated_at=datetime('now') WHERE id=? AND user_id=?`
  ).bind(next.employee_number, next.name, next.title, next.gender, next.marital_status, next.monthly_salary,
    next.expense_account_code, next.hire_date, next.termination_date, next.is_active, id, tenantId).run();
  await auditLog(db, user.id, 'update', 'payroll_employee', id, { changed: Object.keys(d) });
  return c.json(await db.prepare('SELECT * FROM payroll_employees WHERE id = ?').bind(id).first());
});

payroll.delete('/employees/:id', bookkeeperMiddleware, async (c) => {
  const user = c.get('user');
  const tenantId = c.get('client_user_id') || user.id;
  const db = c.env.DB;
  const id = c.req.param('id');
  const existing = await db.prepare('SELECT * FROM payroll_employees WHERE id = ? AND user_id = ?').bind(id, tenantId).first();
  if (!existing) return c.json({ error: 'Employee not found' }, 404);
  const ref = await db.prepare('SELECT id FROM payroll_run_items WHERE employee_id = ? LIMIT 1').bind(id).first();
  if (ref) return c.json({ error: 'Employee has payroll history; deactivate instead (is_active=false)' }, 409);
  await db.prepare('DELETE FROM payroll_employees WHERE id = ? AND user_id = ?').bind(id, tenantId).run();
  await auditLog(db, user.id, 'delete', 'payroll_employee', id, { employee_number: (existing as any).employee_number });
  return c.json({ success: true });
});

export default payroll;
```

Then wire into `api/src/index.ts`:

```ts
// with the other route imports (alphabetical position near line 36):
import { payrollRoutesPlaceholderDoNotUse } from './routes/payroll'; // WRONG NAME — see below
```

Use exactly this (name comes from the module's default export binding at import site):

```ts
import payrollRoutes from './routes/payroll';
// …in the Routes section around line 155:
app.route('/api/payroll', payrollRoutes);
```

- [ ] **Step 4: Run the schema tests to green**

Run: `npx tsx tests/payroll-schemas.test.ts`
Expected: `payroll-schemas: 11 passed, 0 failed`

Note: importing the route module under tsx pulls in `hono`, `../types` — verified type-only imports compile under tsx; if `../types` imports cloudflare types that break runtime, move `Bindings/Variables` types behind a `import type` (they already are types — ensure `import type` is used) and re-run.

- [ ] **Step 5: Typecheck**

Run: `cd api && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add api/src/routes/payroll.ts api/src/index.ts tests/payroll-schemas.test.ts
git commit -m "feat(payroll): /api/payroll module with employees CRUD"
```

---

### Task 5: Payroll API — runs lifecycle (preview/create/accrual/paid/settled/void)

**Files:**
- Modify: `api/src/routes/payroll.ts` (append sections; imports extended)
- Test: extends `tests/payroll-schemas.test.ts` (add transition cases here) — but real coverage came in Task 2 for pure logic; this task adds an integration smoke script `tests/payroll-routes-smoke.ts` that boots the router with a mocked `env.DB` is NOT feasible cheaply — instead verification is (a) unit green from Task 2, (b) typecheck, (c) live smoke documented below.

**Interfaces:**
- Consumes: Task 2 `computeRunItems`, `canTransition`, `build*Lines`, `LIFE_CYCLE_ACCOUNTS`; Task 4 scaffolding.
- Produces routes:
  - `GET /runs` → array of runs (sans secrets) ordered `period_month DESC`
  - `GET /runs/:id` → run + `items[]` (+ per-line JE summaries via linked entry ids)
  - `GET /runs/preview?period=YYYY-MM` → `{ items, totals, accrual_lines }` computed live (needs valid COA names)
  - `GET /bank-accounts` → candidate bank/asset accounts `[{ account_code, account_name }]` (`account_code LIKE '11%'`)
  - `POST /runs` `{ period_month }` → creates run + snapshot items (status `draft`); 409 if an un-cancelled run exists for the period; 409 if zero eligible items
  - `POST /runs/:id/post-accrual` → posts accrual JE (entry_date = month-end), stores `accrual_entry_id`, status `accrued`
  - `POST /runs/:id/mark-paid` `{ bank_account_code }` → validates bank acct active+leaf, posts payment JE (entry_date = today), stores `payment_entry_id` + `bank_account_code`, status `paid`
  - `POST /runs/:id/mark-mpf-settled` → posts settlement JE (entry_date = today, same bank), stores `mpf_entry_id`, status `settled`
  - `POST /runs/:id/void` → reverse-inserts opposite JEs for every stored entry id (number `XXX-REV`, like bookkeeping.ts:424-460), status `cancelled`
- All JE inserts carry `reference_type='payroll'`, `reference_id=<run id>`, `entry_source='manual'`, voucher via `nextManualVoucherNumber(db, tenantId, entryDate)`, `createSnapshot(...)` after insert. Posting requires `checkPeriodOpen`; account codes validated active in COA + `findParentAccountError` leaf guard.

The following task-local helpers make the route additions compact — implement them verbatim at top of the runs section:

```ts
// inside api/src/routes/payroll.ts (runs section)
import { computeRunItems, buildAccrualLines, buildPaymentLines, buildSettlementLines, canTransition, periodBounds, LIFE_CYCLE_ACCOUNTS, type RunEmployeeInput, type JeLineDraft, type TransitionTarget } from '../lib/payroll-core';

async function loadAccountNames(db: any, tenantId: string): Promise<Map<string, string>> {
  const rows = await db.prepare("SELECT account_code, account_name FROM accounts WHERE user_id = ? AND is_active = 1")
    .bind(tenantId).all();
  return new Map((rows.results as any[]).map((r) => [r.account_code, r.account_name]));
}

async function assertAccountsPostable(db: any, tenantId: string, codes: string[]): Promise<string | null> {
  const uniq = [...new Set(codes)];
  const rows = await db.prepare(
    `SELECT account_code FROM accounts WHERE user_id = ? AND is_active = 1 AND account_code IN (${uniq.map(() => '?').join(',')})`
  ).bind(tenantId, ...uniq).all();
  const have = new Set((rows.results as any[]).map((r) => r.account_code));
  const missing = uniq.filter((cde) => !have.has(cde));
  if (missing.length > 0) return `Account code(s) not found: ${missing.join(', ')}`;
  for (const cde of uniq) {
    const guardError = await findParentAccountError(db, tenantId, cde);
    if (guardError) return guardError;
  }
  return null;
}

async function insertPostedEntry(
  db: any, tenantId: string, user: any, entryDate: string, description: string,
  referenceId: string, lines: JeLineDraft[],
): Promise<string> {
  const err = await assertAccountsPostable(db, tenantId, lines.map((l) => l.code));
  if (err) throw Object.assign(new Error(err), { status: 400 });
  if (!(await checkPeriodOpen(db, tenantId, entryDate)))
    throw Object.assign(new Error('Cannot post in a closed period'), { status: 400 });
  const drSum = lines.filter(l => l.dr).reduce((s, l) => s + l.amount, 0);
  const crSum = lines.filter(l => !l.dr).reduce((s, l) => s + l.amount, 0);
  if (Math.abs(drSum - crSum) > 0.001) throw Object.assign(new Error('Debits must equal credits'), { status: 500 });

  const id = `je-${uuidv4().slice(0, 8)}`;
  const entryNumber = await nextManualVoucherNumber(db, tenantId, entryDate);
  await db.prepare(
    'INSERT INTO journal_entries (id, user_id, entry_number, entry_date, description, reference_type, reference_id, entry_source, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).bind(id, tenantId, entryNumber, entryDate, description, 'payroll', referenceId, 'manual',
    JSON.stringify({ id: user.id, name: user.name, email: user.email })).run();
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    await db.prepare(
      // NOTE: deliberately NO `project` column (absent in live D1)
      'INSERT INTO journal_lines (id, entry_id, account_code, account_name, debit, credit, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).bind(`jl-${uuidv4().slice(0, 8)}`, id, l.code, l.name, l.dr ? l.amount : 0, l.dr ? 0 : l.amount, i).run();
  }
  await createSnapshot(db, tenantId, id, 'create');
  await auditLog(db, user.id, 'create', 'journal_entry', id, { entry_number: entryNumber, description, payroll_run: referenceId });
  return id;
}

async function transitionOrFail(c: any, runId: string, target: TransitionTarget) {
  const tenantId = c.get('client_user_id') || c.get('user').id;
  const run = await c.env.DB.prepare('SELECT * FROM payroll_runs WHERE id = ? AND user_id = ?').bind(runId, tenantId).first();
  if (!run) { c.json({ error: 'Run not found' }, 404); return null; }
  if (!canTransition((run as any).status, target)) {
    c.json({ error: `Cannot move run from '${(run as any).status}' to '${target}'` }, 409);
    return null;
  }
  return run as any;
}
```

- [ ] **Step 1: Append the runs routes** (after employees section, before `export default payroll;`), implementing exactly the interface above. Key handler sketches to flesh out verbatim:

```ts
payroll.get('/bank-accounts', async (c) => {
  const tenantId = c.get('client_user_id') || c.get('user').id;
  const rows = await c.env.DB.prepare(
    "SELECT account_code, account_name FROM accounts WHERE user_id = ? AND is_active = 1 AND account_code LIKE '11%' ORDER BY account_code LIMIT 50"
  ).bind(tenantId).all();
  return c.json(rows.results);
});

payroll.get('/runs', async (c) => {
  const tenantId = c.get('client_user_id') || c.get('user').id;
  const rows = await c.env.DB.prepare('SELECT * FROM payroll_runs WHERE user_id = ? ORDER BY period_month DESC, created_at DESC')
    .bind(tenantId).all();
  return c.json(rows.results);
});

payroll.get('/runs/preview', async (c) => {
  const tenantId = c.get('client_user_id') || c.get('user').id;
  const period = c.req.query('period') || '';
  if (!/^\d{4}-\d{2}$/.test(period)) return c.json({ error: 'period must be YYYY-MM' }, 400);
  const names = await loadAccountNames(c.env.DB, tenantId);
  const accountName = (code: string) => names.get(code) || code;
  const emps = await c.env.DB.prepare(
    'SELECT id, monthly_salary, expense_account_code, hire_date, termination_date FROM payroll_employees WHERE user_id = ? AND is_active = 1'
  ).bind(tenantId).all();
  const { items, totals } = computeRunItems(emps.results as RunEmployeeInput[], period);
  return c.json({
    items, totals,
    accrual_lines: items.length ? buildAccrualLines(items, totals, accountName) : [],
  });
});

payroll.post('/runs', bookkeeperMiddleware, zValidator('json', runCreateSchema), async (c) => {
  const user = c.get('user');
  const tenantId = c.get('client_user_id') || user.id;
  const db = c.env.DB;
  const { period_month } = c.req.valid('json');
  const existing = await db.prepare("SELECT id, status FROM payroll_runs WHERE user_id = ? AND period_month = ?")
    .bind(tenantId, period_month).first();
  if (existing && (existing as any).status !== 'cancelled')
    return c.json({ error: `Run for ${period_month} already exists (${(existing as any).status})` }, 409);

  const emps = await db.prepare(
    'SELECT id, monthly_salary, expense_account_code, hire_date, termination_date FROM payroll_employees WHERE user_id = ? AND is_active = 1'
  ).bind(tenantId).all();
  const { items, totals } = computeRunItems(emps.results as RunEmployeeInput[], period_month);
  if (items.length === 0) return c.json({ error: 'No active employees are in-tenure for this period' }, 409);

  const id = `pr-${uuidv4().slice(0, 8)}`;
  await db.batch([
    db.prepare(
      'INSERT INTO payroll_runs (id, user_id, period_month, status, total_gross, total_ee_mpf, total_er_mpf, total_net, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).bind(id, tenantId, period_month, 'draft', totals.total_gross, totals.total_ee_mpf, totals.total_er_mpf, totals.total_net,
      JSON.stringify({ id: user.id, name: user.name, email: user.email })),
    ...items.map((it) => db.prepare(
      'INSERT INTO payroll_run_items (id, run_id, employee_id, gross, ee_mpf, er_mpf, net, expense_account_code) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    ).bind(`pri-${uuidv4().slice(0, 8)}`, id, it.employee_id, it.gross, it.ee_mpf, it.er_mpf, it.net, it.expense_account_code)),
  ]);
  await auditLog(db, user.id, 'create', 'payroll_run', id, { period_month, items: items.length });
  return c.json(await db.prepare('SELECT * FROM payroll_runs WHERE id = ?').bind(id).first(), 201);
});

payroll.get('/runs/:id', async (c) => {
  const tenantId = c.get('client_user_id') || c.get('user').id;
  const run = await c.env.DB.prepare('SELECT * FROM payroll_runs WHERE id = ? AND user_id = ?')
    .bind(c.req.param('id'), tenantId).first() as any;
  if (!run) return c.json({ error: 'Run not found' }, 404);
  const items = await c.env.DB.prepare(`
    SELECT pri.*, pe.name AS employee_name, pe.employee_number
    FROM payroll_run_items pri JOIN payroll_employees pe ON pe.id = pri.employee_id
    WHERE pri.run_id = ? ORDER BY pe.employee_number`).bind(run.id).all();
  const entries = run.accrual_entry_id || run.payment_entry_id || run.mpf_entry_id
    ? await c.env.DB.prepare(
        `SELECT id, entry_number, entry_date, description, status, deleted_at FROM journal_entries WHERE id IN (${[run.accrual_entry_id, run.payment_entry_id, run.mpf_entry_id].filter(Boolean).map(() => '?').join(',')})`
      ).bind(...[run.accrual_entry_id, run.payment_entry_id, run.mpf_entry_id].filter(Boolean)).all()
    : { results: [] };
  return c.json({ ...run, items: items.results, linked_entries: entries.results });
});
```

For `post-accrual` / `mark-paid` / `mark-mpf-settled` / `void`, the shape is: load run via `transitionOrFail`; wrap mutation in try/catch mapping `(err as any).status||500` → `c.json({ error: err.message }, status)`; on success `UPDATE payroll_runs SET status=?, <entry_id_column>=?, updated_at=datetime('now') WHERE id=?`.

```ts
payroll.post('/runs/:id/post-accrual', bookkeeperMiddleware, async (c) => {
  const run = await transitionOrFail(c, c.req.param('id'), 'accrued');
  if (!run) return;
  const user = c.get('user'); const tenantId = c.get('client_user_id') || user.id; const db = c.env.DB;
  try {
    const { period_month, total_gross, total_ee_mpf, total_er_mpf, total_net } = run;
    const items = await db.prepare('SELECT * FROM payroll_run_items WHERE run_id = ? ORDER BY employee_id').bind(run.id).all();
    const names = await loadAccountNames(db, tenantId);
    const lines = buildAccrualLines(items.results as any[], { total_gross, total_ee_mpf, total_er_mpf, total_net },
      (code) => names.get(code) || code);
    const entryId = await insertPostedEntry(db, tenantId, user, periodBounds(period_month).end,
      `Payroll ${period_month} accrual`, run.id, lines);
    await db.prepare("UPDATE payroll_runs SET status='accrued', accrual_entry_id=?, updated_at=datetime('now') WHERE id=?").bind(entryId, run.id).run();
    return c.json({ success: true, status: 'accrued', accrual_entry_id: entryId });
  } catch (err: any) { return c.json({ error: err.message }, err.status || 500); }
});

payroll.post('/runs/:id/mark-paid', bookkeeperMiddleware, zValidator('json', markPaidSchema), async (c) => {
  const run = await transitionOrFail(c, c.req.param('id'), 'paid');
  if (!run) return;
  const user = c.get('user'); const tenantId = c.get('client_user_id') || user.id; const db = c.env.DB;
  try {
    const { bank_account_code } = c.req.valid('json');
    const totals = { total_gross: run.total_gross, total_ee_mpf: run.total_ee_mpf, total_er_mpf: run.total_er_mpf, total_net: run.total_net };
    const names = await loadAccountNames(db, tenantId);
    const lines = buildPaymentLines(totals, bank_account_code, (code) => names.get(code) || code);
    const today = new Date().toISOString().split('T')[0];
    const entryId = await insertPostedEntry(db, tenantId, user, today, `Payroll ${run.period_month} salary payment`, run.id, lines);
    await db.prepare("UPDATE payroll_runs SET status='paid', payment_entry_id=?, bank_account_code=?, updated_at=datetime('now') WHERE id=?")
      .bind(entryId, bank_account_code, run.id).run();
    return c.json({ success: true, status: 'paid', payment_entry_id: entryId });
  } catch (err: any) { return c.json({ error: err.message }, err.status || 500); }
});

payroll.post('/runs/:id/mark-mpf-settled', bookkeeperMiddleware, async (c) => {
  const run = await transitionOrFail(c, c.req.param('id'), 'settled');
  if (!run) return;
  const user = c.get('user'); const tenantId = c.get('client_user_id') || user.id; const db = c.env.DB;
  try {
    const bank = run.bank_account_code || LIFE_CYCLE_ACCOUNTS.BANK_DEFAULT;
    const totals = { total_gross: run.total_gross, total_ee_mpf: run.total_ee_mpf, total_er_mpf: run.total_er_mpf, total_net: run.total_net };
    const names = await loadAccountNames(db, tenantId);
    const lines = buildSettlementLines(totals, bank, (code) => names.get(code) || code);
    const today = new Date().toISOString().split('T')[0];
    const entryId = await insertPostedEntry(db, tenantId, user, today, `Payroll ${run.period_month} MPF remittance`, run.id, lines);
    await db.prepare("UPDATE payroll_runs SET status='settled', mpf_entry_id=?, updated_at=datetime('now') WHERE id=?").bind(entryId, run.id).run();
    return c.json({ success: true, status: 'settled', mpf_entry_id: entryId });
  } catch (err: any) { return c.json({ error: err.message }, err.status || 500); }
});

payroll.post('/runs/:id/void', bookkeeperMiddleware, async (c) => {
  const run = await transitionOrFail(c, c.req.param('id'), 'cancelled');
  if (!run) return;
  const user = c.get('user'); const tenantId = c.get('client_user_id') || user.id; const db = c.env.DB;
  try {
    const today = new Date().toISOString().split('T')[0];
    if (!(await checkPeriodOpen(db, tenantId, today))) return c.json({ error: 'Cannot void in a closed period' }, 400);
    const entryIds = [run.accrual_entry_id, run.payment_entry_id, run.mpf_entry_id].filter(Boolean) as string[];
    for (const originalId of entryIds) {
      const entry = await db.prepare('SELECT * FROM journal_entries WHERE id = ? AND user_id = ?').bind(originalId, tenantId).first() as any;
      if (!entry || entry.deleted_at) continue;
      const revLines = await db.prepare('SELECT * FROM journal_lines WHERE entry_id = ? ORDER BY sort_order').bind(originalId).all();
      const revId = `je-${uuidv4().slice(0, 8)}`;
      await db.prepare(
        'INSERT INTO journal_entries (id, user_id, entry_number, entry_date, description, reference_type, reference_id, entry_source, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
      ).bind(revId, tenantId, `${entry.entry_number}-REV`, today, `Reversal: ${entry.description}`, 'payroll', run.id, 'manual',
        JSON.stringify({ id: user.id, name: user.name, email: user.email })).run();
      for (let i = 0; i < (revLines.results as any[]).length; i++) {
        const l = (revLines.results as any[])[i];
        await db.prepare(
          'INSERT INTO journal_lines (id, entry_id, account_code, account_name, debit, credit, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?)'
        ).bind(`jl-${uuidv4().slice(0, 8)}`, revId, l.account_code, l.account_name, l.credit, l.debit, i).run(); // swapped
      }
      await createSnapshot(db, tenantId, revId, 'create');
      await db.prepare("UPDATE journal_entries SET status='draft', updated_at=datetime('now') WHERE id=?").bind(revId).run();
      await db.prepare("UPDATE journal_entries SET deleted_at=datetime('now'), updated_at=datetime('now') WHERE id=?").bind(originalId).run();
    }
    await db.prepare("UPDATE payroll_runs SET status='cancelled', updated_at=datetime('now') WHERE id=?").bind(run.id).run();
    await auditLog(db, user.id, 'void', 'payroll_run', run.id, { reversed_entries: entryIds.length });
    return c.json({ success: true, status: 'cancelled' });
  } catch (err: any) { return c.json({ error: err.message }, err.status || 500); }
});
```

Semantics note (intentional, matches GJE conventions): reversals arrive as status `draft` (`insertPostedEntry` isn't reused because reversal swaps debit/credit pairs wholesale and tombstones the original immediately, keeping financial figures stable while preserving an auditable trail).

- [ ] **Step 2: Extend `tests/payroll-schemas.test.ts` with lifecycle cases**

```ts
// append to tests/payroll-schemas.test.ts before the summary print
import { canTransition } from '../api/src/lib/payroll-core';
ok(!canTransition('paid', 'cancelled'), 'void refused once paid+settled-next only');
ok(canTransition('accrued', 'cancelled'), 'void allowed while merely accrued');
```

- [ ] **Step 3: Run tests + typecheck**

Run: `npx tsx tests/payroll-schemas.test.ts && npx tsx tests/payroll-core.test.ts && npx tsx tests/payroll-mpf.test.ts`
Expected: all suites print `0 failed`.

Run: `cd api && npx tsc --noEmit` — Expected: clean.

- [ ] **Step 4: Live smoke (manual, documented)**

With `npm run dev` running and a logged-in session holding a valid token, hit:
`GET /api/payroll/employees` → `[]` (or existing rows), `GET /api/payroll/runs` → `[]`.
Record results in the task report; fix wiring issues (mount path, middleware order) if 404/401.

- [ ] **Step 5: Commit**

```bash
git add api/src/routes/payroll.ts tests/payroll-schemas.test.ts
git commit -m "feat(payroll): run lifecycle endpoints posting payroll journals"
```

---

### Task 6: Frontend — split page into shell + demo view (behavior preserved)

**Files:**
- Create: `frontend/src/pages/payroll/shared.tsx`
- Create: `frontend/src/pages/payroll/DemoPayroll.tsx`
- Modify: `frontend/src/pages/Payroll.tsx` (becomes the shell; rewrite)
- Test: existing `tests/payroll-demo.spec.ts` must stay green (it asserts the demo experience at default mode).

**Interfaces:**
- Produces:
  - `shared.tsx` exports `fmt(n: number): string`, `num(n: number): string`, `SummaryCard({ label, value })`, and `JeBlockView({ block }: { block: { id: string; title: string; titleZh: string; titleCn: string; lines: { dr: boolean; code: string; name: string; nameZh?: string; nameCn?: string; amount: number }[]; total: number } })` — pixel-identical markup to current JeBlocks inner block (source: current `Payroll.tsx:39-71`).
  - `DemoPayroll` default-exports the staff-table card (current lines 191-247) with `DetailPanel`/`MonthRow`/demo helpers moved verbatim, minus page header (shell owns it) and minus the demo chip (shell owns it).
  - Shell `Payroll.tsx` owns: title, subtitle, chip (demo mode only), ModeToggle, view switching.

- [ ] **Step 1: Create `frontend/src/pages/payroll/shared.tsx`** — move `fmt`, `num`, `SummaryCard`, and convert `JeBlocks` into single-block `JeBlockView` accepting a generic block (copy JSX verbatim from current Payroll.tsx lines 30-37 and 43-68; render lines as `{tr(l.name, l.nameZh || '', l.nameCn || '')}` so real-view bilingual names work). Demo maps its two blocks via a thin wrapper staying in DemoPayroll.

- [ ] **Step 2: Create `DemoPayroll.tsx`** — move everything else from current `Payroll.tsx` verbatim (imports adjusted: `GENDER_LABEL`, `MARITAL_LABEL`, `MONTH_LABELS_EN`, `STATUS_META`, `MonthRow`, `DetailPanel` stay file-local; `JeBlocks` becomes local wrapper calling `JeBlockView` twice with demo `COA_ACCOUNTS` lookups producing `{ code, name, nameZh, nameCn, amount, dr }` lines). Delete nothing user-visible.

- [ ] **Step 3: Rewrite shell `Payroll.tsx`**

```tsx
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { tr } from '../lib/i18nHelpers';
import { cn } from '../lib/utils';
import DemoPayroll from './payroll/DemoPayroll';

type PayrollMode = 'demo' | 'real';
const MODE_KEY = 'payroll.mode';

export default function Payroll() {
  useTranslation();
  const [mode, setMode] = useState<PayrollMode>(() =>
    localStorage.getItem(MODE_KEY) === 'real' ? 'real' : 'demo');
  useEffect(() => { localStorage.setItem(MODE_KEY, mode); }, [mode]);

  return (
    <div className="space-y-6">
      {/* Page header */}
      <div className="flex items-center gap-3 flex-wrap">
        <div>
          <h2 className="text-2xl font-bold">{tr('Payroll', '薪資', '薪资')}</h2>
          <p className="text-muted-foreground mt-1">
            {mode === 'demo'
              ? tr('Sample payroll for demonstration.', '薪資演示樣本。', '薪资演示样本。')
              : tr('Manage employees and monthly payroll runs.', '管理員工與每月薪酬運行。', '管理员工与每月薪酬运行。')}
          </p>
        </div>
        {mode === 'demo' && (
          <span className="text-[11px] font-medium px-2 py-0.5 rounded-full bg-amber-500/10 text-amber-600 dark:text-amber-400">
            {tr('Demo data', '演示數據', '演示数据')}
          </span>
        )}
        <div className="ml-auto flex rounded-full border p-0.5 text-xs font-medium" style={{ borderColor: 'hsl(var(--border))' }}>
          {([['demo', 'Demo data', '演示數據', '演示数据'], ['real', 'Real data', '實際資料', '实际资料']] as const).map(([m, en, zh, cn]) => (
            <button key={m} onClick={() => setMode(m)}
              className={cn('px-3 py-1 rounded-full transition-colors',
                mode === m ? 'bg-primary text-primary-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground')}>
              {tr(en, zh, cn)}
            </button>
          ))}
        </div>
      </div>

      {mode === 'demo' ? <DemoPayroll /> : null /* Task 7 swaps in RealPayroll */}
    </div>
  );
}
```

Keep the `<style>` slide-in keyframes tag inside `DemoPayroll` root (moved along with the card).

- [ ] **Step 4: Verify demo unchanged**

Run: `npx playwright test payroll-demo` (root; uses deployed BASE URL default)
Expected: PASS (toggle defaults to demo, so selectors match).

Also: `cd frontend && npx tsc -b --noEmit` — clean.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/pages/Payroll.tsx frontend/src/pages/payroll/
git commit -m "refactor(payroll): shell with demo/real toggle, demo view extracted"
```

---

### Task 7: Frontend — Real payroll view (employees + runs + lifecycle actions)

**Files:**
- Create: `frontend/src/pages/payroll/RealPayroll.tsx`
- Modify: `frontend/src/pages/Payroll.tsx` (one-line swap of the `null` branch + import)
- Modify: `tests/payroll-demo.spec.ts` — NO changes (default demo).

**Interfaces:**
- Consumes: all `/api/payroll` routes from Tasks 4-5 via house helper `api(path, options)` from `src/lib/api` (auto-token/X-Active-Client headers); `SlidePanel` from `../../components/SlidePanel` (props per existing usage in repo); React Query (`useQuery`, `useMutation`, `useQueryClient` from `@tanstack/react-query` — app already provides QueryClientProvider); Task 6 `shared.tsx` (`fmt`, `num`, `SummaryCard`, `JeBlockView`); `computeMpf` from `../../lib/mpf` for per-employee preview in the employees table.
- Produces: `RealPayroll` default export with three cards: Employees (list + add/edit panel), Runs (month list, badges), Run detail (items + 3 JeBlockViews + action buttons).

Data types (mirror API):

```ts
interface PayrollEmployee { id: string; employee_number: string; name: string; title: string | null; gender: 'M'|'F'; marital_status: 'single'|'married'; monthly_salary: number; expense_account_code: string; hire_date: string; termination_date: string | null; is_active: number; }
interface RunItemRow { employee_id: string; employee_number: string; employee_name: string; gross: number; ee_mpf: number; er_mpf: number; net: number; expense_account_code: string; }
interface PayrollRun { id: string; period_month: string; status: 'draft'|'accrued'|'paid'|'settled'|'cancelled'; total_gross: number; total_ee_mpf: number; total_er_mpf: number; total_net: number; bank_account_code: string | null; linked_entries?: { id: string; entry_number: string; entry_date: string; description: string; status: string }[]; }
```

REAL_COA mirror (bilingual labels for JeBlockView; copy pattern from `samplePayroll.ts:43-50`, adding 21203 which that file lacks):

```ts
const REAL_COA: Record<string, { code: string; name: string; nameZh: string; nameCn: string }> = {
  '11102': { code: '11102', name: 'HSBC', nameZh: '滙豐銀行', nameCn: '汇丰银行' },
  '21203': { code: '21203', name: 'Salary Payable', nameZh: '薪酬應付', nameCn: '薪酬应付' },
  '21204': { code: '21204', name: 'MPF Payable', nameZh: '應付強積金', nameCn: '应付强积金' },
  '51201': { code: '51201', name: 'Project Staff Salary', nameZh: '項目人員薪酬', nameCn: '项目人员薪酬' },
  '61102': { code: '61102', name: 'Management Salary', nameZh: '管理層薪酬', nameCn: '管理层薪酬' },
  '61201': { code: '61201', name: 'Staff Salaries', nameZh: '員工薪酬', nameCn: '员工薪酬' },
  '61202': { code: '61202', name: 'MPF Employer Contribution', nameZh: '強積金僱主供款', nameCn: '强积金雇主供款' },
};
const FALLBACK_NAME = (code: string) => ({ code, name: code, nameZh: code, nameCn: code });
```

RUN_STATUS_META (badge classes reuse demo palette per spec):

```ts
const RUN_STATUS_META: Record<PayrollRun['status'], { cls: string; en: string; zh: string; cn: string }> = {
  draft:     { cls: 'bg-gray-400/10 text-gray-500 dark:text-gray-400', en: 'Draft', zh: '草稿', cn: '草稿' },
  accrued:   { cls: 'bg-amber-500/10 text-amber-600 dark:text-amber-400', en: 'Accrued', zh: '已計提', cn: '已计提' },
  paid:      { cls: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400', en: 'Paid', zh: '已支付', cn: '已支付' },
  settled:   { cls: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400', en: 'MPF Settled', zh: '強積金已繳', cn: '强积金已缴' },
  cancelled: { cls: 'bg-gray-400/10 text-gray-500 dark:text-gray-400 line-through', en: 'Cancelled', zh: '已取消', cn: '已取消' },
};
```

- [ ] **Step 1: Build `RealPayroll.tsx`** with these sections (concrete code contract; write full JSX in house style — spacing/border/icon conventions copied from current Payroll.tsx):

1. Queries: `['payroll-employees']` → `api('/payroll/employees')`; `['payroll-runs']` → `api('/payroll/runs')`; `['payroll-banks']` → `api('/payroll/bank-accounts')`; selected-run detail `enabled: !!selectedRunId` → `api('/payroll/runs/' + selectedRunId)`.
2. Mutations (each on success invalidates touched keys): `createEmployee` (POST), `updateEmployee` (PATCH), `deleteEmployee` (DELETE w/ `window.confirm(tr(...))` fallback message shown via toast-less inline error text on 409), `previewRun` via `useQuery(['payroll-preview', selMonth])` enabled when month picked; `createRun` (POST /runs) → select new run; `postAccrual`, `markPaid(bank)`, `markMpfSettled`, `voidRun`. Mutations call `api(..., { method, body })`; on non-OK throw with parsed `{error}` so React Query surfaces message; render `mutation.error?.message` inline under buttons in red text-xs.
3. Employees card: header row with count + "Add employee" button (lucide `Plus`); grid columns match demo `[minmax(0,1fr)_90px_70px_90px_130px]` but last col = Salary + inline edit pencil (opens panel); inactive rows dimmed `opacity-50` + `Inactive 已停用` mini-badge; avatar initials circle identical to demo lines 214-216.
4. Employee slide panel form (controlled state, one field per row, all labels trilingual): employee_number (text), name (text), title (text optional), gender `<select>` M/F, marital_status `<select>`, monthly_salary `<input type="number">`, expense_account_code `<select>` with the 3 legal salary accounts (`51201/61102/61201` labeled via REAL_COA), hire_date `<input type="date">`, termination_date `<input type="date">` optional, is_active checkbox (edit mode only). Footer: Cancel + Save buttons; Save disabled while mutation pending.
5. Runs card: month `<input type="month">` + Preview button showing returned totals as four `SummaryCard`s and a read-only `JeBlockView` of `accrual_lines` (names via REAL_COA fallback), then "Create run" primary button (disabled when mutation pending or items 0). Below: run rows (`period_month` mono + RUN_STATUS_META badge + right-aligned totals chevron accordion mirroring MonthRow affordance).
6. Run detail (expanded inside its row): items table (Employee | Gross | EE MPF | ER MPF | Net right-aligned mono columns), totals footer bold; then three staged JeBlockViews rendered client-side by transforming server data exactly as Task 2 defines (Accrual lines when status ≥ draft from items; Payment/Settlement blocks greyed-out previews with `opacity-40 pointer-events-none` until their stage is active; posted stages show entry_number caption line). Action bar under blocks per stage: draft→primary `Confirm & post accrual 確認並過賬計提 确认并过账计提`; accrued→bank `<select>` (from `['payroll-banks']`, default 11102) + `Mark paid 標記已支付 标记已支付`; paid→`Mark MPF settled 標記強積金已繳 标记强积金已缴`; draft|accrued additionally offer subtle destructive `Void 作廢 作废` with confirm dialog; settled/cancelled show nothing but linked voucher numbers.

- [ ] **Step 2: Wire the shell** — in `Payroll.tsx` replace the `{mode === 'demo' ? <DemoPayroll /> : null}` branch:

```tsx
import RealPayroll from './payroll/RealPayroll';
// ...
{mode === 'demo' ? <DemoPayroll /> : <RealPayroll />}
```

- [ ] **Step 3: Typecheck + build**

Run: `cd frontend && npx tsc -b --noEmit`
Expected: clean.

Run: `npx playwright test payroll-demo`
Expected: PASS (demo unaffected).

- [ ] **Step 4: Commit**

```bash
git add frontend/src/pages/payroll/RealPayroll.tsx frontend/src/pages/Payroll.tsx
git commit -m "feat(payroll): real-data view with employees, runs and GL posting actions"
```

---

### Task 8: E2E coverage for the toggle + real view smoke

**Files:**
- Create: `tests/payroll-real.spec.ts`

**Interfaces:**
- Consumes: login pattern + BASE from `tests/payroll-demo.spec.ts:3-14`.

- [ ] **Step 1: Write the spec**

```ts
import { test, expect, type Page } from '@playwright/test';

const BASE = process.env.TEST_BASE_URL || 'https://opcc-crm-testing.pages.dev';
const EMAIL = 'muhammadruhan.farhan25@gmail.com';
const PASSWORD = 'Ruhan123';

async function login(page: Page) {
  await page.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
  await page.fill('input[type="email"]', EMAIL);
  await page.fill('input[type="password"]', PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForFunction(() => !window.location.href.includes('/login'), { timeout: 20000 });
}

test('payroll toggle: demo default intact, real view renders', async ({ page }) => {
  await login(page);
  // Fresh context → localStorage empty → demo default
  await page.goto(`${BASE}/payroll`, { waitUntil: 'networkidle' });
  await expect(page.locator('button', { hasText: /EMP-00/ }).filter({ visible: true }).first()).toBeVisible();

  // Toggle → Real
  await page.getByText(/Real data|實際資料|实际资料/).first().click();
  await expect(page.getByText(/Add employee|新增員工|新增员工/).first()).toBeVisible();
  // Demo chip hidden in real mode
  await expect(page.getByText(/Demo data|演示數據|演示数据/).filter({ visible: true })).toHaveCount(0);
  await page.screenshot({ path: 'test-results/payroll-real.png', fullPage: true });

  // Persistence across reload
  await page.reload({ waitUntil: 'networkidle' });
  await expect(page.getByText(/Add employee|新增員工|新增员工/).first()).toBeVisible();

  // Back to demo restores demo view (chip returns)
  await page.getByText(/Demo data|演示數據|演示数据/).first().click();
  await expect(page.getByText(/Sample payroll for demonstration\.|薪資演示樣本。|薪资演示样本。/)).toBeVisible();
});
```

- [ ] **Step 2: Run**

Run: `npx playwright test payroll-real`
Expected: PASS (requires the deployed frontend to include Tasks 6-7 — run this AFTER deploying those, or set `TEST_BASE_URL=http://localhost:5173` with `npm run dev` running).

- [ ] **Step 3: Commit**

```bash
git add tests/payroll-real.spec.ts
git commit -m "test(payroll): e2e for demo/real toggle persistence"
```

---

### Task 9: Final verification sweep

- [ ] All unit suites green: `npx tsx tests/payroll-mpf.test.ts && npx tsx tests/payroll-core.test.ts && npx tsx tests/payroll-schemas.test.ts`
- [ ] Typechecks clean: `cd api && npx tsc --noEmit`; `cd frontend && npx tsc -b --noEmit`
- [ ] Playwright: `npx playwright test payroll-demo && npx playwright test payroll-real`
- [ ] Migration recorded for deploy in PR description (from Task 3).
- [ ] Spec §API vs implemented routes diff-check (all 13 routes exist).

## Self-Review Notes (done during planning)

1. **Spec coverage** — Data model→T3; MPF port→T1; 3-entry model/aggregation→T2/T5; lifecycle+void→T5; header toggle+chip rules→T6; real UI cards/actions→T7; badges mapping→T7 (`RUN_STATUS_META`); error handling (409 reasons, closed-period surfacing)→T4/T5; testing approach adapted: repo has NO vitest — plan follows the existing `tsx` + `ok()` harness (Global Constraint added); e2e→T8.
2. **Placeholders** — the only intentional non-inline code is the `auditLog` paste (bookkeeping.ts:79, exact pointer given — copying living repo code beats duplicating it in the plan where it could rot).
3. **Type consistency** — `RunItem`/`RunTotals`/`JeLineDraft` shapes identical across T2 definitions, T5 usages, T7 UI contracts; `canTransition` signature matches; route paths consistent between T5 interface and T7 fetch strings (`/payroll/employees`, `/payroll/runs`, `/payroll/bank-accounts`).
