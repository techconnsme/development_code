-- Compliance module migration
-- Run: cd api && npx wrangler d1 execute opcc-crm-db --remote --file=src/db/migrate-compliance.sql

-- Add compliance columns to company_settings (safe to run if they already exist)
ALTER TABLE company_settings ADD COLUMN br_number TEXT;
ALTER TABLE company_settings ADD COLUMN br_expiry_date TEXT;
ALTER TABLE company_settings ADD COLUMN ci_number TEXT;
ALTER TABLE company_settings ADD COLUMN industry TEXT DEFAULT 'general';
ALTER TABLE company_settings ADD COLUMN employee_count INTEGER DEFAULT 0;
ALTER TABLE company_settings ADD COLUMN fiscal_year_end TEXT DEFAULT '03-31';
ALTER TABLE company_settings ADD COLUMN secretary_name TEXT;
ALTER TABLE company_settings ADD COLUMN secretary_contact TEXT;
ALTER TABLE company_settings ADD COLUMN auditor_name TEXT;
ALTER TABLE company_settings ADD COLUMN auditor_contact TEXT;

-- Compliance templates
CREATE TABLE IF NOT EXISTS compliance_templates (
  id TEXT PRIMARY KEY,
  category TEXT NOT NULL,
  industry TEXT DEFAULT 'general',
  title_zh TEXT NOT NULL,
  title_en TEXT,
  description_zh TEXT,
  is_required INTEGER NOT NULL DEFAULT 1,
  has_deadline INTEGER NOT NULL DEFAULT 0,
  deadline_field TEXT,
  action_url TEXT,
  action_label_zh TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Per-member compliance status
CREATE TABLE IF NOT EXISTS member_compliance (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  template_id TEXT NOT NULL REFERENCES compliance_templates(id),
  status TEXT NOT NULL DEFAULT 'pending',
  notes TEXT,
  completed_at TEXT,
  reminder_enabled INTEGER NOT NULL DEFAULT 1,
  last_reminded_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(user_id, template_id)
);

-- Compliance key dates
CREATE TABLE IF NOT EXISTS compliance_dates (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  date_type TEXT NOT NULL,
  date_value TEXT NOT NULL,
  reminder_days TEXT DEFAULT '90,60,30,7',
  notes TEXT,
  last_reminded_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(user_id, date_type)
);

-- Compliance action log
CREATE TABLE IF NOT EXISTS compliance_log (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  action TEXT NOT NULL,
  template_id TEXT REFERENCES compliance_templates(id),
  details TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
