-- Migration (STEP 5): resolve the 4 draft journal entries
-- Run with: cd api && npx wrangler d1 execute opcc-crm-db --remote --file=src/db/migration-je-deleted-at-5-draft-entries-fix.sql
--
-- Decision taken (user, 2026-08-19): promote the 2 real entries to 'posted';
-- for the near-certain duplicate pair, promote the survivor and tombstone the
-- duplicate (the later-created -002).
--
-- The drafts, from diagnosis:
--   u-83161e0c  B-THEHON-202506-003   Dr 62303/11101  20,500   real
--   u-83161e0c  B-THEHON-202506-004   Dr 51101/11101  19,600   real
--   u-e5ea0d2b  B-HSBC-202506-001     Dr 11101/31201   3,000   duplicate pair
--   u-e5ea0d2b  B-HSBC-202506-002     Dr 11101/31201   3,000   duplicate pair
--
-- Both legs of an entry move together, so promoting/tombstoning whole entries
-- cannot unbalance the trial balance.
--
-- Idempotent: the WHERE clauses match nothing once applied.

-- Verify BEFORE (the pair should be identical except id/entry_number/created_at):
--   SELECT je.id, je.entry_number, je.created_at, GROUP_CONCAT(jl.account_code || ':' || jl.debit || '/' || jl.credit)
--   FROM journal_entries je JOIN journal_lines jl ON jl.entry_id = je.id
--   WHERE je.user_id='u-e5ea0d2b' AND je.entry_number IN ('B-HSBC-202506-001','B-HSBC-202506-002')
--   GROUP BY je.id ORDER BY je.entry_number;

-- ── 1. Promote the two real entries ──
UPDATE journal_entries
SET status = 'posted', updated_at = datetime('now')
WHERE user_id = 'u-83161e0c'
  AND entry_number IN ('B-THEHON-202506-003', 'B-THEHON-202506-004')
  AND status = 'draft';

-- ── 2. The duplicate pair: promote the SURVIVOR (-001) so the genuine
--    transaction counts, and tombstone the duplicate (-002).
--    Tombstone is reversible: cleared by restore if ever needed.
UPDATE journal_entries
SET status = 'posted', updated_at = datetime('now')
WHERE user_id = 'u-e5ea0d2b'
  AND entry_number = 'B-HSBC-202506-001'
  AND status = 'draft';

UPDATE journal_entries
SET deleted_at = datetime('now'), updated_at = datetime('now')
WHERE user_id = 'u-e5ea0d2b'
  AND entry_number = 'B-HSBC-202506-002'
  AND status = 'draft'
  AND deleted_at IS NULL;

-- Verify AFTER:
--   live drafts must be 0:
--     SELECT COUNT(*) FROM journal_entries
--     WHERE status='draft' AND deleted_at IS NULL;
--   (the tombstoned -002 keeps status='draft' but is excluded everywhere via
--    deleted_at IS NOT NULL)
