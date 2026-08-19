-- One-time migrations (safe to ignore errors)
-- Run: npx wrangler d1 execute opcc-crm-db --remote --file=src/db/migrate-once.sql

ALTER TABLE bank_transactions ADD COLUMN account_code TEXT;
ALTER TABLE bank_statements ADD COLUMN account_code TEXT;

-- Fixed asset register
CREATE TABLE IF NOT EXISTS fixed_assets (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  asset_name TEXT NOT NULL,
  asset_code TEXT,
  category TEXT DEFAULT 'office_equipment',
  purchase_date TEXT NOT NULL,
  cost REAL NOT NULL,
  useful_life_years REAL NOT NULL DEFAULT 5,
  salvage_value REAL DEFAULT 0,
  depreciation_method TEXT NOT NULL DEFAULT 'straight_line',
  monthly_depreciation REAL DEFAULT 0,
  accumulated_depreciation REAL DEFAULT 0,
  net_book_value REAL DEFAULT 0,
  is_active INTEGER NOT NULL DEFAULT 1,
  disposal_date TEXT,
  disposal_amount REAL,
  account_code TEXT DEFAULT '12201',
  depn_account_code TEXT DEFAULT '66101',
  acc_depn_account_code TEXT DEFAULT '12301',
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
ALTER TABLE accounts ADD COLUMN opening_balance REAL DEFAULT 0;
ALTER TABLE invoices ADD COLUMN br_number TEXT;

-- Compliance columns for company_settings
ALTER TABLE company_settings ADD COLUMN br_number TEXT;
ALTER TABLE company_settings ADD COLUMN br_expiry_date TEXT;
ALTER TABLE company_settings ADD COLUMN ci_number TEXT;
ALTER TABLE company_settings ADD COLUMN industry TEXT DEFAULT 'general';
ALTER TABLE company_settings ADD COLUMN employee_count INTEGER DEFAULT 0;
ALTER TABLE company_settings ADD COLUMN fiscal_year_start TEXT;
ALTER TABLE company_settings ADD COLUMN fiscal_year_end TEXT DEFAULT '03-31';
ALTER TABLE company_settings ADD COLUMN secretary_name TEXT;
ALTER TABLE company_settings ADD COLUMN secretary_contact TEXT;
ALTER TABLE company_settings ADD COLUMN auditor_name TEXT;
ALTER TABLE company_settings ADD COLUMN auditor_contact TEXT;
