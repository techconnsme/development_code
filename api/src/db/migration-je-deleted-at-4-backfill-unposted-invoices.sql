-- Migration (STEP 4): backfill GL entries for historically unposted invoices
-- Run with: cd api && npx wrangler d1 execute opcc-crm-db --remote --file=src/db/migration-je-deleted-at-4-backfill-unposted-invoices.sql
--
-- ⚠ WRITES TO PRODUCTION BOOKS. Review the report first:
--      node scripts/report-unposted-invoices.mjs
--    Measured impact at time of writing: 67 invoices, ~1.4M, 8 tenants.
--
-- Mirrors api/src/lib/post-invoice.ts exactly:
--   incoming  → Dr expense account / Cr 21101 Trade Creditors
--   outgoing  → Dr 11201 Trade Debtors / Cr 41101 Professional Services
-- Only finalised invoices (active/sent/paid/overdue), total > 0, not deleted,
-- and without an existing live invoice entry.
--
-- Idempotent: entry inserts are guarded by NOT EXISTS; re-running adds nothing.
-- Entry ids use the 'je-bkf-'/'jl-bkf-' prefix so the line inserts below can
-- target ONLY entries this migration created and never re-touch a real one
-- (e.g. the live JE-INV-INV-MSZW5F9J entry).

-- Verify BEFORE (must match the report):
--   SELECT i.direction, COUNT(*), ROUND(SUM(i.total),2) FROM invoices i
--   WHERE i.deleted_at IS NULL AND i.status IN ('active','sent','paid','overdue') AND i.total > 0
--     AND NOT EXISTS (SELECT 1 FROM journal_entries je
--       WHERE je.reference_type='invoice' AND je.reference_id=i.id AND je.deleted_at IS NULL)
--   GROUP BY i.direction;

-- ── STEP 0: ensure accounts exist per tenant (mirrors ensureMissingAccounts).
-- parent_code is left NULL — the COA repair migration
-- (migration-coa-name-parent-fix.sql) exists for hierarchy repair, and most of
-- these codes were already auto-created with NULL parents historically.
INSERT INTO accounts (id, user_id, account_code, account_name, account_type, parent_code)
SELECT 'acc-bkf-' || lower(hex(randomblob(8))), t.user_id, t.code, t.name, t.type, NULL
FROM (
  SELECT DISTINCT i.user_id, '11201' AS code, 'Trade Debtors 應收賬款' AS name, 'asset' AS type
    FROM invoices i WHERE i.deleted_at IS NULL AND i.status IN ('active','sent','paid','overdue') AND i.total > 0 AND i.direction='outgoing'
      AND NOT EXISTS (SELECT 1 FROM journal_entries je WHERE je.reference_type='invoice' AND je.reference_id=i.id AND je.deleted_at IS NULL)
  UNION
  SELECT DISTINCT i.user_id, '41101', 'Professional Services 專業服務收入', 'revenue'
    FROM invoices i WHERE i.deleted_at IS NULL AND i.status IN ('active','sent','paid','overdue') AND i.total > 0 AND i.direction='outgoing'
      AND NOT EXISTS (SELECT 1 FROM journal_entries je WHERE je.reference_type='invoice' AND je.reference_id=i.id AND je.deleted_at IS NULL)
  UNION
  SELECT DISTINCT i.user_id, '21101', 'Trade Creditors 應付賬款', 'liability'
    FROM invoices i WHERE i.deleted_at IS NULL AND i.status IN ('active','sent','paid','overdue') AND i.total > 0 AND i.direction='incoming'
      AND NOT EXISTS (SELECT 1 FROM journal_entries je WHERE je.reference_type='invoice' AND je.reference_id=i.id AND je.deleted_at IS NULL)
  UNION
  SELECT DISTINCT i.user_id,
      CASE i.expense_category WHEN 'cash' THEN '67001' WHEN 'reimburse' THEN '61203' WHEN 'director' THEN '21201' ELSE '66203' END,
      CASE i.expense_category WHEN 'cash' THEN 'Petty Cash Expenses' WHEN 'reimburse' THEN 'Employee Reimbursements' WHEN 'director' THEN 'Director Current Account' ELSE 'Miscellaneous Expenses' END,
      CASE i.expense_category WHEN 'director' THEN 'liability' WHEN 'cash' THEN 'expense' WHEN 'reimburse' THEN 'expense' ELSE 'expense' END
    FROM invoices i WHERE i.deleted_at IS NULL AND i.status IN ('active','sent','paid','overdue') AND i.total > 0 AND i.direction='incoming'
      AND NOT EXISTS (SELECT 1 FROM journal_entries je WHERE je.reference_type='invoice' AND je.reference_id=i.id AND je.deleted_at IS NULL)
) t
WHERE NOT EXISTS (SELECT 1 FROM accounts a WHERE a.user_id = t.user_id AND a.account_code = t.code);

-- ── STEP 1: create the journal entry headers.
-- Skips any invoice whose entry_number would collide (UNIQUE(user_id, entry_number)).
INSERT INTO journal_entries (id, user_id, entry_number, entry_date, description, reference_type, reference_id, status)
SELECT 'je-bkf-' || lower(hex(randomblob(8))), i.user_id, 'JE-INV-' || i.invoice_number, i.issue_date,
       CASE WHEN i.direction='incoming'
         THEN 'AP Invoice ' || i.invoice_number || ': ' || COALESCE(i.notes, 'Supplier bill')
         ELSE 'Invoice ' || i.invoice_number || ': ' || COALESCE(i.notes, 'Services') END,
       'invoice', i.id, 'posted'
FROM invoices i
WHERE i.deleted_at IS NULL AND i.status IN ('active','sent','paid','overdue') AND i.total > 0
  AND NOT EXISTS (SELECT 1 FROM journal_entries je
      WHERE je.reference_type='invoice' AND je.reference_id=i.id AND je.deleted_at IS NULL)
  AND NOT EXISTS (SELECT 1 FROM journal_entries je2
      WHERE je2.user_id=i.user_id AND je2.entry_number='JE-INV-'||i.invoice_number);

-- ── STEP 2: AR/AP leg (sort_order 1).
INSERT INTO journal_lines (id, entry_id, account_code, account_name, description, debit, credit, sort_order)
SELECT 'jl-bkf-' || lower(hex(randomblob(8))), je.id,
       CASE WHEN i.direction='incoming' THEN '21101' ELSE '11201' END,
       CASE WHEN i.direction='incoming' THEN 'Trade Creditors 應付賬款' ELSE 'Trade Debtors 應收賬款' END,
       i.invoice_number,
       CASE WHEN i.direction='incoming' THEN 0 ELSE i.total END,
       CASE WHEN i.direction='incoming' THEN i.total ELSE 0 END,
       1
FROM journal_entries je JOIN invoices i ON je.reference_id = i.id
WHERE je.reference_type='invoice' AND je.id LIKE 'je-bkf-%';

-- ── STEP 3: expense/revenue leg (sort_order 0).
INSERT INTO journal_lines (id, entry_id, account_code, account_name, description, debit, credit, sort_order)
SELECT 'jl-bkf-' || lower(hex(randomblob(8))), je.id,
       CASE WHEN i.direction='incoming'
         THEN CASE i.expense_category WHEN 'cash' THEN '67001' WHEN 'reimburse' THEN '61203' WHEN 'director' THEN '21201' ELSE '66203' END
         ELSE '41101' END,
       CASE WHEN i.direction='incoming'
         THEN CASE i.expense_category WHEN 'cash' THEN 'Petty Cash Expenses' WHEN 'reimburse' THEN 'Employee Reimbursements' WHEN 'director' THEN 'Director Current Account' ELSE 'Miscellaneous Expenses' END
         ELSE 'Professional Services 專業服務收入' END,
       i.invoice_number,
       CASE WHEN i.direction='incoming' THEN i.total ELSE 0 END,
       CASE WHEN i.direction='incoming' THEN 0 ELSE i.total END,
       0
FROM journal_entries je JOIN invoices i ON je.reference_id = i.id
WHERE je.reference_type='invoice' AND je.id LIKE 'je-bkf-%';

-- Verify AFTER:
--   1. Backlog is empty:
--        node scripts/report-unposted-invoices.mjs
--   2. Trial balance still balances:
--        SELECT ROUND(SUM(jl.debit),2), ROUND(SUM(jl.credit),2) FROM journal_lines jl
--        JOIN journal_entries je ON jl.entry_id=je.id
--        WHERE je.deleted_at IS NULL AND je.status IN ('posted','reconciled');
--   3. No tenant negative:
--        node scripts/report-unposted-invoices.mjs  (table bottom shows projections — now actual)
