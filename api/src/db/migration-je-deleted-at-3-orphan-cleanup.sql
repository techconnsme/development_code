-- Migration (STEP 3 of 3): tombstone ledger entries whose invoice was deleted
-- Run with: cd api && npx wrangler d1 execute opcc-crm-db --remote --file=src/db/migration-je-deleted-at-3-orphan-cleanup.sql
--
-- PREREQUISITE: step 1 (deleted_at column) must have been applied. Safe to run
-- before or after step 2, and before or after the code deploy — it only ever
-- tombstones entries that are already unbalanced, which can never overstate the
-- books.
--
-- WHY: deleting an invoice never touched its journal entries, so a payment kept
-- debiting AP (or crediting AR) with no invoice left to offset it. The code fix
-- (lib/invoice-journal.ts) handles this going forward; this cleans up the rows
-- that already leaked.
--
-- MEASURED IMPACT at time of writing: 2 entries, 55,500.00 total, all on tenant
-- u-83161e0c. That is the whole of its residual AP shortfall — AP moves from
-- -35,900.00 (post-backfill) to +19,600.00, which is its genuine unpaid-bill
-- balance. No other tenant has orphans.
--
-- Idempotent: the WHERE clauses match nothing once the rows are tombstoned.

-- Verify BEFORE running (expect 2 rows, 55,500.00):
--   SELECT je.user_id, je.entry_number, i.invoice_number, i.total
--   FROM journal_entries je
--   JOIN bank_transactions bt ON bt.id = je.reference_id
--   JOIN invoices i ON i.id = bt.invoice_id
--   WHERE je.reference_type = 'payment' AND je.deleted_at IS NULL
--     AND i.deleted_at IS NOT NULL;

-- 1) Payment entries settling an invoice that has since been deleted.
UPDATE journal_entries
SET deleted_at = datetime('now'), updated_at = datetime('now')
WHERE reference_type = 'payment'
  AND deleted_at IS NULL
  AND reference_id IN (
    SELECT bt.id FROM bank_transactions bt
    JOIN invoices i ON i.id = bt.invoice_id
    WHERE i.deleted_at IS NOT NULL
  );

-- 2) The invoices' own entries, for symmetry. Currently matches zero rows (no
--    invoice has ever been posted), but leaving it out would reintroduce the
--    same leak the moment posting starts working.
UPDATE journal_entries
SET deleted_at = datetime('now'), updated_at = datetime('now')
WHERE reference_type = 'invoice'
  AND deleted_at IS NULL
  AND reference_id IN (SELECT id FROM invoices WHERE deleted_at IS NOT NULL);

-- Verify AFTER running (must return 0):
--   SELECT COUNT(*) FROM journal_entries je
--   JOIN bank_transactions bt ON bt.id = je.reference_id
--   JOIN invoices i ON i.id = bt.invoice_id
--   WHERE je.reference_type = 'payment' AND je.deleted_at IS NULL
--     AND i.deleted_at IS NOT NULL;
