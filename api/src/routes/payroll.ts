import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { v4 as uuidv4 } from 'uuid';
import type { Bindings, Variables } from '../types';
import { authMiddleware, bookkeeperMiddleware } from '../middleware/auth';
import { findParentAccountError } from '../lib/account-guard';
import { checkPeriodOpen } from '../lib/period-guard';
import { nextManualVoucherNumber } from '../lib/manual-booking';
import { createSnapshot } from '../lib/journal-snapshots';
import {
  computeRunItems, buildAccrualLines, buildPaymentLines, buildSettlementLines,
  canTransition, periodBounds, LIFE_CYCLE_ACCOUNTS,
  type RunEmployeeInput, type RunItem, type JeLineDraft, type TransitionTarget,
} from '../lib/payroll-core';

// ?�?� Zod schemas (exported for tests + reuse below) ?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�
export const employeeCreateSchema = z.object({
  employee_number: z.string().min(1).max(50),
  name: z.string().min(1).max(200),
  title: z.string().max(200).optional(),
  gender: z.enum(['M', 'F']),
  marital_status: z.enum(['single', 'married']),
  monthly_salary: z.number().min(0).max(999999999),
  expense_account_code: z.string().regex(/^\d{4,6}$/).default('61201'),
  hire_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  termination_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  is_active: z.boolean().optional(),
});

export const employeeUpdateSchema = employeeCreateSchema.partial();

export const runCreateSchema = z.object({
  period_month: z.string().regex(/^\d{4}-\d{2}$/),
});

export const markPaidSchema = z.object({
  bank_account_code: z.string().regex(/^\d{4,6}$/),
});

// Audit log helper (verbatim from bookkeeping.ts)
async function auditLog(db: any, userId: string, action: string, entityType: string, entityId: string | null | undefined, changes?: object) {
  const id = `al-${uuidv4().slice(0, 8)}`;
  await db.prepare(
    'INSERT INTO audit_log (id, user_id, action, entity_type, entity_id, changes) VALUES (?, ?, ?, ?, ?, ?)'
  ).bind(id, userId, action, entityType, entityId, changes ? JSON.stringify(changes) : null).run();
}

const payroll = new Hono<{ Bindings: Bindings; Variables: Variables }>();
payroll.use('*', authMiddleware);

// ?�?� Employees CRUD ?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�
payroll.get('/employees', async (c) => {
  const tenantId = c.get('client_user_id') || c.get('user').id;
  const rows = await c.env.DB.prepare(
    'SELECT * FROM payroll_employees WHERE user_id = ? ORDER BY is_active DESC, employee_number'
  ).bind(tenantId).all();
  return c.json(rows.results);
});

payroll.post('/employees', bookkeeperMiddleware, zValidator('json', employeeCreateSchema), async (c) => {
  const user = c.get('user');
  const tenantId = c.get('client_user_id') || user.id;
  const db = c.env.DB;
  const d = c.req.valid('json');
  const id = `emp-${uuidv4().slice(0, 8)}`;

  const dup = await db.prepare('SELECT id FROM payroll_employees WHERE user_id = ? AND employee_number = ?')
    .bind(tenantId, d.employee_number).first();
  if (dup) return c.json({ error: `Employee number ${d.employee_number} already exists` }, 409);

  await db.prepare(
    `INSERT INTO payroll_employees (id, user_id, employee_number, name, title, gender, marital_status, monthly_salary, expense_account_code, hire_date, termination_date, is_active)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(id, tenantId, d.employee_number, d.name, d.title || null, d.gender, d.marital_status, d.monthly_salary,
    d.expense_account_code, d.hire_date, d.termination_date || null, d.is_active === false ? 0 : 1).run();
  await auditLog(db, user.id, 'create', 'payroll_employee', id, { employee_number: d.employee_number });
  return c.json(await db.prepare('SELECT * FROM payroll_employees WHERE id = ?').bind(id).first(), 201);
});

payroll.patch('/employees/:id', bookkeeperMiddleware, zValidator('json', employeeUpdateSchema), async (c) => {
  const user = c.get('user');
  const tenantId = c.get('client_user_id') || user.id;
  const db = c.env.DB;
  const id = c.req.param('id');
  const existing = await db.prepare('SELECT * FROM payroll_employees WHERE id = ? AND user_id = ?').bind(id, tenantId).first();
  if (!existing) return c.json({ error: 'Employee not found' }, 404);

  const d = c.req.valid('json');
  const cur = existing as any;
  const next = {
    employee_number: d.employee_number ?? cur.employee_number,
    name: d.name ?? cur.name,
    title: d.title ?? cur.title,
    gender: d.gender ?? cur.gender,
    marital_status: d.marital_status ?? cur.marital_status,
    monthly_salary: d.monthly_salary ?? cur.monthly_salary,
    expense_account_code: d.expense_account_code ?? cur.expense_account_code,
    hire_date: d.hire_date ?? cur.hire_date,
    termination_date: d.termination_date === undefined ? cur.termination_date : d.termination_date,
    is_active: d.is_active === undefined ? cur.is_active : (d.is_active ? 1 : 0),
  };
  if (next.employee_number !== cur.employee_number) {
    const dup = await db.prepare('SELECT id FROM payroll_employees WHERE user_id = ? AND employee_number = ? AND id != ?')
      .bind(tenantId, next.employee_number, id).first();
    if (dup) return c.json({ error: `Employee number ${next.employee_number} already exists` }, 409);
  }
  await db.prepare(
    `UPDATE payroll_employees SET employee_number=?, name=?, title=?, gender=?, marital_status=?, monthly_salary=?, expense_account_code=?, hire_date=?, termination_date=?, is_active=?, updated_at=datetime('now') WHERE id=? AND user_id=?`
  ).bind(next.employee_number, next.name, next.title, next.gender, next.marital_status, next.monthly_salary,
    next.expense_account_code, next.hire_date, next.termination_date, next.is_active, id, tenantId).run();
  await auditLog(db, user.id, 'update', 'payroll_employee', id, { changed: Object.keys(d) });
  return c.json(await db.prepare('SELECT * FROM payroll_employees WHERE id = ?').bind(id).first());
});

payroll.delete('/employees/:id', bookkeeperMiddleware, async (c) => {
  const user = c.get('user');
  const tenantId = c.get('client_user_id') || user.id;
  const db = c.env.DB;
  const id = c.req.param('id');
  const existing = await db.prepare('SELECT * FROM payroll_employees WHERE id = ? AND user_id = ?').bind(id, tenantId).first();
  if (!existing) return c.json({ error: 'Employee not found' }, 404);
  const ref = await db.prepare('SELECT id FROM payroll_run_items WHERE employee_id = ? LIMIT 1').bind(id).first();
  if (ref) return c.json({ error: 'Employee has payroll history; deactivate instead (is_active=false)' }, 409);
  await db.prepare('DELETE FROM payroll_employees WHERE id = ? AND user_id = ?').bind(id, tenantId).run();
  await auditLog(db, user.id, 'delete', 'payroll_employee', id, { employee_number: (existing as any).employee_number });
  return c.json({ success: true });
});

// ?�?� Runs: shared helpers ?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�
async function loadAccountNames(db: any, tenantId: string): Promise<Map<string, string>> {
  const rows = await db.prepare("SELECT account_code, account_name FROM accounts WHERE user_id = ? AND is_active = 1")
    .bind(tenantId).all();
  return new Map((rows.results as any[]).map((r) => [r.account_code, r.account_name]));
}

async function assertAccountsPostable(db: any, tenantId: string, codes: string[]): Promise<string | null> {
  const uniq = [...new Set(codes)];
  const rows = await db.prepare(
    `SELECT account_code FROM accounts WHERE user_id = ? AND is_active = 1 AND account_code IN (${uniq.map(() => '?').join(',')})`
  ).bind(tenantId, ...uniq).all();
  const have = new Set((rows.results as any[]).map((r) => r.account_code));
  const missing = uniq.filter((cde) => !have.has(cde));
  if (missing.length > 0) return `Account code(s) not found: ${missing.join(', ')}`;
  for (const cde of uniq) {
    const guardError = await findParentAccountError(db, tenantId, cde);
    if (guardError) return guardError;
  }
  return null;
}

/** Insert a posted payroll JE; throws { status } on validation failure. */
async function insertPostedEntry(
  db: any, tenantId: string, user: any, entryDate: string, description: string,
  referenceId: string, lines: JeLineDraft[],
): Promise<string> {
  const err = await assertAccountsPostable(db, tenantId, lines.map((l) => l.code));
  if (err) throw Object.assign(new Error(err), { status: 400 });
  if (!(await checkPeriodOpen(db, tenantId, entryDate)))
    throw Object.assign(new Error('Cannot post in a closed period'), { status: 400 });
  const drSum = lines.filter(l => l.dr).reduce((s, l) => s + l.amount, 0);
  const crSum = lines.filter(l => !l.dr).reduce((s, l) => s + l.amount, 0);
  if (Math.abs(drSum - crSum) > 0.001) throw Object.assign(new Error('Debits must equal credits'), { status: 500 });

  // NOTE: deliberately NO `project` column (absent in live D1)
  const id = `je-${uuidv4().slice(0, 8)}`;
  const entryNumber = await nextManualVoucherNumber(db, tenantId, entryDate);
  await db.prepare(
    'INSERT INTO journal_entries (id, user_id, entry_number, entry_date, description, reference_type, reference_id, entry_source, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).bind(id, tenantId, entryNumber, entryDate, description, 'payroll', referenceId, 'manual',
    JSON.stringify({ id: user.id, name: user.name, email: user.email })).run();
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    await db.prepare(
      'INSERT INTO journal_lines (id, entry_id, account_code, account_name, debit, credit, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).bind(`jl-${uuidv4().slice(0, 8)}`, id, l.code, l.name, l.dr ? l.amount : 0, l.dr ? 0 : l.amount, i).run();
  }
  await createSnapshot(db, tenantId, id, 'create');
  await auditLog(db, user.id, 'create', 'journal_entry', id, { entry_number: entryNumber, description, payroll_run: referenceId });
  return id;
}

async function transitionOrFail(c: any, runId: string, target: TransitionTarget) {
  const tenantId = c.get('client_user_id') || c.get('user').id;
  const run = await c.env.DB.prepare('SELECT * FROM payroll_runs WHERE id = ? AND user_id = ?').bind(runId, tenantId).first();
  if (!run) { c.json({ error: 'Run not found' }, 404); return null; }
  if (!canTransition((run as any).status, target)) {
    c.json({ error: `Cannot move run from '${(run as any).status}' to '${target}'` }, 409);
    return null;
  }
  return run as any;
}

// ?�?� Runs: lifecycle endpoints ?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�?�
payroll.get('/bank-accounts', async (c) => {
  const tenantId = c.get('client_user_id') || c.get('user').id;
  const rows = await c.env.DB.prepare(
    "SELECT account_code, account_name FROM accounts WHERE user_id = ? AND is_active = 1 AND account_code LIKE '11%' ORDER BY account_code LIMIT 50"
  ).bind(tenantId).all();
  return c.json(rows.results);
});

payroll.get('/runs', async (c) => {
  const tenantId = c.get('client_user_id') || c.get('user').id;
  const rows = await c.env.DB.prepare('SELECT * FROM payroll_runs WHERE user_id = ? ORDER BY period_month DESC, created_at DESC')
    .bind(tenantId).all();
  return c.json(rows.results);
});

payroll.get('/runs/preview', async (c) => {
  const tenantId = c.get('client_user_id') || c.get('user').id;
  const period = c.req.query('period') || '';
  if (!/^\d{4}-\d{2}$/.test(period)) return c.json({ error: 'period must be YYYY-MM' }, 400);
  const names = await loadAccountNames(c.env.DB, tenantId);
  const accountName = (code: string) => names.get(code) || code;
  const emps = await c.env.DB.prepare(
    'SELECT id, monthly_salary, expense_account_code, hire_date, termination_date FROM payroll_employees WHERE user_id = ? AND is_active = 1'
  ).bind(tenantId).all();
  const { items, totals } = computeRunItems(emps.results as unknown as RunEmployeeInput[], period);
  return c.json({
    items, totals,
    accrual_lines: items.length ? buildAccrualLines(items, totals, accountName) : [],
  });
});

payroll.post('/runs', bookkeeperMiddleware, zValidator('json', runCreateSchema), async (c) => {
  const user = c.get('user');
  const tenantId = c.get('client_user_id') || user.id;
  const db = c.env.DB;
  const { period_month } = c.req.valid('json');
  const existing = await db.prepare("SELECT id, status FROM payroll_runs WHERE user_id = ? AND period_month = ?")
    .bind(tenantId, period_month).first();
  if (existing && (existing as any).status !== 'cancelled')
    return c.json({ error: `Run for ${period_month} already exists (${(existing as any).status})` }, 409);

  const emps = await db.prepare(
    'SELECT id, monthly_salary, expense_account_code, hire_date, termination_date FROM payroll_employees WHERE user_id = ? AND is_active = 1'
  ).bind(tenantId).all();
  const { items, totals } = computeRunItems(emps.results as unknown as RunEmployeeInput[], period_month);
  if (items.length === 0) return c.json({ error: 'No active employees are in-tenure for this period' }, 409);

  const id = `pr-${uuidv4().slice(0, 8)}`;
  await db.batch([
    db.prepare(
      'INSERT INTO payroll_runs (id, user_id, period_month, status, total_gross, total_ee_mpf, total_er_mpf, total_net, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).bind(id, tenantId, period_month, 'draft', totals.total_gross, totals.total_ee_mpf, totals.total_er_mpf, totals.total_net,
      JSON.stringify({ id: user.id, name: user.name, email: user.email })),
    ...items.map((it: RunItem) => db.prepare(
      'INSERT INTO payroll_run_items (id, run_id, employee_id, gross, ee_mpf, er_mpf, net, expense_account_code) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    ).bind(`pri-${uuidv4().slice(0, 8)}`, id, it.employee_id, it.gross, it.ee_mpf, it.er_mpf, it.net, it.expense_account_code)),
  ]);
  await auditLog(db, user.id, 'create', 'payroll_run', id, { period_month, items: items.length });
  return c.json(await db.prepare('SELECT * FROM payroll_runs WHERE id = ?').bind(id).first(), 201);
});

payroll.get('/runs/:id', async (c) => {
  const tenantId = c.get('client_user_id') || c.get('user').id;
  const run = await c.env.DB.prepare('SELECT * FROM payroll_runs WHERE id = ? AND user_id = ?')
    .bind(c.req.param('id'), tenantId).first() as any;
  if (!run) return c.json({ error: 'Run not found' }, 404);
  const items = await c.env.DB.prepare(`
    SELECT pri.*, pe.name AS employee_name, pe.employee_number
    FROM payroll_run_items pri JOIN payroll_employees pe ON pe.id = pri.employee_id
    WHERE pri.run_id = ? ORDER BY pe.employee_number`).bind(run.id).all();
  const linkedIds = [run.accrual_entry_id, run.payment_entry_id, run.mpf_entry_id].filter(Boolean);
  const entries = linkedIds.length
    ? await c.env.DB.prepare(
        `SELECT id, entry_number, entry_date, description, status, deleted_at FROM journal_entries WHERE id IN (${linkedIds.map(() => '?').join(',')})`
      ).bind(...linkedIds).all()
    : { results: [] };
  return c.json({ ...run, items: items.results, linked_entries: entries.results });
});

payroll.post('/runs/:id/post-accrual', bookkeeperMiddleware, async (c) => {
  const run = await transitionOrFail(c, c.req.param('id')!, 'accrued');
  if (!run) return;
  const user = c.get('user'); const tenantId = c.get('client_user_id') || user.id; const db = c.env.DB;
  try {
    const { period_month, total_gross, total_ee_mpf, total_er_mpf, total_net } = run;
    const items = await db.prepare('SELECT * FROM payroll_run_items WHERE run_id = ? ORDER BY employee_id').bind(run.id).all();
    const names = await loadAccountNames(db, tenantId);
    const lines = buildAccrualLines(items.results as unknown as RunItem[],
      { total_gross, total_ee_mpf, total_er_mpf, total_net },
      (code) => names.get(code) || code);
    const entryId = await insertPostedEntry(db, tenantId, user, periodBounds(period_month).end,
      `Payroll ${period_month} accrual`, run.id, lines);
    await db.prepare("UPDATE payroll_runs SET status='accrued', accrual_entry_id=?, updated_at=datetime('now') WHERE id=?").bind(entryId, run.id).run();
    return c.json({ success: true, status: 'accrued', accrual_entry_id: entryId });
  } catch (err: any) { return c.json({ error: err.message }, err.status || 500); }
});

payroll.post('/runs/:id/mark-paid', bookkeeperMiddleware, zValidator('json', markPaidSchema), async (c) => {
  const run = await transitionOrFail(c, c.req.param('id')!, 'paid');
  if (!run) return;
  const user = c.get('user'); const tenantId = c.get('client_user_id') || user.id; const db = c.env.DB;
  try {
    const { bank_account_code } = c.req.valid('json');
    const totals = { total_gross: run.total_gross, total_ee_mpf: run.total_ee_mpf, total_er_mpf: run.total_er_mpf, total_net: run.total_net };
    const names = await loadAccountNames(db, tenantId);
    const lines = buildPaymentLines(totals, bank_account_code, (code) => names.get(code) || code);
    const today = new Date().toISOString().split('T')[0];
    const entryId = await insertPostedEntry(db, tenantId, user, today, `Payroll ${run.period_month} salary payment`, run.id, lines);
    await db.prepare("UPDATE payroll_runs SET status='paid', payment_entry_id=?, bank_account_code=?, updated_at=datetime('now') WHERE id=?")
      .bind(entryId, bank_account_code, run.id).run();
    return c.json({ success: true, status: 'paid', payment_entry_id: entryId });
  } catch (err: any) { return c.json({ error: err.message }, err.status || 500); }
});

payroll.post('/runs/:id/mark-mpf-settled', bookkeeperMiddleware, async (c) => {
  const run = await transitionOrFail(c, c.req.param('id')!, 'settled');
  if (!run) return;
  const user = c.get('user'); const tenantId = c.get('client_user_id') || user.id; const db = c.env.DB;
  try {
    const bank = run.bank_account_code || LIFE_CYCLE_ACCOUNTS.BANK_DEFAULT;
    const totals = { total_gross: run.total_gross, total_ee_mpf: run.total_ee_mpf, total_er_mpf: run.total_er_mpf, total_net: run.total_net };
    const names = await loadAccountNames(db, tenantId);
    const lines = buildSettlementLines(totals, bank, (code) => names.get(code) || code);
    const today = new Date().toISOString().split('T')[0];
    const entryId = await insertPostedEntry(db, tenantId, user, today, `Payroll ${run.period_month} MPF remittance`, run.id, lines);
    await db.prepare("UPDATE payroll_runs SET status='settled', mpf_entry_id=?, updated_at=datetime('now') WHERE id=?").bind(entryId, run.id).run();
    return c.json({ success: true, status: 'settled', mpf_entry_id: entryId });
  } catch (err: any) { return c.json({ error: err.message }, err.status || 500); }
});

payroll.post('/runs/:id/void', bookkeeperMiddleware, async (c) => {
  const run = await transitionOrFail(c, c.req.param('id')!, 'cancelled');
  if (!run) return;
  const user = c.get('user'); const tenantId = c.get('client_user_id') || user.id; const db = c.env.DB;
  try {
    const today = new Date().toISOString().split('T')[0];
    if (!(await checkPeriodOpen(db, tenantId, today))) return c.json({ error: 'Cannot void in a closed period' }, 400);
    const entryIds = [run.accrual_entry_id, run.payment_entry_id, run.mpf_entry_id].filter(Boolean) as string[];
    let reversed = 0;
    for (const originalId of entryIds) {
      const entry = await db.prepare('SELECT * FROM journal_entries WHERE id = ? AND user_id = ?').bind(originalId, tenantId).first() as any;
      if (!entry || entry.deleted_at) continue;
      const revLines = await db.prepare('SELECT * FROM journal_lines WHERE entry_id = ? ORDER BY sort_order').bind(originalId).all();
      const revId = `je-${uuidv4().slice(0, 8)}`;
      await db.prepare(
        'INSERT INTO journal_entries (id, user_id, entry_number, entry_date, description, reference_type, reference_id, entry_source, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
      ).bind(revId, tenantId, `${entry.entry_number}-REV`, today, `Reversal: ${entry.description}`, 'payroll', run.id, 'manual',
        JSON.stringify({ id: user.id, name: user.name, email: user.email })).run();
      for (let i = 0; i < (revLines.results as any[]).length; i++) {
        const l = (revLines.results as any[])[i];
        await db.prepare(
          'INSERT INTO journal_lines (id, entry_id, account_code, account_name, debit, credit, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?)'
        ).bind(`jl-${uuidv4().slice(0, 8)}`, revId, l.account_code, l.account_name, l.credit, l.debit, i).run(); // swapped Dr/Cr
      }
      await createSnapshot(db, tenantId, revId, 'create');
      // Reversal arrives as draft and the original is tombstoned: figures stay stable, trail stays auditable.
      await db.prepare("UPDATE journal_entries SET status='draft', updated_at=datetime('now') WHERE id=?").bind(revId).run();
      await db.prepare("UPDATE journal_entries SET deleted_at=datetime('now'), updated_at=datetime('now') WHERE id=?").bind(originalId).run();
      reversed++;
    }
    await db.prepare("UPDATE payroll_runs SET status='cancelled', updated_at=datetime('now') WHERE id=?").bind(run.id).run();
    await auditLog(db, user.id, 'void', 'payroll_run', run.id, { reversed_entries: reversed });
    return c.json({ success: true, status: 'cancelled', reversed_entries: reversed });
  } catch (err: any) { return c.json({ error: err.message }, err.status || 500); }
});

export default payroll;
