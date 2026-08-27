-- migration-journal-entry-snapshots.sql
-- Stores field-level snapshots for journal entry audit trail

CREATE TABLE IF NOT EXISTS journal_entry_snapshots (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  entry_id TEXT NOT NULL REFERENCES journal_entries(id) ON DELETE CASCADE,
  snapshot TEXT NOT NULL,
  action TEXT NOT NULL,
  changed_fields TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_je_snapshots_entry ON journal_entry_snapshots(entry_id, created_at);