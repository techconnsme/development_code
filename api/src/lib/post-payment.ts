import { v4 as uuidv4 } from 'uuid';
import { jeLive } from './journal-filters';

// Shared GL payment posting for a confirmed bank-transaction ↔ invoice match.
// Used by the unified confirm flow (PATCH /bank-statements/transactions/:id/match)
// and kept behind POST /bookkeeping/post-payment/:txId for backward compatibility.
// Idempotent: returns the existing entry if the payment was already posted.
// Supports two shapes: 1:1 tx→invoice (single Dr/Cr pair, JE-PMT-<invoice_number>)
// and combined payments (N junction rows in bank_transaction_invoice_links,
// one JE with N contra lines + one bank line, JE-PMT-MULTI-<txId8>).
// NOTE: journal_lines has NO `project` column in the live D1 schema — the old
// inline post-payment INSERT referenced one and silently 500'd (2026-08-17).
export async function postPaymentToGl(
  db: D1Database,
  tenantId: string,
  txId: string,
): Promise<{ entry_id: string; entry_number: string; already_posted?: boolean; error?: string }> {
  const base = await db.prepare(
    `SELECT bt.*, bs.account_code as bank_account_code
     FROM bank_transactions bt
     LEFT JOIN bank_statements bs ON bt.bank_statement_id = bs.id
     WHERE bt.id = ? AND bt.user_id = ? AND bt.match_status = 'confirmed' AND bt.deleted_at IS NULL`
  ).bind(txId, tenantId).first<{ id: string; transaction_date: string; deposit_amount: number; withdrawal_amount: number; invoice_id: string | null; bank_account_code: string | null }>();
  if (!base) return { error: 'Transaction not found or not matched', entry_id: '', entry_number: '' };

  // Idempotency: one payment JE per transaction. Tombstoned entries don't count —
  // otherwise a deleted-then-restored statement could never be re-posted.
  // Stays AFTER the base-tx fetch, BEFORE any INSERT (original file order).
  const existing = await db.prepare(
    `SELECT id, entry_number FROM journal_entries
     WHERE reference_type = 'payment' AND reference_id = ? AND user_id = ?
     AND ${jeLive('journal_entries')}`
  ).bind(txId, tenantId).first<{ id: string; entry_number: string }>();
  if (existing) return { entry_id: existing.id, entry_number: existing.entry_number, already_posted: true };

  const isDeposit = base.deposit_amount > 0;
  const amount = isDeposit ? base.deposit_amount : base.withdrawal_amount;
  const bankAccount = base.bank_account_code || '11101';
  const jeId = `je-${uuidv4().slice(0, 8)}`;

  // GROUP path: confirmed tx with junction rows and NULL invoice_id
  let links: { invoice_id: string; allocated_amount: number; invoice_number: string }[] = [];
  if (!base.invoice_id) {
    const lr = await db.prepare(
      `SELECT l.invoice_id, l.allocated_amount, i.invoice_number
       FROM bank_transaction_invoice_links l JOIN invoices i ON l.invoice_id = i.id
       WHERE l.transaction_id = ? AND l.user_id = ?
       ORDER BY l.allocated_amount DESC`
    ).bind(txId, tenantId).all<{ invoice_id: string; allocated_amount: number; invoice_number: string }>();
    links = lr.results || [];
    if (links.length === 0) return { error: 'Transaction not found or not matched to an invoice', entry_id: '', entry_number: '' };
  }

  if (links.length > 0) {
    const jeNum = `JE-PMT-MULTI-${txId.slice(0, 8)}`;
    const nums = links.map(l => l.invoice_number).join(', ');
    const desc = `Combined payment for ${links.length} invoices: ${nums}`;
    await db.prepare(
      'INSERT INTO journal_entries (id, user_id, entry_number, entry_date, description, reference_type, reference_id) VALUES (?,?,?,?,?,?,?)'
    ).bind(jeId, tenantId, jeNum, base.transaction_date, desc, 'payment', txId).run();

    let sort = 0;
    const line = (accountCode: string, accountName: string, lineDesc: string, debit: number, credit: number) =>
      db.prepare(
        'INSERT INTO journal_lines (id, entry_id, account_code, account_name, description, debit, credit, sort_order) VALUES (?,?,?,?,?,?,?,?)'
      ).bind(`jl-${uuidv4().slice(0, 8)}`, jeId, accountCode, accountName, lineDesc, debit, credit, sort++).run();

    if (isDeposit) {
      await line(bankAccount, 'Bank', nums.slice(0, 120), amount, 0);
      for (const l of links) await line('11201', 'Trade Debtors', l.invoice_number, 0, l.allocated_amount);
    } else {
      for (const l of links) await line('21101', 'Trade Creditors', l.invoice_number, l.allocated_amount, 0);
      await line(bankAccount, 'Bank', nums.slice(0, 120), 0, amount);
    }
    return { entry_id: jeId, entry_number: jeNum };
  }

  // Legacy 1:1 path — fetch the linked invoice exactly as before and reuse the
  // original single-pair posting below unchanged.
  const inv = await db.prepare(
    'SELECT invoice_number, total, direction FROM invoices WHERE id = ? AND user_id = ?'
  ).bind(base.invoice_id, tenantId).first<{ invoice_number: string; total: number; direction: string }>();
  if (!inv) return { error: 'Transaction not found or not matched to an invoice', entry_id: '', entry_number: '' };

  const jeNum = `JE-PMT-${inv.invoice_number || txId.slice(0, 8)}`;

  if (isDeposit) {
    // AR: customer paid us → Dr Bank / Cr AR
    await db.prepare(
      'INSERT INTO journal_entries (id, user_id, entry_number, entry_date, description, reference_type, reference_id) VALUES (?,?,?,?,?,?,?)'
    ).bind(jeId, tenantId, jeNum, base.transaction_date, `Payment received for invoice ${inv.invoice_number || ''}`, 'payment', txId).run();
    await db.prepare(
      'INSERT INTO journal_lines (id, entry_id, account_code, account_name, description, debit, credit, sort_order) VALUES (?,?,?,?,?,?,?,?)'
    ).bind(`jl-${uuidv4().slice(0, 8)}`, jeId, bankAccount, 'Bank', inv.invoice_number || '', amount, 0, 0).run();
    await db.prepare(
      'INSERT INTO journal_lines (id, entry_id, account_code, account_name, description, debit, credit, sort_order) VALUES (?,?,?,?,?,?,?,?)'
    ).bind(`jl-${uuidv4().slice(0, 8)}`, jeId, '11201', 'Trade Debtors', inv.invoice_number || '', 0, amount, 1).run();
  } else {
    // AP: we paid supplier → Dr AP / Cr Bank
    await db.prepare(
      'INSERT INTO journal_entries (id, user_id, entry_number, entry_date, description, reference_type, reference_id) VALUES (?,?,?,?,?,?,?)'
    ).bind(jeId, tenantId, jeNum, base.transaction_date, `Payment for AP invoice ${inv.invoice_number || ''}`, 'payment', txId).run();
    await db.prepare(
      'INSERT INTO journal_lines (id, entry_id, account_code, account_name, description, debit, credit, sort_order) VALUES (?,?,?,?,?,?,?,?)'
    ).bind(`jl-${uuidv4().slice(0, 8)}`, jeId, '21101', 'Trade Creditors', inv.invoice_number || '', amount, 0, 0).run();
    await db.prepare(
      'INSERT INTO journal_lines (id, entry_id, account_code, account_name, description, debit, credit, sort_order) VALUES (?,?,?,?,?,?,?,?)'
    ).bind(`jl-${uuidv4().slice(0, 8)}`, jeId, bankAccount, 'Bank', inv.invoice_number || '', 0, amount, 1).run();
  }

  return { entry_id: jeId, entry_number: jeNum };
}
