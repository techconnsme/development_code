import { v4 as uuidv4 } from 'uuid';
import { ensureMissingAccounts } from './ensure-accounts';
import { jeLive } from './journal-filters';

/**
 * Shared GL posting for an invoice — the leg that CREATES the receivable or
 * payable. Its counterpart is postPaymentToGl(), which posts the leg that
 * SETTLES it.
 *
 * Both legs must exist or AR/AP go one-sided. Historically only the payment leg
 * posted (it runs automatically on bank match-confirm), while this one was
 * reachable only through a transient "Post to GL" button that appeared for a
 * few seconds after saving an invoice review — a page most invoices never visit,
 * because clean OCR imports are written straight to status='active'. The result
 * was zero invoice entries in the ledger and permanently negative AR/AP.
 *
 * NOTE: journal_lines has NO `project` column in the live D1 schema. The old
 * inline post-invoice INSERT referenced one, so every call threw
 * "no column named project" — meaning even clicking the button failed. This is
 * the same defect post-payment.ts hit on 2026-08-17; the columns below are
 * deliberately limited to what the live schema actually has.
 *
 * Idempotent: returns the existing entry instead of creating a duplicate.
 */

/**
 * Statuses an invoice must reach before it belongs in the ledger.
 * 'draft' and 'pending_review' are deliberately excluded — unreviewed OCR
 * output must not reach the books. 'cancelled'/'void' never post.
 */
const POSTABLE_STATUSES = ['active', 'sent', 'paid', 'overdue'];

export async function postInvoiceToGl(
  db: D1Database,
  tenantId: string,
  invoiceId: string,
): Promise<{ entry_id: string; entry_number: string; already_posted?: boolean; not_postable?: string; error?: string }> {
  const inv = await db.prepare(
    'SELECT * FROM invoices WHERE id = ? AND user_id = ? AND deleted_at IS NULL'
  ).bind(invoiceId, tenantId).first<{
    id: string; invoice_number: string; issue_date: string; total: number;
    customer_id: string; direction: string; expense_category: string; notes: string; status: string;
  }>();
  if (!inv) return { error: 'Invoice not found', entry_id: '', entry_number: '' };

  // Idempotency: one invoice JE per invoice. Tombstoned entries don't count, so
  // a deleted-then-restored invoice can still be re-posted.
  const existing = await db.prepare(
    `SELECT id, entry_number FROM journal_entries
     WHERE reference_type = 'invoice' AND reference_id = ? AND user_id = ?
     AND ${jeLive('journal_entries')}`
  ).bind(invoiceId, tenantId).first<{ id: string; entry_number: string }>();
  if (existing) {
    return { entry_id: existing.id, entry_number: existing.entry_number, already_posted: true };
  }

  if (!POSTABLE_STATUSES.includes(inv.status)) {
    return { entry_id: '', entry_number: '', not_postable: inv.status };
  }

  if (!inv.total || inv.total <= 0) {
    return { entry_id: '', entry_number: '', error: 'Invoice has no amount to post' };
  }

  const jeId = `je-${uuidv4().slice(0, 8)}`;
  const jeNum = `JE-INV-${inv.invoice_number}`;
  const isIncoming = inv.direction === 'incoming';
  const expenseCat = inv.expense_category || 'general';

  // Map expense_category to expense account
  const expenseAccountMap: Record<string, string> = {
    cash: '67001',       // Petty Cash Expenses
    reimburse: '61203',  // Employee Reimbursements
    director: '21201',   // Director Loan / Current Account
  };
  const expenseAccount = isIncoming ? (expenseAccountMap[expenseCat] || '66203') : '11201';
  const expenseAccountName = isIncoming
    ? (expenseCat === 'cash' ? 'Petty Cash Expenses' : expenseCat === 'reimburse' ? 'Employee Reimbursements' : expenseCat === 'director' ? 'Director Current Account' : 'Miscellaneous Expenses')
    : 'Trade Debtors 應收賬款';

  if (isIncoming) {
    // AP invoice: Dr Expense / Cr Trade Creditors
    await ensureMissingAccounts(db, tenantId, [expenseAccount, '21101'], [0]);
    await db.prepare(
      'INSERT INTO journal_entries (id, user_id, entry_number, entry_date, description, reference_type, reference_id) VALUES (?,?,?,?,?,?,?)'
    ).bind(jeId, tenantId, jeNum, inv.issue_date, `AP Invoice ${inv.invoice_number}: ${inv.notes || 'Supplier bill'}`, 'invoice', invoiceId).run();
    // Dr Expense
    await db.prepare(
      'INSERT INTO journal_lines (id, entry_id, account_code, account_name, description, debit, credit, sort_order) VALUES (?,?,?,?,?,?,?,?)'
    ).bind(`jl-${uuidv4().slice(0, 8)}`, jeId, expenseAccount, expenseAccountName, inv.invoice_number, inv.total, 0, 0).run();
    // Cr AP
    await db.prepare(
      'INSERT INTO journal_lines (id, entry_id, account_code, account_name, description, debit, credit, sort_order) VALUES (?,?,?,?,?,?,?,?)'
    ).bind(`jl-${uuidv4().slice(0, 8)}`, jeId, '21101', 'Trade Creditors 應付賬款', inv.invoice_number, 0, inv.total, 1).run();
  } else {
    // AR invoice: Dr AR / Cr Revenue
    await ensureMissingAccounts(db, tenantId, ['11201', '41101'], [0]);
    await db.prepare(
      'INSERT INTO journal_entries (id, user_id, entry_number, entry_date, description, reference_type, reference_id) VALUES (?,?,?,?,?,?,?)'
    ).bind(jeId, tenantId, jeNum, inv.issue_date, `Invoice ${inv.invoice_number}: ${inv.notes || 'Services'}`, 'invoice', invoiceId).run();
    // Dr AR
    await db.prepare(
      'INSERT INTO journal_lines (id, entry_id, account_code, account_name, description, debit, credit, sort_order) VALUES (?,?,?,?,?,?,?,?)'
    ).bind(`jl-${uuidv4().slice(0, 8)}`, jeId, '11201', 'Trade Debtors 應收賬款', inv.invoice_number, inv.total, 0, 0).run();
    // Cr Revenue
    await db.prepare(
      'INSERT INTO journal_lines (id, entry_id, account_code, account_name, description, debit, credit, sort_order) VALUES (?,?,?,?,?,?,?,?)'
    ).bind(`jl-${uuidv4().slice(0, 8)}`, jeId, '41101', 'Professional Services 專業服務收入', inv.invoice_number, 0, inv.total, 1).run();
  }

  return { entry_id: jeId, entry_number: jeNum };
}

/**
 * Fire-and-forget wrapper for the automatic call sites (invoice confirm, clean
 * OCR import). Posting must never break the user's primary action, so failures
 * are logged and swallowed — the manual "Post to GL" control remains available
 * as the recovery path.
 */
export async function tryPostInvoiceToGl(db: D1Database, tenantId: string, invoiceId: string): Promise<void> {
  try {
    const r = await postInvoiceToGl(db, tenantId, invoiceId);
    if (r.error) console.warn(`[post-invoice] ${invoiceId}: ${r.error}`);
    else if (r.not_postable) console.log(`[post-invoice] ${invoiceId}: skipped, status=${r.not_postable}`);
  } catch (e: any) {
    console.error(`[post-invoice] ${invoiceId} threw:`, e?.message || e);
  }
}
