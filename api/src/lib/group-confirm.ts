/**
 * Pure validation for confirming ONE bank transaction against a GROUP of
 * invoices (combined payment). Mirrors the single-match guards in
 * PATCH /bank-statements/transactions/:id/match — extracted so the rules are
 * unit-testable without a DB.
 */

export interface GroupConfirmInvoiceRow {
  id: string;
  total: number;
  direction: string;
  currency: string | null;
  status: string;
  deleted_at: string | null;
  file_id: string | null;
}

export type GroupConfirmResult =
  | { ok: true; allocations: { invoice_id: string; allocated_amount: number; alreadyPaid: boolean }[]; fileIds: (string | null)[] }
  | { ok: false; httpStatus: number; error: string };

export function validateGroupConfirm(input: {
  txAmount: number;
  txIsDeposit: boolean;
  txCurrency: string;
  invoices: (GroupConfirmInvoiceRow | undefined)[];
}): GroupConfirmResult {
  const invs = input.invoices;
  if (invs.some(i => !i)) return { ok: false, httpStatus: 404, error: 'One or more invoices not found' };
  if (invs.length < 2) return { ok: false, httpStatus: 400, error: 'A combined payment needs at least two invoices' };

  const ids = new Set(invs.map(i => i!.id));
  if (ids.size !== invs.length) return { ok: false, httpStatus: 400, error: 'Duplicate invoice ids in invoice_ids' };

  for (const inv of invs as GroupConfirmInvoiceRow[]) {
    if (inv.deleted_at) return { ok: false, httpStatus: 409, error: 'One or more invoices are deleted' };
    if (inv.status === 'cancelled') return { ok: false, httpStatus: 409, error: 'Invoice is cancelled' };
    // 'paid' is NOT rejected here: an invoice settled via the receipt leg can
    // legitimately coexist with a bank match on the same money — the caller
    // skips the status write for alreadyPaid allocations instead.
    const incoming = inv.direction === 'incoming';
    if (input.txIsDeposit === incoming) {
      return { ok: false, httpStatus: 400, error: input.txIsDeposit
        ? 'A deposit cannot pay an incoming (AP) invoice'
        : 'A withdrawal cannot pay an outgoing (AR) invoice' };
    }
    if ((inv.currency || 'HKD') !== input.txCurrency) {
      return { ok: false, httpStatus: 409, error: `Currency mismatch: ${input.txCurrency} vs ${inv.currency || 'HKD'}` };
    }
  }

  const sum = invs.reduce((s, i) => s + i!.total, 0);
  if (Math.abs(sum - input.txAmount) >= 0.02) {
    return { ok: false, httpStatus: 409, error: `Amount mismatch: transaction ${input.txAmount} vs invoices total ${sum}` };
  }

  return {
    ok: true,
    allocations: invs.map(i => ({ invoice_id: i!.id, allocated_amount: i!.total, alreadyPaid: i!.status === 'paid' })),
    fileIds: invs.map(i => i!.file_id),
  };
}
