-- journal_entries.entry_source: distinguishes engine-generated entries ('auto',
-- the historical default) from user-built multi-line postings ('manual') created
-- via PUT /transactions/:id/posting. Automation (regen, auto-categorize,
-- post-to-GL) must never overwrite manual entries.
ALTER TABLE journal_entries ADD COLUMN entry_source TEXT NOT NULL DEFAULT 'auto';
