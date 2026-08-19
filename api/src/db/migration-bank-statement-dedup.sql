-- Migration: tombstone duplicate bank statement imports (soft delete)
-- Run with: cd api && npx wrangler d1 execute opcc-crm-db --remote --file=src/db/migration-bank-statement-dedup.sql
--
-- WHY: the same PDF re-uploaded gets a fresh r2_key, so the import-time dedup
-- check never caught it. The result was multiple live bank_statements (and their
-- bank_transactions) for the same real statement. The fallback P&L path in
-- chat.ts / workbuddy.ts sums bank_transactions without a deleted_at filter,
-- so these duplicates inflate the numbers for tenants with no journal entries.
--
-- Scope (verified 2026-08-20, live rows only):
--   * u-a21aaae1  (Proficiency and Reliance Company Limited) — 8 TIME_TEST_*
--     imports duplicating the real BANK_HSBC_BusinessDirect_2026-08_Aug.pdf
--     (bs-f54dd027, imported 2026-08-06). The TIME_TEST rows were uploaded
--     2026-08-13 while testing import; keep bs-f54dd027, tombstone the rest.
--   * u-ac7f1e56  (gh@gmail.com "test") — two eStatement 20250128.pdf imports.
--     Keep bs-8e74d740 (dep 102,112.30 - wit 1,400.00 = closing 100,712.30,
--     reconciles); tombstone bs-690777f6 (102,112.03 does not reconcile).
--   * u-d0757ac1  ("untitled" x3) — NOT duplicates; they are Jan/Feb/Mar 2025
--     statements that merely share the filename "untitled". Left untouched.
--
-- Idempotent: the WHERE clauses match nothing once the rows are tombstoned.
-- Soft delete only (deleted_at), never a hard DELETE — consistent with how the
-- 2026-08-17 cleanup for u-83161e0c handled the same problem.

-- Verify BEFORE running (expect 8 rows for u-a21aaae1 + 1 row for u-ac7f1e56):
--   SELECT user_id, id, file_name, r2_key, created_at
--   FROM bank_statements
--   WHERE deleted_at IS NULL
--     AND id IN (
--       'bs-0c2e8501','bs-a338c636','bs-d8e0a25b','bs-27b3dae6',
--       'bs-8b2fc541','bs-26ad7a2b','bs-ef2ad494','bs-b8b92c7f',
--       'bs-690777f6'
--     );

-- 1) Tombstone the duplicate bank_statements.
UPDATE bank_statements
SET deleted_at = datetime('now'), updated_at = datetime('now')
WHERE deleted_at IS NULL
  AND id IN (
    'bs-0c2e8501','bs-a338c636','bs-d8e0a25b','bs-27b3dae6',
    'bs-8b2fc541','bs-26ad7a2b','bs-ef2ad494','bs-b8b92c7f',
    'bs-690777f6'
  );

-- 2) Tombstone their transactions too (so the fallback sums exclude them).
UPDATE bank_transactions
SET deleted_at = datetime('now')
WHERE deleted_at IS NULL
  AND bank_statement_id IN (
    'bs-0c2e8501','bs-a338c636','bs-d8e0a25b','bs-27b3dae6',
    'bs-8b2fc541','bs-26ad7a2b','bs-ef2ad494','bs-b8b92c7f',
    'bs-690777f6'
  );

-- Verify AFTER running (both must return 0):
--   SELECT COUNT(*) FROM bank_statements
--   WHERE deleted_at IS NULL
--     AND id IN (
--       'bs-0c2e8501','bs-a338c636','bs-d8e0a25b','bs-27b3dae6',
--       'bs-8b2fc541','bs-26ad7a2b','bs-ef2ad494','bs-b8b92c7f',
--       'bs-690777f6'
--     );
--   SELECT COUNT(*) FROM bank_transactions
--   WHERE deleted_at IS NULL
--     AND bank_statement_id IN (
--       'bs-0c2e8501','bs-a338c636','bs-d8e0a25b','bs-27b3dae6',
--       'bs-8b2fc541','bs-26ad7a2b','bs-ef2ad494','bs-b8b92c7f',
--       'bs-690777f6'
--     );
