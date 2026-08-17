import { getJwtSecret } from '../middleware/auth';
import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { sign } from 'jsonwebtoken';
import { hash, compare } from 'bcryptjs';
import { v4 as uuidv4 } from 'uuid';
import { Bindings, Variables, AuthUser } from '../types';
import { authMiddleware } from '../middleware/auth';

const auth = new Hono<{ Bindings: Bindings; Variables: Variables }>();

// Rate limiter
const authRateLimitMap = new Map<string, { count: number; resetAt: number }>();
function authRateLimiter(c: any, next: any) {
  const ip = c.req.header('cf-connecting-ip') || c.req.header('x-forwarded-for') || 'unknown';
  const now = Date.now();
  let entry = authRateLimitMap.get(ip);
  if (!entry || now > entry.resetAt) {
    entry = { count: 0, resetAt: now + 60000 };
    authRateLimitMap.set(ip, entry);
  }
  entry.count++;
  if (entry.count > 5) return c.json({ error: 'Too many attempts. Please try again later.' }, 429);
  return next();
}

// ── APPLY (replaces open registration) ──────────────────────────────────
// Anyone can submit an application. Admin reviews and approves.
const applySchema = z.object({
  company_name: z.string().min(1),
  contact_name: z.string().min(1),
  email: z.string().email(),
  phone: z.string().optional(),
  message: z.string().optional(),
});

auth.post('/apply', authRateLimiter, zValidator('json', applySchema), async (c) => {
  const { company_name, contact_name, email, phone, message } = c.req.valid('json');
  const db = c.env.DB;

  // Check if email already has an active application (pending or approved)
  const existingApp = await db.prepare(
    "SELECT id, status FROM applications WHERE email = ? ORDER BY created_at DESC LIMIT 1"
  ).bind(email).first<{ id: string; status: string }>();
  // Block only if pending or approved — allow re-apply after deregistered/rejected
  if (existingApp && (existingApp.status === 'pending' || existingApp.status === 'approved')) {
    return c.json({ error: 'An application with this email already exists.' }, 409);
  }

  // Check if email is an active supervisor/admin account (not legacy 'user' role)
  const existingUser = await db.prepare(
    "SELECT id, role FROM users WHERE email = ?"
  ).bind(email).first<{ id: string; role: string }>();
  if (existingUser && (existingUser.role === 'supervisor' || existingUser.role === 'admin')) {
    return c.json({ error: 'This email is already registered as an active account.' }, 409);
  }

  const id = `app-${uuidv4().slice(0, 8)}`;
  await db.prepare(
    `INSERT INTO applications (id, company_name, contact_name, email, phone, message, status)
     VALUES (?, ?, ?, ?, ?, ?, 'pending')`
  ).bind(id, company_name, contact_name, email, phone || null, message || null).run();

  return c.json({
    success: true,
    message: 'Application received. You will receive an email when your account is approved.',
  }, 201);
});

// ── LEGACY REGISTER (disabled — all registration goes through /apply + admin approval) ──
auth.post('/register', authRateLimiter, async (c) => {
  return c.json({ error: 'Registration is by invitation only. Please use the Apply form at /apply.' }, 403);
});

// ── LOGIN ────────────────────────────────────────────────────────────────
const loginSchema = z.object({ email: z.string().email(), password: z.string().min(1) });

auth.post('/login', authRateLimiter, zValidator('json', loginSchema), async (c) => {
  const { email, password } = c.req.valid('json');
  const db = c.env.DB;
  const jwtSecret = getJwtSecret(c.env);

  const row = await db.prepare(
    'SELECT id, email, password_hash, name, role, company_name, status, must_change_password FROM users WHERE email = ?'
  ).bind(email).first<{
    id: string; email: string; password_hash: string; name: string;
    role: string; company_name: string | null; status: string; must_change_password: number;
  }>();

  if (!row) return c.json({ error: 'Invalid email or password' }, 401);

  // Block pending/suspended accounts
  if (row.status === 'pending') return c.json({ error: 'Your account is pending approval. Please check your email.' }, 403);
  if (row.status === 'suspended') return c.json({ error: 'Your account has been suspended. Please contact your administrator.' }, 403);

  const valid = await compare(password, row.password_hash);
  if (!valid) {
    // Audit: log failed login attempt
    try {
      await db.prepare('INSERT INTO audit_log (id, user_id, action, entity_type, entity_id, changes) VALUES (?, ?, ?, ?, ?, ?)')
        .bind(`al-${uuidv4().slice(0,8)}`, row.id, 'failed_login', 'user', row.id, JSON.stringify({ email })).run();
    } catch { /* ignore */ }
    return c.json({ error: 'Invalid email or password' }, 401);
  }

  const user: AuthUser = {
    id: row.id, email: row.email, name: row.name, role: row.role,
    company_name: row.company_name || undefined,
  };

  // Ensure the account has a company_settings row — direction detection and
  // company identity read it. Self-heals legacy accounts on their next login
  // (2026-08-18: 26/42 accounts were missing it, which silently broke own-issued
  // invoice direction detection).
  if (row.company_name) {
    try {
      await db.prepare(
        'INSERT OR IGNORE INTO company_settings (id, user_id, name) VALUES (?, ?, ?)'
      ).bind(`cs-${row.id}`, row.id, row.company_name).run();
    } catch (e: any) { console.log('[SETTINGS-ENSURE] failed:', e?.message); }
  }

  // Check firm membership
  const firmMember = await db.prepare(
    `SELECT fm.firm_id, fm.role as firm_role, f.name as firm_name
     FROM firm_members fm JOIN firms f ON f.id = fm.firm_id
     WHERE fm.user_id = ? AND fm.is_active = 1`
  ).bind(row.id).first<{ firm_id: string; firm_role: string; firm_name: string }>();
  if (firmMember) {
    user.firm_id = firmMember.firm_id;
    user.firm_role = firmMember.firm_role;
  } else {
    // Auto-create a personal firm for users without one.
    // Each user gets their own isolated firm — no data sharing.
    const firmName = row.company_name || row.name || row.email;
    const firmId = `f-${uuidv4().slice(0, 8)}`;
    try {
      await db.prepare('INSERT INTO firms (id, name, owner_user_id) VALUES (?, ?, ?)')
        .bind(firmId, firmName, row.id).run();
      await db.prepare('INSERT INTO firm_members (id, firm_id, user_id, role) VALUES (?, ?, ?, ?)')
        .bind(`fm-${uuidv4().slice(0, 8)}`, firmId, row.id, 'admin').run();
      user.firm_id = firmId;
      user.firm_role = 'admin';
    } catch (e: any) {
      console.log('[AUTO-FIRM] Could not create firm for user', row.id, ':', e?.message);
      // Non-fatal — user can still log in, just without firm features
    }
  }

  const token = sign(user, jwtSecret, { expiresIn: '24h' });

  // Audit: log successful login
  try {
    await db.prepare('INSERT INTO audit_log (id, user_id, action, entity_type, entity_id) VALUES (?, ?, ?, ?, ?)')
      .bind(`al-${uuidv4().slice(0,8)}`, row.id, 'login', 'user', row.id).run();
  } catch { /* never block login for audit errors */ }

  const isProd = c.env.ENVIRONMENT === 'production';
  const secureFlag = isProd ? 'Secure; ' : '';
  c.header('Set-Cookie', `token=${token}; HttpOnly; ${secureFlag}SameSite=Lax; Path=/; Max-Age=86400`);

  return c.json({
    user,
    token,
    must_change_password: row.must_change_password === 1,
  });
});

// ── CHANGE PASSWORD (including forced first-login change) ────────────────
auth.post('/change-password', authMiddleware, async (c) => {
  const user = c.get('user') as any;
  const db = c.env.DB;
  const { current_password, new_password } = await c.req.json();

  if (!new_password || new_password.length < 8) {
    return c.json({ error: 'New password must be at least 8 characters.' }, 400);
  }
  const pwRegex = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)/;
  if (!pwRegex.test(new_password)) {
    return c.json({ error: 'Password must contain uppercase, lowercase, and a number.' }, 400);
  }

  const row = await db.prepare('SELECT password_hash, must_change_password FROM users WHERE id = ?')
    .bind(user.id).first<{ password_hash: string; must_change_password: number }>();
  if (!row) return c.json({ error: 'User not found' }, 404);

  // If not a forced change, verify current password
  if (!row.must_change_password) {
    if (!current_password) return c.json({ error: 'Current password is required.' }, 400);
    const valid = await compare(current_password, row.password_hash);
    if (!valid) return c.json({ error: 'Current password is incorrect.' }, 401);
  }

  const newHash = await hash(new_password, 12);
  await db.prepare(
    'UPDATE users SET password_hash = ?, must_change_password = 0, updated_at = datetime(\'now\') WHERE id = ?'
  ).bind(newHash, user.id).run();

  return c.json({ success: true, message: 'Password changed successfully.' });
});

// ── LOGOUT ───────────────────────────────────────────────────────────────
auth.post('/logout', async (c) => {
  const isProd = c.env.ENVIRONMENT === 'production';
  const secureFlag = isProd ? 'Secure; ' : '';
  c.header('Set-Cookie', `token=; HttpOnly; ${secureFlag}SameSite=Lax; Path=/; Max-Age=0`);
  return c.json({ success: true });
});

// ── /ME ──────────────────────────────────────────────────────────────────
auth.get('/me', authMiddleware, async (c) => {
  const user = c.get('user') as any;
  let permission_tier = 'higher';
  const db = c.env.DB;
  try {
    if (user.firm_id) {
      const row = await db.prepare(
        'SELECT permission_tier FROM firm_members WHERE firm_id = ? AND user_id = ? AND is_active = 1'
      ).bind(user.firm_id, user.id).first<{ permission_tier: string }>();
      if (row?.permission_tier) permission_tier = row.permission_tier;
      else if (user.firm_role === 'admin') permission_tier = 'higher';
      else permission_tier = 'normal';
    } else {
      const row = await db.prepare('SELECT permission_tier, must_change_password FROM users WHERE id = ?')
        .bind(user.id).first<{ permission_tier: string; must_change_password: number }>();
      if (row?.permission_tier) permission_tier = row.permission_tier;
      return c.json({ user: { ...user, permission_tier, must_change_password: row?.must_change_password === 1 } });
    }
  } catch { /* default */ }
  return c.json({ user: { ...user, permission_tier } });
});

// ── STAFF MANAGEMENT (Supervisor/Accountant only) ────────────────────────

// List staff accounts under this supervisor
auth.get('/staff', authMiddleware, async (c) => {
  const user = c.get('user') as any;
  const db = c.env.DB;
  if (!['admin', 'supervisor', 'accountant'].includes(user.role)) {
    return c.json({ error: 'Not authorized' }, 403);
  }
  const tenantId = c.get('client_user_id') || user.id;
  const staff = await db.prepare(
    `SELECT id, name, email, role, status, created_at FROM users
     WHERE parent_user_id = ? AND deleted_at IS NULL ORDER BY created_at DESC`
  ).bind(tenantId).all();
  return c.json({ data: staff.results });
});

// Create a staff/viewer account
const createStaffSchema = z.object({
  name: z.string().min(1),
  email: z.string().email(),
  role: z.enum(['staff', 'viewer']),
});

auth.post('/staff', authMiddleware, zValidator('json', createStaffSchema), async (c) => {
  const user = c.get('user') as any;
  const db = c.env.DB;
  if (!['admin', 'supervisor', 'accountant'].includes(user.role)) {
    return c.json({ error: 'Not authorized' }, 403);
  }
  const tenantId = c.get('client_user_id') || user.id;
  const { name, email, role } = c.req.valid('json');

  const existing = await db.prepare('SELECT id FROM users WHERE email = ?').bind(email).first();
  if (existing) return c.json({ error: 'This email is already registered.' }, 409);

  // Generate temporary password
  const tempPassword = `Temp${Math.random().toString(36).slice(2, 8).toUpperCase()}1!`;
  const passwordHash = await hash(tempPassword, 12);
  const id = `u-${uuidv4().slice(0, 8)}`;

  // Get parent's company info
  const parent = await db.prepare('SELECT company_name FROM users WHERE id = ?')
    .bind(tenantId).first<{ company_name: string }>();

  await db.prepare(
    `INSERT INTO users (id, email, password_hash, name, company_name, role, status, must_change_password, parent_user_id, permission_tier)
     VALUES (?, ?, ?, ?, ?, ?, 'active', 1, ?, ?)`
  ).bind(id, email, passwordHash, name, parent?.company_name || null, role, tenantId,
    role === 'viewer' ? 'viewer' : 'normal').run();

  // Ensure company_settings exists for the new account too (2026-08-18)
  if (parent?.company_name) {
    try {
      await db.prepare(
        'INSERT OR IGNORE INTO company_settings (id, user_id, name) VALUES (?, ?, ?)'
      ).bind(`cs-${id}`, id, parent.company_name).run();
    } catch (e: any) { console.log('[SETTINGS-ENSURE] failed:', e?.message); }
  }

  // Audit: log user creation
  try {
    await db.prepare('INSERT INTO audit_log (id, user_id, action, entity_type, entity_id, changes) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(`al-${uuidv4().slice(0,8)}`, tenantId, 'create_user', 'user', id, JSON.stringify({ email, role, name })).run();
  } catch { /* ignore */ }

  // Send welcome email if mail service is configured
  try {
    if (c.env.MAILGUN_API_KEY || c.env.RESEND_API_KEY) {
      await sendStaffWelcomeEmail(email, name, tempPassword, c.env);
    }
  } catch (e) { console.error('Failed to send welcome email:', e); }

  return c.json({
    success: true,
    user_id: id,
    temp_password: tempPassword, // shown in UI since email may not be configured
    message: `Staff account created. Temporary password: ${tempPassword}`,
  }, 201);
});

// Update staff role
auth.patch('/staff/:id', authMiddleware, async (c) => {
  const user = c.get('user') as any;
  const db = c.env.DB;
  if (!['admin', 'supervisor', 'accountant'].includes(user.role)) {
    return c.json({ error: 'Not authorized' }, 403);
  }
  const tenantId = c.get('client_user_id') || user.id;
  const staffId = c.req.param('id');
  const { role, status } = await c.req.json();

  // Verify this staff member belongs to this supervisor
  const staffRow = await db.prepare('SELECT id FROM users WHERE id = ? AND parent_user_id = ?')
    .bind(staffId, tenantId).first();
  if (!staffRow) return c.json({ error: 'Staff member not found' }, 404);

  const updates: string[] = [];
  const binds: any[] = [];
  if (role && ['staff', 'viewer'].includes(role)) {
    updates.push('role = ?', 'permission_tier = ?');
    binds.push(role, role === 'viewer' ? 'viewer' : 'normal');
  }
  if (status && ['active', 'suspended'].includes(status)) {
    updates.push('status = ?');
    binds.push(status);
  }
  if (updates.length === 0) return c.json({ error: 'Nothing to update' }, 400);

  updates.push("updated_at = datetime('now')");
  binds.push(staffId);
  await db.prepare(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`).bind(...binds).run();

  return c.json({ success: true });
});

// Delete staff account
auth.delete('/staff/:id', authMiddleware, async (c) => {
  const user = c.get('user') as any;
  const db = c.env.DB;
  // Only supervisor can delete (not accountant, per Joseph's spec)
  if (!['admin', 'supervisor'].includes(user.role)) {
    return c.json({ error: 'Only supervisors can delete accounts' }, 403);
  }
  const tenantId = c.get('client_user_id') || user.id;
  const staffId = c.req.param('id');

  const staffRow = await db.prepare('SELECT id FROM users WHERE id = ? AND parent_user_id = ?')
    .bind(staffId, tenantId).first();
  if (!staffRow) return c.json({ error: 'Staff member not found' }, 404);

  await db.prepare('DELETE FROM users WHERE id = ?').bind(staffId).run();
  return c.json({ success: true });
});

// ── Self-service delete & export (unchanged) ─────────────────────────────
auth.delete('/me', authMiddleware, async (c) => {
  const user = c.get('user');
  const db = c.env.DB;
  const tables = [
    'journal_lines', 'journal_entries', 'accounts', 'bank_transactions', 'bank_statements',
    'expense_receipts', 'file_records', 'invoices', 'invoice_items', 'customers', 'suppliers',
    'products', 'quotations', 'quotation_items', 'purchase_orders', 'purchase_order_items',
    'service_orders', 'service_order_items', 'chat_messages', 'chat_sessions',
    'calendar_events', 'messages', 'conversations', 'firm_client_assignments',
    'firm_clients', 'firm_members', 'api_tokens', 'compliance_log', 'member_compliance',
    'compliance_dates', 'company_settings', 'subscriptions', 'audit_log', 'fixed_assets',
    'closed_periods', 'bank_reconciliations', 'website_versions',
  ];
  for (const table of tables) {
    await db.prepare(`DELETE FROM ${table} WHERE user_id = ?`).bind(user.id).run();
  }
  await db.prepare('DELETE FROM users WHERE id = ?').bind(user.id).run();
  c.header('Set-Cookie', 'token=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0');
  return c.json({ success: true });
});

auth.get('/export-my-data', authMiddleware, async (c) => {
  const user = c.get('user');
  const db = c.env.DB;
  const exportData: Record<string, any> = { user };
  const tables = [
    'accounts', 'journal_entries', 'journal_lines', 'bank_statements', 'bank_transactions',
    'expense_receipts', 'file_records', 'invoices', 'invoice_items', 'customers', 'suppliers',
    'products', 'quotations', 'quotation_items', 'chat_sessions', 'chat_messages',
    'calendar_events', 'fixed_assets', 'company_settings',
  ];
  for (const table of tables) {
    try {
      const rows = await db.prepare(`SELECT * FROM ${table} WHERE user_id = ?`).bind(user.id).all();
      exportData[table] = rows.results;
    } catch { exportData[table] = []; }
  }
  c.header('Content-Type', 'application/json');
  c.header('Content-Disposition', 'attachment; filename=opcc-data-export.json');
  return c.json(exportData);
});

// ── Verify Supervisor Password (for Staff delete approval) ───────────────
// Staff calls this when trying to delete something.
// The system finds the supervisor of the current tenant and checks the password.
auth.post('/verify-supervisor-password', authMiddleware, async (c) => {
  const user = c.get('user') as any;
  const tenantId = c.get('client_user_id') || user.id;
  const db = c.env.DB;
  const { password } = await c.req.json();

  if (!password) return c.json({ error: 'Password is required.' }, 400);

  // If the current user is already a supervisor/admin, verify their own password
  if (['admin', 'supervisor', 'accountant'].includes(user.role)) {
    const row = await db.prepare('SELECT password_hash FROM users WHERE id = ?')
      .bind(user.id).first<{ password_hash: string }>();
    if (!row) return c.json({ error: 'User not found.' }, 404);
    const valid = await compare(password, row.password_hash);
    if (!valid) return c.json({ error: 'Incorrect password.' }, 401);
    return c.json({ success: true });
  }

  // Staff user — find their supervisor (parent_user_id)
  const staffRow = await db.prepare('SELECT parent_user_id FROM users WHERE id = ?')
    .bind(user.id).first<{ parent_user_id: string }>();

  const supervisorId = staffRow?.parent_user_id || tenantId;
  const supRow = await db.prepare(
    'SELECT password_hash, role FROM users WHERE id = ? AND role IN (\'supervisor\', \'accountant\', \'admin\')'
  ).bind(supervisorId).first<{ password_hash: string; role: string }>();

  if (!supRow) return c.json({ error: 'No supervisor found for this account.' }, 404);

  const valid = await compare(password, supRow.password_hash);
  if (!valid) return c.json({ error: 'Incorrect supervisor password.' }, 401);

  // Audit: log supervisor override approval
  try {
    await db.prepare('INSERT INTO audit_log (id, user_id, action, entity_type, entity_id, changes) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(`al-${uuidv4().slice(0,8)}`, supervisorId, 'supervisor_override', 'user', user.id, JSON.stringify({ approved_for: user.id, approved_by: supervisorId })).run();
  } catch { /* ignore */ }

  return c.json({ success: true });
});

// ── Email helper ─────────────────────────────────────────────────────────
async function sendStaffWelcomeEmail(email: string, name: string, tempPassword: string, env: any) {
  const subject = 'Your Tech Connect SME Staff Account';
  const body = `Hi ${name},\n\nYour staff account has been created on Tech Connect SME.\n\nEmail: ${email}\nTemporary Password: ${tempPassword}\n\nPlease log in and change your password immediately.\n\nTech Connect SME Team`;
  console.log('[EMAIL]', email, subject, body);
}

export { auth as authRoutes };
