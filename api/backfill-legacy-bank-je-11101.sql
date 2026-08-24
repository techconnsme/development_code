-- Backfill: legacy bank JEs posted fixed side to hardcoded 11101 Cash on Hand
-- (pre-2026-08-22 engine). Retarget to the statement's real bank account.
-- Non-HSBC banks get their own per-tenant COA leaf under 11100, next sequential
-- code after 11103 (ordering rule: 11101, 11102, 11103, 11104, ...).
-- Guards: live bank_transaction JEs only; contra side must be non-asset (1xxx)
-- so legitimate cash<->bank transfers are untouched.

-- ── 1) Missing canonical accounts ──────────────────────────────────────────
INSERT INTO accounts (id, user_id, account_code, account_name, account_type, parent_code) VALUES
  ('acc-9f21c4a7', 'u-21e2a52a', '11102', '匯豐銀行 HSBC', 'asset', '11100');

INSERT INTO accounts (id, user_id, account_code, account_name, account_type, parent_code) VALUES
  ('acc-3b8e5d20', 'u-d0757ac1', '10000', '資產 Assets', 'asset', NULL),
  ('acc-7c42f9b1', 'u-d0757ac1', '11000', '流動資產 Current Assets', 'asset', '10000'),
  ('acc-5d19a8e6', 'u-d0757ac1', '11100', '現金及銀行存款 Cash & Bank', 'asset', '11000'),
  ('acc-2e6b3c94', 'u-d0757ac1', '11102', '匯豐銀行 HSBC', 'asset', '11100');

INSERT INTO accounts (id, user_id, account_code, account_name, account_type, parent_code) VALUES
  ('acc-8a53d1f2', 'u-5bc78c1c', '11104', '中國銀行 Bank of China', 'asset', '11100');

INSERT INTO accounts (id, user_id, account_code, account_name, account_type, parent_code) VALUES
  ('acc-4c7e9b30', 'u-a21aaae1', '11104', '恒生銀行 Hang Seng Bank', 'asset', '11100'),
  ('acc-6f28a5d9', 'u-a21aaae1', '11105', '中國銀行 Bank of China', 'asset', '11100'),
  ('acc-1d94c7b8', 'u-a21aaae1', '11106', '渣打銀行 Standard Chartered', 'asset', '11100');

INSERT INTO accounts (id, user_id, account_code, account_name, account_type, parent_code) VALUES
  ('acc-9b36e2f5', 'u-bf5c166e', '11104', '恒生銀行 Hang Seng Bank', 'asset', '11100');

-- Re-attach orphaned 11101 under the newly created 11100 parent
UPDATE accounts SET parent_code = '11100'
WHERE user_id = 'u-d0757ac1' AND account_code = '11101'
  AND (parent_code IS NULL OR parent_code = '');

-- ── 2) Rewrite legacy fixed-side 11101 lines ───────────────────────────────

-- 2a) HSBC-family statements → 11102 (244 JEs)
UPDATE journal_lines SET
  account_code = '11102',
  account_name = COALESCE(
    (SELECT a.account_name FROM accounts a
     JOIN journal_entries je2 ON je2.user_id = a.user_id
     WHERE je2.id = journal_lines.entry_id AND a.account_code = '11102'),
    '匯豐銀行 HSBC')
WHERE account_code = '11101'
  AND entry_id IN (
    SELECT je.id FROM journal_entries je
    JOIN bank_transactions bt ON bt.id = je.reference_id AND bt.deleted_at IS NULL
    JOIN bank_statements bs ON bs.id = bt.bank_statement_id
    WHERE je.reference_type = 'bank_transaction' AND je.deleted_at IS NULL
      AND ((bt.deposit_amount > 0 AND journal_lines.debit > 0)
        OR (bt.withdrawal_amount > 0 AND journal_lines.credit > 0))
      AND (UPPER(COALESCE(bs.bank_name,'')) LIKE '%HSBC%'
        OR UPPER(COALESCE(bs.bank_name,'')) LIKE '%SHANGHAI BANKING%'
        OR COALESCE(bs.bank_name,'') LIKE '%滙豐%'
        OR COALESCE(bs.bank_name,'') LIKE '%汇丰%')
      AND EXISTS (SELECT 1 FROM journal_lines jl2 WHERE jl2.entry_id = je.id
        AND jl2.account_code != '11101' AND SUBSTR(jl2.account_code,1,1) != '1')
  );

-- 2b) Hang Seng statements → tenant's 11104 (16 JEs: u-a21aaae1, u-bf5c166e)
UPDATE journal_lines SET
  account_code = '11104',
  account_name = COALESCE(
    (SELECT a.account_name FROM accounts a
     JOIN journal_entries je2 ON je2.user_id = a.user_id
     WHERE je2.id = journal_lines.entry_id AND a.account_code = '11104'),
    '恒生銀行 Hang Seng Bank')
WHERE account_code = '11101'
  AND entry_id IN (
    SELECT je.id FROM journal_entries je
    JOIN bank_transactions bt ON bt.id = je.reference_id AND bt.deleted_at IS NULL
    JOIN bank_statements bs ON bs.id = bt.bank_statement_id
    WHERE je.reference_type = 'bank_transaction' AND je.deleted_at IS NULL
      AND ((bt.deposit_amount > 0 AND journal_lines.debit > 0)
        OR (bt.withdrawal_amount > 0 AND journal_lines.credit > 0))
      AND UPPER(COALESCE(bs.bank_name,'')) LIKE '%HANG SENG%'
      AND EXISTS (SELECT 1 FROM journal_lines jl2 WHERE jl2.entry_id = je.id
        AND jl2.account_code != '11101' AND SUBSTR(jl2.account_code,1,1) != '1')
  );

-- 2c) Bank of China, u-5bc78c1c → 11104 (6 JEs)
UPDATE journal_lines SET
  account_code = '11104',
  account_name = '中國銀行 Bank of China'
WHERE account_code = '11101'
  AND entry_id IN (
    SELECT je.id FROM journal_entries je
    JOIN bank_transactions bt ON bt.id = je.reference_id AND bt.deleted_at IS NULL
    JOIN bank_statements bs ON bs.id = bt.bank_statement_id
    WHERE je.reference_type = 'bank_transaction' AND je.deleted_at IS NULL
      AND je.user_id = 'u-5bc78c1c'
      AND ((bt.deposit_amount > 0 AND journal_lines.debit > 0)
        OR (bt.withdrawal_amount > 0 AND journal_lines.credit > 0))
      AND UPPER(COALESCE(bs.bank_name,'')) LIKE '%BANK OF CHINA%'
      AND EXISTS (SELECT 1 FROM journal_lines jl2 WHERE jl2.entry_id = je.id
        AND jl2.account_code != '11101' AND SUBSTR(jl2.account_code,1,1) != '1')
  );

-- 2d) Bank of China, u-a21aaae1 → 11105 (7 JEs)
UPDATE journal_lines SET
  account_code = '11105',
  account_name = '中國銀行 Bank of China'
WHERE account_code = '11101'
  AND entry_id IN (
    SELECT je.id FROM journal_entries je
    JOIN bank_transactions bt ON bt.id = je.reference_id AND bt.deleted_at IS NULL
    JOIN bank_statements bs ON bs.id = bt.bank_statement_id
    WHERE je.reference_type = 'bank_transaction' AND je.deleted_at IS NULL
      AND je.user_id = 'u-a21aaae1'
      AND ((bt.deposit_amount > 0 AND journal_lines.debit > 0)
        OR (bt.withdrawal_amount > 0 AND journal_lines.credit > 0))
      AND UPPER(COALESCE(bs.bank_name,'')) LIKE '%BANK OF CHINA%'
      AND EXISTS (SELECT 1 FROM journal_lines jl2 WHERE jl2.entry_id = je.id
        AND jl2.account_code != '11101' AND SUBSTR(jl2.account_code,1,1) != '1')
  );

-- 2e) Standard Chartered, u-a21aaae1 → 11106 (6 JEs)
UPDATE journal_lines SET
  account_code = '11106',
  account_name = '渣打銀行 Standard Chartered'
WHERE account_code = '11101'
  AND entry_id IN (
    SELECT je.id FROM journal_entries je
    JOIN bank_transactions bt ON bt.id = je.reference_id AND bt.deleted_at IS NULL
    JOIN bank_statements bs ON bs.id = bt.bank_statement_id
    WHERE je.reference_type = 'bank_transaction' AND je.deleted_at IS NULL
      AND je.user_id = 'u-a21aaae1'
      AND ((bt.deposit_amount > 0 AND journal_lines.debit > 0)
        OR (bt.withdrawal_amount > 0 AND journal_lines.credit > 0))
      AND UPPER(COALESCE(bs.bank_name,'')) LIKE '%STANDARD CHARTERED%'
      AND EXISTS (SELECT 1 FROM journal_lines jl2 WHERE jl2.entry_id = je.id
        AND jl2.account_code != '11101' AND SUBSTR(jl2.account_code,1,1) != '1')
  );

-- ── 3) Sync affected statements' persisted account_code ────────────────────
-- So PATCH-regen / auto-categorize don't reintroduce a wrong bank code.
-- HSBC-family statements with NULL/other code → 11102
UPDATE bank_statements SET account_code = '11102'
WHERE COALESCE(account_code,'') != '11102'
  AND id IN (
    SELECT DISTINCT bs.id FROM bank_statements bs
    JOIN bank_transactions bt ON bt.bank_statement_id = bs.id AND bt.deleted_at IS NULL
    JOIN journal_entries je ON je.reference_id = bt.id AND je.reference_type = 'bank_transaction' AND je.deleted_at IS NULL
    JOIN journal_lines jl_f ON jl_f.entry_id = je.id AND jl_f.account_code = '11102'
    WHERE (UPPER(COALESCE(bs.bank_name,'')) LIKE '%HSBC%'
      OR UPPER(COALESCE(bs.bank_name,'')) LIKE '%SHANGHAI BANKING%'
      OR COALESCE(bs.bank_name,'') LIKE '%滙豐%' OR COALESCE(bs.bank_name,'') LIKE '%汇丰%')
  );

-- Non-HSBC statements that were on 11101-fixed JEs now carry their per-bank code
UPDATE bank_statements SET account_code = '11104'
WHERE COALESCE(account_code,'11103') = '11103'
  AND id IN (
    SELECT DISTINCT bs.id FROM bank_statements bs
    JOIN bank_transactions bt ON bt.bank_statement_id = bs.id AND bt.deleted_at IS NULL
    JOIN journal_entries je ON je.reference_id = bt.id AND je.reference_type = 'bank_transaction' AND je.deleted_at IS NULL
    JOIN journal_lines jl_f ON jl_f.entry_id = je.id AND jl_f.account_code = '11104'
    JOIN accounts a ON a.user_id = bs.user_id AND a.account_code = '11104'
    WHERE UPPER(COALESCE(bs.bank_name,'')) LIKE '%HANG SENG%'
  );

UPDATE bank_statements SET account_code = '11105'
WHERE COALESCE(account_code,'11103') = '11103'
  AND id IN (
    SELECT DISTINCT bs.id FROM bank_statements bs
    JOIN bank_transactions bt ON bt.bank_statement_id = bs.id AND bt.deleted_at IS NULL
    JOIN journal_entries je ON je.reference_id = bt.id AND je.reference_type = 'bank_transaction' AND je.deleted_at IS NULL
    JOIN journal_lines jl_f ON jl_f.entry_id = je.id AND jl_f.account_code = '11105'
    JOIN accounts a ON a.user_id = bs.user_id AND a.account_code = '11105'
    WHERE UPPER(COALESCE(bs.bank_name,'')) LIKE '%BANK OF CHINA%'
  );

UPDATE bank_statements SET account_code = '11106'
WHERE COALESCE(account_code,'11103') = '11103'
  AND id IN (
    SELECT DISTINCT bs.id FROM bank_statements bs
    JOIN bank_transactions bt ON bt.bank_statement_id = bs.id AND bt.deleted_at IS NULL
    JOIN journal_entries je ON je.reference_id = bt.id AND je.reference_type = 'bank_transaction' AND je.deleted_at IS NULL
    JOIN journal_lines jl_f ON jl_f.entry_id = je.id AND jl_f.account_code = '11106'
    JOIN accounts a ON a.user_id = bs.user_id AND a.account_code = '11106'
    WHERE UPPER(COALESCE(bs.bank_name,'')) LIKE '%STANDARD CHARTERED%'
  );
