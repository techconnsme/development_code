// Pure payroll run computation + journal-entry composition for /api/payroll.
import { computeMpf } from './mpf';

export interface RunEmployeeInput {
  id: string;
  monthly_salary: number;
  expense_account_code: string;
  hire_date: string;
  termination_date: string | null;
}

export interface RunItem {
  employee_id: string;
  gross: number;
  ee_mpf: number;
  er_mpf: number;
  net: number;
  expense_account_code: string;
}

export interface RunTotals {
  total_gross: number;
  total_ee_mpf: number;
  total_er_mpf: number;
  total_net: number;
}

export interface JeLineDraft {
  dr: boolean;
  code: string;
  name: string;
  amount: number;
}

export const LIFE_CYCLE_ACCOUNTS = {
  BANK_DEFAULT: '11102',
  SALARY_PAYABLE: '21203',
  MPF_PAYABLE: '21204',
  ER_MPF_EXPENSE: '61202',
} as const;

/** Last day of 'YYYY-MM' as 'YYYY-MM-DD'. */
export function periodBounds(periodMonth: string): { start: string; end: string } {
  const [y, m] = periodMonth.split('-').map(Number);
  if (!y || !m || m < 1 || m > 12) throw new Error(`Invalid period_month: ${periodMonth}`);
  const end = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
  return { start: `${periodMonth}-01`, end };
}

export function isActiveInPeriod(emp: RunEmployeeInput, start: string, end: string): boolean {
  return emp.hire_date <= end && (!emp.termination_date || emp.termination_date >= start);
}

export function computeRunItems(
  employees: RunEmployeeInput[],
  periodMonth: string,
): { items: RunItem[]; totals: RunTotals } {
  const { start, end } = periodBounds(periodMonth);
  const items: RunItem[] = [];
  let total_gross = 0, total_ee_mpf = 0, total_er_mpf = 0, total_net = 0;
  for (const emp of [...employees].sort((a, b) => a.id.localeCompare(b.id))) {
    if (!isActiveInPeriod(emp, start, end)) continue;
    const mpf = computeMpf(emp.monthly_salary);
    items.push({
      employee_id: emp.id,
      gross: emp.monthly_salary,
      ee_mpf: mpf.employee,
      er_mpf: mpf.employer,
      net: mpf.net,
      expense_account_code: emp.expense_account_code,
    });
    total_gross += emp.monthly_salary;
    total_ee_mpf += mpf.employee;
    total_er_mpf += mpf.employer;
    total_net += mpf.net;
  }
  return { items, totals: { total_gross, total_ee_mpf, total_er_mpf, total_net } };
}

// Lifecycle: draft → accrued → paid → settled; cancellable until paid.
const TRANSITIONS: Record<string, string[]> = {
  draft: ['accrued', 'cancelled'],
  accrued: ['paid', 'cancelled'],
  paid: ['settled'],
  settled: [],
  cancelled: [],
};

export type TransitionTarget = 'accrued' | 'paid' | 'settled' | 'cancelled';

export function canTransition(from: string, to: TransitionTarget): boolean {
  return (TRANSITIONS[from] || []).includes(to);
}

/** Aggregated accrual: one salary-expense line per distinct account, then ER expense, MPF payable, salary payable. */
export function buildAccrualLines(
  items: RunItem[],
  totals: RunTotals,
  accountName: (code: string) => string,
): JeLineDraft[] {
  const byAccount = new Map<string, number>();
  for (const it of items) {
    byAccount.set(it.expense_account_code, (byAccount.get(it.expense_account_code) || 0) + it.gross);
  }
  const lines: JeLineDraft[] = [...byAccount.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([code, amount]) => ({ dr: true, code, name: accountName(code), amount }));
  lines.push({ dr: true, code: LIFE_CYCLE_ACCOUNTS.ER_MPF_EXPENSE, name: accountName(LIFE_CYCLE_ACCOUNTS.ER_MPF_EXPENSE), amount: totals.total_er_mpf });
  lines.push({ dr: false, code: LIFE_CYCLE_ACCOUNTS.MPF_PAYABLE, name: accountName(LIFE_CYCLE_ACCOUNTS.MPF_PAYABLE), amount: totals.total_ee_mpf + totals.total_er_mpf });
  lines.push({ dr: false, code: LIFE_CYCLE_ACCOUNTS.SALARY_PAYABLE, name: accountName(LIFE_CYCLE_ACCOUNTS.SALARY_PAYABLE), amount: totals.total_net });
  return lines.filter((l) => l.amount !== 0);
}

export function buildPaymentLines(totals: RunTotals, bankCode: string, accountName: (code: string) => string): JeLineDraft[] {
  return [
    { dr: true, code: LIFE_CYCLE_ACCOUNTS.SALARY_PAYABLE, name: accountName(LIFE_CYCLE_ACCOUNTS.SALARY_PAYABLE), amount: totals.total_net },
    { dr: false, code: bankCode, name: accountName(bankCode), amount: totals.total_net },
  ].filter((l) => l.amount !== 0);
}

export function buildSettlementLines(totals: RunTotals, bankCode: string, accountName: (code: string) => string): JeLineDraft[] {
  const mpfTotal = totals.total_ee_mpf + totals.total_er_mpf;
  return [
    { dr: true, code: LIFE_CYCLE_ACCOUNTS.MPF_PAYABLE, name: accountName(LIFE_CYCLE_ACCOUNTS.MPF_PAYABLE), amount: mpfTotal },
    { dr: false, code: bankCode, name: accountName(bankCode), amount: mpfTotal },
  ].filter((l) => l.amount !== 0);
}
