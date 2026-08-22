/**
 * Bank matcher tests — run: npx --yes tsx tests/bank-matcher.test.ts
 * Cases mirror real PNR/HSBC shapes: cheque-ref narrations, fee-deducted
 * payments, counterparty-name-only signals.
 */
import assert from 'node:assert/strict';
import { findBestInvoiceMatch } from '../api/src/lib/bank-matcher';

let pass = 0, fail = 0;
function t(name: string, fn: () => void): void {
  try { fn(); pass++; console.log('ok   - ' + name); }
  catch (e: any) { fail++; console.error('FAIL - ' + name + '\n       ' + e.message); }
}

const INV = {
  id: 'inv-1', invoice_number: 'INV-MT15QFEU', total: 19600, currency: 'HKD',
  issue_date: '2025-05-15', due_date: '2025-06-14', counterparty_name: 'Pastel Tech Limited',
};

t('tier high: invoice number in narration wins even outside window', () => {
  const r = findBestInvoiceMatch(
    { id: 'tx1', transaction_date: '2024-01-01', description: 'PAYMENT INV-MT15QFEU', amount: 999 },
    [INV]
  );
  assert.equal(r?.confidence, 'high');
});

t('tier medium: exact amount inside issue..due+7', () => {
  const r = findBestInvoiceMatch(
    { id: 'tx2', transaction_date: '2025-06-02', description: 'CHEQUE DEPOSIT MACHINE (02JUN25)', amount: 19600 },
    [INV]
  );
  assert.equal(r?.confidence, 'medium');
  assert.match(r?.reason || '', /Exact amount/);
});

t('exact amount far outside window drops to low, not null', () => {
  const r = findBestInvoiceMatch(
    { id: 'tx3', transaction_date: '2026-01-01', description: 'FPS INWARD SOMEBODY', amount: 19600 },
    [INV]
  );
  assert.equal(r?.confidence, 'low');
});

t('tier medium(low): near amount within max(10, 0.5%) + window -> suggestion', () => {
  // 19,600 - 30 fee = 19,570 → Δ=30 ≤ max(10, 98)=98 ✓
  const r = findBestInvoiceMatch(
    { id: 'tx4', transaction_date: '2025-06-10', description: 'FROM PASTEL TECH LIMITED ECQ DEPOSIT', amount: 19570 },
    [INV]
  );
  assert.equal(r?.confidence, 'low');
  assert.match(r?.reason || '', /fees\/partial/);
});

t('near amount outside generous window -> null', () => {
  const r = findBestInvoiceMatch(
    { id: 'tx5', transaction_date: '2026-06-10', description: 'FROM SOMEONE ELSE', amount: 19570 },
    [INV]
  );
  assert.equal(r, null);
});

t('amount way off + no name signal -> null (no silent guess)', () => {
  const r = findBestInvoiceMatch(
    { id: 'tx6', transaction_date: '2025-06-10', description: 'SMART CITY CONSORTIUM CHEQUE', amount: 11550 },
    [INV]
  );
  assert.equal(r, null);
});

t('tier low: counterparty name ≥80 + date in ±window', () => {
  const r = findBestInvoiceMatch(
    { id: 'tx7', transaction_date: '2025-06-20', description: 'PASTEL TECH LIMITED HC12560266214385 02JUN', amount: 12345 },
    [INV]
  );
  assert.equal(r?.confidence, 'low');
  assert.match(r?.reason || '', /scores \d+/);
});

t('name below threshold -> null', () => {
  const r = findBestInvoiceMatch(
    { id: 'tx8', transaction_date: '2025-06-20', description: 'TOTALLY UNRELATED COMPANY LTD', amount: 12345 },
    [INV]
  );
  assert.equal(r, null);
});

t('currency mismatch never matches', () => {
  const r = findBestInvoiceMatch(
    { id: 'tx9', transaction_date: '2025-06-02', description: 'X', amount: 19600, currency: 'USD' },
    [{ ...INV }]
  );
  assert.equal(r, null);
});

t('excluded ids are skipped', () => {
  const r = findBestInvoiceMatch(
    { id: 'txA', transaction_date: '2025-06-02', description: 'x', amount: 19600 },
    [INV],
    new Set(['inv-1'])
  );
  assert.equal(r, null);
});

t('higher tier beats earlier lower-tier candidate', () => {
  const weak: typeof INV = { ...INV, id: 'weak', invoice_number: 'INV-ZZZ', total: 100, counterparty_name: null };
  const r = findBestInvoiceMatch(
    { id: 'txB', transaction_date: '2025-06-02', description: 'PAYMENT FOR INV-MT15QFEU', amount: 19600 },
    [weak, INV]
  );
  assert.equal(r?.invoice.id, 'inv-1');
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
