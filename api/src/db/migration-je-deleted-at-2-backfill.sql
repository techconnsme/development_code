-- Migration (STEP 2 of 2): convert status='stale' rows to deleted_at tombstones
-- Run with: cd api && npx wrangler d1 execute opcc-crm-db --remote --file=src/db/migration-je-deleted-at-2-backfill.sql
--
-- PREREQUISITES — do not run this until BOTH are true:
--   1. migration-je-deleted-at-1-column.sql has been applied, AND
--   2. the new API code is deployed (filters on deleted_at IS NULL and
--      status IN ('posted','reconciled')).
--
-- Running this against the OLD code would be actively harmful: the ~168 rows
-- below flip to status='posted', and the old `status != 'stale'` filters would
-- then count every tombstoned entry as live financial data.
--
-- Rolling the code back AFTER this runs is unsafe for the same reason.
--
-- status is set to 'posted' because the pre-stale lifecycle value is already
-- lost — the old restore path (bank-statements.ts:1528) hard-coded 'posted'
-- too. Exclusion is now driven by deleted_at, so the status value is inert for
-- these rows. Idempotent: re-running matches nothing once converted.

-- Verify BEFORE running (expect ~168, all reference_type='bank_transaction'):
--   SELECT reference_type, COUNT(*) FROM journal_entries
--   WHERE status = 'stale' GROUP BY reference_type;

UPDATE journal_entries
SET deleted_at = COALESCE(updated_at, created_at, datetime('now')),
    status = 'posted'
WHERE status = 'stale';

-- Verify AFTER running (both must return 0):
--   SELECT COUNT(*) FROM journal_entries WHERE status = 'stale';
--   SELECT COUNT(*) FROM journal_entries WHERE deleted_at IS NOT NULL AND status = 'stale';
