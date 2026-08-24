/**
 * Group-confirm validator tests — run: npx --yes tsx tests/group-confirm.test.ts
 */
import assert from 'node:assert/strict';
import { validateGroupConfirm, GroupConfirmInvoiceRow } from '../api/src/lib/group-confirm';

let pass = 0, fail = 0;
function t(name: string, fn: () => void): void {
  try { fn(); pass++; console.log('ok   - ' + name); }
  catch (e: any) { fail++; console.error('FAIL - ' + name + '\n       ' + e.message); }
}

const row = (over: Partial<GroupConfirmInvoiceRow>): GroupConfirmInvoiceRow =>
  ({ id: 'x', total: 100, direction: 'incoming', currency: 'HKD', status: 'sent', deleted_at: null, file_id: null, ...over });

const input = (invoices: any[], over: object = {}) => ({
  txAmount: 55000, txIsDeposit: false, txCurrency: 'HKD', invoices, ...over,
});

t('happy path: two AP invoices summing exactly', () => {
  const v = validateGroupConfirm(input([
    row({ id: 'a', total: 40050 }), row({ id: 'b', total: 14950 }),
  ]));
  assert.ok(v.ok);
  assert.deepEqual(v.allocations, [{ invoice_id: 'a', allocated_amount: 40050 }, { invoice_id: 'b', allocated_amount: 14950 }]);
  assert.deepEqual(v.fileIds, [null, null]);
});

t('missing invoice id -> 404', () => {
  const v = validateGroupConfirm(input([row({ id: 'a', total: 40050 }), undefined]));
  assert.ok(!v.ok && v.httpStatus === 404);
});

t('single invoice -> 400 (use the 1:1 path)', () => {
  const v = validateGroupConfirm(input([row({ total: 55000 })]));
  assert.ok(!v.ok && v.httpStatus === 400);
});

t('duplicate ids -> 400', () => {
  const v = validateGroupConfirm(input([row({ id: 'a', total: 27500 }), row({ id: 'a', total: 27500 })]));
  assert.ok(!v.ok && v.httpStatus === 400);
});

t('deleted member -> 409', () => {
  const v = validateGroupConfirm(input([row({ id: 'a', deleted_at: '2026-01-01' }), row({ id: 'b' })]));
  assert.ok(!v.ok && v.httpStatus === 409);
});

t('paid member -> 409', () => {
  const v = validateGroupConfirm(input([row({ id: 'a', status: 'paid' }), row({ id: 'b' })]));
  assert.ok(!v.ok && v.httpStatus === 409);
});

t('cancelled member -> 409', () => {
  const v = validateGroupConfirm(input([row({ id: 'a', status: 'cancelled' }), row({ id: 'b' })]));
  assert.ok(!v.ok && v.httpStatus === 409);
});

t('deposit cannot pay AP incoming -> 400', () => {
  const v = validateGroupConfirm(input([row({ id: 'a', total: 40050 }), row({ id: 'b', total: 14950 })], { txIsDeposit: true }));
  assert.ok(!v.ok && v.httpStatus === 400);
});

t('withdrawal cannot pay AR outgoing -> 400', () => {
  const v = validateGroupConfirm(input([row({ id: 'a', direction: 'outgoing', total: 40050 }), row({ id: 'b', direction: 'outgoing', total: 14950 })]));
  assert.ok(!v.ok && v.httpStatus === 400);
});

t('currency mismatch -> 409', () => {
  const v = validateGroupConfirm(input([row({ id: 'a', currency: 'USD', total: 40050 }), row({ id: 'b' })]));
  assert.ok(!v.ok && v.httpStatus === 409);
});

t('sum off by 0.03 -> 409', () => {
  const v = validateGroupConfirm(input([row({ id: 'a', total: 40050 }), row({ id: 'b', total: 14950.03 })]));
  assert.ok(!v.ok && v.httpStatus === 409);
});

t('sum boundary: off by exactly 0.02 rejected, 0.01 accepted', () => {
  const rej = validateGroupConfirm(input([row({ id: 'a', total: 40050 }), row({ id: 'b', total: 14950.02 })]));
  assert.ok(!rej.ok && rej.httpStatus === 409);
  const acc = validateGroupConfirm(input([row({ id: 'a', total: 40050 }), row({ id: 'b', total: 14950.01 })]));
  assert.ok(acc.ok);
});

process.exitCode = fail > 0 ? 1 : 0;
