CREATE TABLE IF NOT EXISTS journal_entry_files (
  entry_id        TEXT NOT NULL REFERENCES journal_entries(id) ON DELETE CASCADE,
  file_record_id  TEXT NOT NULL REFERENCES file_records(id),
  attached_at     TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (entry_id, file_record_id)
);
CREATE INDEX IF NOT EXISTS idx_jef_file ON journal_entry_files(file_record_id);

ALTER TABLE journal_entries ADD COLUMN created_by TEXT;

UPDATE journal_entries SET entry_source = 'manual'
WHERE entry_source = 'auto' AND reference_type IS NULL;
