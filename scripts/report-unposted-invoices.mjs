/**
 * READ-ONLY report: invoices that are finalised but have no General Ledger entry.
 *
 * Writes nothing. Every statement below is a SELECT. Run it, read the output,
 * and decide whether to backfill — do not wire this into anything automatic.
 *
 * Usage:  node scripts/report-unposted-invoices.mjs
 *         node scripts/report-unposted-invoices.mjs --detail    (per-invoice listing)
 *
 * Background: the invoice leg of double-entry never reached the ledger (the
 * posting path was unreachable four different ways), while the payment leg
 * posted automatically on bank reconciliation. That made AR and AP drift
 * negative. Code is fixed going forward; this reports the historical backlog.
 */

import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const API_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'api');
const DB = 'opcc-crm-db';

// Statuses that belong in the ledger — mirrors POSTABLE_STATUSES in
// api/src/lib/post-invoice.ts. Drafts and pending_review are excluded by design.
const POSTABLE = `('active','sent','paid','overdue')`;

// Built lazily: the "live entry" predicate depends on whether the tombstone
// migration has run (see HAS_DELETED_AT below).
const unposted = () => `
  i.deleted_at IS NULL
  AND i.status IN ${POSTABLE}
  AND i.total > 0
  AND NOT EXISTS (
    SELECT 1 FROM journal_entries je
    WHERE je.reference_type = 'invoice' AND je.reference_id = i.id AND ${JE_LIVE}
  )`;

function query(sql) {
  // Collapse to one line and wrap in double quotes — every SQL literal here uses
  // single quotes, so there is nothing to escape. Run from api/ so wrangler picks
  // up the right account and database binding.
  const oneLine = sql.replace(/\s+/g, ' ').trim();
  const out = execSync(
    `npx wrangler d1 execute ${DB} --remote --json --command "${oneLine}"`,
    { cwd: API_DIR, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] },
  );
  return JSON.parse(out.slice(out.indexOf('[')))[0].results ?? [];
}

const money = (n) => (n ?? 0).toLocaleString('en-HK', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// The deleted_at tombstone migration may or may not have been applied yet, so
// probe for the column and pick the matching "live entry" predicate. Lets this
// report run before, during, or after the migration.
const HAS_DELETED_AT = query('PRAGMA table_info(journal_entries)').some((c) => c.name === 'deleted_at');
const JE_LIVE = HAS_DELETED_AT ? 'je.deleted_at IS NULL' : `je.status != 'stale'`;
const JE_POSTED = HAS_DELETED_AT
  ? `je.deleted_at IS NULL AND je.status IN ('posted','reconciled')`
  : `je.status != 'stale'`;

console.log('\nREAD-ONLY — no data is modified by this script.');
console.log(`Tombstone migration applied: ${HAS_DELETED_AT ? 'yes (deleted_at)' : 'no (still status=stale)'}\n`);

// ── 1. Backlog summary ────────────────────────────────────────────────────
const summary = query(`
  SELECT i.user_id, i.direction, COUNT(*) AS n, ROUND(SUM(i.total),2) AS total
  FROM invoices i WHERE ${unposted()}
  GROUP BY i.user_id, i.direction ORDER BY i.user_id, i.direction`);

if (summary.length === 0) {
  console.log('No unposted invoices. Nothing to backfill.\n');
  process.exit(0);
}

console.log('UNPOSTED INVOICES (finalised, no GL entry)');
console.log('-'.repeat(64));
console.log('tenant'.padEnd(16), 'direction'.padEnd(11), 'count'.padStart(6), 'total'.padStart(16));
for (const r of summary) {
  console.log(String(r.user_id).padEnd(16), String(r.direction ?? '?').padEnd(11), String(r.n).padStart(6), money(r.total).padStart(16));
}

// ── 2. Effect on AR/AP ────────────────────────────────────────────────────
// An outgoing invoice debits AR (11201); an incoming one credits AP (21101).
// So backfilling raises each balance by the corresponding unposted total.
const current = query(`
  SELECT je.user_id,
    ROUND(SUM(CASE WHEN jl.account_code LIKE '112%' THEN jl.debit - jl.credit ELSE 0 END),2) AS ar,
    ROUND(SUM(CASE WHEN jl.account_code LIKE '211%' THEN jl.credit - jl.debit ELSE 0 END),2) AS ap
  FROM journal_lines jl JOIN journal_entries je ON jl.entry_id = je.id
  WHERE ${JE_POSTED}
    AND (jl.account_code LIKE '112%' OR jl.account_code LIKE '211%')
  GROUP BY je.user_id`);

const cur = new Map(current.map((r) => [r.user_id, r]));
const delta = new Map();
for (const r of summary) {
  const d = delta.get(r.user_id) ?? { ar: 0, ap: 0, orphanAr: 0, orphanAp: 0 };
  if (r.direction === 'outgoing') d.ar += r.total ?? 0;
  else if (r.direction === 'incoming') d.ap += r.total ?? 0;
  delta.set(r.user_id, d);
}

// Payments whose invoice was deleted while the entry stayed live. These debit AP
// (or credit AR) with nothing to offset them, so tombstoning them — what
// migration step 3 does — moves the balance back by the same amount.
// NB: only the AR/AP leg is selected, so debit+credit IS the entry amount (one
// side is always zero). Do not halve it — that would assume both legs are summed.
// Also: no `--` comments inside these SQL strings; query() collapses them to one
// line, which would swallow the rest of the statement.
const orphans = query(`
  SELECT je.user_id, i.direction, ROUND(SUM(jl.debit + jl.credit), 2) AS amount
  FROM journal_entries je
  JOIN journal_lines jl ON jl.entry_id = je.id
  JOIN bank_transactions bt ON bt.id = je.reference_id
  JOIN invoices i ON i.id = bt.invoice_id
  WHERE je.reference_type = 'payment' AND ${JE_LIVE} AND i.deleted_at IS NOT NULL
    AND (jl.account_code LIKE '112%' OR jl.account_code LIKE '211%')
  GROUP BY je.user_id, i.direction`);

for (const o of orphans) {
  const d = delta.get(o.user_id) ?? { ar: 0, ap: 0, orphanAr: 0, orphanAp: 0 };
  // An orphaned AP payment left a debit behind; removing it raises AP. Same for AR.
  if (o.direction === 'incoming') d.orphanAp += o.amount ?? 0;
  else d.orphanAr += o.amount ?? 0;
  delta.set(o.user_id, d);
}

console.log('\n\nPROJECTED AR / AP  (backfill + orphaned-payment cleanup)');
console.log('-'.repeat(94));
console.log('tenant'.padEnd(14), 'AR now'.padStart(13), 'AR after'.padStart(13), 'AP now'.padStart(13), 'AP after'.padStart(13), '  orphans removed');
for (const [tenant, d] of delta) {
  const c = cur.get(tenant) ?? { ar: 0, ap: 0 };
  const arAfter = (c.ar ?? 0) + d.ar + d.orphanAr;
  const apAfter = (c.ap ?? 0) + d.ap + d.orphanAp;
  const orphan = d.orphanAr + d.orphanAp;
  const flag = arAfter < 0 || apAfter < 0 ? '  <-- STILL NEGATIVE, needs review' : '';
  console.log(
    String(tenant).padEnd(14),
    money(c.ar).padStart(13), money(arAfter).padStart(13),
    money(c.ap).padStart(13), money(apAfter).padStart(13),
    (orphan ? money(orphan) : '-').padStart(16), flag,
  );
}

// ── 3. Per-invoice detail (opt-in) ────────────────────────────────────────
if (process.argv.includes('--detail')) {
  const rows = query(`
    SELECT i.user_id, i.id, i.invoice_number, i.issue_date, i.direction, i.status,
           i.total, COALESCE(i.expense_category,'general') AS cat
    FROM invoices i WHERE ${unposted()}
    ORDER BY i.user_id, i.issue_date LIMIT 500`);

  console.log('\n\nPER-INVOICE DETAIL — entries that WOULD be created');
  console.log('-'.repeat(104));
  for (const r of rows) {
    // Mirrors the account mapping in api/src/lib/post-invoice.ts
    const expenseMap = { cash: '67001', reimburse: '61203', director: '21201' };
    const [dr, cr] = r.direction === 'incoming'
      ? [expenseMap[r.cat] ?? '66203', '21101']
      : ['11201', '41101'];
    console.log(
      String(r.user_id).padEnd(14),
      String(r.invoice_number ?? '').padEnd(20),
      String(r.issue_date ?? '').padEnd(11),
      String(r.status).padEnd(9),
      money(r.total).padStart(14),
      ` Dr ${dr} / Cr ${cr}`,
    );
  }
  if (rows.length === 500) console.log('\n(truncated at 500 rows)');
}

console.log('\nNothing was written. Review the above before deciding on a backfill.\n');
