-- Migration: Add card_statement_id to bank_transactions
-- Enables linking bank withdrawals (credit card payments) to card statements
ALTER TABLE bank_transactions ADD COLUMN card_statement_id TEXT REFERENCES card_statements(id);
CREATE INDEX IF NOT EXISTS idx_bt_card_statement ON bank_transactions(card_statement_id);
