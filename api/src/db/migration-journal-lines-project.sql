-- Add project column to journal_lines
-- Run: npx wrangler d1 execute oppc-crm-db --remote --file=src/db/migration-journal-lines-project.sql

ALTER TABLE journal_lines ADD COLUMN project TEXT;
