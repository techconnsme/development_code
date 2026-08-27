// Tests for /api/payroll Zod schemas.
// Run: npx tsx tests/payroll-schemas.test.ts
import { employeeCreateSchema, employeeUpdateSchema, runCreateSchema, markPaidSchema } from '../api/src/routes/payroll';

let pass = 0, fail = 0;
function ok(cond: boolean, label: string) {
  if (cond) { pass++; } else { fail++; console.error(`FAIL: ${label}`); }
}

const valid = { employee_number: 'EMP-0101', name: 'Chan Siu Ming', gender: 'M' as const, marital_status: 'single' as const, monthly_salary: 18000, expense_account_code: '61201', hire_date: '2026-01-15' };

ok(employeeCreateSchema.safeParse(valid).success, 'full valid payload passes');
ok(employeeCreateSchema.safeParse({ employee_number: 'EMP-X', name: 'Y', gender: 'M', marital_status: 'single', monthly_salary: 12000, hire_date: '2026-01-01' }).success, 'defaults applied (title/account optional)');
ok(!employeeCreateSchema.safeParse({ ...valid, gender: 'X' }).success, 'bad gender rejected');
ok(!employeeCreateSchema.safeParse({ ...valid, monthly_salary: -1 }).success, 'negative salary rejected');
ok(!employeeCreateSchema.safeParse({ ...valid, hire_date: 'not-a-date' }).success, 'bad hire_date rejected');
ok(employeeUpdateSchema.safeParse({ monthly_salary: 20000 }).success, 'partial update parses');
ok(employeeUpdateSchema.safeParse({}).success, 'empty update object parses (no-op patch)');
ok(runCreateSchema.safeParse({ period_month: '2026-08' }).success, 'run create valid');
ok(!runCreateSchema.safeParse({ period_month: 'Aug 2026' }).success, 'run create rejects malformed month');
ok(markPaidSchema.safeParse({ bank_account_code: '11102' }).success, 'mark-paid valid');
ok(!markPaidSchema.safeParse({}).success, 'mark-paid requires bank_account_code');

console.log(`payroll-schemas: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
