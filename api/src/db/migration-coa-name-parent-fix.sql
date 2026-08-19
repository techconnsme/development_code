-- Migration: Repair COA accounts created by the bank-statement auto-create path
-- Problem: file-storage.ts auto-creates accounts with account_name = account_code
--          and no parent_code, and never creates parent accounts.
-- Fix: (1) restore proper template names + parent_code for placeholder accounts,
--       (2) create missing parent accounts for the reported tenant.
-- Run with: wrangler d1 execute opcc-crm-db --remote --file=migration-coa-name-parent-fix.sql
-- Safe to re-run: idempotent

-- 1. Restore proper names + parents for placeholder accounts (account_name == account_code).
--    Generic across tenants — only touches rows that still have the code-as-name placeholder.
UPDATE accounts SET account_name = '董事往來-往來帳 Director Current A/C', parent_code = '31200'
WHERE account_code = '31201' AND account_name = account_code;

UPDATE accounts SET account_name = '銷售收入 Sales Revenue', parent_code = '41000'
WHERE account_code = '41200' AND account_name = account_code;

UPDATE accounts SET account_name = '銀行利息收入 Bank Interest', parent_code = '42100'
WHERE account_code = '42101' AND account_name = account_code;

-- 2. Create missing parent accounts for the reported tenant (u-83161e0c).
--    Covers the full missing chain so the COA tree renders correctly.
INSERT OR IGNORE INTO accounts (id, user_id, account_code, account_name, account_type, parent_code) VALUES
  ('fix-coa-11000', 'u-83161e0c', '11000', '流動資產 Current Assets', 'asset', '10000'),
  ('fix-coa-20000', 'u-83161e0c', '20000', '負債 Liabilities', 'liability', NULL),
  ('fix-coa-21000', 'u-83161e0c', '21000', '流動負債 Current Liabilities', 'liability', '20000'),
  ('fix-coa-21200', 'u-83161e0c', '21200', '其他應付款 Other Payables', 'liability', '21000'),
  ('fix-coa-30000', 'u-83161e0c', '30000', '資本及儲備 Equity & Reserves', 'equity', NULL),
  ('fix-coa-31000', 'u-83161e0c', '31000', '股本及往來 Share Capital & Current', 'equity', '30000'),
  ('fix-coa-31200', 'u-83161e0c', '31200', '董事往來 Director Current Account', 'equity', '31000'),
  ('fix-coa-42000', 'u-83161e0c', '42000', '其他收益 Other Income', 'revenue', '40000'),
  ('fix-coa-50000', 'u-83161e0c', '50000', '直接成本 Direct Costs', 'expense', NULL),
  ('fix-coa-51000', 'u-83161e0c', '51000', '服務成本 Cost of Services', 'expense', '50000'),
  ('fix-coa-51100', 'u-83161e0c', '51100', '外判及顧問費 Subcontractor & Consultant', 'expense', '51000'),
  ('fix-coa-62000', 'u-83161e0c', '62000', '辦公室支出 Office Costs', 'expense', '60000');