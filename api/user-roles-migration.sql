-- Migration: User Type Dictionary
-- Run: wrangler d1 execute opcc-crm-db --file=./src/db/migrations/user-roles.sql

-- Add new columns to users table
ALTER TABLE users ADD COLUMN status TEXT NOT NULL DEFAULT 'active';
-- status values: 'pending' | 'active' | 'suspended'

ALTER TABLE users ADD COLUMN must_change_password INTEGER NOT NULL DEFAULT 0;
-- 1 = force password change on next login (new supervisor accounts)

ALTER TABLE users ADD COLUMN parent_user_id TEXT REFERENCES users(id);
-- for staff accounts: who created them (their supervisor/accountant)

ALTER TABLE users ADD COLUMN permission_tier TEXT NOT NULL DEFAULT 'higher';
-- 'higher' = supervisor/accountant, 'normal' = staff, 'viewer' = read-only

-- Update existing users role column comment (values now include supervisor, accountant, staff, viewer)
-- role: 'admin' | 'supervisor' | 'accountant' | 'staff' | 'viewer' | 'user'(legacy)

-- Applications table (for the apply flow)
CREATE TABLE IF NOT EXISTS applications (
  id TEXT PRIMARY KEY,
  company_name TEXT NOT NULL,
  contact_name TEXT NOT NULL,
  email TEXT NOT NULL,
  phone TEXT,
  message TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  -- status: 'pending' | 'approved' | 'rejected'
  reviewed_by TEXT REFERENCES users(id),
  reviewed_at TEXT,
  created_user_id TEXT REFERENCES users(id),
  -- set after approval when supervisor account is created
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_applications_status ON applications(status);
CREATE INDEX IF NOT EXISTS idx_applications_email ON applications(email);
