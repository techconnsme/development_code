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

// ── Zod schemas (exported for tests + reuse below) ──────────────────────────
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

// ── Employees CRUD ───────────────────────────────────────────────────────────
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

export default payroll;
