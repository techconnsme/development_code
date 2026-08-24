/**
 * Bank matcher tests — run: npx --yes tsx tests/bank-matcher.test.ts
 * Cases mirror real PNR/HSBC shapes: cheque-ref narrations, fee-deducted
 * payments, counterparty-name-only signals.
 */
import assert from 'node:assert/strict';
import { findBestInvoiceMatch, findInvoiceGroupMatch } from '../api/src/lib/bank-matcher';

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

t('name tier runs even when amount differs (5100 vs 4150, real PNR shape)', () => {
  const r = findBestInvoiceMatch(
    { id: 'txN1', transaction_date: '2025-11-07', description: 'PASTEL TECH LIMITED HC125B0730030988   07NOV', amount: 5100 },
    [{ ...INV, issue_date: '2025-11-04', due_date: '2025-12-03', total: 4150 }]
  );
  assert.equal(r?.confidence, 'low');
});

t('name tier rejects wild amount ratios (55000 vs 4150)', () => {
  const r = findBestInvoiceMatch(
    { id: 'txN2', transaction_date: '2025-11-05', description: 'PASTEL TECH LIMITED HC125B0521391053   05NOV', amount: 55000 },
    [{ ...INV, issue_date: '2025-11-04', due_date: '2025-12-03', total: 4150 }]
  );
  assert.equal(r, null);
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

// ── findInvoiceGroupMatch (multi-invoice combined payments) ──
const P = 'Pastel Tech Limited';
const mkInv = (id: string, num: string, total: number, issue: string, due: string): typeof INV =>
  ({ ...INV, id, invoice_number: num, total, issue_date: issue, due_date: due, counterparty_name: P });

// Ground truth 1: 19 Sep 2025 −57,580.80 = #001414 (15,300) + #001417v2 (42,280.80)
const gt1Pool = [
  mkInv('a1', '#001414', 15300, '2025-06-08', '2025-07-08'),
  mkInv('a2', '#001417v2', 42280.8, '2025-08-20', '2025-09-19'),
];
t('group GT1: 57,580.80 = 15,300 + 42,280.80', () => {
  const g = findInvoiceGroupMatch(
    { id: 'txG1', transaction_date: '2025-09-19', description: 'PASTEL TECH LIMITED HC1259078 19SEP', amount: 57580.8 },
    [...gt1Pool, mkInv('other', '#009999', 99999, '2025-01-01', '2025-02-01')]
  );
  assert.ok(g);
  assert.deepEqual(g.invoices.map(i => i.id).sort(), ['a1', 'a2']);
  assert.equal(g.confidence, 'medium');
  assert.match(g.reason, /Combined payment: 15,300\.00 \+ 42,280\.80 = 57,580\.80/);
});

// Ground truth 2: 5 Nov 2025 −55,000 = #001441 (40,050) + #001442 (14,950)
t('group GT2: 55,000 = 40,050 + 14,950', () => {
  const pool = [
    mkInv('b1', '#001441', 40050, '2025-10-06', '2025-11-05'),
    mkInv('b2', '#001442', 14950, '2025-10-20', '2025-11-19'),
  ];
  const g = findInvoiceGroupMatch(
    { id: 'txG2', transaction_date: '2025-11-05', description: 'PASTEL TECH LIMITED HC125B05213 05NOV', amount: 55000 },
    pool
  );
  assert.ok(g);
  assert.equal(g.invoices.length, 2);
});

// Ground truth 3: 5 Feb 2026 −27,544 = 3 invoices
t('group GT3: 27,544 = 5,200 + 4,150 + 18,194 (three members)', () => {
  const pool = [
    mkInv('c1', '#001458v2', 5200, '2026-01-06', '2026-02-05'),
    mkInv('c2', '#001467-v2', 4150, '2026-01-10', '2026-02-09'),
    mkInv('c3', '#001484-v2', 18194, '2026-01-15', '2026-02-14'),
  ];
  const g = findInvoiceGroupMatch(
    { id: 'txG3', transaction_date: '2026-02-05', description: 'PASTEL TECH LIMITED HC125C0599 05FEB', amount: 27544 },
    pool
  );
  assert.ok(g);
  assert.equal(g.invoices.length, 3);
  assert.match(g.reason, /5,200\.00 \+ 4,150\.00 \+ 18,194\.00 = 27,544\.00/);
});

t('group excludes reserved ids', () => {
  const g = findInvoiceGroupMatch(
    { id: 'txX', transaction_date: '2025-11-05', description: 'PASTEL TECH LIMITED x', amount: 55000 },
    [
      mkInv('b1', '#001441', 40050, '2025-10-06', '2025-11-05'),
      mkInv('b2', '#001442', 14950, '2025-10-20', '2025-11-19'),
    ],
    new Set(['b1'])
  );
  assert.equal(g, null);
});

t('group narration fast-path: 2 referenced numbers -> high confidence without sum match', () => {
  const pool = [
    mkInv('d1', 'INV-777001', 1111, '2025-10-01', '2025-11-01'),
    mkInv('d2', 'INV-777002', 2222, '2025-10-02', '2025-11-02'),
    mkInv('d3', 'INV-777003', 3333, '2025-10-03', '2025-11-03'),
  ];
  const g = findInvoiceGroupMatch(
    { id: 'txY', transaction_date: '2025-11-05', description: 'PAYMENT INV-777001 INV-777002', amount: 88888 },
    pool
  );
  assert.ok(g);
  assert.equal(g.confidence, 'high');
  assert.deepEqual(g.invoices.map(i => i.id).sort(), ['d1', 'd2']);
});

t('group date gate: beyond due+120d rejected', () => {
  // Issue 2025-03-01 due 2025-03-31 -> gate ends ~2025-07-29; pay 2025-09-19.
  const g = findInvoiceGroupMatch(
    { id: 'txZ', transaction_date: '2025-09-19', description: 'PASTEL TECH LIMITED late', amount: 30000 },
    [
      mkInv('e1', '#LATE1', 10000, '2025-03-01', '2025-03-31'),
      mkInv('e2', '#LATE2', 20000, '2025-03-05', '2025-04-04'),
    ]
  );
  assert.equal(g, null);
});

t('group date gate: due+103d passes (real #001414 shape)', () => {
  const g = findInvoiceGroupMatch(
    { id: 'txW', transaction_date: '2025-09-19', description: 'PASTEL TECH LIMITED ok', amount: 57580.8 },
    gt1Pool
  );
  assert.ok(g); // oldest issue Jun 8 − newest due Sep 19 +120d window contains Sep 19
});

t('group sum off by 0.02 -> null', () => {
  const g = findInvoiceGroupMatch(
    { id: 'txV', transaction_date: '2025-11-05', description: 'PASTEL TECH LIMITED off', amount: 55000.02 },
    [
      mkInv('f1', '#S1', 40050, '2025-10-06', '2025-11-05'),
      mkInv('f2', '#S2', 14950, '2025-10-20', '2025-11-19'),
    ]
  );
  assert.equal(g, null);
});

t('group skips cross-currency invoices', () => {
  const g = findInvoiceGroupMatch(
    { id: 'txU', transaction_date: '2025-11-05', description: 'PASTEL TECH LIMITED usd', amount: 55000 },
    [
      { ...mkInv('g1', '#U1', 40050, '2025-10-06', '2025-11-05'), currency: 'USD' },
      mkInv('g2', '#U2', 14950, '2025-10-20', '2025-11-19'),
    ]
  );
  assert.equal(g, null);
});

t('group skips when counterparty does not score >=80 on narration', () => {
  const g = findInvoiceGroupMatch(
    { id: 'txT', transaction_date: '2025-11-05', description: 'TOTALLY UNRELATED COMPANY', amount: 55000 },
    [
      mkInv('h1', '#T1', 40050, '2025-10-06', '2025-11-05'),
      mkInv('h2', '#T2', 14950, '2025-10-20', '2025-11-19'),
    ]
  );
  assert.equal(g, null);
});

t('group pool over cap of 30 -> skip combinatorics', () => {
  const big = Array.from({ length: 31 }, (_, k) => mkInv(`p${k}`, `#P${k}`, 1000 + k, '2025-10-01', '2025-11-01'));
  const g = findInvoiceGroupMatch(
    { id: 'txS', transaction_date: '2025-11-05', description: 'PASTEL TECH LIMITED big', amount: 2000 },
    big
  );
  assert.equal(g, null);
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
