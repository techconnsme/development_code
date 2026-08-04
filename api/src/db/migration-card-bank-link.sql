-- Migration: Add bank_transaction_id linkage to card_transactions
-- Enables linking credit card payments back to bank statement transactions

ALTER TABLE card_transactions ADD COLUMN bank_transaction_id TEXT;
ALTER TABLE card_transactions ADD COLUMN file_id TEXT;

-- Also add file_id to bank_statements and card_statements for document linkage
ALTER TABLE bank_statements ADD COLUMN file_id TEXT;
ALTER TABLE card_statements ADD COLUMN file_id TEXT;
