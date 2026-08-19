/**
 * Journal-entry lifecycle for invoices — the counterpart to what
 * routes/bank-statements.ts already does for statements.
 *
 * Deleting an invoice used to leave its ledger entries live. Payments would
 * keep debiting AP (or crediting AR) with no invoice left to offset them, so the
 * balance stayed permanently wrong. On tenant u-83161e0c that accounted for
 * exactly 55,500 of a 35,900 AP shortfall (netted against genuine unpaid bills).
 * Purge made it unrecoverable: the invoice row was hard-deleted while its
 * payment entry survived, orphaned and untraceable.
 *
 * Two kinds of entry belong to an invoice:
 *   - its own entry            reference_type='invoice', reference_id=<invoice id>
 *   - the payments settling it reference_type='payment',  reference_id=<bank_transaction id>
 *     (reachable only through bank_transactions.invoice_id)
 */

/**
 * Entries belonging to an invoice. `liveTxOnly` restricts the payment side to
 * transactions that still exist — used on restore, so a payment whose bank
 * statement is still deleted is not revived by restoring the invoice.
 */
function relatedEntriesPredicate(liveTxOnly = false): string {
  const txFilter = liveTxOnly ? ' AND bt.deleted_at IS NULL' : '';
  return `(
    (reference_type = 'invoice' AND reference_id = ?)
    OR (reference_type = 'payment' AND reference_id IN (
      SELECT bt.id FROM bank_transactions bt WHERE bt.invoice_id = ? AND bt.user_id = ?${txFilter}
    ))
  )`;
}

/** Tombstone an invoice's ledger entries when the invoice is soft-deleted. */
export async function tombstoneInvoiceJournal(
  db: D1Database, tenantId: string, invoiceId: string, now: string,
): Promise<number> {
  const r = await db.prepare(
    `UPDATE journal_entries SET deleted_at = ?, updated_at = ?
     WHERE user_id = ? AND deleted_at IS NULL AND ${relatedEntriesPredicate()}`
  ).bind(now, now, tenantId, invoiceId, invoiceId, tenantId).run();
  return r.meta?.changes || 0;
}

/**
 * Revive an invoice's ledger entries when the invoice is restored.
 * Payment entries come back only if their bank transaction is still live.
 */
export async function restoreInvoiceJournal(
  db: D1Database, tenantId: string, invoiceId: string,
): Promise<number> {
  const r = await db.prepare(
    `UPDATE journal_entries SET deleted_at = NULL, updated_at = ?
     WHERE user_id = ? AND deleted_at IS NOT NULL AND ${relatedEntriesPredicate(true)}`
  ).bind(new Date().toISOString(), tenantId, invoiceId, invoiceId, tenantId).run();
  return r.meta?.changes || 0;
}

/**
 * Hard-delete an invoice's ledger entries when the invoice is purged.
 * MUST run before the invoice row is deleted — the payment lookup joins through
 * bank_transactions.invoice_id, which stops resolving once the invoice is gone.
 */
export async function purgeInvoiceJournal(
  db: D1Database, tenantId: string, invoiceId: string,
): Promise<number> {
  const r = await db.prepare(
    `DELETE FROM journal_entries
     WHERE user_id = ? AND deleted_at IS NOT NULL AND ${relatedEntriesPredicate()}`
  ).bind(tenantId, invoiceId, invoiceId, tenantId).run();
  return r.meta?.changes || 0;
}
