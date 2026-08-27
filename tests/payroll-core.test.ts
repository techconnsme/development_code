// Tests for payroll run computation + JE composition core.
// Run: npx tsx tests/payroll-core.test.ts
import {
  computeRunItems, periodBounds, canTransition,
  buildAccrualLines, buildPaymentLines, buildSettlementLines, LIFE_CYCLE_ACCOUNTS,
  type RunEmployeeInput, type RunItem, type RunTotals,
} from '../api/src/lib/payroll-core';

let pass = 0, fail = 0;
function ok(cond: boolean, label: string) {
  if (cond) { pass++; } else { fail++; console.error(`FAIL: ${label}`); }
}

// ── periodBounds ──
ok(periodBounds('2026-02').end === '2026-02-28', 'Feb non-leap end');
ok(periodBounds('2024-02').end === '2024-02-29', 'leap Feb end');
ok(periodBounds('2026-12').end === '2026-12-31', 'Dec end');
ok(periodBounds('2026-08').start === '2026-08-01', 'Aug start');

// ── tenure gating + computeRunItems ──
const EMPS: RunEmployeeInput[] = [
  { id: 'EMP-0001', monthly_salary: 20000, expense_account_code: '61201', hire_date: '2024-01-01', termination_date: null },
  { id: 'EMP-0002', monthly_salary: 10000, expense_account_code: '61201', hire_date: '2026-09-01', termination_date: null },      // hires after Aug
  { id: 'EMP-0003', monthly_salary: 10000, expense_account_code: '61102', hire_date: '2024-01-01', termination_date: '2026-07-31' }, // left before Aug
];

const aug = computeRunItems(EMPS, '2026-08');
ok(aug.items.length === 1, 'only in-tenure employee included');
ok(aug.totals.total_gross === 20000 && aug.totals.total_net === 19000, 'totals from survivor (EE mpf 1,000)');
ok(aug.items[0].ee_mpf === 1000 && aug.items[0].er_mpf === 1000, 'item mpf values');

const crossYear = computeRunItems([
  { id: 'A', monthly_salary: 6000, expense_account_code: '61201', hire_date: '2023-01-01', termination_date: null },
], '2026-01');
ok(crossYear.totals.total_gross === 6000 && crossYear.totals.total_er_mpf === 300 && crossYear.totals.total_ee_mpf === 0, 'below-min aggregated');

// ── transitions ──
ok(canTransition('draft', 'accrued') && canTransition('accrued', 'paid') && canTransition('paid', 'settled'), 'happy path');
ok(canTransition('draft', 'cancelled') && canTransition('accrued', 'cancelled'), 'cancellable before settlement');
ok(!canTransition('paid', 'accrued') && !canTransition('settled', 'cancelled') && !canTransition('draft', 'paid'), 'illegal hops rejected');

// ── accrual lines: per-account aggregation ──
const ITEMS: RunItem[] = [
  { employee_id: 'EMP-0001', gross: 20000, ee_mpf: 1000, er_mpf: 1000, net: 19000, expense_account_code: '61201' },
  { employee_id: 'EMP-0004', gross: 10000, ee_mpf: 500, er_mpf: 500, net: 9500, expense_account_code: '61102' },
];
const TOTALS: RunTotals = { total_gross: 30000, total_ee_mpf: 1500, total_er_mpf: 1500, total_net: 28500 };
const NAMES = (code: string) => `NAME-${code}`;
const acc = buildAccrualLines(ITEMS, TOTALS, NAMES);
const drSum = acc.filter(l => l.dr).reduce((s, l) => s + l.amount, 0);
const crSum = acc.filter(l => !l.dr).reduce((s, l) => s + l.amount, 0);
ok(acc.length === 5, '5 lines: 2 salary accts + 61202 + 21204 + 21203');
ok(drSum === crSum && drSum === 31500, 'Dr = Cr = gross + ER (31,500)');
ok(acc[0].code === '61102' && acc[0].amount === 10000, 'expense lines sorted by code, 61102 first');
ok(acc[1].code === '61201' && acc[1].amount === 20000, '61201 aggregated gross');
ok(acc[2].dr && acc[2].code === '61202' && acc[2].amount === 1500, 'ER expense line');
ok(!acc[3].dr && acc[3].code === '21204' && acc[3].amount === 3000, 'MPF payable = EE+ER');
ok(!acc[4].dr && acc[4].code === '21203' && acc[4].amount === 28500, 'salary payable = net');

// zero-amount filtering: below-min run drops the EE portion implicitly
const MIN_ITEMS: RunItem[] = [{ employee_id: 'X', gross: 6000, ee_mpf: 0, er_mpf: 300, net: 6000, expense_account_code: '61201' }];
const MIN_TOTALS: RunTotals = { total_gross: 6000, total_ee_mpf: 0, total_er_mpf: 300, total_net: 6000 };
const minAcc = buildAccrualLines(MIN_ITEMS, MIN_TOTALS, NAMES);
ok(minAcc.find(l => l.code === '21204')!.amount === 300, '21204 carries ER even when EE is 0');

// ── payment & settlement ──
const pay = buildPaymentLines(TOTALS, '11102', NAMES);
ok(pay.length === 2 && pay[0].dr && pay[0].code === '21203' && pay[0].amount === 28500, 'payment Dr 21203 net');
ok(!pay[1].dr && pay[1].code === '11102' && pay[1].amount === 28500, 'payment Cr bank net');

const set = buildSettlementLines(TOTALS, '11102', NAMES);
ok(set.length === 2 && set[0].dr && set[0].code === LIFE_CYCLE_ACCOUNTS.MPF_PAYABLE && set[0].amount === 3000, 'settlement Dr 21204 EE+ER');
ok(!set[1].dr && set[1].code === '11102' && set[1].amount === 3000, 'settlement Cr bank');

console.log(`payroll-core: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
