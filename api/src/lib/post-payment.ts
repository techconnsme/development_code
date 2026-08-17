import { v4 as uuidv4 } from 'uuid';

// Shared GL payment posting for a confirmed bank-transaction ↔ invoice match.
// Used by the unified confirm flow (PATCH /bank-statements/transactions/:id/match)
// and kept behind POST /bookkeeping/post-payment/:txId for backward compatibility.
// Idempotent: returns the existing entry if the payment was already posted.
// NOTE: journal_lines has NO `project` column in the live D1 schema — the old
// inline post-payment INSERT referenced one and silently 500'd (2026-08-17).
export async function postPaymentToGl(
  db: D1Database,
  tenantId: string,
  txId: string,
): Promise<{ entry_id: string; entry_number: string; already_posted?: boolean; error?: string }> {
  const tx = await db.prepare(
    `SELECT bt.*, i.invoice_number, i.total as invoice_total, i.direction,
     bs.account_code as bank_account_code
     FROM bank_transactions bt
     LEFT JOIN invoices i ON bt.invoice_id = i.id
     LEFT JOIN bank_statements bs ON bt.bank_statement_id = bs.id
     WHERE bt.id = ? AND bt.user_id = ? AND bt.match_status = 'confirmed' AND bt.deleted_at IS NULL`
  ).bind(txId, tenantId).first<{ id: string; transaction_date: string; deposit_amount: number; withdrawal_amount: number; invoice_id: string; invoice_number: string; invoice_total: number; direction: string; bank_account_code: string | null }>();
  if (!tx || !tx.invoice_id) return { error: 'Transaction not found or not matched to an invoice', entry_id: '', entry_number: '' };

  // Idempotency: one payment JE per transaction
  const existing = await db.prepare(
    "SELECT id, entry_number FROM journal_entries WHERE reference_type = 'payment' AND reference_id = ? AND user_id = ?"
  ).bind(txId, tenantId).first<{ id: string; entry_number: string }>();
  if (existing) return { entry_id: existing.id, entry_number: existing.entry_number, already_posted: true };

  const isDeposit = tx.deposit_amount > 0;
  const amount = isDeposit ? tx.deposit_amount : tx.withdrawal_amount;
  const bankAccount = tx.bank_account_code || '11101';
  const jeId = `je-${uuidv4().slice(0, 8)}`;
  const jeNum = `JE-PMT-${tx.invoice_number || txId.slice(0, 8)}`;

  if (isDeposit) {
    // AR: customer paid us → Dr Bank / Cr AR
    await db.prepare(
      'INSERT INTO journal_entries (id, user_id, entry_number, entry_date, description, reference_type, reference_id) VALUES (?,?,?,?,?,?,?)'
    ).bind(jeId, tenantId, jeNum, tx.transaction_date, `Payment received for invoice ${tx.invoice_number || ''}`, 'payment', txId).run();
    await db.prepare(
      'INSERT INTO journal_lines (id, entry_id, account_code, account_name, description, debit, credit, sort_order) VALUES (?,?,?,?,?,?,?,?)'
    ).bind(`jl-${uuidv4().slice(0, 8)}`, jeId, bankAccount, 'Bank', tx.invoice_number || '', amount, 0, 0).run();
    await db.prepare(
      'INSERT INTO journal_lines (id, entry_id, account_code, account_name, description, debit, credit, sort_order) VALUES (?,?,?,?,?,?,?,?)'
    ).bind(`jl-${uuidv4().slice(0, 8)}`, jeId, '11201', 'Trade Debtors', tx.invoice_number || '', 0, amount, 1).run();
  } else {
    // AP: we paid supplier → Dr AP / Cr Bank
    await db.prepare(
      'INSERT INTO journal_entries (id, user_id, entry_number, entry_date, description, reference_type, reference_id) VALUES (?,?,?,?,?,?,?)'
    ).bind(jeId, tenantId, jeNum, tx.transaction_date, `Payment for AP invoice ${tx.invoice_number || ''}`, 'payment', txId).run();
    await db.prepare(
      'INSERT INTO journal_lines (id, entry_id, account_code, account_name, description, debit, credit, sort_order) VALUES (?,?,?,?,?,?,?,?)'
    ).bind(`jl-${uuidv4().slice(0, 8)}`, jeId, '21101', 'Trade Creditors', tx.invoice_number || '', amount, 0, 0).run();
    await db.prepare(
      'INSERT INTO journal_lines (id, entry_id, account_code, account_name, description, debit, credit, sort_order) VALUES (?,?,?,?,?,?,?,?)'
    ).bind(`jl-${uuidv4().slice(0, 8)}`, jeId, bankAccount, 'Bank', tx.invoice_number || '', 0, amount, 1).run();
  }

  return { entry_id: jeId, entry_number: jeNum };
}
