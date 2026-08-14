import { test, expect } from '@playwright/test';
import { reconcileDirections } from '../api/src/lib/balance-reconcile';

test.describe('reconcileDirections', () => {

  test('June HSBC scenario: flips the two transposed rows using balance anchors', () => {
    const txs = [
      { transaction_date: '2025-05-30', description: 'B/F BALANCE', deposit_amount: 0, withdrawal_amount: 0, balance: 0 },
      { transaction_date: '2025-06-02', description: 'CHEQUE 948152', deposit_amount: 0, withdrawal_amount: 10000, balance: -10000 },
      { transaction_date: '2025-06-03', description: 'FROM PROFICIENCY & R SWEEP (03JUN25)', deposit_amount: 10000, withdrawal_amount: 0, balance: 0 },
      { transaction_date: '2025-06-28', description: '28MAY25 TO 27JUN25 DEBIT INTEREST', deposit_amount: 0, withdrawal_amount: 5.78, balance: -5.78 },
      { transaction_date: '2025-06-30', description: 'FROM PROFICIENCY & R SWEEP (30JUN25)', deposit_amount: 5.78, withdrawal_amount: 0, balance: 0 },
      { transaction_date: '2025-05-30', description: 'B/F BALANCE', deposit_amount: 0, withdrawal_amount: 0, balance: 112697.65 },
      { transaction_date: '2025-06-02', description: 'REF:584E 0619 CHEQUE DEPOSIT MACHINE (02JUN25)', deposit_amount: 45700, withdrawal_amount: 0, balance: null },
      { transaction_date: '2025-06-02', description: 'CHARGES HC12560266214385 02JUN', deposit_amount: 0, withdrawal_amount: 5, balance: null },
      { transaction_date: '2025-06-02', description: 'PASTEL TECH LIMITED HC12560266214385 02JUN', deposit_amount: 19600, withdrawal_amount: 0, balance: null },
      { transaction_date: '2025-06-02', description: 'CHARGES HC12560266234228 02JUN', deposit_amount: 0, withdrawal_amount: 5, balance: null },
      { transaction_date: '2025-06-02', description: 'LIN PUI KEUNG JOSEPH HC12560266234228 02JUN', deposit_amount: 20500, withdrawal_amount: 0, balance: 118287.65 },
      { transaction_date: '2025-06-03', description: 'CR TO 147-162101-001 SWEEP (03JUN25)', deposit_amount: 0, withdrawal_amount: 10000, balance: 108287.65 },
      { transaction_date: '2025-06-16', description: 'CR TO 521-305565-838 N61632566682(16JUN25)', deposit_amount: 0, withdrawal_amount: 4800, balance: 103487.65 },
      { transaction_date: '2025-06-28', description: 'CREDIT INTEREST', deposit_amount: 22.96, withdrawal_amount: 0, balance: 103510.61 },
      { transaction_date: '2025-06-30', description: 'CR TO 147-162101-001 SWEEP (30JUN25)', deposit_amount: 0, withdrawal_amount: 5.78, balance: 103504.83 },
    ];
    const out = reconcileDirections(txs, 112697.65, 103504.83);

    const pastel = out.find(t => t.description.includes('PASTEL TECH'));
    const lin = out.find(t => t.description.includes('LIN PUI KEUNG'));
    const deposit = out.find(t => t.description.includes('CHEQUE DEPOSIT MACHINE'));
    expect(pastel?.deposit_amount).toBe(0);
    expect(pastel?.withdrawal_amount).toBe(19600);
    expect(lin?.deposit_amount).toBe(0);
    expect(lin?.withdrawal_amount).toBe(20500);
    // correctly-parsed rows untouched
    expect(deposit?.deposit_amount).toBe(45700);
    expect(deposit?.withdrawal_amount).toBe(0);
  });

  test('already-correct rows are not modified', () => {
    const txs = [
      { description: 'B/F BALANCE', deposit_amount: 0, withdrawal_amount: 0, balance: 100 },
      { description: 'A', deposit_amount: 50, withdrawal_amount: 0, balance: 150 },
      { description: 'B', deposit_amount: 0, withdrawal_amount: 30, balance: 120 },
    ];
    const out = reconcileDirections(txs, 100, 120);
    expect(out).toEqual(txs);
  });

  test('single transposed row between anchors gets flipped', () => {
    const txs = [
      { description: 'B/F BALANCE', deposit_amount: 0, withdrawal_amount: 0, balance: 100 },
      { description: 'C', deposit_amount: 40, withdrawal_amount: 0, balance: 60 }, // wrong: should be withdrawal
    ];
    const out = reconcileDirections(txs, 100, 60);
    expect(out[1].deposit_amount).toBe(0);
    expect(out[1].withdrawal_amount).toBe(40);
  });
});
