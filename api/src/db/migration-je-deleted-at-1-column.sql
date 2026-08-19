-- Migration (STEP 1 of 2): add deleted_at tombstone column to journal_entries
-- Run with: cd api && npx wrangler d1 execute opcc-crm-db --remote --file=src/db/migration-je-deleted-at-1-column.sql
--
-- Replaces the undocumented status='stale' tombstone with a deleted_at column,
-- matching the soft-delete idiom already used by bank_statements, invoices and
-- file_records. 'stale' conflated two orthogonal concepts in one column —
-- lifecycle (draft/posted/reconciled) and existence — which is why restoring a
-- soft-deleted statement resurrected its entries as 'posted' regardless of what
-- they were before.
--
-- ORDER MATTERS. This file is additive and safe to run against the CURRENT
-- deployed code: deleted_at is NULL everywhere, so nothing changes behaviour.
-- Run this FIRST, then deploy the new API code, and only THEN run step 2.
-- Running step 2 before the code deploy would flip 168 rows to status='posted'
-- while the old `status != 'stale'` filters are still live, pulling every
-- tombstoned entry into the financial statements.
--
-- Not idempotent: re-running errors with "duplicate column name" (house
-- convention — the ALTER errors, the rest of the file still runs).

ALTER TABLE journal_entries ADD COLUMN deleted_at TEXT;

CREATE INDEX IF NOT EXISTS idx_journal_entries_active
  ON journal_entries(user_id, deleted_at, status);
