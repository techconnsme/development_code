-- Manual statement entry + file linking (2026-08-27)
-- Adds source_file_id (link to file_records) and source ('ocr' | 'manual') columns

ALTER TABLE bank_statements ADD COLUMN source_file_id TEXT;
ALTER TABLE bank_statements ADD COLUMN source TEXT;
ALTER TABLE card_statements ADD COLUMN source_file_id TEXT;
ALTER TABLE card_statements ADD COLUMN source TEXT;
ALTER TABLE invoices ADD COLUMN source TEXT;

UPDATE bank_statements SET source = 'ocr' WHERE source IS NULL;
UPDATE card_statements SET source = 'ocr' WHERE source IS NULL;
UPDATE invoices SET source = 'ocr' WHERE source IS NULL AND file_id IS NOT NULL;
UPDATE invoices SET source = 'manual' WHERE source IS NULL;

CREATE INDEX IF NOT EXISTS idx_bank_stmt_source_file ON bank_statements(source_file_id);
CREATE INDEX IF NOT EXISTS idx_card_stmt_source_file ON card_statements(source_file_id);
