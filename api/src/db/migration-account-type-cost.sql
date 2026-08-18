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
