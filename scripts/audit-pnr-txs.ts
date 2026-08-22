/**
 * One-off audit: re-categorize PNR bank transactions with the shared engine.
 * Run: npx --yes tsx scripts/audit-pnr-txs.ts  (reads %TEMP%\pnr-txs.json)
 */
import fs from 'fs';
import { categorizeTransaction } from '../api/src/lib/transaction-categorizer';

interface Tx {
  id: string;
  bank_statement_id: string;
  transaction_date: string;
  description: string;
  deposit_amount: number;
  withdrawal_amount: number;
  account_code: string | null;
  invoice_id: string | null;
  bank_name: string | null;
}

const raw = fs.readFileSync(process.env.TEMP + '\\pnr-txs.json', 'utf8').replace(/^\uFEFF/, '');
const rows: Tx[] = JSON.parse(raw);
let changes = 0, same = 0, empty = 0, skippedInvoice = 0;

console.log('id        | date       | dir | old     | new (conf)         | tag                | description');
console.log('-'.repeat(120));
for (const tx of rows) {
  const dir = tx.deposit_amount > 0 ? 'deposit' : 'withdrawal';
  const r = categorizeTransaction(tx.description || '', dir);
  const newCode = r && r.code !== '' ? r.code : null;
  const tag = r?.tag || 'UNCATEGORIZED';
  const conf = r ? `(${r.confidence})` : '';
  const desc1 = (tx.description || '').replace(/\s+/g, ' ').slice(0, 42);

  if (tx.invoice_id) { skippedInvoice++; continue; }

  if (!newCode) { empty++; }
  if ((tx.account_code || null) === newCode) { same++; continue; }
  changes++;
  console.log(`${tx.id.padEnd(9)} | ${tx.transaction_date} | ${(dir === 'deposit' ? 'DEP' : 'WDR')} | ${(tx.account_code || '—').padEnd(7)} | ${(newCode || '—').padEnd(18)} | ${tag.padEnd(18)} | ${desc1}`);
}
console.log('-'.repeat(120));
console.log(`total=${rows.length} changes=${changes} already-ok=${same} uncategorized-by-engine=${empty} invoice-matched-skipped=${skippedInvoice}`);
