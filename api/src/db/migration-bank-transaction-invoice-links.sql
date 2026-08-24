-- bank_transaction_invoice_links: direction-agnostic tx↔invoice membership.
-- One row per invoice settled by a bank transaction. 1:1 matches keep using
-- bank_transactions.invoice_id; a GROUP match = match_status='confirmed' +
-- N rows here + bt.invoice_id left NULL. allocated_amount == invoice total
-- this round (full settlement); the N:1 split-payment fast-follow reuses the
-- same rows with allocated_amount < total.
CREATE TABLE IF NOT EXISTS bank_transaction_invoice_links (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  transaction_id TEXT NOT NULL,
  invoice_id TEXT NOT NULL,
  allocated_amount REAL NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_btil_tx ON bank_transaction_invoice_links(transaction_id);
CREATE INDEX IF NOT EXISTS idx_btil_inv ON bank_transaction_invoice_links(invoice_id);
