/**
 * postPaymentToGl tests with a minimal fake D1 — run: npx --yes tsx tests/post-payment.test.ts
 */
import assert from 'node:assert/strict';
import { postPaymentToGl } from '../api/src/lib/post-payment';

let pass = 0, fail = 0;
async function t(name: string, fn: () => Promise<void>): Promise<void> {
  try { await fn(); pass++; console.log('ok   - ' + name); }
  catch (e: any) { fail++; console.error('FAIL - ' + name + '\n       ' + e.message); }
}

class FakeD1 {
  calls: { sql: string; args: any[] }[] = [];
  constructor(private scripted: [RegExp, any][] = []) {}
  prepare(sql: string) {
    let args: any[] = [];
    const bound = {
      first: async () => {
        this.calls.push({ sql, args });
        for (const [re, v] of this.scripted) if (re.test(sql)) return v;
        return null;
      },
      all: async () => {
        this.calls.push({ sql, args });
        for (const [re, v] of this.scripted) if (re.test(sql)) return { results: v };
        return { results: [] };
      },
      run: async () => { this.calls.push({ sql, args }); return { meta: { changes: 1 } }; },
      raw: async () => { throw new Error('not implemented in fake'); },
    };
    return { bind: (...a: any[]) => { args = a; return bound; } } as any;
  }
  batch(_stmts: any[]) { throw new Error('postPaymentToGl must not batch'); }
  insertedLines(): { account_code: string; debit: number; credit: number; description: string }[] {
    return this.calls
      .filter(c => /INSERT INTO journal_lines/.test(c.sql))
      .map(c => ({ account_code: c.args[2], debit: c.args[5], credit: c.args[6], description: c.args[4] }));
  }
}
const db = (f: FakeD1) => f as unknown as D1Database;

const TX_BASE = {
  id: 'tx-multi', transaction_date: '2025-11-05', deposit_amount: 0, withdrawal_amount: 55000,
  invoice_id: null, match_status: 'confirmed', bank_account_code: '11102',
};
const LINKS = [
  { invoice_id: 'ia', allocated_amount: 40050, invoice_number: '#001441', direction: 'incoming' },
  { invoice_id: 'ib', allocated_amount: 14950, invoice_number: '#001442', direction: 'incoming' },
];

async function main(): Promise<void> {
  await t('group: one JE, N creditor Dr lines + one bank Cr line, MULTI entry number', async () => {
    const f = new FakeD1([
      [/FROM bank_transactions[\s\S]*LEFT JOIN bank_statements/, { ...TX_BASE }],
      [/reference_type = 'payment'/, null],
      [/bank_transaction_invoice_links/, LINKS],
    ]);
    const r = await postPaymentToGl(db(f), 'tenant', 'tx-multi');
    assert.ok(!r.error, r.error);
    assert.match(r.entry_number, /^JE-PMT-MULTI-tx-multi/);
    const lines = f.insertedLines();
    assert.equal(lines.length, 3);
    assert.deepEqual(lines.map(l => l.account_code), ['21101', '21101', '11102']);
    assert.equal(lines[0].debit, 40050);
    assert.equal(lines[0].description, '#001441');
    assert.equal(lines[1].debit, 14950);
    assert.equal(lines[2].credit, 55000);
    const je = f.calls.find(c => /INSERT INTO journal_entries/.test(c.sql));
    assert.match(je!.args[4], /#001441.*#001442|Combined payment/i);
  });

  await t('1:1 fallback: invoice_id set -> legacy pair + JE-PMT-<number>', async () => {
    const f = new FakeD1([
      [/FROM bank_transactions/, { ...TX_BASE, invoice_id: 'ia', withdrawal_amount: 40050 }],
      [/reference_type = 'payment'/, null],
      [/FROM invoices WHERE id/, { invoice_number: '#001441', total: 40050, direction: 'incoming' }],
    ]);
    const r = await postPaymentToGl(db(f), 'tenant', 'tx-single');
    assert.ok(!r.error, r.error);
    assert.equal(r.entry_number, 'JE-PMT-#001441');
    const lines = f.insertedLines();
    assert.equal(lines.length, 2);
    assert.deepEqual(lines.map(l => l.account_code), ['21101', '11102']);
    assert.equal(lines[0].debit, 40050);
    assert.equal(lines[1].credit, 40050);
  });

  await t('idempotent: existing live payment JE short-circuits', async () => {
    const f2 = new FakeD1([
      [/FROM journal_entries[\s\S]*reference_type = 'payment'/, { id: 'je-x', entry_number: 'JE-PMT-old' }],
      [/FROM bank_transactions/, { ...TX_BASE }],
    ]);
    const r = await postPaymentToGl(db(f2), 'tenant', 'tx-multi');
    assert.equal(r.entry_id, 'je-x');
    assert.equal(r.already_posted, true);
    assert.equal(f2.insertedLines().length, 0);
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}
main();
