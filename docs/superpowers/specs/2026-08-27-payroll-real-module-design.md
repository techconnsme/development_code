# Real Payroll Module with Demo Toggle — Design

Date: 2026-08-27
Status: Approved (brainstorming session, continued from Claude Code session "HK MPF payroll journal")
Repo: `Tech_Connect_SME/Development_code/latest_code`

## Goal

Turn the demo-only `/payroll` page into a real HK payroll module while preserving the
demo experience behind a Demo ⇄ Real header toggle. Real payroll manages employees,
runs monthly payroll, and posts the BA-specified 3 journal entries to the GL.

## User Decisions (from brainstorming)

1. **Full module**: employee CRUD + monthly runs + GL posting.
2. **Demo/Real switch**: segmented toggle in the page header (not tabs/routes).
3. **Journal lifecycle**: 3-step — accrual → mark paid → MPF settled, each posting its JE.
4. **JE granularity**: aggregated by expense account in GL; per-employee detail lives in payroll tables only.
5. **Calc complexity v1**: fixed monthly salaries + tenure gating only. No proration,
   bonuses, unpaid leave, or age exemptions. No salaries-tax withholding (HK model).
6. **Architecture**: dedicated `/api/payroll` backend module mirroring the AP/AR pattern.

## Accounting Model (HK)

MPF rules identical to existing `frontend/src/lib/mpf.ts`, ported server-side:
5% each side; relevant income < 7,100 → employee 0 / employer 5% of actual income;
cap at 30,000 → max 1,500 per side per month.

Existing COA accounts are reused (no new accounts):

| Account | Code |
|---|---|
| Bank (default payment account) | `11102` HSBC |
| Salary Payable (= "Accrued Salaries Payable") | `21203` |
| MPF Payable | `21204` |
| Project Staff Salary | `51201` |
| Management Salary | `61102` |
| Staff Salaries | `61201` |
| MPF Employer Contribution | `61202` |

### The three entries per run

1. **Accrual** (entry_date = month-end):
   - Dr Σgross by distinct `expense_account_code`
   - Dr `61202` total employer MPF
   - Cr `21204` (employee + employer MPF)
   - Cr `21203` net pay
2. **Salary payment** (on mark-paid): Dr `21203` · Cr chosen bank — Σnet
3. **MPF settlement** (on mark-MPF-settled): Dr `21204` · Cr same bank — EE+ER total

Entry dates: accrual uses the period's month-end date; payment and settlement JEs
use the date the user performs that action.

All JEs: `reference_type='payroll'`, `reference_id=<run id>`, respect
`checkPeriodOpen`, skip the manual-duplicate guard (the run's
`UNIQUE(user_id, period_month)` makes duplicates impossible). Tenant bank/coa codes
validated against active leaf COA accounts before use.

### Tenure rule

An item is included in a period only if
`hire_date <= period_end && (termination_date IS NULL OR termination_date >= period_start)`.
Outside tenure → excluded entirely from salary and MPF.

## Data Model (new migration)

```sql
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
  period_month TEXT NOT NULL,            -- 'YYYY-MM'
  status TEXT NOT NULL DEFAULT 'draft',  -- draft|accrued|paid|settled|cancelled
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
  expense_account_code TEXT NOT NULL,    -- snapshot at run creation
  UNIQUE(run_id, employee_id)
);

CREATE INDEX IF NOT EXISTS idx_payroll_employees_user ON payroll_employees(user_id);
CREATE INDEX IF NOT EXISTS idx_payroll_runs_user ON payroll_runs(user_id, period_month);
CREATE INDEX IF NOT EXISTS idx_payroll_items_run ON payroll_run_items(run_id);
```

Salaries are snapshotted into items at run creation; later employee edits never
rewrite posted history.

## API — `/api/payroll`

Auth: `authMiddleware` on all routes; mutations also gated by `bookkeeperMiddleware`.
Tenant: `client_user_id || user.id`.

| Route | Purpose |
|---|---|
| `GET /employees` | List (active first) |
| `POST /employees` | Create (Zod validation) |
| `PATCH /employees/:id` | Update fields |
| `DELETE /employees/:id` | Hard delete only if unreferenced by any run item; else 409 advising deactivate |
| `GET /runs?period=` | Run list w/ totals + status |
| `GET /runs/:id` | Detail incl. items and linked JE numbers/dates |
| `GET /runs/preview?period=YYYY-MM` | Compute-only dry run against live employees |
| `POST /runs {period_month}` | Create run + snapshot items, compute totals, status `draft`; 409 if period already has a non-cancelled run |
| `POST /runs/:id/post-accrual` | Posts JE 1, sets `accrued`, stores `accrual_entry_id` |
| `POST /runs/:id/mark-paid {bank_account_code}` | Validated bank account; posts JE 2, stores bank code + entry id, status `paid` |
| `POST /runs/:id/mark-mpf-settled` | Posts JE 3 using same bank, status `settled` |
| `POST /runs/:id/void` | Reverse any posted JEs via the existing reverse mechanism; status `cancelled`; blocked if already `settled` (advise reversing via GJE) |

Lifecycle transitions enforced server-side with 409 errors carrying user-facing reasons.

## Frontend — `/payroll`

Header row gains a bilingual segmented control **[Demo data 資料示範 | Real data 實際資料]**
next to the title (existing amber chip stays visible only in Demo mode). Choice persists
in localStorage (`payroll.mode`).

- **Demo mode**: current page exactly as-is (no behavior change).
- **Real mode**, three cards:
  1. **Employees** — table styled like the demo staff list; add/edit via `SlidePanel.tsx`;
     fields per schema incl. expense account select sourced from `/coa` (fallback to hardcoded six).
  2. **Runs** — rows per month with status badges mapped onto the existing STATUS_META
     palette: draft → gray ("Scheduled" style), accrued → amber ("Pending" style),
     paid → emerald ("Paid" style), settled → emerald with a check modifier,
     cancelled → gray strikethrough.
     A "New run for {month}" affordance opens preview totals before create.
  3. **Run detail** — per-employee breakdown table plus the same bilingual JeBlock visual
     format used by demo (`Dr/Cr · code · name · amount`), one block per staged entry;
     lifecycle action button under each block ("Confirm & post accrual" → "Mark paid" +
     bank selector → "Mark MPF settled"), disabled with tooltip when prerequisites unmet.

All new copy uses `tr(en, zhHant, zhHans)`.

## Error Handling

- 409 with `reason` for invalid transitions, duplicate periods, referenced-employee delete.
- Period-closed postings surface the existing period-guard message.
- Posting failures roll back inserts (transaction) leaving run in prior state.

## Testing

- Vitest unit (TDD): server-side MPF port regressed against the spec table
  (6,000 → 0/300; 9,500 → 475/475; 22,500 → 1,125 both; 28,000 → 1,400 both;
  ≥30,000 → 1,500 caps); tenure filtering; accrual JE line composition per-account
  aggregation; transition guard matrix.
- Playwright e2e extending `tests/payroll-demo.spec.ts`: toggle switch renders both modes;
  demo view unchanged; real-mode happy path creates employee → run → posts three JEs.

## Out of Scope (v1)

Proration, bonuses/commissions, unpaid leave, age-based exemptions, salaries-tax
withholding, IRD forms, multi-currency, payslip PDFs, auto-scheduling, integration
with bank statement matching beyond manual "mark paid".
