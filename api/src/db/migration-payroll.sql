-- Payroll module tables (spec: docs/superpowers/specs/2026-08-27-payroll-real-module-design.md)
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
