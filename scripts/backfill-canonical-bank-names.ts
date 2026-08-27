/**
 * One-off backfill: canonicalize bank_statements.bank_name so all statements
 * of the same account share one name (differing only by year-month prefix).
 *
 * Run: npx --yes tsx scripts/backfill-canonical-bank-names.ts
 * Input: %TEMP%\bank-names.json — JSON array of { bank_name, cnt } rows from:
 *   SELECT bank_name, COUNT(*) AS cnt FROM bank_statements
 *   WHERE bank_name IS NOT NULL AND bank_name != '' GROUP BY bank_name
 *
 * Prints a dry-run mapping and the UPDATE statements; execute the SQL via
 * `wrangler d1 execute opcc-crm-db --remote` after review.
 */
import fs from 'fs';
import { normalizeBankNameForStorage } from '../api/src/lib/company-matcher';

interface Row { bank_name: string; cnt: number }

const raw = fs.readFileSync(process.env.TEMP + '\\bank-names.json', 'utf8').replace(/^﻿/, '');
const rows: Row[] = JSON.parse(raw);

const sqlEsc = (s: string) => s.replace(/'/g, "''");
const updates: string[] = [];

console.log('current bank_name'.padEnd(75) + '| rows | canonical');
console.log('-'.repeat(130));
for (const r of rows) {
  const canonical = normalizeBankNameForStorage(r.bank_name);
  const changed = canonical !== r.bank_name;
  console.log(
    JSON.stringify(r.bank_name).padEnd(75) + '| ' + String(r.cnt).padStart(4) + ' | ' +
    (changed ? JSON.stringify(canonical) : '(unchanged)'),
  );
  if (changed) {
    updates.push(
      `UPDATE bank_statements SET bank_name = '${sqlEsc(canonical!)}', updated_at = datetime('now') ` +
      `WHERE bank_name = '${sqlEsc(r.bank_name)}';`,
    );
  }
}

console.log('\n-- SQL (includes soft-deleted rows so restores stay consistent):');
console.log(updates.length ? updates.join('\n') : '-- nothing to update');
